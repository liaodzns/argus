/**
 * Alert construction.
 *
 * Step 5 has exactly one signal, so the composite is that signal. `score` is a
 * weight-normalised mean over the signals that actually exist, which with one
 * signal reduces to its own normalised value. Step 7 widens the denominator to
 * the full weight set; nothing here has to change for that, and nothing here
 * invents a number it cannot justify.
 *
 * `safety` is all nulls because nothing has looked yet, and null means
 * unresolved rather than safe. The filter that acts on it arrives at step 7.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  AlertPayloadSchema,
  KEYS,
  type AlertPayload,
  type KolWallet,
  type Signal,
  type Timestamp,
  type TokenMeta,
  type TradeEvent,
} from "@argus/shared";
import type { Thresholds } from "@argus/shared/config";

export interface AlertInput {
  trade: TradeEvent;
  meta: TokenMeta;
  kols: KolWallet[];
  distinctKols: number;
  earliestEventAt: Timestamp;
  thresholds: Thresholds;
}

/** Normalised 0..1 against the configured saturation point. */
export function kolClusterValue(distinct: number, saturateAt: number): number {
  if (saturateAt <= 0) return 0;
  return Math.min(distinct / saturateAt, 1);
}

export function buildAlert(input: AlertInput): AlertPayload {
  const config = input.thresholds.signals.kol_cluster;
  const value = kolClusterValue(input.distinctKols, config.saturate_at);

  const signals: Signal[] = [
    {
      name: "kol_cluster",
      value,
      weight: config.weight,
      // Raw values live here, never in `value`.
      detail: {
        distinctInWindow: input.distinctKols,
        minDistinct: config.min_distinct,
        saturateAt: config.saturate_at,
        windowSeconds: input.thresholds.windows.short,
      },
    },
  ];

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const score =
    totalWeight === 0 ? 0 : (signals.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight) * 100;

  return AlertPayloadSchema.parse({
    id: randomUUID(),
    mint: input.trade.mint,
    meta: input.meta,
    score,
    signals,
    safety: {
      mintAuthorityLive: null,
      freezeAuthorityLive: null,
      topHolderPct: null,
      devHoldingPct: null,
      lpBurned: null,
    },
    kols: input.kols,
    narrativeCluster: null,
    // Wall clock on purpose: triggeredAt minus earliestEventAt is meant to
    // measure how long Argus took, not how long the market took.
    triggeredAt: Date.now(),
    earliestEventAt: input.earliestEventAt,
  });
}

/**
 * Minimal per-mint cooldown, so one token cannot crowd out the wall.
 *
 * Measured in block time, like every window in this system, rather than as a
 * Redis TTL. A wall-clock cooldown disagrees with a block-time window the
 * moment the two clocks diverge, which is every replay and every minute the
 * engine spends behind the stream. Replaying a session at 4x would expire a
 * five-minute cooldown after seventy-five seconds of events and produce alerts
 * the live run never emitted.
 *
 * The key still carries a TTL, but only so a dead mint's key is reclaimed. It
 * is deliberately far longer than the cooldown and never decides anything.
 *
 * Read-then-write is safe here because the engine serialises work per mint;
 * this is the only writer for a given key at a given time.
 *
 * The escalation override, where a big enough score jump re-alerts inside the
 * cooldown, is part of the suppression work at step 7 and is not guessed at
 * here.
 */
export async function claimAlertSlot(
  redis: Redis,
  mint: string,
  blockTime: Timestamp,
  cooldownSeconds: number,
): Promise<boolean> {
  const key = KEYS.cooldown(mint);
  const existing = await redis.get(key);
  if (existing !== null && Number(existing) > blockTime) return false;
  const expiresAt = blockTime + cooldownSeconds * 1000;
  await redis.set(key, String(expiresAt), "EX", cooldownSeconds * 8);
  return true;
}
