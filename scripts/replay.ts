/**
 * Record and replay sessions.
 *
 * Tuning against a live market has no control: you change `min_volume_sol`, the
 * market changes too, and nothing tells you which one moved the result. A
 * recording turns fifteen tunable numbers from guesswork into something you can
 * actually attribute, and it costs no provider quota to run again.
 *
 * What gets recorded is stream events, not raw RPC responses. That is the right
 * layer, because the thing being tuned is the engine and the engine consumes
 * stream events. Recording a layer lower would mean re-running the decoder on
 * every replay and coupling the recordings to its implementation.
 *
 *   npm run replay -- --record recordings/session.jsonl
 *   npm run replay -- --play   recordings/session.jsonl --speed 4 --reset
 *   npm run replay -- --play   recordings/session.jsonl --capture-alerts out.jsonl
 */
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { Redis } from "ioredis";
import {
  CHANNELS,
  AlertPayloadSchema,
  StreamEventSchema,
  channelForEvent,
  eventTime,
  type StreamEvent,
} from "@argus/shared";
import { loadEnv } from "@argus/shared/config";

const { values } = parseArgs({
  options: {
    record: { type: "string" },
    play: { type: "string" },
    speed: { type: "string", default: "1" },
    reset: { type: "boolean", default: false },
    "capture-alerts": { type: "string" },
  },
});

const env = loadEnv();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

/**
 * Flush the engine's derived state so two replays start from the same place.
 *
 * Without this the second run inherits the first run's windows and cooldowns,
 * and the comparison you were trying to make is meaningless.
 *
 * Slot cursors are left alone. They belong to ingest, not to the engine, and
 * they record how far a live stream actually got. Wiping one because you wanted
 * to re-run a replay loses real position for an unrelated process.
 */
async function resetState(): Promise<void> {
  let cursor = "0";
  let removed = 0;
  let kept = 0;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "argus:*", "COUNT", 500);
    cursor = next;
    const doomed = keys.filter((key) => !key.startsWith("argus:cursor:"));
    kept += keys.length - doomed.length;
    if (doomed.length > 0) {
      await redis.del(...doomed);
      removed += doomed.length;
    }
  } while (cursor !== "0");
  log(`reset: removed ${removed} keys, kept ${kept} cursor${kept === 1 ? "" : "s"}`);
}

async function record(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const out = createWriteStream(path, { flags: "a" });
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const counts = { trade: 0, mint: 0, migration: 0, activity: 0, malformed: 0 };

  await sub.subscribe(CHANNELS.trades, CHANNELS.mints, CHANNELS.migrations, CHANNELS.activity);
  sub.on("message", (_channel: string, payload: string) => {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      counts.malformed += 1;
      return;
    }
    // Validate on the way in, so a recording is known-good and a replay never
    // has to wonder whether a failure is the engine or the file.
    const parsed = StreamEventSchema.safeParse(json);
    if (!parsed.success) {
      counts.malformed += 1;
      return;
    }
    counts[parsed.data.kind] += 1;
    out.write(`${JSON.stringify(parsed.data)}\n`);
  });

  log(`recording to ${path} — ctrl-c to stop`);
  const ticker = setInterval(() => log(`  ${JSON.stringify(counts)}`), 10_000);
  ticker.unref();

  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => resolve());
    }
  });
  clearInterval(ticker);
  await new Promise<void>((resolve) => out.end(resolve));
  await sub.quit();
  log(`recorded ${JSON.stringify(counts)} to ${path}`);
}

async function* readEvents(path: string): AsyncGenerator<StreamEvent> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const parsed = StreamEventSchema.safeParse(JSON.parse(line));
    if (parsed.success) yield parsed.data;
  }
}

/**
 * Capture the alerts a replay produces, normalised for comparison.
 *
 * The spec asks a replay to produce identical alerts, which cannot hold
 * literally: every AlertPayload carries a fresh uuid and a wall-clock
 * triggeredAt, so two runs never match byte for byte. What must match is the
 * decision — which mint, at what score, off which signals — so that is what
 * gets written, sorted-key JSON per line for a clean diff.
 */
function captureAlerts(path: string): { stop: () => Promise<void> } {
  mkdirSync(dirname(path), { recursive: true });
  const out = createWriteStream(path, { flags: "w" });
  const sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  void sub.subscribe(CHANNELS.alerts).then(() => {
    sub.on("message", (_channel: string, payload: string) => {
      const parsed = AlertPayloadSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) return;
      const a = parsed.data;
      out.write(
        `${JSON.stringify({
          mint: a.mint,
          symbol: a.meta.symbol,
          score: Number(a.score.toFixed(4)),
          earliestEventAt: a.earliestEventAt,
          kols: a.kols.map((k) => k.address).sort(),
          signals: a.signals.map((s) => [s.name, Number(s.value.toFixed(4))]).sort(),
          narrativeCluster: a.narrativeCluster?.parentMint ?? null,
        })}\n`,
      );
    });
  });
  return {
    async stop() {
      await sub.quit();
      await new Promise<void>((resolve) => out.end(resolve));
    },
  };
}

async function play(path: string, speed: number, alertsPath: string | undefined): Promise<void> {
  const capture = alertsPath === undefined ? undefined : captureAlerts(alertsPath);
  let previous: number | null = null;
  let published = 0;
  const started = Date.now();

  for await (const event of readEvents(path)) {
    // Block time is replayed exactly as recorded and never rewritten. Every
    // window, and now the cooldown, is measured against it, so an event's
    // timestamp is what makes a replay reproduce the original run. Speed
    // changes only how long this process waits between publishes.
    if (previous !== null && speed > 0) {
      const wait = (eventTime(event) - previous) / speed;
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30_000)));
    }
    previous = eventTime(event);
    await redis.publish(channelForEvent(event), JSON.stringify(event));
    published += 1;
    if (published % 1000 === 0) log(`  published ${published}`);
  }

  // The engine is still draining; alerts trail the last event it consumed.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await capture?.stop();
  log(`replayed ${published} events in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (values.reset) await resetState();

if (values.record !== undefined) {
  await record(values.record);
} else if (values.play !== undefined) {
  await play(values.play, Number(values.speed), values["capture-alerts"]);
} else {
  log("usage: npm run replay -- (--record <file> | --play <file>) [--speed N] [--reset] [--capture-alerts <file>]");
  process.exitCode = 1;
}

await redis.quit();
