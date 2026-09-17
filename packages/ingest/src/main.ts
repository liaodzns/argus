/**
 * Ingest entry point.
 *
 * Subscribe, decode, parse, publish. No scoring, no enrichment, no filtering
 * beyond program id — this process stays dumb on purpose, because that is what
 * keeps it fast and lets it restart without taking anything else down.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { loadEnv } from "@argus/shared/config";
import { createHeliusLogsSource } from "./streams/helius-logs.js";
import { createPublisher } from "./publish.js";

// Loud, but readable. A stack trace through zod internals tells an operator
// nothing about which variable they forgot to set.
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

// Pretty output only when a human is watching. Piped or redirected, it stays
// newline-delimited JSON so the latency histogram is greppable later.
const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  ...(process.stdout.isTTY
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
      }
    : {}),
});

if (env.INGEST_SOURCE !== "helius_logs") {
  logger.error(
    { source: env.INGEST_SOURCE },
    "only helius_logs is implemented; laserstream lands at step 10",
  );
  process.exit(1);
}

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on("error", (error: Error) => logger.error({ err: error.message }, "redis error"));
redis.on("end", () => logger.warn("redis connection closed"));

// Refuse to start against an unreachable bus. Buffering into the void while
// the wall stays empty is the failure mode that looks like a quiet market.
try {
  await redis.ping();
} catch (error) {
  logger.error({ err: String(error), redis: env.REDIS_URL }, "cannot reach redis; start it with `docker compose up -d redis`");
  process.exit(1);
}

const publisher = createPublisher({ redis, logger, source: env.INGEST_SOURCE });
publisher.start();

const controller = new AbortController();
const source = createHeliusLogsSource({
  wsUrl: env.SOLANA_WS_URL,
  rpcUrl: env.SOLANA_RPC_URL,
  logger,
  onEvent: (event) => {
    publisher.publish(event);
    if (event.kind !== "trade") return;
    logger.debug(
      {
        mint: event.mint,
        side: event.side,
        sol: (event.solLamports / 1e9).toFixed(4),
        venue: event.venue,
        slot: event.slot,
      },
      "trade",
    );
  },
});

// A stream that has delivered nothing is indistinguishable from a market that
// has done nothing, so report the counters even when they are all zero.
const heartbeat = setInterval(() => {
  logger.info({ stream: source.stats, publish: publisher.stats }, "ingest stats");
}, 15_000);
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
      await publisher.close();
      await redis.quit();
      process.exit(0);
    })();
  });
}

logger.info(
  { source: env.INGEST_SOURCE, ws: env.SOLANA_WS_URL.split("?")[0], redis: env.REDIS_URL },
  "ingest starting",
);
await source.start(controller.signal);
