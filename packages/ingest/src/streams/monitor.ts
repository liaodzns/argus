/**
 * Price and flow monitoring, keyed on the mint.
 *
 * One `logsSubscribe { mentions: [mint] }` per monitored token. That is
 * venue-agnostic by construction: the mint never changes while the bonding
 * curve and the AMM pool do, so the same subscription follows a token across
 * bonding with no switchover logic at all.
 *
 * This replaced an attempt to read reserves out of the curve and pool accounts
 * directly. PumpSwap's pool account holds no reserves — they live in separate
 * vaults — and the curve's values did not reconcile with the creation feed's
 * own figures. Guessing at either layout yields a confident chart at the wrong
 * magnitude, which is the worst kind of wrong. See PIVOT.md.
 *
 * Two tiers, because they cost very differently:
 *
 *   Free   — every notification forwarded as MintActivity. Exact trade count
 *            and landed ratio, no RPC calls, identical on both venues.
 *   Paid   — one decoded trade per mint per `sampleIntervalMs`, giving price.
 *            Rate-limited on purpose: a hot token does ~7 landed trades a
 *            second, so decoding everything on a 25-clone wave would need
 *            hundreds of calls a second and fall behind exactly when it matters.
 *
 * Which mints to hold is not decided here. The engine writes a set to Redis and
 * this polls it, so the two processes need no protocol between them and either
 * can restart without a re-announce.
 */
import WebSocket from "ws";
import type { Logger } from "pino";
import type { Redis } from "ioredis";
import { KEYS, MintActivitySchema, type StreamEvent } from "@argus/shared";
import { RpcTransactionSchema, decodeSwaps } from "../decode/swap.js";
import { runWithReconnect } from "./reconnect.js";

const MAX_TX_VERSION = 1;

export interface MonitorStats {
  subscribed: number;
  activity: number;
  landed: number;
  samplesTaken: number;
  samplesDecoded: number;
  rpcErrors: number;
  subscribeFailures: number;
}

export interface MonitorOptions {
  wsUrl: string;
  rpcUrl: string;
  redis: Redis;
  logger: Logger;
  onEvent: (event: StreamEvent) => void;
  /** Minimum gap between decoded price samples for a single mint. */
  sampleIntervalMs: () => number;
  /** Most mints that may be sampled at once, chosen by observed activity. */
  maxPriced: () => number;
  /** How often to reconcile live subscriptions against the Redis set. */
  refreshMs?: number;
}

export function createMonitor(options: MonitorOptions) {
  const { wsUrl, rpcUrl, redis, logger, onEvent } = options;
  const refreshMs = options.refreshMs ?? 2_000;

  const stats: MonitorStats = {
    subscribed: 0, activity: 0, landed: 0,
    samplesTaken: 0, samplesDecoded: 0, rpcErrors: 0, subscribeFailures: 0,
  };

  /** mint -> subscription id, for the mints currently held. */
  const live = new Map<string, number>();
  /** subscription id -> mint, to route notifications back. */
  const bySubscription = new Map<number, string>();
  /** mint -> when it was last decoded, for the sampling gate. */
  const lastSampled = new Map<string, number>();
  /** mint -> landed notifications seen, so sampling can favour the busy. */
  const landedCount = new Map<string, number>();

  let socket: WebSocket | null = null;
  let nextRequestId = 1;
  /** request id -> mint, so a confirmation can be tied to what asked for it. */
  const pending = new Map<number, string>();

  async function fetchTransaction(signature: string): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [signature, {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: MAX_TX_VERSION,
        // Must match the subscription's commitment. Defaulting to finalized
        // returns null for a transaction we were just told about.
        commitment: "confirmed",
      }],
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 60)}`);
      const payload = JSON.parse(text) as { result?: unknown; error?: { message: string } };
      if (payload.error !== undefined) throw new Error(payload.error.message);
      return payload.result;
    }
    throw new Error("throttled");
  }

  /**
   * Decide whether this notification earns a decode.
   *
   * Sampling is capped two ways: a per-mint interval, and a ceiling on how many
   * mints may be sampled at all. The ceiling is spent on the mints with the
   * most observed activity rather than on the first ones seen, because during a
   * wave the one that matters is whichever is taking volume.
   */
  function shouldSample(mint: string, now: number): boolean {
    const last = lastSampled.get(mint) ?? 0;
    if (now - last < options.sampleIntervalMs()) return false;
    const busiest = [...landedCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.maxPriced())
      .map(([m]) => m);
    return busiest.includes(mint);
  }

  async function sample(mint: string, signature: string): Promise<void> {
    stats.samplesTaken += 1;
    try {
      const raw = await fetchTransaction(signature);
      if (raw === null || raw === undefined) return;
      const { trades } = decodeSwaps(RpcTransactionSchema.parse(raw));
      for (const trade of trades) {
        if (trade.mint !== mint) continue; // routed transactions carry other legs
        stats.samplesDecoded += 1;
        onEvent(trade);
      }
    } catch (error) {
      stats.rpcErrors += 1;
      logger.debug({ mint, signature, err: String(error) }, "price sample failed");
    }
  }

  function subscribe(mint: string): void {
    if (socket === null || socket.readyState !== 1 || live.has(mint)) return;
    const id = ++nextRequestId;
    pending.set(id, mint);
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id, method: "logsSubscribe",
      params: [{ mentions: [mint] }, { commitment: "confirmed" }],
    }));
  }

  function unsubscribe(mint: string): void {
    const id = live.get(mint);
    if (id === undefined || socket === null || socket.readyState !== 1) return;
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id: ++nextRequestId, method: "logsUnsubscribe", params: [id],
    }));
    live.delete(mint);
    bySubscription.delete(id);
    landedCount.delete(mint);
    lastSampled.delete(mint);
    stats.subscribed = live.size;
  }

  /** Reconcile what we hold against what the engine asked for. */
  async function reconcile(): Promise<void> {
    if (socket === null || socket.readyState !== 1) return;
    let wanted: string[];
    try {
      wanted = await redis.smembers(KEYS.monitored());
    } catch (error) {
      logger.debug({ err: String(error) }, "could not read the monitored set");
      return;
    }
    const want = new Set(wanted);
    for (const mint of want) if (!live.has(mint)) subscribe(mint);
    for (const mint of [...live.keys()]) if (!want.has(mint)) unsubscribe(mint);
  }

  function connect(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      socket = ws;
      let settled = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearInterval(timer);
        ws.removeAllListeners();
        ws.terminate();
        // A reconnect must re-subscribe from scratch; ids from the dead socket
        // mean nothing on the new one.
        live.clear();
        bySubscription.clear();
        pending.clear();
        stats.subscribed = 0;
        socket = null;
        if (error === undefined) resolve();
        else reject(error);
      };

      signal.addEventListener("abort", () => finish(), { once: true });

      ws.on("open", () => {
        logger.info("monitor socket open");
        void reconcile();
        timer = setInterval(() => void reconcile(), refreshMs);
        timer.unref();
      });

      ws.on("message", (data: WebSocket.RawData) => {
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        const message = frame as {
          id?: number;
          result?: unknown;
          error?: { message: string };
          method?: string;
          params?: { subscription?: number; result?: { value?: { signature?: string; err?: unknown } } };
        };

        if (message.id !== undefined) {
          const mint = pending.get(message.id);
          pending.delete(message.id);
          if (mint === undefined) return; // an unsubscribe acknowledgement
          if (message.error !== undefined || typeof message.result !== "number") {
            stats.subscribeFailures += 1;
            logger.warn({ mint, err: message.error?.message }, "mint subscription rejected");
            return;
          }
          live.set(mint, message.result);
          bySubscription.set(message.result, mint);
          stats.subscribed = live.size;
          return;
        }

        if (message.method !== "logsNotification") return;
        const subscription = message.params?.subscription;
        const value = message.params?.result?.value;
        const signature = value?.signature;
        if (subscription === undefined || typeof signature !== "string") return;
        const mint = bySubscription.get(subscription);
        if (mint === undefined) return;

        const landed = value?.err == null;
        stats.activity += 1;
        if (landed) {
          stats.landed += 1;
          landedCount.set(mint, (landedCount.get(mint) ?? 0) + 1);
        }

        const observedAt = Date.now();
        const activity = MintActivitySchema.safeParse({
          kind: "activity", mint, signature, landed, observedAt,
        });
        if (activity.success) onEvent(activity.data);

        // Only landed transactions are worth decoding; a failed one moved
        // nothing and would burn a sample for no price.
        if (landed && shouldSample(mint, observedAt)) {
          lastSampled.set(mint, observedAt);
          void sample(mint, signature);
        }
      });

      ws.on("error", (error) => finish(error));
      ws.on("close", () => finish());
    });
  }

  return {
    stats,
    /** Mints currently held, for logging. */
    held: (): string[] => [...live.keys()],
    async start(signal: AbortSignal): Promise<void> {
      await runWithReconnect(connect, signal, {
        onRetry: (attempt, delayMs, error) =>
          logger.warn({ attempt, delayMs, err: String(error) }, "monitor dropped, reconnecting"),
      });
    },
  };
}
