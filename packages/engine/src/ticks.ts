/**
 * Panel ticks.
 *
 * High frequency and small: this is the bulk of socket traffic once the wall is
 * full, so it carries only what a panel draws.
 *
 * Candles are aggregated here rather than in the browser. Shipping raw trades
 * and letting twelve panels each bucket them is how a monitoring surface turns
 * into a space heater.
 */
import { KEYS, PanelTickSchema, type PanelTick, type TradeEvent } from "@argus/shared";
import { decodeTrade, type Windows } from "./windows.js";

const LAMPORTS_PER_SOL = 1e9;

/**
 * SOL per token for a single fill.
 *
 * This is the first consumer of `decimals`, and the reason it rides on every
 * trade. Scaling through BigInt rather than parsing the base-unit string as a
 * float keeps a nine-figure supply exact up to the final division.
 */
export function priceSolOf(trade: TradeEvent): number {
  const tokens = Number(BigInt(trade.tokenAmount)) / 10 ** trade.decimals;
  if (tokens === 0) return 0;
  return trade.solLamports / LAMPORTS_PER_SOL / tokens;
}

export interface TickInput {
  trade: TradeEvent;
  windows: Windows;
  shortWindowMs: number;
  score: number;
}

export async function buildTick(input: TickInput): Promise<PanelTick> {
  const { trade, windows, shortWindowMs } = input;

  const [tradeMembers, buyers1m] = await Promise.all([
    windows.members(KEYS.tradeWindow(trade.mint), trade.blockTime, shortWindowMs),
    windows.count(KEYS.buyerWindow(trade.mint), trade.blockTime, shortWindowMs),
  ]);

  let volumeLamports = 0;
  for (const member of tradeMembers) {
    const entry = decodeTrade(member);
    if (entry !== null) volumeLamports += entry.solLamports;
  }

  return PanelTickSchema.parse({
    mint: trade.mint,
    blockTime: trade.blockTime,
    priceSol: priceSolOf(trade),
    volumeSol1m: volumeLamports / LAMPORTS_PER_SOL,
    buyers1m,
    score: input.score,
  });
}
