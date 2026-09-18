/**
 * New token launches.
 *
 * PumpPortal's free `subscribeNewToken` feed, roughly 31 launches a minute, no
 * API key. Each frame carries the mint, name, symbol, metadata uri and creator,
 * which is everything narrative matching needs.
 *
 * The feed is not pump.fun only: about a quarter of launches come from bonk.fun
 * and carry no bonding curve at all. An earlier version required one and
 * therefore dropped them, which meant a quarter of possible clones were never
 * compared against anything you hold.
 *
 * This is the source that was dropped at v1 step 2 for having no trades. It was
 * never bad at creations, and for creations it costs nothing at all.
 *
 * Note the liveness inversion against the wallet watcher next door. There,
 * silence means you had lunch and must never be treated as a fault. Here, at
 * 31 a minute, silence means the socket died — so this one does get the
 * watchdog.
 */
import WebSocket from "ws";
import type { Logger } from "pino";
import { MintEventSchema, type MintEvent } from "@argus/shared";
import { SilenceWatchdog, runWithReconnect } from "./reconnect.js";

const PUMPPORTAL_WS = "wss://pumpportal.fun/api/data";

export interface LaunchWatcherStats {
  launches: number;
  malformed: number;
  duplicates: number;
}

export interface LaunchWatcherOptions {
  logger: Logger;
  /** Narrowed to MintEvent: this source emits nothing else. */
  onEvent: (event: MintEvent) => void;
  wsUrl?: string;
  /** No frame for this long means the feed is dead, not that nobody launched. */
  silenceMs?: number;
}

export function createLaunchWatcher(options: LaunchWatcherOptions) {
  const { logger, onEvent } = options;
  const wsUrl = options.wsUrl ?? PUMPPORTAL_WS;
  const silenceMs = options.silenceMs ?? 60_000;

  const stats: LaunchWatcherStats = { launches: 0, malformed: 0, duplicates: 0 };

  // Bounded: a reconnect replays nothing, but the feed occasionally repeats a
  // frame and a duplicate launch would be matched twice.
  const seen = new Set<string>();
  const order: string[] = [];
  const CAP = 20_000;

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

      const watchdog = new SilenceWatchdog(silenceMs, () => {
        finish(new Error(`no launches for ${silenceMs}ms; feed is dead`));
      });

      signal.addEventListener("abort", () => finish(), { once: true });

      ws.on("open", () => {
        ws.send(JSON.stringify({ method: "subscribeNewToken" }));
        watchdog.kick();
        logger.info("watching new launches");
      });

      ws.on("message", (data: WebSocket.RawData) => {
        watchdog.kick();
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }
        const message = frame as {
          message?: string;
          txType?: string;
          mint?: unknown;
          signature?: unknown;
          traderPublicKey?: unknown;
          bondingCurveKey?: unknown;
          name?: unknown;
          symbol?: unknown;
          uri?: unknown;
          pool?: unknown;
        };
        // Subscription acknowledgements and plan-gating notices arrive on the
        // same socket.
        if (typeof message.message === "string") {
          logger.info({ notice: message.message }, "launch feed said");
          return;
        }
        if (message.txType !== "create") return;
        if (typeof message.mint === "string") {
          if (seen.has(message.mint)) {
            stats.duplicates += 1;
            return;
          }
          seen.add(message.mint);
          order.push(message.mint);
          if (order.length > CAP) for (const m of order.splice(0, CAP / 2)) seen.delete(m);
        }

        const parsed = MintEventSchema.safeParse({
          kind: "mint",
          mint: message.mint,
          signature: message.signature,
          creator: message.traderPublicKey,
          // Absent on launchpads without a curve, such as bonk.fun.
          bondingCurve: message.bondingCurveKey ?? null,
          name: message.name ?? "",
          symbol: message.symbol ?? "",
          uri: message.uri ?? "",
          pool: typeof message.pool === "string" ? message.pool : "unknown",
          // Wall clock, and the contract says so. This feed has no chain
          // timestamp; pretending otherwise would put a fabricated block time
          // into a rolling window somewhere downstream.
          observedAt: Date.now(),
        });
        if (!parsed.success) {
          stats.malformed += 1;
          logger.debug({ issues: parsed.error.issues.length }, "dropped malformed launch");
          return;
        }
        stats.launches += 1;
        onEvent(parsed.data);
      });

      ws.on("error", (error) => finish(error));
      ws.on("close", () => finish());
    });
  }

  return {
    stats,
    async start(signal: AbortSignal): Promise<void> {
      await runWithReconnect(connect, signal, {
        onRetry: (attempt, delayMs, error) =>
          logger.warn({ attempt, delayMs, err: String(error) }, "launch feed dropped, reconnecting"),
      });
    },
  };
}
