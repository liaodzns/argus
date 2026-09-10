/**
 * Trade source: Helius standard WebSocket RPC.
 *
 * `logsSubscribe` pushes a signature and a slot for every transaction that
 * mentions one of the pump.fun programs. It does not carry the transaction, so
 * each signature costs one `getTransaction` to reach the balance deltas the
 * decoder needs.
 *
 * That per-signature round trip is the known cost of this source and the reason
 * Step 10 replaces it with LaserStream, which streams whole transactions. The
 * decoder behind this interface does not change when that happens.
 */
import WebSocket from "ws";
import type { Logger } from "pino";
import { WATCHED_PROGRAMS, type StreamEvent } from "@argus/shared";
import { RpcTransactionSchema, decodeSwaps, type SkipReason } from "../decode/swap.js";
import { SilenceWatchdog, runWithReconnect } from "./reconnect.js";

export interface SourceStats {
  notifications: number;
  decoded: number;
  trades: number;
  duplicates: number;
  rpcErrors: number;
  queueDepth: number;
  skips: Record<SkipReason, number>;
}

export interface HeliusLogsOptions {
  wsUrl: string;
  rpcUrl: string;
  logger: Logger;
  onEvent: (event: StreamEvent) => void;
  /** Concurrent getTransaction calls. Above the plan's rate limit this only
   *  converts throughput into 429s, so it is deliberately modest. */
  concurrency?: number;
  /** No frame for this long means the connection is dead, not the market. */
  silenceMs?: number;
}

const emptySkips = (): Record<SkipReason, number> => ({
  failed_tx: 0,
  no_block_time: 0,
  no_watched_program: 0,
  no_candidate_mint: 0,
  no_trader: 0,
  zero_sol: 0,
});

export function createHeliusLogsSource(options: HeliusLogsOptions) {
  const { wsUrl, rpcUrl, logger, onEvent } = options;
  const concurrency = options.concurrency ?? 6;
  const silenceMs = options.silenceMs ?? 45_000;

  const stats: SourceStats = {
    notifications: 0, decoded: 0, trades: 0, duplicates: 0,
    rpcErrors: 0, queueDepth: 0, skips: emptySkips(),
  };

  // Both program subscriptions fire for a transaction that touches both, and a
  // migration touches both by definition. Bounded because this process is
  // meant to run for days.
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const SEEN_CAP = 100_000;
  const remember = (signature: string): boolean => {
    if (seen.has(signature)) return false;
    seen.add(signature);
    seenOrder.push(signature);
    if (seenOrder.length > SEEN_CAP) {
      const evicted = seenOrder.splice(0, SEEN_CAP / 2);
      for (const s of evicted) seen.delete(s);
    }
    return true;
  };

  const queue: string[] = [];
  let active = 0;
  let rpcId = 0;

  async function fetchTransaction(signature: string): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "getTransaction",
      params: [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = (await response.json()) as { result?: unknown; error?: { message: string } };
      if (payload.error === undefined) return payload.result;
      if (!/rate|limit|too many/i.test(payload.error.message)) throw new Error(payload.error.message);
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw new Error("getTransaction rate limited after 4 attempts");
  }

  async function drain(): Promise<void> {
    while (active < concurrency) {
      const signature = queue.shift();
      if (signature === undefined) return;
      active += 1;
      stats.queueDepth = queue.length;
      void (async () => {
        try {
          const raw = await fetchTransaction(signature);
          if (raw === null || raw === undefined) return;
          const tx = RpcTransactionSchema.parse(raw);
          const { trades, skipped } = decodeSwaps(tx);
          stats.decoded += 1;
          if (skipped !== null) stats.skips[skipped] += 1;
          for (const trade of trades) {
            stats.trades += 1;
            onEvent(trade);
          }
        } catch (error) {
          stats.rpcErrors += 1;
          logger.debug({ signature, err: String(error) }, "transaction fetch or decode failed");
        } finally {
          active -= 1;
          void drain();
        }
      })();
    }
  }

  function connect(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        watchdog.stop();
        ws.removeAllListeners();
        ws.terminate();
        if (error === undefined) resolve();
        else reject(error);
      };

      // terminate(), not close(): a mute socket may never complete a closing
      // handshake, and waiting for one is how you hang forever.
      const watchdog = new SilenceWatchdog(silenceMs, () => {
        finish(new Error(`no frames for ${silenceMs}ms; treating stream as dead`));
      });

      signal.addEventListener("abort", () => finish(), { once: true });

      ws.on("open", () => {
        WATCHED_PROGRAMS.forEach((programId, i) => {
          ws.send(JSON.stringify({
            jsonrpc: "2.0",
            id: i + 1,
            method: "logsSubscribe",
            params: [{ mentions: [programId] }, { commitment: "confirmed" }],
          }));
        });
        watchdog.kick();
        logger.info({ programs: WATCHED_PROGRAMS.length }, "subscribed to program logs");
      });

      ws.on("message", (data: WebSocket.RawData) => {
        watchdog.kick();
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
        // Failed transactions are delivered too. Dropping them here saves an
        // RPC call the decoder would only throw away.
        if (value?.err != null) { stats.skips.failed_tx += 1; return; }
        if (!remember(signature)) { stats.duplicates += 1; return; }
        queue.push(signature);
        stats.queueDepth = queue.length;
        void drain();
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
          logger.warn({ attempt, delayMs, err: String(error) }, "stream dropped, reconnecting");
        },
      });
    },
  };
}
