/**
 * Engine entry point.
 *
 * Your fills open watches, each watch learns what it holds, every new launch is
 * matched against the open ones, both your token and its clones are monitored
 * for price and flow, and when tracked wallets start buying a clone it alerts.
 *
 * Matching stays deliberately permissive. Step 5's roster signal is the strict
 * gate, so a false positive here costs a free subscription while a false
 * negative is a missed vamp. Tune toward recall.
 *
 * The trigger is the roster rather than volume, because those wallets cause the
 * volume and so their buys land first. Volume is the confirmation.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import {
  CHANNELS,
  KEYS,
  StreamEventSchema,
  PositionStateSchema,
  type Clone,
  type MintEvent,
  type PositionState,
  type TradeEvent,
} from "@argus/shared";
import { configPaths, loadEnv, watchKolWallets, watchThresholds } from "@argus/shared/config";
import { createWatches, type Watch, type WatchCloseReason } from "./watches.js";
import { createEnricher } from "./enrich.js";
import { matchNarrative } from "./narrative.js";
import { createWindows } from "./windows.js";
import { createFlow } from "./flow.js";
import { buildRoster, type KolRoster } from "./signals/kol.js";
import { buildAlert, claimAlertSlot } from "./alerts.js";

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

if (env.WATCHED_WALLET === undefined) {
  fail("WATCHED_WALLET is not set. Put your Axiom trading wallet in .env.");
}
const wallet = env.WATCHED_WALLET;

const watches = createWatches({
  wallet,
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
    void publishMonitored();
    void publishPosition(watch);
  },
  onClose: (watch, reason) => {
    logger.info(
      {
        mint: watch.mint,
        reason,
        heldSeconds: Math.round((Date.now() - watch.openedAt) / 1000),
        suspects: watch.suspects.size,
      },
      "WATCH CLOSED",
    );
    // Published before the flow state is dropped, and before the watch is gone
    // from the map, so the screen learns why the panel is going away.
    void publishPosition(watch, reason).finally(() => {
      alerted.delete(watch.mint);
      flow.forget(watch.mint);
      for (const suspect of watch.suspects.keys()) flow.forget(suspect);
    });
    void publishMonitored();
  },
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
let rosterHandle: ReturnType<typeof watchKolWallets>;
try {
  rosterHandle = watchKolWallets(paths.kolWallets, {
    onError: (error) =>
      logger.error({ err: String(error) }, "roster reload failed; keeping previous"),
  });
} catch (error) {
  fail(
    `Could not load ${paths.kolWallets}`,
    `  ${String(error)}\n  Copy config/kol-wallets.example.json and import your own wallets.`,
  );
}
let roster: KolRoster = buildRoster(rosterHandle.current.wallets);
rosterHandle.onChange((next) => {
  roster = buildRoster(next.wallets);
  logger.info({ wallets: roster.size }, "roster reloaded");
});

const flow = createFlow({
  windows: createWindows({ redis }),
  windowMs: () => thresholds.current.windows.short * 1000,
});

/**
 * Publish the set of mints ingest should hold subscriptions for.
 *
 * Rewritten in full each time rather than patched, so the engine's view is
 * always authoritative and a missed delta cannot leave a stale subscription
 * alive. Ingest polls this and diffs; there is no protocol between them.
 */
/**
 * Snapshot a watch as the screen sees it.
 *
 * Read from the watch itself rather than accumulated separately, so the panel
 * cannot drift from engine state. Clones carry their live flow readings, which
 * is why this is async.
 */
async function positionStateOf(
  watch: Watch,
  extras: { alerted: boolean; score: number | null; closed: boolean; closeReason: string | null },
): Promise<PositionState> {
  const now = Date.now();
  const clones: Clone[] = [];
  for (const suspect of watch.suspects.values()) {
    const reading = await flow.read(suspect.mint, now);
    clones.push({
      mint: suspect.mint,
      symbol: suspect.symbol,
      name: suspect.name,
      similarity: suspect.similarity,
      matchedOn: suspect.matchedOn,
      rosterBuys: suspect.rosterBuyers.size,
      rosterWallets: [...suspect.rosterBuyers],
      tradesPerMin: reading.tradesPerMin,
      priceSol: reading.priceSol,
      firstSeenAt: suspect.firstSeenAt,
    });
  }
  return PositionStateSchema.parse({
    mint: watch.mint,
    meta: watch.meta,
    openedAt: watch.openedAt,
    expiresAt: watch.expiresAt,
    entrySolLamports: watch.entrySolLamports,
    // Ranked by what matters: tracked buyers first, then how hard it is
    // trading. The screen draws the top few and counts the rest.
    clones: clones.sort((a, b) => b.rosterBuys - a.rosterBuys || b.tradesPerMin - a.tradesPerMin),
    alerted: extras.alerted,
    score: extras.score,
    closed: extras.closed,
    closeReason: extras.closeReason,
  });
}

/** Score per position once it has alerted, so a republished panel stays loud. */
const alerted = new Map<string, number>();

/**
 * Publish the panel for one position.
 *
 * `watch` is passed in rather than looked up, because the most important call
 * happens as a watch closes, when it is already gone from the map. Without that
 * frame the panel would stay on screen forever.
 */
async function publishPosition(watch: Watch, closeReason: WatchCloseReason | null = null): Promise<void> {
  try {
    const score = alerted.get(watch.mint);
    const state = await positionStateOf(watch, {
      alerted: score !== undefined,
      score: score ?? null,
      closed: closeReason !== null,
      closeReason,
    });
    await redis.publish(CHANNELS.positions, JSON.stringify(state));
  } catch (error) {
    logger.error({ mint: watch.mint, err: String(error) }, "could not publish position state");
  }
}

/** Look a watch up by mint, for the paths that only have one. */
const watchOf = (mint: string): Watch | undefined =>
  watches.list().find((w) => w.mint === mint);

async function publishMonitored(): Promise<void> {
  const wanted = new Set<string>();
  for (const watch of watches.list()) {
    wanted.add(watch.mint);
    for (const suspect of watch.suspects.keys()) wanted.add(suspect);
  }
  try {
    const key = KEYS.monitored();
    if (wanted.size === 0) {
      await redis.del(key);
      return;
    }
    // Replace atomically: a temporary key renamed over the real one means
    // ingest never observes a half-written set.
    const temp = `${key}:next`;
    const pipeline = redis.pipeline();
    pipeline.del(temp);
    pipeline.sadd(temp, ...wanted);
    pipeline.rename(temp, key);
    await pipeline.exec();
  } catch (error) {
    logger.error({ err: String(error) }, "could not publish the monitored set");
  }
}

const stats = {
  trades: 0,
  launches: 0,
  malformed: 0,
  narrativesResolved: 0,
  narrativesUnresolved: 0,
  /** Launches skipped because no watch had a narrative yet. */
  launchesUnmatchable: 0,
  clonesFound: 0,
  activity: 0,
  samples: 0,
  rosterBuys: 0,
  alerts: 0,
  suppressed: 0,
  ticks: 0,
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
    const described = watchOf(mint);
    if (described !== undefined) void publishPosition(described);
    logger.info({ mint, symbol: meta.symbol, name: meta.name }, "NARRATIVE");
  } catch (error) {
    stats.narrativesUnresolved += 1;
    logger.error({ mint, err: String(error) }, "narrative lookup failed");
  }
}

/**
 * A tracked wallet bought a clone. This is the trigger.
 *
 * Assembles the alert from what is already known rather than looking anything
 * up: the narrative came from enrichment when the watch opened, the clones came
 * from matching, and the rates came from flow.
 */
async function considerAlert(trade: TradeEvent): Promise<void> {
  if (trade.side !== "buy") return;
  const wallet = roster.lookup(trade.trader);
  if (wallet === undefined) return;
  const watch = watches.watchForClone(trade.mint);
  if (watch === null || watch.meta === null) return;

  watches.recordRosterBuy(trade.mint, trade.trader);
  stats.rosterBuys += 1;
  void publishPosition(watch);

  const buyers = new Set<string>();
  for (const suspect of watch.suspects.values()) {
    for (const buyer of suspect.rosterBuyers) buyers.add(buyer);
  }
  const minDistinct = thresholds.current.signals.kol_cluster.min_distinct;
  if (buyers.size < minDistinct) {
    logger.info(
      { clone: trade.mint, wallet: wallet.label, distinct: buyers.size, need: minDistinct },
      "roster buy on a clone, below the threshold",
    );
    return;
  }

  const now = Date.now();
  const parentFlow = await flow.read(watch.mint, now);
  const clones: Clone[] = [];
  let busiest = 0;
  for (const suspect of watch.suspects.values()) {
    const reading = await flow.read(suspect.mint, now);
    busiest = Math.max(busiest, reading.tradesPerMin);
    clones.push({
      mint: suspect.mint,
      symbol: suspect.symbol,
      name: suspect.name,
      similarity: suspect.similarity,
      matchedOn: suspect.matchedOn,
      rosterBuys: suspect.rosterBuyers.size,
      rosterWallets: [...suspect.rosterBuyers],
      tradesPerMin: reading.tradesPerMin,
      priceSol: reading.priceSol,
      firstSeenAt: suspect.firstSeenAt,
    });
  }
  // Share of combined rate. Zero denominator means nothing is trading at all,
  // in which case there is no pressure to report.
  const combined = busiest + parentFlow.tradesPerMin;
  const flowShare = combined === 0 ? 0 : busiest / combined;

  // Cooldown is keyed on your position, not on a clone, so a 25-clone wave
  // produces one alert rather than twenty-five.
  if (!(await claimAlertSlot(redis, watch.mint, trade.blockTime, thresholds.current.alerting.cooldown_seconds))) {
    stats.suppressed += 1;
    return;
  }

  const kols = [...buyers].map((a) => roster.lookup(a)).filter((w) => w !== undefined);
  const earliest = Math.min(watch.openedAt, ...clones.map((c) => c.firstSeenAt));
  const alert = buildAlert({
    held: watch.meta,
    clones: clones.sort((a, b) => b.rosterBuys - a.rosterBuys || b.tradesPerMin - a.tradesPerMin),
    kols,
    distinctRosterBuyers: buyers.size,
    flowShare,
    earliestEventAt: earliest,
    thresholds: thresholds.current,
  });
  await redis.publish(CHANNELS.alerts, JSON.stringify(alert));
  alerted.set(watch.mint, alert.score);
  await publishPosition(watch);
  stats.alerts += 1;
  logger.warn(
    {
      held: alert.meta.symbol,
      mint: alert.mint,
      score: Number(alert.score.toFixed(1)),
      rosterBuyers: buyers.size,
      wallets: kols.map((k) => k.label),
      clones: alert.clones.length,
      flowSharePct: Math.round(flowShare * 100),
      latencyMs: alert.triggeredAt - alert.earliestEventAt,
    },
    "VAMP ALERT",
  );
}

function matchLaunch(launch: MintEvent): void {
  const open = watches.list();
  if (open.length === 0) return;
  const config = {
    minSimilarity: thresholds.current.narrative.min_similarity,
    minRosterBuyers: thresholds.current.signals.kol_cluster.min_distinct,
    rosterWallets: roster.size,
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
    const isNew = watches.addSuspect(watch.mint, {
      mint: launch.mint,
      symbol: launch.symbol,
      name: launch.name,
      similarity: hit.similarity,
      matchedOn: hit.matchedOn,
      firstSeenAt: launch.observedAt,
      rosterBuyers: new Set<string>(),
    });
    if (!isNew) continue;
    stats.clonesFound += 1;
    void publishMonitored();
    void publishPosition(watch);
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

await sub.subscribe(CHANNELS.trades, CHANNELS.mints, CHANNELS.activity);
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
    // Your fills drive watches; anything else on this channel is a monitored
    // mint's market flow. watches.observe guards on the wallet itself, so the
    // routing here cannot cause a stranger's sell to close a watch.
    watches.observe(event);
    if (event.trader !== wallet) {
      stats.samples += 1;
      void flow.sample(event).catch((error: unknown) =>
        logger.debug({ err: String(error) }, "sample aggregation failed"),
      );
      void considerAlert(event).catch((error: unknown) =>
        logger.error({ err: String(error), mint: event.mint }, "alert evaluation failed"),
      );
    }
    return;
  }
  if (event.kind === "activity") {
    stats.activity += 1;
    void flow.observe(event).catch((error: unknown) =>
      logger.debug({ err: String(error) }, "activity aggregation failed"),
    );
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

/**
 * Publish a tick for everything monitored, and log it.
 *
 * Step 4 deliberately withheld ticks because the old shape demanded a score
 * nothing had computed. The shape no longer asks for one — score belongs to the
 * position — so these are now honest.
 */
const reporter = setInterval(() => {
  void (async () => {
    const now = Date.now();
    for (const watch of watches.list()) {
      const rows = [watch.mint, ...watch.suspects.keys()];
      for (const mint of rows) {
        const reading = await flow.read(mint, now);
        await redis.publish(CHANNELS.ticks, JSON.stringify({
          mint,
          observedAt: now,
          priceSol: reading.priceSol,
          tradesPerMin: reading.tradesPerMin,
          estimatedVolumeSolPerMin: reading.estimatedVolumeSolPerMin,
        }));
        stats.ticks += 1;
        if (reading.tradesPerMin === 0 && reading.priceSol === null) continue;
        const suspect = watch.suspects.get(mint);
        logger.info(
          {
            role: suspect === undefined ? "held" : "clone",
            mint,
            symbol: suspect?.symbol ?? watch.meta?.symbol ?? "?",
            tradesPerMin: Math.round(reading.tradesPerMin),
            landedPct: Math.round(reading.landedRatio * 100),
            priceSol: reading.priceSol === null ? null : reading.priceSol.toExponential(3),
            estVolSolPerMin:
              reading.estimatedVolumeSolPerMin === null
                ? null
                : Number(reading.estimatedVolumeSolPerMin.toFixed(2)),
            samples: reading.samples,
          },
          "FLOW",
        );
      }
    }
  })().catch((error: unknown) => logger.debug({ err: String(error) }, "flow report failed"));
}, thresholds.current.monitor.tick_interval_ms);
reporter.unref();

const heartbeat = setInterval(() => {
  logger.info(
    {
      ...stats,
      ...watches.stats,
      openWatches: watches.size,
      rosterWallets: roster.size,
      meta: enricher.stats,
    },
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
    clearInterval(reporter);
    clearInterval(heartbeat);
    thresholds.close();
    rosterHandle.close();
    void Promise.allSettled([sub.quit(), redis.quit()]).then(() => process.exit(0));
  });
}

logger.info(
  {
    channels: [CHANNELS.trades, CHANNELS.mints, CHANNELS.activity],
    publishes: [CHANNELS.positions, CHANNELS.ticks, CHANNELS.alerts],
    wallet,
    windowSeconds: thresholds.current.watch.window_seconds,
    minSimilarity: thresholds.current.narrative.min_similarity,
    minRosterBuyers: thresholds.current.signals.kol_cluster.min_distinct,
    rosterWallets: roster.size,
    config: paths.thresholds,
  },
  "engine listening",
);
