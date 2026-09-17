/**
 * Ingest entry point.
 *
 * Watches one wallet, decodes its fills, prints them and puts them on the bus.
 * Nothing else. The firehose that read every pump.fun trade is gone; see
 * PIVOT.md for why.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { loadEnv } from "@argus/shared/config";
import { createWalletWatcher } from "./streams/wallet.js";
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
  logger.info({ ...watcher.stats, publishing: publisher !== null }, "watching");
}, 60_000);
heartbeat.unref();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    controller.abort();
    void (async () => {
      await publisher?.close();
      await redis.quit().catch(() => undefined);
      process.exit(0);
    })();
  });
}

logger.info({ wallet, rpc: env.SOLANA_WS_URL.split("?")[0] }, "argus ingest starting");
await watcher.start(controller.signal);
