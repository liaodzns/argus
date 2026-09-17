/**
 * Redis publisher.
 *
 * One round trip per event does not survive a busy block, so events accumulate
 * in a buffer and leave as a single pipeline. Each event is still its own
 * PUBLISH, so subscribers receive one message per event and
 * `redis-cli SUBSCRIBE argus:stream:trades` shows exactly what it should. The
 * batching is in the transport, not in the message shape.
 */
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { KEYS, channelForEvent, type StreamEvent } from "@argus/shared";

export interface PublisherStats {
  published: number;
  batches: number;
  largestBatch: number;
  bufferDepth: number;
  errors: number;
  stalledFlushes: number;
  cursorSlot: number;
}

export interface PublisherOptions {
  redis: Redis;
  logger: Logger;
  /** Identifies the cursor key, so laserstream and helius_logs keep separate
   *  positions and swapping sources does not resume from the wrong one. */
  source: string;
  /** Short enough that a panel feels live, long enough to coalesce a block. */
  flushIntervalMs?: number;
  /** Flush early once the buffer reaches this, rather than waiting out the tick. */
  maxBatch?: number;
  /** Above this the consumer or the link is not keeping up. Warn, do not drop:
   *  a hole in a rolling window is silent and shows up minutes later as a
   *  wrong score. */
  warnDepth?: number;
  /** A pipeline that has not been acknowledged in this long is treated as a
   *  failure rather than waited on indefinitely. */
  flushTimeoutMs?: number;
}

export function createPublisher(options: PublisherOptions) {
  const { redis, logger, source } = options;
  const flushIntervalMs = options.flushIntervalMs ?? 50;
  const maxBatch = options.maxBatch ?? 500;
  const warnDepth = options.warnDepth ?? 10_000;
  const flushTimeoutMs = options.flushTimeoutMs ?? 5_000;

  let buffer: Array<[channel: string, payload: string]> = [];
  let pendingSlot = 0;
  let warnedAtDepth = 0;
  let flushing = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stats: PublisherStats = {
    published: 0, batches: 0, largestBatch: 0, bufferDepth: 0,
    errors: 0, stalledFlushes: 0, cursorSlot: 0,
  };

  async function flush(): Promise<void> {
    // Serialised on purpose. Two pipelines in flight can commit the cursor out
    // of order, and a cursor that moves backwards is worse than a stale one.
    if (flushing || buffer.length === 0) return;
    flushing = true;
    const batch = buffer;
    buffer = [];
    const slot = pendingSlot;

    try {
      const pipeline = redis.pipeline();
      for (const [channel, payload] of batch) pipeline.publish(channel, payload);
      // Monotonic by construction: pendingSlot only ever rises, and this is the
      // only writer of the key.
      if (slot > stats.cursorSlot) pipeline.set(KEYS.slotCursor(source), String(slot));

      // ioredis queues commands while the server is unreachable rather than
      // rejecting them, so without this the exec never settles, `flushing`
      // stays true, every later flush is a no-op, and the buffer grows forever
      // with nothing logged. A silently stuck publisher is exactly the failure
      // this project refuses to have.
      //
      // Re-queueing on timeout can republish a batch that did land. That is
      // deliberate and safe: windows are sorted sets keyed by signature, so a
      // duplicate is a no-op, while a dropped event is a permanent hole.
      const outcome = await Promise.race([
        pipeline.exec().then(() => "ok" as const),
        new Promise<"timeout">((resolve) => {
          const t = setTimeout(() => resolve("timeout"), flushTimeoutMs);
          t.unref();
        }),
      ]);
      if (outcome === "timeout") {
        stats.stalledFlushes += 1;
        throw new Error(`redis did not acknowledge ${batch.length} publishes in ${flushTimeoutMs}ms`);
      }

      stats.published += batch.length;
      stats.batches += 1;
      stats.largestBatch = Math.max(stats.largestBatch, batch.length);
      if (slot > stats.cursorSlot) stats.cursorSlot = slot;
    } catch (error) {
      stats.errors += 1;
      // Put them back at the front; ordering within a slot is not guaranteed by
      // the source anyway, but losing events silently is not acceptable.
      buffer = batch.concat(buffer);
      logger.error({ err: String(error), depth: buffer.length }, "redis publish failed");
    } finally {
      flushing = false;
      stats.bufferDepth = buffer.length;
    }
  }

  return {
    stats,

    publish(event: StreamEvent): void {
      buffer.push([channelForEvent(event), JSON.stringify(event)]);
      // The cursor records chain position, and a launch has none: the creation
      // feed reports when we heard about a mint, not which slot confirmed it.
      // Advancing the cursor from an observation timestamp would corrupt it.
      if (event.kind !== "mint") pendingSlot = Math.max(pendingSlot, event.slot);
      stats.bufferDepth = buffer.length;

      if (buffer.length >= warnDepth && buffer.length >= warnedAtDepth * 2) {
        warnedAtDepth = buffer.length;
        logger.warn({ depth: buffer.length }, "publish buffer growing; redis or link is behind");
      }
      if (buffer.length >= maxBatch) void flush();
    },

    start(): void {
      timer = setInterval(() => void flush(), flushIntervalMs);
      timer.unref();
    },

    flush,

    async close(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      // Drain rather than drop. A restart that loses the last half second of a
      // run is a gap in exactly the window that mattered.
      //
      // The pause matters: flush() returns immediately while another flush is
      // in flight, so without it this burns all its attempts on no-ops and
      // exits while the buffer is still full.
      for (let i = 0; i < 20 && buffer.length > 0; i++) {
        await flush();
        if (buffer.length > 0) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (buffer.length > 0) {
        logger.error({ depth: buffer.length }, "shutting down with events undelivered");
      }
    },
  };
}
