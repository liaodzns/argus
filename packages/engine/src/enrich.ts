/**
 * Token metadata resolution.
 *
 * Two sources, in this order, because they fail in opposite directions.
 *
 * DexScreener is free, needs no key, and carries the image and socials that
 * vamp clustering will want at step 9. It does not carry a token until that
 * token has an indexed pair, which for a fresh pump.fun mint can be minutes —
 * exactly the window this product exists to watch.
 *
 * Helius' DAS reads the mint's own on-chain metadata, so it answers from the
 * moment the token exists. It costs plan quota, which is why it is second and
 * why both results are cached.
 *
 * An unresolvable mint returns null and the caller does not alert. That
 * anticipates the hard safety rule at step 7: a panel with no name on it is
 * not worth the space it takes on the wall.
 */
import { z } from "zod";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { KEYS, TokenMetaSchema, type Address, type TokenMeta, type Timestamp } from "@argus/shared";

const DexPairSchema = z.object({
  chainId: z.string(),
  baseToken: z.object({ address: z.string(), name: z.string(), symbol: z.string() }),
  pairCreatedAt: z.number().optional(),
  info: z
    .object({
      imageUrl: z.string().optional(),
      websites: z.array(z.object({ url: z.string() })).optional(),
      socials: z.array(z.object({ url: z.string(), type: z.string() })).optional(),
    })
    .optional(),
});
const DexResponseSchema = z.object({ pairs: z.array(DexPairSchema).nullish() });

const DasResponseSchema = z.object({
  result: z
    .object({
      content: z
        .object({
          metadata: z.object({ name: z.string().optional(), symbol: z.string().optional() }).optional(),
          links: z.object({ image: z.string().optional() }).optional(),
        })
        .optional(),
    })
    .nullish(),
});

export interface EnricherOptions {
  redis: Redis;
  logger: Logger;
  rpcUrl: string;
  /** Resolved metadata is stable; this only bounds how stale socials get. */
  ttlSeconds?: number;
  /** Short, so a mint that DexScreener has not indexed yet gets retried soon. */
  negativeTtlSeconds?: number;
}

export interface Enricher {
  resolve(mint: Address, fallbackCreatedAt: Timestamp): Promise<TokenMeta | null>;
  readonly stats: { hits: number; dexscreener: number; das: number; unresolved: number };
}

const socialUrl = (
  socials: ReadonlyArray<{ url: string; type: string }> | undefined,
  type: string,
): string | null => socials?.find((s) => s.type === type)?.url ?? null;

export function createEnricher(options: EnricherOptions): Enricher {
  const { redis, logger, rpcUrl } = options;
  const ttlSeconds = options.ttlSeconds ?? 6 * 60 * 60;
  const negativeTtlSeconds = options.negativeTtlSeconds ?? 60;
  const stats = { hits: 0, dexscreener: 0, das: 0, unresolved: 0 };

  async function fromDexScreener(mint: Address): Promise<Partial<TokenMeta> | null> {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!response.ok) return null;
    const parsed = DexResponseSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const pair = (parsed.data.pairs ?? []).find(
      (p) => p.chainId === "solana" && p.baseToken.address === mint,
    );
    if (pair === undefined) return null;
    return {
      name: pair.baseToken.name,
      symbol: pair.baseToken.symbol,
      imageUrl: pair.info?.imageUrl ?? null,
      twitter: socialUrl(pair.info?.socials, "twitter"),
      telegram: socialUrl(pair.info?.socials, "telegram"),
      website: pair.info?.websites?.[0]?.url ?? null,
      ...(pair.pairCreatedAt === undefined ? {} : { createdAt: pair.pairCreatedAt }),
    };
  }

  async function fromDas(mint: Address): Promise<Partial<TokenMeta> | null> {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }),
    });
    if (!response.ok) return null;
    const parsed = DasResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.result == null) return null;
    const content = parsed.data.result.content;
    const name = content?.metadata?.name;
    const symbol = content?.metadata?.symbol;
    if (name === undefined && symbol === undefined) return null;
    return {
      name: name ?? symbol ?? "",
      symbol: symbol ?? name ?? "",
      imageUrl: content?.links?.image ?? null,
      twitter: null,
      telegram: null,
      website: null,
    };
  }

  return {
    stats,

    async resolve(mint, fallbackCreatedAt) {
      const key = KEYS.tokenMeta(mint);
      const cached = await redis.get(key);
      if (cached !== null) {
        stats.hits += 1;
        if (cached === "") return null; // negative cache
        const parsed = TokenMetaSchema.safeParse(JSON.parse(cached));
        if (parsed.success) return parsed.data;
      }

      let partial: Partial<TokenMeta> | null = null;
      try {
        partial = await fromDexScreener(mint);
        if (partial !== null) stats.dexscreener += 1;
      } catch (error) {
        logger.debug({ mint, err: String(error) }, "dexscreener lookup failed");
      }
      if (partial === null) {
        try {
          partial = await fromDas(mint);
          if (partial !== null) stats.das += 1;
        } catch (error) {
          logger.debug({ mint, err: String(error) }, "das lookup failed");
        }
      }

      if (partial === null || partial.name === undefined || partial.symbol === undefined) {
        stats.unresolved += 1;
        await redis.set(key, "", "EX", negativeTtlSeconds);
        return null;
      }

      // createdAt falls back to the earliest block time this engine has seen for
      // the mint. That is a lower bound on its real age, not the mint time, and
      // the distinction matters to the vamp candidate window at step 9.
      const meta = TokenMetaSchema.parse({
        mint,
        name: partial.name,
        symbol: partial.symbol,
        imageUrl: partial.imageUrl ?? null,
        imagePhash: null, // computed at step 9, when clustering needs it
        twitter: partial.twitter ?? null,
        telegram: partial.telegram ?? null,
        website: partial.website ?? null,
        createdAt: partial.createdAt ?? fallbackCreatedAt,
      });
      await redis.set(key, JSON.stringify(meta), "EX", ttlSeconds);
      return meta;
    },
  };
}
