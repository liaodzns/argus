/**
 * Swap decoding via token balance deltas.
 *
 * Not instruction parsing. One wallet's recent history alone produced the
 * instruction names Buy, Sell, BuyExactIn, BuyExactQuoteIn, SellExactIn, Swap2
 * and SwapBaseInput across six different venues. Any decoder keyed on
 * instruction layout would already be broken. Balance deltas survive that,
 * because they describe what actually moved.
 *
 * **Venue-agnostic on purpose.** An earlier version required a pump.fun program
 * to be present, which silently discarded roughly half the operator's trading:
 * Raydium AMM v4, Raydium CPMM, Meteora DLMM and Meteora DBC all went
 * unrecorded, including launchpads like Stonkfun that are built on Raydium and
 * therefore have no program of their own. A fill is a fill wherever it executed.
 *
 * Dropping that filter means the "is this a swap at all" question has to be
 * answered from the deltas instead, which is what `looksLikeSwap` does below.
 *
 * Three things about this stream that bite if you assume otherwise: failed
 * transactions are delivered and must be dropped, one transaction can contain
 * several swaps, and the fee payer is frequently not the trader.
 */
import { z } from "zod";
import { TradeEventSchema, type TradeEvent } from "@argus/shared";

const WSOL = "So11111111111111111111111111111111111111112";

/** Quote assets. A delta in one of these is the money leg, not the traded token. */
const QUOTE_MINTS = new Set([
  WSOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/**
 * Programs that are never the venue: system plumbing, token programs, and the
 * front-end router that wraps a trade without being where it executed.
 */
const INFRASTRUCTURE = [
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9", // Axiom router
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ", // pump.fun fee program
];

/**
 * Below this, a lamport movement is fees and rent rather than a trade.
 *
 * A fresh associated token account costs about 0.002 SOL of rent and a
 * transaction fee is a few ten-thousandths, while the smallest real fill
 * observed was 0.029 SOL. Without this floor an inbound token transfer reads as
 * a buy whose price is the transaction fee.
 */
const MIN_TRADE_LAMPORTS = 1_000_000; // 0.001 SOL

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
  | "no_swap_program"
  | "no_candidate_mint"
  | "no_trader"
  | "not_a_swap"
  | "below_floor";

export interface DecodeResult {
  trades: TradeEvent[];
  skipped: SkipReason | null;
}

interface Delta {
  owner: string;
  mint: string;
  decimals: number;
  delta: bigint;
}

function swapPrograms(tx: RpcTransaction): string[] {
  const ids = new Set<string>();
  for (const ix of tx.transaction.message.instructions) ids.add(ix.programId);
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) ids.add(ix.programId);
  }
  for (const known of INFRASTRUCTURE) ids.delete(known);
  // Sysvars and other pseudo-programs occasionally appear.
  return [...ids].filter((id) => !id.startsWith("Sysvar"));
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
 * How much SOL the trader's side moved, in lamports, signed.
 *
 * Native lamports plus any wrapped SOL, because a routed trade may settle in
 * either and some front-ends unwrap while others do not. The transaction fee is
 * added back when the trader paid it, so a fill is not understated by it.
 */
function traderSolMovement(
  tx: RpcTransaction,
  trader: string,
  deltas: readonly Delta[],
  isFeePayer: boolean,
): number {
  const native = nativeDeltaOf(tx, trader) + (isFeePayer ? tx.meta.fee : 0);
  const wrapped = deltas
    .filter((d) => d.owner === trader && d.mint === WSOL)
    .reduce((sum, d) => sum + Number(d.delta), 0);
  return native + wrapped;
}

/**
 * Does this look like a trade rather than a transfer?
 *
 * The venue-agnostic definition: the trader's token balance moved one way and
 * their SOL moved the other. A transfer moves tokens with no SOL on the other
 * side, so its only lamport movement is the fee, which the floor rejects.
 *
 * This is the guard that replaced requiring a known program. Without it, every
 * inbound token transfer would be recorded as a buy priced at the fee.
 */
function looksLikeSwap(tokenDelta: bigint, solMovement: number): boolean {
  if (Math.abs(solMovement) < MIN_TRADE_LAMPORTS) return false;
  const tokensIn = tokenDelta > 0n;
  const solOut = solMovement < 0;
  return tokensIn === solOut;
}

/**
 * SOL moved by the swap, in lamports.
 *
 * Preferred reading is the counterparty's own lamport change: for a bonding
 * curve trade that is exactly the SOL that entered or left the curve, with no
 * transaction fee, rent, or platform fee mixed in. An AMM pool holding wrapped
 * SOL in separate vaults has no such change, and neither does an aggregator
 * standing between the trader and the pool, so fall back to the trader's own
 * movement. Measured against one routed sell, that fallback came in about 5%
 * light because platform fees stay inside it. Fine for a volume signal, not
 * fine for anything claiming to be a fill price.
 */
function solLamportsOf(
  tx: RpcTransaction,
  counterparty: string,
  traderMovement: number,
): number {
  const viaCounterparty = Math.abs(nativeDeltaOf(tx, counterparty));
  return viaCounterparty > 0 ? viaCounterparty : Math.abs(traderMovement);
}

/**
 * Decode every swap in one transaction, at any venue.
 *
 * Returns an empty trade list with a reason rather than throwing, because most
 * transactions on this stream are legitimately not trades and a throw per
 * uninteresting transaction would be noise, not a signal.
 */
export function decodeSwaps(tx: RpcTransaction): DecodeResult {
  if (tx.meta.err !== null) return { trades: [], skipped: "failed_tx" };

  const programs = swapPrograms(tx);
  if (programs.length === 0) return { trades: [], skipped: "no_swap_program" };

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
  let sawNonSwap = false;
  let sawBelowFloor = false;

  for (const leg of candidates) {
    const movement = traderSolMovement(tx, leg.owner, deltas, leg.owner === feePayer);
    if (Math.abs(movement) < MIN_TRADE_LAMPORTS) {
      sawBelowFloor = true;
      continue;
    }
    if (!looksLikeSwap(leg.delta, movement)) {
      sawNonSwap = true;
      continue;
    }

    // The other side of this mint: a curve, a pool, or an aggregator.
    const counterparty = deltas.find(
      (d) => d.mint === leg.mint && d.owner !== leg.owner && d.delta * leg.delta < 0n,
    );

    const solLamports = solLamportsOf(tx, counterparty?.owner ?? "", movement);
    if (solLamports < MIN_TRADE_LAMPORTS) {
      sawBelowFloor = true;
      continue;
    }

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
        programs,
      }),
    );
  }

  if (trades.length === 0) {
    return { trades: [], skipped: sawNonSwap ? "not_a_swap" : sawBelowFloor ? "below_floor" : "no_candidate_mint" };
  }
  return { trades, skipped: null };
}
