/**
 * Swap decoding via token balance deltas.
 *
 * Not instruction parsing. Six consecutive pump.fun transactions sampled off
 * mainnet carried the instruction names Buy, SellV2, BuyExactQuoteInV2,
 * BuyExactSolIn and SwapV2, several of them wrapped in an aggregator Route.
 * Any decoder keyed on instruction layout would already be broken. Balance
 * deltas survive that, because they describe what actually moved.
 *
 * Three things about this stream that bite if you assume otherwise:
 * failed transactions are delivered and must be dropped, one transaction can
 * contain several swaps, and the fee payer is frequently not the trader.
 */
import { z } from "zod";
import { PROGRAMS, TradeEventSchema, type TradeEvent, type Venue } from "@argus/shared";

/** Quote assets. A delta in one of these is the money leg, not the traded token. */
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wrapped SOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

const ProgramRefSchema = z.object({ programId: z.string() });

const TokenBalanceSchema = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: z.object({
    amount: z.string().regex(/^\d+$/),
    decimals: z.number().int().min(0).max(18),
  }),
});

/**
 * Only the fields the decoder reads. Parsed rather than cast, because this is
 * external input and a malformed response that reaches the engine poisons a
 * rolling window minutes later somewhere unrelated.
 */
export const RpcTransactionSchema = z.object({
  slot: z.number().int().nonnegative(),
  blockTime: z.number().int().nullable(),
  transaction: z.object({
    signatures: z.array(z.string()).min(1),
    message: z.object({
      accountKeys: z.array(z.object({ pubkey: z.string(), signer: z.boolean() })),
      instructions: z.array(ProgramRefSchema),
    }),
  }),
  meta: z.object({
    err: z.unknown().nullable(),
    fee: z.number().int().nonnegative(),
    preBalances: z.array(z.number()),
    postBalances: z.array(z.number()),
    preTokenBalances: z.array(TokenBalanceSchema).nullish(),
    postTokenBalances: z.array(TokenBalanceSchema).nullish(),
    innerInstructions: z.array(z.object({ instructions: z.array(ProgramRefSchema) })).nullish(),
  }),
});
export type RpcTransaction = z.infer<typeof RpcTransactionSchema>;

/** Why a transaction produced no trade. Counted and logged, never swallowed. */
export type SkipReason =
  | "failed_tx"
  | "no_block_time"
  | "no_watched_program"
  | "no_candidate_mint"
  | "no_trader"
  | "zero_sol";

export interface DecodeResult {
  trades: TradeEvent[];
  skipped: SkipReason | null;
}

interface Delta {
  owner: string;
  mint: string;
  decimals: number;
  delta: bigint;
  accountIndex: number;
}

function programsInvoked(tx: RpcTransaction): Set<string> {
  const ids = new Set<string>();
  for (const ix of tx.transaction.message.instructions) ids.add(ix.programId);
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) ids.add(ix.programId);
  }
  return ids;
}

/**
 * Post-migration trades run through the AMM, pre-migration through the curve.
 * A migrating token appears on both in the same transaction; the AMM wins,
 * because that is where the liquidity now is.
 */
function venueOf(invoked: Set<string>): Venue | null {
  if (invoked.has(PROGRAMS.PUMP_SWAP)) return "pumpswap";
  if (invoked.has(PROGRAMS.PUMP_FUN)) return "pumpfun_curve";
  return null;
}

function tokenDeltas(tx: RpcTransaction): Delta[] {
  const key = (b: { owner?: string | undefined; mint: string }) => `${b.owner ?? ""}|${b.mint}`;
  const seen = new Map<string, Delta>();

  for (const b of tx.meta.preTokenBalances ?? []) {
    if (b.owner === undefined) continue;
    seen.set(key(b), {
      owner: b.owner,
      mint: b.mint,
      decimals: b.uiTokenAmount.decimals,
      delta: -BigInt(b.uiTokenAmount.amount),
      accountIndex: b.accountIndex,
    });
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.owner === undefined) continue;
    const k = key(b);
    const existing = seen.get(k);
    const amount = BigInt(b.uiTokenAmount.amount);
    if (existing === undefined) {
      seen.set(k, {
        owner: b.owner,
        mint: b.mint,
        decimals: b.uiTokenAmount.decimals,
        delta: amount,
        accountIndex: b.accountIndex,
      });
    } else {
      existing.delta += amount;
    }
  }
  return [...seen.values()].filter((d) => d.delta !== 0n);
}

function nativeDeltaOf(tx: RpcTransaction, pubkey: string): number {
  const keys = tx.transaction.message.accountKeys;
  for (let i = 0; i < keys.length; i++) {
    if (keys[i]?.pubkey !== pubkey) continue;
    const post = tx.meta.postBalances[i];
    const pre = tx.meta.preBalances[i];
    if (post === undefined || pre === undefined) return 0;
    return post - pre;
  }
  return 0;
}

/**
 * SOL moved by the swap, in lamports.
 *
 * Preferred reading is the counterparty's own lamport change: for a bonding
 * curve trade that is exactly the SOL that entered or left the curve, with no
 * transaction fee, rent for a freshly created associated token account, or
 * platform fee mixed in.
 *
 * A pool holding wrapped SOL rather than native lamports has no such change,
 * and neither does an aggregator standing between the trader and the curve, so
 * fall back to the trader's own movement with the fee added back. Measured
 * against one routed sell in the fixtures, that fallback came in about 5% light
 * because platform fees stay inside it. Fine for a volume signal, which cares
 * about the shape of the curve rather than the exact fill, and not fine for
 * anything claiming to be a fill price.
 */
function solLamportsOf(
  tx: RpcTransaction,
  counterparty: string,
  trader: string,
  traderIsFeePayer: boolean,
): number {
  const viaCounterparty = Math.abs(nativeDeltaOf(tx, counterparty));
  if (viaCounterparty > 0) return viaCounterparty;
  const raw = nativeDeltaOf(tx, trader);
  return Math.abs(traderIsFeePayer ? raw + tx.meta.fee : raw);
}

/**
 * Decode every pump.fun swap in one transaction.
 *
 * Returns an empty trade list with a reason rather than throwing, because most
 * transactions on this stream are legitimately not trades and a throw per
 * uninteresting transaction would be noise, not a signal.
 */
export function decodeSwaps(tx: RpcTransaction): DecodeResult {
  if (tx.meta.err !== null) return { trades: [], skipped: "failed_tx" };

  const invoked = programsInvoked(tx);
  const venue = venueOf(invoked);
  if (venue === null) return { trades: [], skipped: "no_watched_program" };

  // Block time is null for very recent blocks on some endpoints. Emitting the
  // event with a wall-clock stamp would silently corrupt every rolling window
  // it lands in, so drop it and let the count show up in the logs.
  if (tx.blockTime === null) return { trades: [], skipped: "no_block_time" };
  const blockTime = tx.blockTime * 1000; // RPC reports seconds; the contract is ms.

  const signature = tx.transaction.signatures[0];
  const feePayer = tx.transaction.message.accountKeys[0]?.pubkey;
  if (signature === undefined || feePayer === undefined) {
    return { trades: [], skipped: "no_trader" };
  }
  const signers = new Set(
    tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey),
  );

  const deltas = tokenDeltas(tx);
  const candidates = deltas.filter((d) => !QUOTE_MINTS.has(d.mint) && signers.has(d.owner));
  if (candidates.length === 0) return { trades: [], skipped: "no_candidate_mint" };

  const trades: TradeEvent[] = [];
  for (const leg of candidates) {
    // The other side of this mint: the curve, or the AMM pool.
    const counterparty = deltas.find(
      (d) => d.mint === leg.mint && d.owner !== leg.owner && d.delta * leg.delta < 0n,
    );
    if (counterparty === undefined) continue;

    const solLamports = solLamportsOf(tx, counterparty.owner, leg.owner, leg.owner === feePayer);
    if (solLamports === 0) continue;

    trades.push(
      TradeEventSchema.parse({
        kind: "trade",
        mint: leg.mint,
        signature,
        slot: tx.slot,
        blockTime,
        trader: leg.owner,
        side: leg.delta > 0n ? "buy" : "sell",
        solLamports,
        tokenAmount: (leg.delta < 0n ? -leg.delta : leg.delta).toString(),
        decimals: leg.decimals,
        venue,
      }),
    );
  }

  if (trades.length === 0) return { trades: [], skipped: "zero_sol" };
  return { trades, skipped: null };
}
