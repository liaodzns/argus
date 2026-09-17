/**
 * Alert construction.
 *
 * The alert is about the token you hold, and the clones are the evidence.
 *
 * Two signals are real: how many tracked wallets bought a clone, and how much
 * of the combined trade rate the busiest clone has taken. `score` is a
 * weight-normalised mean over those, so it widens without changing shape when
 * more arrive. Nothing here invents a number it cannot justify.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import {
  AlertPayloadSchema,
  KEYS,
  type AlertPayload,
  type Clone,
  type KolWallet,
  type Signal,
  type Timestamp,
  type TokenMeta,
} from "@argus/shared";
import type { Thresholds } from "@argus/shared/config";

export interface AlertInput {
  /** Your position. The alert is about this, not about the clones. */
  held: TokenMeta;
  clones: Clone[];
  kols: KolWallet[];
  /** Distinct tracked wallets that bought any clone. */
  distinctRosterBuyers: number;
  /** The busiest clone's share of combined clone-plus-parent trade rate. */
  flowShare: number;
  earliestEventAt: Timestamp;
  thresholds: Thresholds;
}

/** Normalised 0..1 against the configured saturation point. */
export function kolClusterValue(distinct: number, saturateAt: number): number {
  if (saturateAt <= 0) return 0;
  return Math.min(distinct / saturateAt, 1);
}

export function buildAlert(input: AlertInput): AlertPayload {
  const kolConfig = input.thresholds.signals.kol_cluster;
  const vampConfig = input.thresholds.signals.vamp_of_runner;

  const signals: Signal[] = [
    {
      name: "kol_cluster",
      value: kolClusterValue(input.distinctRosterBuyers, kolConfig.saturate_at),
      weight: kolConfig.weight,
      // Raw values here, never in `value`.
      detail: {
        distinctRosterBuyers: input.distinctRosterBuyers,
        minDistinct: kolConfig.min_distinct,
        saturateAt: kolConfig.saturate_at,
      },
    },
    {
      // The confirmation half. A clone doing ten trades a minute matters only
      // relative to what your own token is doing, so this is a share rather
      // than an absolute. First cut; the threshold lives in config.
      name: "vamp_of_runner",
      value: Math.min(Math.max(input.flowShare, 0), 1),
      weight: vampConfig.weight,
      detail: { flowShare: Number(input.flowShare.toFixed(4)), clones: input.clones.length },
    },
  ];

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const score =
    totalWeight === 0
      ? 0
      : (signals.reduce((sum, s) => sum + s.value * s.weight, 0) / totalWeight) * 100;

  return AlertPayloadSchema.parse({
    id: randomUUID(),
    mint: input.held.mint,
    meta: input.held,
    score,
    signals,
    // Still all nulls: nothing inspects mint authority or holder concentration
    // yet, and null means unresolved rather than safe.
    safety: {
      mintAuthorityLive: null,
      freezeAuthorityLive: null,
      topHolderPct: null,
      devHoldingPct: null,
      lpBurned: null,
    },
    kols: input.kols,
    clones: input.clones,
    // Wall clock on purpose: triggeredAt minus earliestEventAt measures how
    // long Argus took, not how long the market took.
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
