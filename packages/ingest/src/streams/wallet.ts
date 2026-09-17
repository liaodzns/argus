/**
 * Watch one wallet.
 *
 * `logsSubscribe { mentions: [wallet] }` fires only on transactions that touch
 * the address, which for a person is a few dozen a day rather than the 460 a
 * second the whole pump.fun program does. Each one costs a single
 * `getTransaction`, so the running cost of this file is the number of trades
 * you make.
 *
 * Liveness is measured by ping and pong, not by data arriving.
 *
 * That is the one real difference from the firehose watcher this replaces.
 * There, forty-five seconds of silence meant the stream was dead. Here it means
 * you had lunch. A wallet that is quiet all morning is the normal case, so
 * treating silence as a fault would reconnect endlessly and treating it as
 * health would hide a genuinely dead socket. The websocket's own keepalive is
 * the only honest signal, so it is what gets used.
 */
import WebSocket from "ws";
import type { Logger } from "pino";
import type { StreamEvent } from "@argus/shared";
import { RpcTransactionSchema, decodeSwaps, type SkipReason } from "../decode/swap.js";
import { runWithReconnect } from "./reconnect.js";

/**
 * Mainnet carries version 1 transactions as of 2026-09-17, and asking for a
 * lower ceiling does not downgrade them — the RPC refuses the request outright
 * with "Transaction version (1) is not supported by the requested encoding".
 * Every such fill would be silently invisible.
 */
const MAX_TX_VERSION = 1;

export interface WalletWatcherStats {
  notifications: number;
  fills: number;
  duplicates: number;
  queueDepth: number;
  rpcErrors: number;
  skips: Partial<Record<SkipReason, number>>;
  lastSeenAt: number | null;
}

export interface WalletWatcherOptions {
  wsUrl: string;
  rpcUrl: string;
  /** The wallet that actually signs the trades. For Axiom that is its trading
   *  wallet, not the funding wallet the user would name first. */
  wallet: string;
  logger: Logger;
  onEvent: (event: StreamEvent) => void;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  /** Concurrent getTransaction calls. One wallet rarely needs more than a few,
   *  but a burst must not turn into a burst of requests. */
  concurrency?: number;
}

export function createWalletWatcher(options: WalletWatcherOptions) {
  const { wsUrl, rpcUrl, wallet, logger, onEvent } = options;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
  const concurrency = options.concurrency ?? 4;

  const stats: WalletWatcherStats = {
    notifications: 0, fills: 0, duplicates: 0, queueDepth: 0, rpcErrors: 0, skips: {}, lastSeenAt: null,
  };

  // One wallet does not generate enough signatures to need eviction, but the
  // process is meant to run for weeks and both programs can report the same
  // transaction.
  const seen = new Set<string>();

  /**
   * Throttling does not always arrive as JSON.
   *
   * Helius answers an over-rate request with a 429 whose body is the bare
   * string "Too Many Requests". Calling .json() on that throws a SyntaxError,
   * which looks nothing like rate limiting, so a retry policy that only
   * inspects a parsed JSON-RPC error will not recognise it and every request in
   * the burst fails for the wrong reason. Check the status first.
   */
  async function fetchTransaction(signature: string): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_TX_VERSION }],
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetch(rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      if (response.status === 429 || response.status >= 500) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 80)}`);
      let payload: { result?: unknown; error?: { message: string } };
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        throw new Error(`non-JSON response: ${text.slice(0, 80)}`);
      }
      if (payload.error === undefined) return payload.result;
      if (!/rate|limit|too many/i.test(payload.error.message)) throw new Error(payload.error.message);
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
    throw new Error("getTransaction throttled after 5 attempts");
  }

  // Bounded, because a signature arriving is not a reason to start a request
  // immediately. Your own wallet will never fill this, but pointing the watcher
  // at a busy address otherwise fires hundreds of concurrent fetches and every
  // one of them gets throttled.
  const queue: string[] = [];
  let active = 0;

  function drain(): void {
    while (active < concurrency) {
      const signature = queue.shift();
      if (signature === undefined) return;
      active += 1;
      void handleSignature(signature).finally(() => {
        active -= 1;
        drain();
      });
    }
  }

  async function handleSignature(signature: string): Promise<void> {
    try {
      const raw = await fetchTransaction(signature);
      if (raw === null || raw === undefined) return;
      const tx = RpcTransactionSchema.parse(raw);
      const { trades, skipped } = decodeSwaps(tx);
      if (skipped !== null) {
        stats.skips[skipped] = (stats.skips[skipped] ?? 0) + 1;
        return;
      }
      for (const trade of trades) {
        // Other people's legs can ride along in a routed transaction; only the
        // watched wallet's own fill is a position change.
        if (trade.trader !== wallet) continue;
        stats.fills += 1;
        stats.lastSeenAt = trade.blockTime;
        onEvent(trade);
      }
    } catch (error) {
      stats.rpcErrors += 1;
      logger.warn({ signature, err: String(error) }, "could not read transaction");
    }
  }

  function connect(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      let pongTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (pingTimer !== undefined) clearInterval(pingTimer);
        if (pongTimer !== undefined) clearTimeout(pongTimer);
        ws.removeAllListeners();
        // terminate, not close: a socket that has stopped answering may never
        // complete a closing handshake, and waiting for one is how you hang.
        ws.terminate();
        if (error === undefined) resolve();
        else reject(error);
      };

      signal.addEventListener("abort", () => finish(), { once: true });

      ws.on("open", () => {
        ws.send(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "logsSubscribe",
          params: [{ mentions: [wallet] }, { commitment: "confirmed" }],
        }));
        pingTimer = setInterval(() => {
          if (pongTimer !== undefined) return; // one in flight is enough
          pongTimer = setTimeout(() => {
            finish(new Error(`no pong within ${pongTimeoutMs}ms; socket is dead`));
          }, pongTimeoutMs);
          pongTimer.unref();
          ws.ping();
        }, pingIntervalMs);
        pingTimer.unref();
        logger.info({ wallet }, "watching wallet");
      });

      ws.on("pong", () => {
        if (pongTimer !== undefined) clearTimeout(pongTimer);
        pongTimer = undefined;
      });

      ws.on("message", (data: WebSocket.RawData) => {
        let frame: unknown;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        const message = frame as {
          method?: string;
          params?: { result?: { value?: { signature?: string; err?: unknown } } };
        };
        if (message.method !== "logsNotification") return;
        const value = message.params?.result?.value;
        const signature = value?.signature;
        if (typeof signature !== "string") return;
        stats.notifications += 1;
        if (value?.err != null) return;                 // failed on chain
        if (seen.has(signature)) { stats.duplicates += 1; return; }
        seen.add(signature);
        queue.push(signature);
        stats.queueDepth = queue.length;
        drain();
      });

      ws.on("error", (error) => finish(error));
      ws.on("close", () => finish());
    });
  }

  return {
    stats,
    async start(signal: AbortSignal): Promise<void> {
      await runWithReconnect(connect, signal, {
        onRetry: (attempt, delayMs, error) => {
          logger.warn({ attempt, delayMs, err: String(error) }, "wallet stream dropped, reconnecting");
        },
      });
    },
  };
}
