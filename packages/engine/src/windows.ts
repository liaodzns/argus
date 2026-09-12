/**
 * Rolling aggregates over Redis.
 *
 * Every window is a sorted set scored by block time. Eviction is
 * ZREMRANGEBYSCORE against that score, never a TTL, so a window boundary means
 * exactly what it says: the last N seconds of chain time, not the last N
 * seconds of this process being alive. Those two diverge the moment the engine
 * restarts, falls behind, or replays a recording, which is precisely when the
 * numbers matter most.
 *
 * Wall clock never appears in this file.
 */
import type { Redis } from "ioredis";
import type { Timestamp } from "@argus/shared";

export interface WindowsOptions {
  redis: Redis;
  /**
   * Garbage collection only. A mint that stops trading stops receiving writes,
   * so nothing would ever evict its key; this reclaims it long after any window
   * could still reference it. Deliberately far longer than the widest window,
   * because it must never be the thing that decides a boundary.
   */
  gcTtlMs?: number;
}

export interface Windows {
  /** Add a member at its block time and drop anything that fell out. */
  record(key: string, member: string, blockTime: Timestamp, windowMs: number): Promise<void>;
  /** Distinct members still inside the window as of `blockTime`. */
  count(key: string, blockTime: Timestamp, windowMs: number): Promise<number>;
  members(key: string, blockTime: Timestamp, windowMs: number): Promise<string[]>;
  /** Block time of the oldest member still inside the window, or null. */
  earliest(key: string, blockTime: Timestamp, windowMs: number): Promise<Timestamp | null>;
}

export function createWindows(options: WindowsOptions): Windows {
  const { redis } = options;
  const gcTtlMs = options.gcTtlMs ?? 6 * 60 * 60 * 1000;

  return {
    async record(key, member, blockTime, windowMs) {
      const cutoff = blockTime - windowMs;
      const pipeline = redis.pipeline();
      // Re-adding an existing member updates its score rather than duplicating
      // it, which is what makes a distinct-wallet count fall out for free.
      pipeline.zadd(key, blockTime, member);
      pipeline.zremrangebyscore(key, "-inf", `(${cutoff}`);
      pipeline.pexpire(key, gcTtlMs);
      await pipeline.exec();
    },

    // Reads re-apply the cutoff rather than trusting the last write to have
    // evicted. Events arrive slightly out of order, and a key whose newest
    // event is old would otherwise report members that have long since expired.
    async count(key, blockTime, windowMs) {
      return redis.zcount(key, blockTime - windowMs, "+inf");
    },

    async members(key, blockTime, windowMs) {
      return redis.zrangebyscore(key, blockTime - windowMs, "+inf");
    },

    async earliest(key, blockTime, windowMs) {
      const rows = await redis.zrangebyscore(
        key, blockTime - windowMs, "+inf", "WITHSCORES", "LIMIT", 0, 1,
      );
      const score = rows[1];
      return score === undefined ? null : Number(score);
    },
  };
}

/**
 * What a trade window stores.
 *
 * The sorted-set score has to be the block time, because that is what the
 * window boundary is measured in, so everything else the aggregates need rides
 * inside the member string. Signature makes the member unique, which is also
 * what makes a replayed or duplicated publish a no-op rather than double
 * counting.
 */
export interface TradeEntry {
  signature: string;
  side: "buy" | "sell";
  solLamports: number;
  trader: string;
}

export const encodeTrade = (entry: TradeEntry): string =>
  `${entry.signature}|${entry.side === "buy" ? "b" : "s"}|${entry.solLamports}|${entry.trader}`;

export function decodeTrade(member: string): TradeEntry | null {
  const parts = member.split("|");
  if (parts.length !== 4) return null;
  const [signature, side, lamports, trader] = parts;
  if (signature === undefined || trader === undefined) return null;
  if (side !== "b" && side !== "s") return null;
  const solLamports = Number(lamports);
  if (!Number.isFinite(solLamports)) return null;
  return { signature, side: side === "b" ? "buy" : "sell", solLamports, trader };
}
