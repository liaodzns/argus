/**
 * Watches.
 *
 * A watch is a timer, not a position. It opens when you buy, and closes when
 * you sell or when its window runs out. Nothing is persisted and nothing is
 * reconciled against on-chain balances, because the operator closes out of
 * positions and monitors longer holds elsewhere. A restart dropping every watch
 * is fine: the risk window it was covering has already passed.
 *
 * That decision deletes balance reads, token account subscriptions, restart
 * reconciliation and a dust threshold. See NOTES.md.
 */
import type { Address, NarrativeMatch, Timestamp, TokenMeta, TradeEvent } from "@argus/shared";

export interface Watch {
  mint: Address;
  /** Block time of the buy that opened it. */
  openedAt: Timestamp;
  openedBy: string;
  entrySolLamports: number;
  expiresAt: Timestamp;
  /**
   * What this token is, for matching clones against. Null until enrichment
   * resolves it, which is why matching has to tolerate a watch with no
   * narrative yet rather than assuming one is always present.
   */
  meta: TokenMeta | null;
  /** Clones found since this watch opened, keyed by mint. */
  suspects: Map<string, Suspect>;
}

/** A launch that matched a watch's narrative, and is therefore worth watching. */
export interface Suspect {
  mint: Address;
  symbol: string;
  name: string;
  similarity: number;
  matchedOn: NarrativeMatch[];
  firstSeenAt: Timestamp;
}

export type WatchCloseReason = "sold" | "expired";

export interface WatchesStats {
  opened: number;
  closedBySell: number;
  closedByExpiry: number;
  /** Sells for a mint no watch was open on — bought before Argus was running. */
  sellsWithoutWatch: number;
  /** Buys that added to a mint already watched. The clock is not restarted. */
  addedToExisting: number;
}

export interface WatchesOptions {
  /**
   * The wallet whose fills open and close watches.
   *
   * Required rather than optional because market trades now share a channel
   * with your own fills. Guarding inside this module makes a stranger's sell
   * closing your watch structurally impossible, instead of relying on every
   * call site to check first. Wrongly closing a watch means missing a vamp.
   */
  wallet: Address;
  /**
   * Read as a function, not a value, so a hot-reloaded window length applies to
   * the next watch without restarting anything.
   */
  windowMs: () => number;
  onOpen: (watch: Watch) => void;
  onClose: (watch: Watch, reason: WatchCloseReason) => void;
}

export function createWatches(options: WatchesOptions) {
  const watches = new Map<string, Watch>();
  const stats: WatchesStats = {
    opened: 0, closedBySell: 0, closedByExpiry: 0,
    sellsWithoutWatch: 0, addedToExisting: 0,
  };

  function close(mint: string, watch: Watch, reason: WatchCloseReason): void {
    watches.delete(mint);
    if (reason === "sold") stats.closedBySell += 1;
    else stats.closedByExpiry += 1;
    options.onClose(watch, reason);
  }

  return {
    stats,
    get size(): number {
      return watches.size;
    },
    list(): Watch[] {
      return [...watches.values()];
    },

    /** Record a clone. Returns false if the watch has already closed. */
    addSuspect(mint: string, suspect: Suspect): boolean {
      const watch = watches.get(mint);
      if (watch === undefined) return false;
      if (watch.suspects.has(suspect.mint)) return false;
      watch.suspects.set(suspect.mint, suspect);
      return true;
    },

    /** Attach the narrative once enrichment has resolved it. */
    describe(mint: string, meta: TokenMeta): boolean {
      const watch = watches.get(mint);
      if (watch === undefined) return false;
      watch.meta = meta;
      return true;
    },

    observe(trade: TradeEvent): void {
      // Not our fill, so it says nothing about whether we hold anything.
      if (trade.trader !== options.wallet) return;
      if (trade.side === "buy") {
        const existing = watches.get(trade.mint);
        if (existing !== undefined) {
          // Adding to a position does not restart the clock. The vamp risk is
          // measured from the parent's deployment, which the first buy already
          // anchors; a later top-up does not make the token younger.
          stats.addedToExisting += 1;
          return;
        }
        const watch: Watch = {
          mint: trade.mint,
          openedAt: trade.blockTime,
          openedBy: trade.signature,
          entrySolLamports: trade.solLamports,
          expiresAt: trade.blockTime + options.windowMs(),
          meta: null,
          suspects: new Map(),
        };
        watches.set(trade.mint, watch);
        stats.opened += 1;
        options.onOpen(watch);
        return;
      }

      const watch = watches.get(trade.mint);
      if (watch === undefined) {
        stats.sellsWithoutWatch += 1;
        return;
      }
      // Any sell closes the watch, including a partial one. The operator states
      // they close out in full, so this follows that rather than tracking
      // remaining size. If scaling out ever becomes normal, this is the line
      // that has to change, because closing early is the expensive direction.
      close(trade.mint, watch, "sold");
    },

    /**
     * Close anything whose window has run out.
     *
     * The caller supplies `now` rather than this reading a clock, because which
     * clock is correct depends on who is calling. Live, it is wall clock: "three
     * minutes since I bought" is a statement about elapsed real time. Under
     * replay it must be event time, or a session replayed at 600x would expire
     * every watch before its vamps arrived — the same trap the cooldown fell
     * into at step 6.
     */
    sweep(now: Timestamp): void {
      for (const [mint, watch] of watches) {
        if (now < watch.expiresAt) continue;
        close(mint, watch, "expired");
      }
    },
  };
}
