/**
 * Engine entry point.
 *
 * Consume trades, maintain the rolling windows, and publish an alert plus a
 * stream of panel ticks when a watched wallet buys.
 *
 * Still no safety filters and no vamp logic. The score is a weight-normalised
 * mean over the one signal that exists, which is a real number rather than a
 * placeholder, and it widens to the full signal set at step 7 without changing
 * shape.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { CHANNELS, KEYS, StreamEventSchema, type TradeEvent } from "@argus/shared";
import {
  configPaths,
  loadEnv,
  watchKolWallets,
  watchThresholds,
  type Thresholds,
} from "@argus/shared/config";
import { createWindows, encodeTrade } from "./windows.js";
import { buildRoster, observeKolTrade, type KolRoster } from "./signals/kol.js";
import { createEnricher } from "./enrich.js";
import { buildAlert, claimAlertSlot } from "./alerts.js";
import { buildTick } from "./ticks.js";

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  ...(process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
});

function fail(message: string, detail?: string): never {
  process.stderr.write(`${message}\n`);
  if (detail !== undefined) process.stderr.write(`${detail}\n`);
  process.exit(1);
}

let env: ReturnType<typeof loadEnv>;
try {
  env = loadEnv();
} catch (error) {
  if (!(error instanceof ZodError)) throw error;
  fail(
    "Invalid environment. Copy .env.example to .env and fill in:",
    error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
  );
}

const paths = configPaths(env);

// Both files are watched, so tuning and roster changes take effect mid-session.
// The first load throws on purpose: starting against a broken config and
// discovering it an hour later is worse than not starting.
let thresholdsHandle: ReturnType<typeof watchThresholds>;
let rosterHandle: ReturnType<typeof watchKolWallets>;
try {
  thresholdsHandle = watchThresholds(paths.thresholds, {
    onError: (error) => logger.error({ err: String(error) }, "thresholds reload failed; keeping previous"),
  });
  rosterHandle = watchKolWallets(paths.kolWallets, {
    onError: (error) => logger.error({ err: String(error) }, "roster reload failed; keeping previous"),
  });
} catch (error) {
  fail(`Could not load config from ${paths.dir}`, `  ${String(error)}`);
}

let roster: KolRoster = buildRoster(rosterHandle.current.wallets);
rosterHandle.onChange((next) => {
  roster = buildRoster(next.wallets);
  logger.info({ wallets: roster.size }, "roster reloaded");
});

const windowMs = (t: Thresholds): number => t.windows.short * 1000;
thresholdsHandle.onChange((next) => {
  logger.info({ shortWindowSeconds: next.windows.short }, "thresholds reloaded");
});

// ioredis puts a connection into subscriber mode, where it can issue nothing
// else, so the window writes need their own client.
const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
for (const [name, client] of [["sub", sub], ["cmd", redis]] as const) {
  client.on("error", (error: Error) => logger.error({ client: name, err: error.message }, "redis error"));
}

try {
  await redis.ping();
} catch (error) {
  fail(
    `Cannot reach redis at ${env.REDIS_URL}`,
    "  Start it with `docker compose up -d redis`.",
  );
}

const windows = createWindows({ redis });
const enricher = createEnricher({ redis, logger, rpcUrl: env.SOLANA_RPC_URL });

const stats = {
  received: 0,
  malformed: 0,
  kolBuys: 0,
  alerts: 0,
  suppressedByCooldown: 0,
  unresolvedMeta: 0,
  ticks: 0,
  lastEventAt: 0,
};

/**
 * Mints with a panel open, and the score last published for each.
 *
 * Ticks go only to these. Publishing a tick for every pump.fun trade would
 * swamp the socket with tokens nobody is looking at. The real panel budget,
 * with eviction and pinning, is step 8; this is just the set that has alerted
 * recently.
 */
const active = new Map<string, { expiresAt: number; score: number }>();

async function publish(channel: string, payload: unknown): Promise<void> {
  await redis.publish(channel, JSON.stringify(payload));
}

async function handleTrade(trade: TradeEvent): Promise<void> {
  const thresholds = thresholdsHandle.current;
  const shortMs = windowMs(thresholds);

  // Every trade feeds the windows, watched or not: volume and buyer counts are
  // about the token, not about who we happen to follow.
  await Promise.all([
    windows.record(KEYS.tradeWindow(trade.mint), encodeTrade({
      signature: trade.signature, side: trade.side,
      solLamports: trade.solLamports, trader: trade.trader,
    }), trade.blockTime, shortMs),
    trade.side === "buy"
      ? windows.record(KEYS.buyerWindow(trade.mint), trade.trader, trade.blockTime, shortMs)
      : Promise.resolve(),
  ]);

  const hit = await observeKolTrade(trade, roster, windows, shortMs);
  if (hit !== null) {
    stats.kolBuys += 1;
    if (await claimAlertSlot(redis, trade.mint, thresholds.alerting.cooldown_seconds)) {
      const earliestEventAt =
        (await windows.earliest(KEYS.kolWindow(trade.mint), trade.blockTime, shortMs)) ??
        trade.blockTime;
      const meta = await enricher.resolve(trade.mint, earliestEventAt);
      if (meta === null) {
        // Anticipates the step 7 safety rule: a panel with no name on it is not
        // worth the space. Counted rather than silently dropped.
        stats.unresolvedMeta += 1;
        logger.warn({ mint: trade.mint }, "no metadata; not alerting");
      } else {
        const addresses = await windows.members(KEYS.kolWindow(trade.mint), trade.blockTime, shortMs);
        const kols = addresses.map((a) => roster.lookup(a)).filter((w) => w !== undefined);
        const alert = buildAlert({
          trade, meta, kols,
          distinctKols: hit.distinctInWindow,
          earliestEventAt,
          thresholds,
        });
        await publish(CHANNELS.alerts, alert);
        active.set(trade.mint, {
          expiresAt: trade.blockTime + thresholds.wall.panel_ttl_seconds * 1000,
          score: alert.score,
        });
        stats.alerts += 1;
        logger.info(
          {
            mint: alert.mint, symbol: alert.meta.symbol, score: alert.score.toFixed(1),
            kols: alert.kols.map((k) => k.label), distinct: hit.distinctInWindow,
            latencyMs: alert.triggeredAt - alert.earliestEventAt,
          },
          "ALERT",
        );
      }
    } else {
      stats.suppressedByCooldown += 1;
    }
  }

  const panel = active.get(trade.mint);
  if (panel === undefined) return;
  if (trade.blockTime > panel.expiresAt) {
    active.delete(trade.mint);
    return;
  }
  const tick = await buildTick({ trade, windows, shortWindowMs: shortMs, score: panel.score });
  await publish(CHANNELS.ticks, tick);
  stats.ticks += 1;
}

/** One promise chain per mint, deleted once it drains. */
const inFlight = new Map<string, Promise<void>>();

await sub.subscribe(CHANNELS.trades);
sub.on("message", (_channel: string, payload: string) => {
  stats.received += 1;
  // parse, never cast. A malformed event that reaches a window poisons it, and
  // the damage surfaces minutes later somewhere unrelated.
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    stats.malformed += 1;
    return;
  }
  const result = StreamEventSchema.safeParse(json);
  if (!result.success) {
    stats.malformed += 1;
    logger.warn({ issues: result.error.issues.length }, "dropped malformed event");
    return;
  }
  const event = result.data;
  if (event.kind !== "trade") return;
  stats.lastEventAt = event.blockTime;

  // Serialised per mint. Two trades on one token would otherwise interleave
  // between a window write and the read that follows it, and the distinct
  // counts that come back would depend on which promise resolved first.
  const previous = inFlight.get(event.mint) ?? Promise.resolve();
  const next = previous
    .then(() => handleTrade(event))
    .catch((error: unknown) => {
      logger.error({ err: String(error), mint: event.mint }, "trade handling failed");
    })
    .finally(() => {
      if (inFlight.get(event.mint) === next) inFlight.delete(event.mint);
    });
  inFlight.set(event.mint, next);
});

const heartbeat = setInterval(() => {
  logger.info(
    { ...stats, wallets: roster.size, activePanels: active.size, meta: enricher.stats },
    "engine stats",
  );
}, 15_000);
heartbeat.unref();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    thresholdsHandle.close();
    rosterHandle.close();
    void (async () => {
      await sub.quit();
      await redis.quit();
      process.exit(0);
    })();
  });
}

logger.info(
  {
    wallets: roster.size,
    shortWindowSeconds: thresholdsHandle.current.windows.short,
    channel: CHANNELS.trades,
    publishes: [CHANNELS.alerts, CHANNELS.ticks],
  },
  "engine listening",
);
