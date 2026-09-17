/**
 * Flow aggregation.
 *
 * Turns the two monitoring tiers into something readable per mint:
 *
 *   trades/min   exact, from free activity notifications
 *   priceSol     from a decoded sample, absent until one arrives
 *   ~volume      an ESTIMATE: sampled trade size times observed rate
 *
 * The volume figure is labelled an estimate everywhere it surfaces because that
 * is what it is. Exact SOL volume needs a decode per trade, which on a busy
 * clone is hundreds of calls a second. The estimate costs one call every couple
 * of seconds and is good enough to answer "is this one taking the money".
 *
 * Two clocks live here and must not meet. Activity carries arrival wall clock,
 * because a log notification has no chain timestamp. Sampled trades carry real
 * block time. They go in separate windows, and a count from one is never
 * compared against a count from the other — that conflation is the trap the
 * cooldown fell into at step 6.
 */
import { KEYS, type Address, type MintActivity, type TradeEvent } from "@argus/shared";
import { decodeTrade, encodeTrade, type Windows } from "./windows.js";
import { priceSolOf } from "./price.js";

export interface FlowReading {
  mint: Address;
  /** Landed trades per minute. Exact, and free. */
  tradesPerMin: number;
  /** Share of observed transactions that landed. */
  landedRatio: number;
  /** From the most recent decoded sample. Null until one arrives. */
  priceSol: number | null;
  /** Sampled trade size times rate. An estimate, never exact. */
  estimatedVolumeSolPerMin: number | null;
  samples: number;
}

export interface FlowOptions {
  windows: Windows;
  /** Window both tiers are measured over. */
  windowMs: () => number;
}

export function createFlow(options: FlowOptions) {
  const { windows } = options;

  /** Per mint, the newest sample. Small and hot, so it stays in memory. */
  const latest = new Map<string, { priceSol: number; solLamports: number; samples: number }>();
  /** Observed transactions per mint, to derive the landed ratio. */
  const observed = new Map<string, { total: number; landed: number }>();

  return {
    /** Free tier. Recorded against arrival time, which is all it has. */
    async observe(activity: MintActivity): Promise<void> {
      const seen = observed.get(activity.mint) ?? { total: 0, landed: 0 };
      seen.total += 1;
      if (activity.landed) seen.landed += 1;
      observed.set(activity.mint, seen);
      if (!activity.landed) return;
      await windows.record(
        KEYS.activityWindow(activity.mint),
        activity.signature,
        activity.observedAt,
        options.windowMs(),
      );
    },

    /** Paid tier. Recorded against block time, in its own window. */
    async sample(trade: TradeEvent): Promise<void> {
      const previous = latest.get(trade.mint);
      latest.set(trade.mint, {
        priceSol: priceSolOf(trade),
        solLamports: trade.solLamports,
        samples: (previous?.samples ?? 0) + 1,
      });
      await windows.record(
        KEYS.tradeWindow(trade.mint),
        encodeTrade({
          signature: trade.signature,
          side: trade.side,
          solLamports: trade.solLamports,
          trader: trade.trader,
        }),
        trade.blockTime,
        options.windowMs(),
      );
    },

    async read(mint: Address, now: number): Promise<FlowReading> {
      const windowMs = options.windowMs();
      const landedInWindow = await windows.count(KEYS.activityWindow(mint), now, windowMs);
      const tradesPerMin = (landedInWindow / windowMs) * 60_000;
      const seen = observed.get(mint) ?? { total: 0, landed: 0 };
      const sample = latest.get(mint);

      // Mean sampled size times rate. Crude by construction, and the only
      // volume figure available without decoding every trade.
      const members = sample === undefined
        ? []
        : await windows.members(KEYS.tradeWindow(mint), now, windowMs);
      let lamports = 0;
      let counted = 0;
      for (const member of members) {
        const entry = decodeTrade(member);
        if (entry === null) continue;
        lamports += entry.solLamports;
        counted += 1;
      }
      const meanSol = counted === 0 ? null : lamports / counted / 1e9;

      return {
        mint,
        tradesPerMin,
        landedRatio: seen.total === 0 ? 0 : seen.landed / seen.total,
        priceSol: sample?.priceSol ?? null,
        estimatedVolumeSolPerMin: meanSol === null ? null : meanSol * tradesPerMin,
        samples: sample?.samples ?? 0,
      };
    },

    forget(mint: Address): void {
      latest.delete(mint);
      observed.delete(mint);
    },
  };
}
