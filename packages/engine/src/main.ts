/**
 * Engine entry point.
 *
 * Step 3 scope: your fills open watches, each watch learns what it holds, and
 * every new pump.fun launch is matched against the open ones.
 *
 * Matching is deliberately permissive. Step 5's roster signal is the strict
 * gate, so a false positive here costs one wasted bonding curve subscription
 * while a false negative is a missed vamp. Tune toward recall.
 *
 * Bonding curve monitoring lands at step 4 and the alert at step 5.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { CHANNELS, StreamEventSchema, type MintEvent } from "@argus/shared";
import { configPaths, loadEnv, watchThresholds } from "@argus/shared/config";
import { createWatches } from "./watches.js";
import { createEnricher } from "./enrich.js";
import { matchNarrative } from "./narrative.js";

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
  onOpen: (watch) => {
    logger.info(
      {
        mint: watch.mint,
        sol: (watch.entrySolLamports / 1e9).toFixed(4),
        windowSeconds: (watch.expiresAt - watch.openedAt) / 1000,
      },
      "WATCH OPEN",
    );
    void describe(watch.mint, watch.openedAt);
  },
  onClose: (watch, reason) =>
    logger.info(
      { mint: watch.mint, reason, heldSeconds: Math.round((Date.now() - watch.openedAt) / 1000) },
      "WATCH CLOSED",
    ),
});

// Subscriber mode locks a connection to nothing else, so enrichment needs its
// own client for the metadata cache.
const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
for (const [name, client] of [["sub", sub], ["cmd", redis]] as const) {
  client.on("error", (error: Error) => logger.error({ client: name, err: error.message }, "redis error"));
}

try {
  await sub.ping();
} catch {
  fail(`Cannot reach redis at ${env.REDIS_URL}`, "  Start it with `docker compose up -d redis`.");
}

const enricher = createEnricher({ redis, logger, rpcUrl: env.SOLANA_RPC_URL });

const stats = {
  trades: 0,
  launches: 0,
  malformed: 0,
  narrativesResolved: 0,
  narrativesUnresolved: 0,
  /** Launches skipped because no watch had a narrative yet. */
  launchesUnmatchable: 0,
  clonesFound: 0,
};

/**
 * Resolve what a watched token actually is.
 *
 * DexScreener first, Helius DAS second. DAS is the one that answers for a mint
 * minutes old, which is every token this tool cares about, and DexScreener has
 * not indexed those yet. One lookup per watch, cached, a handful per day.
 */
async function describe(mint: string, openedAt: number): Promise<void> {
  try {
    const meta = await enricher.resolve(mint, openedAt);
    if (meta === null) {
      stats.narrativesUnresolved += 1;
      // Not fatal. The watch stays open and the metadata-uri check can still
      // catch a byte-identical clone without knowing the name.
      logger.warn({ mint }, "could not resolve narrative; name matching disabled for this watch");
      return;
    }
    if (!watches.describe(mint, meta)) return; // closed while we were resolving
    stats.narrativesResolved += 1;
    logger.info({ mint, symbol: meta.symbol, name: meta.name }, "NARRATIVE");
  } catch (error) {
    stats.narrativesUnresolved += 1;
    logger.error({ mint, err: String(error) }, "narrative lookup failed");
  }
}

function matchLaunch(launch: MintEvent): void {
  const open = watches.list();
  if (open.length === 0) return;
  const config = {
    minSimilarity: thresholds.current.narrative.min_similarity,
    minLength: thresholds.current.narrative.min_length,
  };
  let considered = 0;
  for (const watch of open) {
    if (watch.meta === null) continue;
    // A token is not a clone of itself. Without this the launch feed reporting
    // the very mint you just bought counts as the first vamp of it, which is
    // both wrong and the most alarming possible false positive.
    if (launch.mint === watch.mint) continue;
    considered += 1;
    const hit = matchNarrative(
      { name: watch.meta.name, symbol: watch.meta.symbol },
      launch,
      config,
    );
    if (hit === null) continue;
    stats.clonesFound += 1;
    logger.warn(
      {
        parent: watch.meta.symbol,
        parentMint: watch.mint,
        cloneMint: launch.mint,
        cloneSymbol: launch.symbol,
        cloneName: launch.name,
        similarity: Number(hit.similarity.toFixed(3)),
        matchedOn: hit.matchedOn,
        secondsAfterBuy: Math.round((launch.observedAt - watch.openedAt) / 1000),
      },
      "CLONE",
    );
  }
  if (considered === 0) stats.launchesUnmatchable += 1;
}

await sub.subscribe(CHANNELS.trades, CHANNELS.mints);
sub.on("message", (channel: string, payload: string) => {
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
  const event = result.data;
  if (event.kind === "trade") {
    stats.trades += 1;
    watches.observe(event);
    return;
  }
  if (event.kind === "mint") {
    stats.launches += 1;
    matchLaunch(event);
  }
});

// Wall clock here, on purpose: "three minutes since I bought" is elapsed real
// time. Replay must drive expiry from event time instead, which is why sweep
// takes the clock as an argument rather than reading one.
const sweeper = setInterval(() => watches.sweep(Date.now()), 5_000);
sweeper.unref();

const heartbeat = setInterval(() => {
  logger.info(
    { ...stats, ...watches.stats, openWatches: watches.size, meta: enricher.stats },
    "engine stats",
  );
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
    void Promise.allSettled([sub.quit(), redis.quit()]).then(() => process.exit(0));
  });
}

logger.info(
  {
    channels: [CHANNELS.trades, CHANNELS.mints],
    windowSeconds: thresholds.current.watch.window_seconds,
    minSimilarity: thresholds.current.narrative.min_similarity,
    config: paths.thresholds,
  },
  "engine listening",
);
