/**
 * Engine entry point.
 *
 * Step 4 scope: consume trades, maintain one rolling window, print when a
 * watched wallet buys. No scoring, no safety filters, no vamp logic, and no
 * AlertPayload on the bus yet — a payload carrying a fabricated score and an
 * empty safety block would be worse than no payload, and both arrive with the
 * steps that can fill them in honestly.
 */
import pino from "pino";
import { Redis } from "ioredis";
import { ZodError } from "zod";
import { CHANNELS, StreamEventSchema } from "@argus/shared";
import {
  configPaths,
  loadEnv,
  watchKolWallets,
  watchThresholds,
  type Thresholds,
} from "@argus/shared/config";
import { createWindows } from "./windows.js";
import { buildRoster, observeKolTrade, type KolRoster } from "./signals/kol.js";

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

const stats = {
  received: 0,
  malformed: 0,
  kolBuys: 0,
  lastEventAt: 0,
};

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

  void (async () => {
    try {
      const hit = await observeKolTrade(event, roster, windows, windowMs(thresholdsHandle.current));
      if (hit === null) return;
      stats.kolBuys += 1;
      logger.info(
        {
          mint: hit.trade.mint,
          kol: hit.wallet.label,
          tier: hit.wallet.tier,
          sol: (hit.trade.solLamports / 1e9).toFixed(4),
          distinctKolsInWindow: hit.distinctInWindow,
          venue: hit.trade.venue,
          slot: hit.trade.slot,
        },
        "KOL BUY",
      );
    } catch (error) {
      logger.error({ err: String(error), mint: event.mint }, "window update failed");
    }
  })();
});

const heartbeat = setInterval(() => {
  logger.info({ ...stats, wallets: roster.size }, "engine stats");
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
  },
  "engine listening",
);
