/**
 * Engine entry point.
 *
 * Step 2 scope: turn your fills into watches. A buy opens one, your sell closes
 * it, and the window closing closes it. Nothing else yet.
 *
 * Narrative capture and clone matching land at step 3, bonding curve monitoring
 * at step 4, and the roster signal that actually fires an alert at step 5. The
 * modules for those are still in this package from v1 and are deliberately not
 * wired up.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { CHANNELS, StreamEventSchema } from "@argus/shared";
import { configPaths, loadEnv, watchThresholds } from "@argus/shared/config";
import { createWatches } from "./watches.js";

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

// The first load throws on purpose. Starting against a broken config and
// finding out an hour later is worse than not starting.
let thresholds: ReturnType<typeof watchThresholds>;
try {
  thresholds = watchThresholds(paths.thresholds, {
    onError: (error) =>
      logger.error({ err: String(error) }, "thresholds reload failed; keeping previous"),
  });
} catch (error) {
  fail(`Could not load ${paths.thresholds}`, `  ${String(error)}`);
}
thresholds.onChange((next) =>
  logger.info({ windowSeconds: next.watch.window_seconds }, "thresholds reloaded"),
);

const watches = createWatches({
  windowMs: () => thresholds.current.watch.window_seconds * 1000,
  onOpen: (watch) =>
    logger.info(
      {
        mint: watch.mint,
        sol: (watch.entrySolLamports / 1e9).toFixed(4),
        windowSeconds: (watch.expiresAt - watch.openedAt) / 1000,
      },
      "WATCH OPEN",
    ),
  onClose: (watch, reason) =>
    logger.info(
      { mint: watch.mint, reason, heldSeconds: Math.round((Date.now() - watch.openedAt) / 1000) },
      "WATCH CLOSED",
    ),
});

const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
sub.on("error", (error: Error) => logger.error({ err: error.message }, "redis error"));

try {
  await sub.ping();
} catch {
  fail(`Cannot reach redis at ${env.REDIS_URL}`, "  Start it with `docker compose up -d redis`.");
}

const stats = { received: 0, malformed: 0 };

await sub.subscribe(CHANNELS.trades);
sub.on("message", (_channel: string, payload: string) => {
  stats.received += 1;
  // parse, never cast. A malformed event that opens a watch on garbage is worse
  // than one that is dropped and counted.
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
  if (result.data.kind !== "trade") return;
  watches.observe(result.data);
});

// Wall clock here, on purpose: "three minutes since I bought" is elapsed real
// time. Replay must drive expiry from event time instead, which is why sweep
// takes the clock as an argument rather than reading one.
const sweeper = setInterval(() => watches.sweep(Date.now()), 5_000);
sweeper.unref();

const heartbeat = setInterval(() => {
  logger.info({ ...stats, ...watches.stats, openWatches: watches.size }, "engine stats");
}, 60_000);
heartbeat.unref();

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Counters on the way out as well as on the heartbeat, so a short run
    // still reports what it saw instead of nothing.
    logger.info(
      { signal, ...stats, ...watches.stats, openWatches: watches.size },
      "shutting down",
    );
    clearInterval(sweeper);
    clearInterval(heartbeat);
    thresholds.close();
    void sub.quit().then(() => process.exit(0));
  });
}

logger.info(
  {
    channel: CHANNELS.trades,
    windowSeconds: thresholds.current.watch.window_seconds,
    config: paths.thresholds,
  },
  "engine listening",
);
