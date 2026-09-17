/**
 * Price, flow, and who is buying — all from log subscriptions.
 *
 * Holds two kinds of subscription on one socket:
 *
 *   mints    the token you hold and every clone of it, driven by a Redis set
 *            the engine writes. Gives trade rate for free, and a rate-limited
 *            decoded price sample.
 *   roster   all 230 tracked wallets, permanently.
 *
 * Both are `mentions` filters, so a transaction touching a roster wallet *and*
 * a monitored mint is delivered twice, once per subscription, with the same
 * signature. Joining on that signature proves a tracked wallet traded that
 * clone, with no `getTransaction` at all. Verified: 100% of one mint's
 * transactions also appeared in a second subscription's stream, and 231
 * subscriptions confirmed on a single socket.
 *
 * Subscribing by mint rather than by curve or pool account is what makes
 * pre-bond and post-bond one mechanism: a mint does not change when a token
 * bonds. See PIVOT.md for the account layouts this replaced.
 *
 * Roster subscriptions are permanent rather than opened when a watch opens.
 * Subscribing 230 wallets at that moment would add setup latency exactly when
 * the risk window is sixty seconds long, and holding them costs no RPC.
 */
import WebSocket from "ws";
import type { Logger } from "pino";
import type { Redis } from "ioredis";
import { KEYS, MintActivitySchema, type StreamEvent } from "@argus/shared";
import { RpcTransactionSchema, decodeSwaps } from "../decode/swap.js";
import { runWithReconnect } from "./reconnect.js";

const MAX_TX_VERSION = 1;

export interface MonitorStats {
  mintSubs: number;
  rosterSubs: number;
  activity: number;
  landed: number;
  rosterSeen: number;
  /** Transactions matched across both streams. The whole point of this file. */
  joins: number;
  joinDecodes: number;
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
  /** Read fresh, so a hot-reloaded roster resubscribes without a restart. */
  roster: () => readonly string[];
  sampleIntervalMs: () => number;
  maxPriced: () => number;
  refreshMs?: number;
  /**
   * How long a signature stays joinable. The two notifications for one
   * transaction can arrive in either order and a few hundred milliseconds
   * apart, so both sides are held briefly rather than assuming an order.
   */
  joinWindowMs?: number;
}

type Subject = { kind: "mint" | "roster"; address: string };

export function createMonitor(options: MonitorOptions) {
  const { wsUrl, rpcUrl, redis, logger, onEvent } = options;
  const refreshMs = options.refreshMs ?? 2_000;
  const joinWindowMs = options.joinWindowMs ?? 30_000;

  const stats: MonitorStats = {
    mintSubs: 0, rosterSubs: 0, activity: 0, landed: 0, rosterSeen: 0,
    joins: 0, joinDecodes: 0, samplesTaken: 0, samplesDecoded: 0,
    rpcErrors: 0, subscribeFailures: 0,
  };

  /** address -> subscription id, per kind. */
  const liveMints = new Map<string, number>();
  const liveRoster = new Map<string, number>();
  const bySubscription = new Map<number, Subject>();

  const lastSampled = new Map<string, number>();
  const landedCount = new Map<string, number>();

  // Both halves of the join, because either can arrive first.
  const rosterSigs = new Map<string, { wallet: string; at: number }>();
  const mintSigs = new Map<string, { mint: string; at: number }>();
  const joined = new Set<string>();

  let socket: WebSocket | null = null;
  let nextRequestId = 0;
  const pending = new Map<number, Subject>();

  function prune(now: number): void {
    for (const [sig, entry] of rosterSigs) if (now - entry.at > joinWindowMs) rosterSigs.delete(sig);
    for (const [sig, entry] of mintSigs) if (now - entry.at > joinWindowMs) mintSigs.delete(sig);
    if (joined.size > 10_000) joined.clear();
  }

  async function rpc(signature: string): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [signature, {
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: MAX_TX_VERSION,
        // Must match the subscription commitment; finalized returns null for a
        // transaction we were just told about.
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

  async function decodeInto(mint: string, signature: string, tag: "join" | "sample"): Promise<void> {
    try {
      const raw = await rpc(signature);
      if (raw === null || raw === undefined) return;
      const { trades } = decodeSwaps(RpcTransactionSchema.parse(raw));
      for (const trade of trades) {
        // A routed transaction carries other people's legs; only this mint's
        // movement describes the clone.
        if (trade.mint !== mint) continue;
        if (tag === "join") stats.joinDecodes += 1;
        else stats.samplesDecoded += 1;
        onEvent(trade);
      }
    } catch (error) {
      stats.rpcErrors += 1;
      logger.debug({ mint, signature, tag, err: String(error) }, "decode failed");
    }
  }

  /**
   * A tracked wallet and a monitored mint in the same transaction.
   *
   * This is the one call worth making unconditionally. The join alone proves
   * the wallet traded the clone but not in which direction, and a tracked
   * wallet *exiting* a clone is not a vamp signal, so the direction has to be
   * read off the balance deltas. Rare by construction: it needs both halves at
   * once.
   */
  function join(signature: string, mint: string, wallet: string): void {
    if (joined.has(signature)) return;
    joined.add(signature);
    stats.joins += 1;
    logger.info({ wallet, mint, signature }, "ROSTER TOUCHED A MONITORED MINT");
    void decodeInto(mint, signature, "join");
  }

  function shouldSample(mint: string, now: number): boolean {
    if (now - (lastSampled.get(mint) ?? 0) < options.sampleIntervalMs()) return false;
    const busiest = [...landedCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, options.maxPriced())
      .map(([m]) => m);
    return busiest.includes(mint);
  }

  function send(subject: Subject): void {
    if (socket === null || socket.readyState !== 1) return;
    const id = ++nextRequestId;
    pending.set(id, subject);
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id, method: "logsSubscribe",
      params: [{ mentions: [subject.address] }, { commitment: "confirmed" }],
    }));
  }

  function drop(kind: "mint" | "roster", address: string): void {
    const table = kind === "mint" ? liveMints : liveRoster;
    const id = table.get(address);
    if (id === undefined || socket === null || socket.readyState !== 1) return;
    socket.send(JSON.stringify({
      jsonrpc: "2.0", id: ++nextRequestId, method: "logsUnsubscribe", params: [id],
    }));
    table.delete(address);
    bySubscription.delete(id);
    if (kind === "mint") {
      landedCount.delete(address);
      lastSampled.delete(address);
    }
    stats.mintSubs = liveMints.size;
    stats.rosterSubs = liveRoster.size;
  }

  /** Reconcile both subscription sets against what they should be. */
  async function reconcile(): Promise<void> {
    if (socket === null || socket.readyState !== 1) return;

    const wantRoster = new Set(options.roster());
    for (const address of wantRoster) if (!liveRoster.has(address)) send({ kind: "roster", address });
    for (const address of [...liveRoster.keys()]) if (!wantRoster.has(address)) drop("roster", address);

    let members: string[];
    try {
      members = await redis.smembers(KEYS.monitored());
    } catch (error) {
      logger.debug({ err: String(error) }, "could not read the monitored set");
      return;
    }
    const wantMints = new Set(members);
    for (const address of wantMints) if (!liveMints.has(address)) send({ kind: "mint", address });
    for (const address of [...liveMints.keys()]) if (!wantMints.has(address)) drop("mint", address);
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
        // Subscription ids belong to the dead socket; a reconnect resubscribes
        // everything from scratch.
        liveMints.clear();
        liveRoster.clear();
        bySubscription.clear();
        pending.clear();
        stats.mintSubs = 0;
        stats.rosterSubs = 0;
        socket = null;
        if (error === undefined) resolve();
        else reject(error);
      };

      signal.addEventListener("abort", () => finish(), { once: true });

      ws.on("open", () => {
        logger.info({ roster: options.roster().length }, "monitor socket open");
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
          params?: {
            subscription?: number;
            result?: { value?: { signature?: string; err?: unknown } };
          };
        };

        if (message.id !== undefined) {
          const subject = pending.get(message.id);
          pending.delete(message.id);
          if (subject === undefined) return; // unsubscribe acknowledgement
          if (message.error !== undefined || typeof message.result !== "number") {
            stats.subscribeFailures += 1;
            logger.warn(
              { kind: subject.kind, address: subject.address, err: message.error?.message },
              "subscription rejected",
            );
            return;
          }
          (subject.kind === "mint" ? liveMints : liveRoster).set(subject.address, message.result);
          bySubscription.set(message.result, subject);
          stats.mintSubs = liveMints.size;
          stats.rosterSubs = liveRoster.size;
          return;
        }

        if (message.method !== "logsNotification") return;
        const subscriptionId = message.params?.subscription;
        const value = message.params?.result?.value;
        const signature = value?.signature;
        if (subscriptionId === undefined || typeof signature !== "string") return;
        const subject = bySubscription.get(subscriptionId);
        if (subject === undefined) return;

        const now = Date.now();
        // Failed transactions moved nothing. They are not activity, not a join,
        // and not worth a decode.
        if (value?.err != null) {
          if (subject.kind === "mint") stats.activity += 1;
          return;
        }
        prune(now);

        if (subject.kind === "roster") {
          stats.rosterSeen += 1;
          rosterSigs.set(signature, { wallet: subject.address, at: now });
          const hit = mintSigs.get(signature);
          if (hit !== undefined) join(signature, hit.mint, subject.address);
          return;
        }

        const mint = subject.address;
        stats.activity += 1;
        stats.landed += 1;
        landedCount.set(mint, (landedCount.get(mint) ?? 0) + 1);
        mintSigs.set(signature, { mint, at: now });

        const activity = MintActivitySchema.safeParse({
          kind: "activity", mint, signature, landed: true, observedAt: now,
        });
        if (activity.success) onEvent(activity.data);

        const rosterHit = rosterSigs.get(signature);
        if (rosterHit !== undefined) {
          join(signature, mint, rosterHit.wallet);
          return; // already decoded; no need to spend a sample on it too
        }

        if (shouldSample(mint, now)) {
          lastSampled.set(mint, now);
          stats.samplesTaken += 1;
          void decodeInto(mint, signature, "sample");
        }
      });

      ws.on("error", (error) => finish(error));
      ws.on("close", () => finish());
    });
  }

  return {
    stats,
    held: (): string[] => [...liveMints.keys()],
    async start(signal: AbortSignal): Promise<void> {
      await runWithReconnect(connect, signal, {
        onRetry: (attempt, delayMs, error) =>
          logger.warn({ attempt, delayMs, err: String(error) }, "monitor dropped, reconnecting"),
      });
    },
  };
}
