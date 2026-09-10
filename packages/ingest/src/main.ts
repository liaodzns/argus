/**
 * Ingest entry point.
 *
 * Step 2 scope: subscribe, decode, parse, print. No Redis and no filtering
 * beyond program id — this process stays dumb on purpose, because that is what
 * keeps it fast and lets it restart without taking anything else down.
 */
import pino from "pino";
import { ZodError } from "zod";
import { loadEnv } from "@argus/shared/config";
import { createHeliusLogsSource } from "./streams/helius-logs.js";

// Loud, but readable. A stack trace through zod internals tells an operator
// nothing about which variable they forgot to set.
function readEnv(): ReturnType<typeof loadEnv> {
  try {
    return loadEnv();
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

const controller = new AbortController();
const source = createHeliusLogsSource({
  wsUrl: env.SOLANA_WS_URL,
  rpcUrl: env.SOLANA_RPC_URL,
  logger,
  onEvent: (event) => {
    if (event.kind !== "trade") return;
    logger.info(
      {
        mint: event.mint,
        side: event.side,
        sol: (event.solLamports / 1e9).toFixed(4),
        tokens: (Number(event.tokenAmount) / 10 ** event.decimals).toFixed(0),
        trader: event.trader.slice(0, 8),
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
  logger.info({ ...source.stats }, "ingest stats");
}, 15_000);
heartbeat.unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    controller.abort();
    setTimeout(() => process.exit(0), 250).unref();
  });
}

logger.info({ source: env.INGEST_SOURCE, ws: env.SOLANA_WS_URL.split("?")[0] }, "ingest starting");
await source.start(controller.signal);
