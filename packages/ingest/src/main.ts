/**
 * Ingest entry point.
 *
 * Three sources, all onto the bus. The wallet watcher decodes your own fills.
 * The launch watcher reports every new pump.fun token so the engine can match
 * them against what you hold. The monitor holds a log subscription per mint the
 * engine asks about, reporting flow for free and sampling prices sparingly.
 *
 * The firehose that read every pump.fun trade is gone; see PIVOT.md for why.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { configPaths, loadEnv, watchThresholds } from "@argus/shared/config";
import { createWalletWatcher } from "./streams/wallet.js";
import { createLaunchWatcher } from "./streams/launches.js";
import { createMonitor } from "./streams/monitor.js";
import { createPublisher } from "./publish.js";

function readEnv(): ReturnType<typeof loadEnv> {
  try {
    return loadEnv(process.env, { requireChainSource: true });
  } catch (error) {
    if (error instanceof ZodError) {
      process.stderr.write("Invalid environment. Copy .env.example to .env and fill in:\n");
      for (const issue of error.issues) {
        process.stderr.write(`  ${issue.path.join(".") || "(root)"}: ${issue.message}\n`);
      }
      process.exit(1);
    }
    throw error;
  }
}

const env = readEnv();

const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  ...(process.stdout.isTTY
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } } }
    : {}),
});

if (env.WATCHED_WALLET === undefined) {
  process.stderr.write("WATCHED_WALLET is not set. Put your Axiom trading wallet in .env.\n");
  process.exit(1);
}
const wallet = env.WATCHED_WALLET;

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
redis.on("error", (error: Error) => logger.debug({ err: error.message }, "redis error"));

// The bus is where positions will be read from at step 2. Until then a dead
// Redis should not stop you seeing your own fills — this is a tool you leave
// running, and infrastructure being down is not a reason to go blind.
let publisher: ReturnType<typeof createPublisher> | null = null;
try {
  await redis.connect();
  await redis.ping();
  publisher = createPublisher({ redis, logger, source: "wallet" });
  publisher.start();
} catch {
  logger.warn({ redis: env.REDIS_URL }, "redis unreachable; printing fills only, not publishing");
}

// Sampling rates are operator tuning, so they are hot-reloaded like everything
// else rather than fixed at start.
const paths = configPaths(env);
let thresholds: ReturnType<typeof watchThresholds>;
try {
  thresholds = watchThresholds(paths.thresholds, {
    onError: (error) =>
      logger.error({ err: String(error) }, "thresholds reload failed; keeping previous"),
  });
} catch (error) {
  process.stderr.write(`Could not load ${paths.thresholds}\n  ${String(error)}\n`);
  process.exit(1);
}

const controller = new AbortController();
const watcher = createWalletWatcher({
  wsUrl: env.SOLANA_WS_URL,
  rpcUrl: env.SOLANA_RPC_URL,
  wallet,
  logger,
  onEvent: (event) => {
    publisher?.publish(event);
    if (event.kind !== "trade") return;
    logger.info(
      {
        side: event.side,
        sol: (event.solLamports / 1e9).toFixed(4),
        mint: event.mint,
        venue: event.venue,
        slot: event.slot,
      },
      event.side === "buy" ? "BUY" : "SELL",
    );
  },
});

// Your fills are rare, so an empty heartbeat is the normal state and not a
// sign of trouble. It exists to show the socket is still attached.
const heartbeat = setInterval(() => {
  logger.info(
    {
      wallet: watcher.stats,
      launches: launches.stats,
      monitor: { ...monitor.stats, held: monitor.held().length },
      publishing: publisher !== null,
    },
    "watching",
  );
}, 60_000);
heartbeat.unref();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    thresholds.close();
    controller.abort();
    void (async () => {
      await publisher?.close();
      await redis.quit().catch(() => undefined);
      process.exit(0);
    })();
  });
}

const launches = createLaunchWatcher({
  logger,
  onEvent: (event) => {
    publisher?.publish(event);
    logger.debug({ mint: event.mint, symbol: event.symbol, name: event.name }, "launch");
  },
});

const monitor = createMonitor({
  wsUrl: env.SOLANA_WS_URL,
  rpcUrl: env.SOLANA_RPC_URL,
  redis,
  logger,
  onEvent: (event) => publisher?.publish(event),
  sampleIntervalMs: () => thresholds.current.monitor.price_sample_ms,
  maxPriced: () => thresholds.current.monitor.max_priced,
  refreshMs: thresholds.current.monitor.set_refresh_ms,
});

logger.info({ wallet, rpc: env.SOLANA_WS_URL.split("?")[0] }, "argus ingest starting");

// Both run until aborted. Either failing independently is the point of giving
// them separate reconnect loops, so a dead launch feed cannot take your fills
// down with it.
await Promise.all([
  watcher.start(controller.signal),
  launches.start(controller.signal),
  monitor.start(controller.signal),
]);
