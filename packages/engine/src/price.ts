/**
 * Price from a single fill.
 *
 * This is the first and only consumer of `TradeEvent.decimals`, and the reason
 * that field rides on every trade rather than being joined from TokenMeta.
 * Scaling through BigInt rather than parsing the base-unit string as a float
 * keeps a nine-figure supply exact right up to the final division.
 *
 * What this returns is an effective fill price: SOL actually moved over tokens
 * actually moved. It is not a pool mid price, and on a steep bonding curve the
 * two differ. Two independently decoded fills at the same moment agree with
 * each other to within half a percent, which is the check that matters; an
 * external chart is only comparable while it is fresh. See NOTES.md.
 */
import type { TradeEvent } from "@argus/shared";

const LAMPORTS_PER_SOL = 1e9;

export function priceSolOf(trade: TradeEvent): number {
  const tokens = Number(BigInt(trade.tokenAmount)) / 10 ** trade.decimals;
  if (tokens === 0) return 0;
  return trade.solLamports / LAMPORTS_PER_SOL / tokens;
}
