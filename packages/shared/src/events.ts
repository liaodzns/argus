/**
 * The type contract.
 *
 * Every message that crosses a process boundary is defined here — the Redis
 * bus and the WebSocket frames both conform to these shapes. Changing a schema
 * breaks compilation in every package that touches it, which is the point.
 *
 * Never define an event shape inside a package. If a field is missing, it gets
 * added here.
 */
import { z } from "zod";

// --- Primitives -------------------------------------------------------------

/** Base58 Solana address. The alphabet excludes 0, O, I and l. */
export const AddressSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address");
export type Address = z.infer<typeof AddressSchema>;

/** Base58 transaction signature. */
export const SignatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, "expected a base58 transaction signature");
export type Signature = z.infer<typeof SignatureSchema>;

/**
 * Milliseconds since epoch, and always block time — never `Date.now()`.
 *
 * Wall-clock skew silently corrupts rolling windows and the damage surfaces
 * minutes later somewhere unrelated. The single exception in this file is
 * `AlertPayload.triggeredAt`, which is documented where it is declared.
 */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

export const SlotSchema = z.number().int().nonnegative();
export type Slot = z.infer<typeof SlotSchema>;

export const VenueSchema = z.enum(["pumpfun_curve", "pumpswap"]);
export type Venue = z.infer<typeof VenueSchema>;

export const SideSchema = z.enum(["buy", "sell"]);
export type Side = z.infer<typeof SideSchema>;

/** Raw token base units. A string because the value overflows a double. */
const BaseUnitsSchema = z.string().regex(/^\d+$/, "expected an integer string of base units");

// --- Stream events ----------------------------------------------------------
// Published by ingest. Discriminated on `kind`.

export const TradeEventSchema = z.object({
  kind: z.literal("trade"),
  mint: AddressSchema,
  signature: SignatureSchema,
  slot: SlotSchema,
  blockTime: TimestampSchema,
  trader: AddressSchema,
  side: SideSchema,
  /** Lamports, integer. Never store SOL as a float; divide at display time. */
  solLamports: z.number().int().nonnegative(),
  tokenAmount: BaseUnitsSchema,
  /**
   * Decimals of `mint`, carried on every trade rather than joined from
   * TokenMeta. Price is `(solLamports / 1e9) / (tokenAmount / 10 ** decimals)`
   * and the engine computes it on the hot path, so a Redis lookup per trade
   * would be the wrong trade-off — and a trade that arrives before enrichment
   * resolves would otherwise be unpriceable. The decode path already has this
   * in hand: token balance deltas carry `uiTokenAmount.decimals`.
   *
   * Bounded well above any real SPL mint so a decode bug fails loud.
   */
  decimals: z.number().int().min(0).max(18),
  venue: VenueSchema,
});
export type TradeEvent = z.infer<typeof TradeEventSchema>;

export const MintEventSchema = z.object({
  kind: z.literal("mint"),
  mint: AddressSchema,
  signature: SignatureSchema,
  slot: SlotSchema,
  blockTime: TimestampSchema,
  creator: AddressSchema,
  name: z.string(),
  symbol: z.string(),
  /** Off-chain metadata URI. May not resolve; that is a safety rejection. */
  uri: z.string(),
});
export type MintEvent = z.infer<typeof MintEventSchema>;

/**
 * Bonding curve completed and liquidity moved to PumpSwap. Historically one of
 * the strongest single predictors of continued attention.
 */
export const MigrationEventSchema = z.object({
  kind: z.literal("migration"),
  mint: AddressSchema,
  slot: SlotSchema,
  blockTime: TimestampSchema,
  pool: AddressSchema,
});
export type MigrationEvent = z.infer<typeof MigrationEventSchema>;

export const StreamEventSchema = z.discriminatedUnion("kind", [
  TradeEventSchema,
  MintEventSchema,
  MigrationEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

// --- Enrichment -------------------------------------------------------------

export const TokenMetaSchema = z.object({
  mint: AddressSchema,
  name: z.string(),
  symbol: z.string(),
  imageUrl: z.string().nullable(),
  /** Perceptual hash, hex. Exists for vamp clustering — it catches the
   *  reuploads that rename. Null until the image has been fetched. */
  imagePhash: z.string().nullable(),
  twitter: z.string().nullable(),
  telegram: z.string().nullable(),
  website: z.string().nullable(),
  createdAt: TimestampSchema,
});
export type TokenMeta = z.infer<typeof TokenMetaSchema>;

export const KolTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type KolTier = z.infer<typeof KolTierSchema>;

export const KolWalletSchema = z.object({
  address: AddressSchema,
  label: z.string().min(1),
  tier: KolTierSchema,
  notes: z.string().optional(),
});
export type KolWallet = z.infer<typeof KolWalletSchema>;

// --- Signals ----------------------------------------------------------------

export const SignalNameSchema = z.enum([
  "volume_zscore",
  "unique_buyer_rate",
  "buy_pressure",
  "kol_cluster",
  "migration",
  "vamp_of_runner",
]);
export type SignalName = z.infer<typeof SignalNameSchema>;

export const SignalSchema = z.object({
  name: SignalNameSchema,
  /** Normalized against an explicit saturation point. Raw values belong in
   *  `detail`, never here. */
  value: z.number().min(0).max(1),
  /** Snapshot of the weight from thresholds.yml at evaluation time. */
  weight: z.number().min(0),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type Signal = z.infer<typeof SignalSchema>;

/**
 * Hard filters. `null` means "not yet resolved", which the safety filter treats
 * as a rejection when the matching reject rule is on — unknown must not read as
 * safe.
 */
export const SafetyFlagsSchema = z.object({
  mintAuthorityLive: z.boolean().nullable(),
  freezeAuthorityLive: z.boolean().nullable(),
  topHolderPct: z.number().min(0).max(1).nullable(),
  devHoldingPct: z.number().min(0).max(1).nullable(),
  lpBurned: z.boolean().nullable(),
});
export type SafetyFlags = z.infer<typeof SafetyFlagsSchema>;

// --- Outbound ---------------------------------------------------------------

export const NarrativeMatchSchema = z.enum(["name", "symbol", "image", "socials"]);
export type NarrativeMatch = z.infer<typeof NarrativeMatchSchema>;

export const NarrativeClusterSchema = z.object({
  parentMint: AddressSchema,
  parentSymbol: z.string(),
  similarity: z.number().min(0).max(1),
  matchedOn: z.array(NarrativeMatchSchema).min(1),
});
export type NarrativeCluster = z.infer<typeof NarrativeClusterSchema>;

export const AlertPayloadSchema = z.object({
  id: z.string().min(1),
  mint: AddressSchema,
  meta: TokenMetaSchema,
  score: z.number().min(0).max(100),
  signals: z.array(SignalSchema),
  safety: SafetyFlagsSchema,
  kols: z.array(KolWalletSchema),
  narrativeCluster: NarrativeClusterSchema.nullable(),
  /**
   * Wall clock at emission — the one deliberate exception to the block-time
   * rule. `triggeredAt - earliestEventAt` is detection latency: how long Argus
   * took from the first contributing event to putting a panel on the wall. If
   * both were block time the difference would measure the market, not us.
   */
  triggeredAt: TimestampSchema,
  /** Block time of the earliest event that contributed to this alert. */
  earliestEventAt: TimestampSchema,
});
export type AlertPayload = z.infer<typeof AlertPayloadSchema>;

/** High frequency — this is the bulk of socket traffic. Keep it small. */
export const PanelTickSchema = z.object({
  mint: AddressSchema,
  blockTime: TimestampSchema,
  priceSol: z.number().nonnegative(),
  volumeSol1m: z.number().nonnegative(),
  buyers1m: z.number().int().nonnegative(),
  score: z.number().min(0).max(100),
});
export type PanelTick = z.infer<typeof PanelTickSchema>;

// --- Socket frames ----------------------------------------------------------

/**
 * What the gateway sends a browser.
 *
 * The bus carries alerts and ticks on separate Redis channels; one socket
 * carries both, so the frame has to say which it is. This lives in the contract
 * rather than in the gateway because it crosses a process boundary just like
 * everything else here.
 */
export const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("alert"), data: AlertPayloadSchema }),
  z.object({ type: z.literal("tick"), data: PanelTickSchema }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// --- Constants --------------------------------------------------------------

/** Redis pub/sub channels. Import these; never inline a channel name. */
export const CHANNELS = {
  trades: "argus:stream:trades",
  mints: "argus:stream:mints",
  migrations: "argus:stream:migrations",
  alerts: "argus:alerts",
  ticks: "argus:ticks",
} as const;
export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Redis key builders. Import these; never inline a key string.
 *
 * Every window is a sorted set scored by block time. Evict with
 * ZREMRANGEBYSCORE rather than a TTL so window boundaries stay exact.
 */
export const KEYS = {
  /** zset, score = blockTime, member = `${signature}:${index}`. */
  tradeWindow: (mint: Address) => `argus:w:trades:${mint}`,
  /** zset, score = blockTime, member = buyer address. */
  buyerWindow: (mint: Address) => `argus:w:buyers:${mint}`,
  /** zset, score = blockTime, member = KOL address. */
  kolWindow: (mint: Address) => `argus:w:kols:${mint}`,
  tokenMeta: (mint: Address) => `argus:meta:${mint}`,
  safety: (mint: Address) => `argus:safety:${mint}`,
  /** zset of active runners, score = expiry. Vamp candidates match against it. */
  runners: () => "argus:runners",
  cooldown: (mint: Address) => `argus:cooldown:${mint}`,
  /** Last emitted score, for the escalation-delta check. */
  lastScore: (mint: Address) => `argus:score:${mint}`,
  slotCursor: (source: string) => `argus:cursor:${source}`,
} as const;
