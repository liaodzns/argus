/**
 * KOL cluster signal, step 4 shape: detection only.
 *
 * The real signal weights by tier and demands a minimum distinct count, because
 * one wallet is noise and three at once is a signal. Neither applies yet — step
 * 4 fires on a single watched wallet so the path can be proven end to end, and
 * the thresholds arrive with scoring at step 7.
 */
import { KEYS, type KolWallet, type TradeEvent } from "@argus/shared";
import type { Windows } from "../windows.js";

export interface KolRoster {
  lookup(address: string): KolWallet | undefined;
  readonly size: number;
}

export function buildRoster(wallets: readonly KolWallet[]): KolRoster {
  const byAddress = new Map(wallets.map((w) => [w.address, w]));
  return {
    lookup: (address) => byAddress.get(address),
    get size() {
      return byAddress.size;
    },
  };
}

export interface KolHit {
  wallet: KolWallet;
  trade: TradeEvent;
  /** Distinct watched wallets that bought this mint inside the window. */
  distinctInWindow: number;
}

/**
 * Record a watched wallet's buy and report the cluster around it 
 * Buys only
 */
export async function observeKolTrade(
  trade: TradeEvent,
  roster: KolRoster,
  windows: Windows,
  windowMs: number,
): Promise<KolHit | null> {
  if (trade.side !== "buy") return null;
  const wallet = roster.lookup(trade.trader);
  if (wallet === undefined) return null;

  const key = KEYS.kolWindow(trade.mint);
  await windows.record(key, wallet.address, trade.blockTime, windowMs);
  const distinctInWindow = await windows.count(key, trade.blockTime, windowMs);

  return { wallet, trade, distinctInWindow };
}
