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

/**
 * A new token launch.
 *
 * Shaped to its only producer, PumpPortal's free creation feed, which carries
 * no slot and no block time. Those fields were specified for a chain-derived
 * source and lost their producer when the firehose was deleted, so rather than
 * carry two fields nothing can fill, this records when the launch was observed
 * and says so.
 *
 * `observedAt` is wall clock, the second documented exception to the block-time
 * rule after `AlertPayload.triggeredAt`. It is honest for what it is: the
 * moment this process heard about the launch, not the moment it happened.
 * Nothing downstream may treat it as chain time or put it in a rolling window.
 */
export const MintEventSchema = z.object({
  kind: z.literal("mint"),
  mint: AddressSchema,
  signature: SignatureSchema,
  creator: AddressSchema,
  name: z.string(),
  symbol: z.string(),
  /** Off-chain metadata URI. Two launches sharing one are byte-identical. */
  uri: z.string(),
  /** Bonding curve account, free from the feed. Step 4 subscribes to it. */
  bondingCurve: AddressSchema,
  observedAt: TimestampSchema,
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

/**
 * A transaction touched a mint we are watching.
 *
 * This is the free tier of price and flow monitoring: a log notification
 * forwarded as-is, with no transaction fetched. It gives an exact trade count
 * and the landed-versus-failed ratio for any token, on the bonding curve or on
 * the AMM, because it keys on the mint rather than on a venue-specific account.
 *
 * It deliberately carries no amount and no direction. Neither is readable from
 * a log notification: one sampled mint surfaced seventeen different trade
 * instruction names plus aggregator traffic where a `Swap` could go either way,
 * so counting `Buy` and `Sell` lines would miss most of the volume. Amounts and
 * direction require a decode, which is the paid tier.
 *
 * `observedAt` is arrival wall clock, like `MintEvent.observedAt`, because a
 * notification has no chain timestamp. It must never share a rolling window
 * with block-time events.
 */
export const MintActivitySchema = z.object({
  kind: z.literal("activity"),
  mint: AddressSchema,
  signature: SignatureSchema,
  landed: z.boolean(),
  observedAt: TimestampSchema,
});
export type MintActivity = z.infer<typeof MintActivitySchema>;

export const StreamEventSchema = z.discriminatedUnion("kind", [
  TradeEventSchema,
  MintEventSchema,
  MigrationEventSchema,
  MintActivitySchema,
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

/** `metadata` means an identical metadata URI, so the two are byte-identical. */
export const NarrativeMatchSchema = z.enum([
  "name",
  "symbol",
  "metadata",
  "image",
  "socials",
]);
export type NarrativeMatch = z.infer<typeof NarrativeMatchSchema>;

/**
 * A launch that is impersonating something you hold.
 *
 * Replaces v1's `NarrativeCluster`, which pointed the other way: there an alert
 * was about a clone and named its parent. Here the alert is about your position
 * and names its clones, because that is the direction the decision runs. A
 * 25-clone wave is one alert with 25 of these rather than 25 alerts about
 * tokens you do not own.
 *
 * `rosterBuys` is the trigger and `tradesPerMin` is the confirmation.
 * `priceSol` is null until a sample has been decoded for this mint.
 */
export const CloneSchema = z.object({
  mint: AddressSchema,
  symbol: z.string(),
  name: z.string(),
  similarity: z.number().min(0).max(1),
  /** Which of your token's fields was recognisable in this one. */
  matchedOn: z.array(NarrativeMatchSchema).min(1),
  /** Distinct tracked wallets that BOUGHT this clone. Sells do not count. */
  rosterBuys: z.number().int().nonnegative(),
  rosterWallets: z.array(AddressSchema),
  /** Exact, from free activity notifications. */
  tradesPerMin: z.number().nonnegative(),
  priceSol: z.number().nonnegative().nullable(),
  firstSeenAt: TimestampSchema,
});
export type Clone = z.infer<typeof CloneSchema>;

/**
 * The alert, and it is about the token you hold.
 *
 * `mint` and `meta` are your position, not the clone. You act on your position,
 * so that is what the payload is keyed on; the clones are the evidence.
 */
export const AlertPayloadSchema = z.object({
  id: z.string().min(1),
  mint: AddressSchema,
  meta: TokenMetaSchema,
  score: z.number().min(0).max(100),
  signals: z.array(SignalSchema),
  safety: SafetyFlagsSchema,
  /** Tracked wallets that bought at least one of the clones below. */
  kols: z.array(KolWalletSchema),
  /** Why this alert exists. Never empty: no clones means no alert. */
  clones: z.array(CloneSchema).min(1),
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

/**
 * High frequency — the bulk of socket traffic. Keep it small.
 *
 * Reshaped from v1, which promised `buyers1m` that nothing counts and
 * `volumeSol1m` as though it were exact. Trade rate is exact and free; the
 * volume figure is sampled size times rate and is named an estimate so nobody
 * downstream mistakes it for a sum.
 *
 * `score` is gone: a clone does not have one, and it belongs to the position.
 * `observedAt` replaces `blockTime` because the rate comes from the
 * arrival-stamped activity window, not from chain time.
 */
export const PanelTickSchema = z.object({
  mint: AddressSchema,
  observedAt: TimestampSchema,
  /** Null until a trade on this mint has been decoded. */
  priceSol: z.number().nonnegative().nullable(),
  tradesPerMin: z.number().nonnegative(),
  estimatedVolumeSolPerMin: z.number().nonnegative().nullable(),
});
export type PanelTick = z.infer<typeof PanelTickSchema>;

export const WatchCloseReasonSchema = z.enum(["sold", "expired"]);
export type WatchCloseReasonName = z.infer<typeof WatchCloseReasonSchema>;

/**
 * Everything a panel draws, republished whenever it changes.
 *
 * The screen has to exist before any alert does — it opens when you buy, so you
 * can see the watch is live rather than wondering whether the tool is running.
 * Alerts alone therefore cannot drive it.
 *
 * This overlaps `AlertPayload` on purpose, and the distinction is worth keeping:
 * this is a live view model the browser re-renders from, while an AlertPayload
 * is the durable record of something that happened. Collapsing them would force
 * either the browser to rebuild state from a stream of events, or the record to
 * carry view concerns it has no business knowing about.
 */
export const PositionStateSchema = z.object({
  mint: AddressSchema,
  /** Null while enrichment is still resolving what you bought. */
  meta: TokenMetaSchema.nullable(),
  openedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  entrySolLamports: z.number().int().nonnegative(),
  clones: z.array(CloneSchema),
  alerted: z.boolean(),
  /** Null until an alert fires. Never a placeholder. */
  score: z.number().min(0).max(100).nullable(),
  closed: z.boolean(),
  closeReason: WatchCloseReasonSchema.nullable(),
});
export type PositionState = z.infer<typeof PositionStateSchema>;

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
  z.object({ type: z.literal("position"), data: PositionStateSchema }),
  z.object({ type: z.literal("tick"), data: PanelTickSchema }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

// --- Constants --------------------------------------------------------------

/** Redis pub/sub channels. Import these; never inline a channel name. */
export const CHANNELS = {
  trades: "argus:stream:trades",
  mints: "argus:stream:mints",
  migrations: "argus:stream:migrations",
  activity: "argus:stream:activity",
  alerts: "argus:alerts",
  positions: "argus:positions",
  ticks: "argus:ticks",
} as const;
export type ChannelName = (typeof CHANNELS)[keyof typeof CHANNELS];

/**
 * Which channel an event belongs on.
 *
 * Part of the bus contract rather than a detail of whoever happens to be
 * publishing, so ingest and the replay tool cannot disagree about where a
 * migration goes.
 */
/**
 * The timestamp an event is ordered by.
 *
 * Trades and migrations carry block time. A launch carries only `observedAt`,
 * because its source has no chain timestamp. Anything that paces, sorts or
 * replays a mixed stream has to go through here rather than reaching for
 * `blockTime` and quietly excluding launches.
 */
export const eventTime = (event: StreamEvent): Timestamp => {
  switch (event.kind) {
    case "mint":
    case "activity":
      return event.observedAt;
    case "trade":
    case "migration":
      return event.blockTime;
  }
};

export const channelForEvent = (event: StreamEvent): ChannelName => {
  switch (event.kind) {
    case "trade":
      return CHANNELS.trades;
    case "mint":
      return CHANNELS.mints;
    case "migration":
      return CHANNELS.migrations;
    case "activity":
      return CHANNELS.activity;
  }
};

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
  /**
   * zset, score = **arrival** time, member = signature.
   *
   * Scored by a different clock to every other window here, because a log
   * notification has no chain timestamp. Never compare a count from this window
   * against one from a block-time window.
   */
  activityWindow: (mint: Address) => `argus:w:activity:${mint}`,
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
  /**
   * Set of mints ingest should hold log subscriptions for.
   *
   * The engine owns the contents, ingest polls and diffs. Being a set rather
   * than a message stream makes it idempotent and lets either process restart
   * without a re-announce protocol.
   */
  monitored: () => "argus:monitored",
} as const;
