/**
 * Socket fan-out.
 *
 * One Redis subscription feeds every browser. The alternative, a subscription
 * per client, multiplies bus traffic by the number of tabs somebody happens to
 * have open, which is the wrong thing to scale with.
 *
 * Frames are relayed as they arrive. The gateway validates rather than
 * reshapes: if something malformed reaches the bus, it dies here instead of on
 * a chart axis.
 */
import { Redis } from "ioredis";
import type { WebSocket } from "ws";
import { CHANNELS, ServerFrameSchema, type ServerFrame } from "@argus/shared";

/**
 * Structural, so this takes either a pino logger or Fastify's own. They are
 * compatible in every way this file uses and incompatible in their full types.
 */
export interface FanOutLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
}

export interface FanOutOptions {
  redisUrl: string;
  logger: FanOutLogger;
}

export function createFanOut(options: FanOutOptions) {
  const { logger } = options;
  const clients = new Set<WebSocket>();
  const sub = new Redis(options.redisUrl, { maxRetriesPerRequest: null });
  const stats = { clients: 0, alerts: 0, ticks: 0, dropped: 0, malformed: 0 };

  sub.on("error", (error: Error) => logger.error({ err: error.message }, "gateway redis error"));

  function broadcast(frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const client of clients) {
      // A browser on a slow link must not become the thing that stalls the
      // process. OPEN is the only state worth writing to.
      if (client.readyState !== 1) continue;
      try {
        client.send(payload);
      } catch (error) {
        stats.dropped += 1;
        logger.debug({ err: String(error) }, "send failed; dropping client");
        clients.delete(client);
      }
    }
  }

  return {
    stats,

    async start(): Promise<void> {
      await sub.subscribe(CHANNELS.alerts, CHANNELS.ticks);
      sub.on("message", (channel: string, payload: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          stats.malformed += 1;
          return;
        }
        const type = channel === CHANNELS.alerts ? "alert" : "tick";
        const frame = ServerFrameSchema.safeParse({ type, data: parsed });
        if (!frame.success) {
          stats.malformed += 1;
          logger.warn({ channel, issues: frame.error.issues.length }, "dropped malformed frame");
          return;
        }
        if (type === "alert") stats.alerts += 1;
        else stats.ticks += 1;
        broadcast(frame.data);
      });
      logger.info({ channels: [CHANNELS.alerts, CHANNELS.ticks] }, "fan-out subscribed");
    },

    add(client: WebSocket): void {
      clients.add(client);
      stats.clients = clients.size;
      client.on("close", () => {
        clients.delete(client);
        stats.clients = clients.size;
      });
      client.on("error", () => {
        clients.delete(client);
        stats.clients = clients.size;
      });
    },

    async close(): Promise<void> {
      for (const client of clients) client.close();
      clients.clear();
      await sub.quit();
    },
  };
}
