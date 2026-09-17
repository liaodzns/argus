/**
 * Environment and file-backed configuration.
 *
 * Kept out of the package's main entry point on purpose: this module touches
 * node:fs, and the web package must be able to import the type contract without
 * dragging Node built-ins into a browser bundle. Node services import it as
 * `@argus/shared/config`.
 */
import { basename, dirname, resolve } from "node:path";
import { readFileSync, watch } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { KolWalletSchema } from "./events.js";

// --- Environment ------------------------------------------------------------

/** A blank value in a .env file means absent, not empty. */
const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const EnvSchema = z
  .object({
    // Solana data
    HELIUS_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
    LASERSTREAM_ENDPOINT: z.preprocess(blankToUndefined, z.string().url().optional()),
    /** Left blank, both are derived from HELIUS_API_KEY below. */
    SOLANA_RPC_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
    SOLANA_WS_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
    INGEST_SOURCE: z.preprocess(
      blankToUndefined,
      z.enum(["laserstream", "helius_logs"]).default("helius_logs"),
    ),

    // Enrichment
    BIRDEYE_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),

    // Infra
    REDIS_URL: z.preprocess(blankToUndefined, z.string().min(1).default("redis://localhost:6379")),
    DATABASE_URL: z.preprocess(
      blankToUndefined,
      z.string().min(1).default("postgres://argus:argus@localhost:5432/argus"),
    ),
    GATEWAY_PORT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(65535).default(8080),
    ),
    NEXT_PUBLIC_WS_URL: z.preprocess(
      blankToUndefined,
      z.string().min(1).default("ws://localhost:8080/ws"),
    ),

    /**
     * The wallet Argus watches. For Axiom this is its trading wallet, which is
     * not the funding wallet you would name first. Public address, not a
     * secret, but user-specific so it stays out of the repository.
     */
    WATCHED_WALLET: z.preprocess(
      blankToUndefined,
      z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "expected a base58 Solana address").optional(),
    ),

    // Where thresholds.yml lives.
    ARGUS_CONFIG_DIR: z.preprocess(blankToUndefined, z.string().min(1).default("./config")),
  })
  .transform((env) => ({
    ...env,
    // Both endpoints are the same host with the key as a query parameter, so
    // deriving them keeps one secret in .env instead of three copies of it.
    SOLANA_RPC_URL:
      env.SOLANA_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY ?? ""}`,
    SOLANA_WS_URL:
      env.SOLANA_WS_URL ?? `wss://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY ?? ""}`,
  }));
export type Env = z.infer<typeof EnvSchema>;

export interface LoadEnvOptions {
  /**
   * Demand the credentials needed to open a chain stream.
   *
   * Only ingest opens one. The engine, the gateway and the replay tool all run
   * happily without a provider key, and making them carry one means a dummy
   * value in every .env that does not ingest — which is how a required secret
   * quietly becomes a meaningless one.
   */
  requireChainSource?: boolean;
}

/** Throws on invalid environment. Call once at process start, fail loud. */
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
  options: LoadEnvOptions = {},
): Env {
  const env = EnvSchema.parse(source);
  if (options.requireChainSource !== true) return env;

  const required: Array<"HELIUS_API_KEY" | "LASERSTREAM_ENDPOINT"> = ["HELIUS_API_KEY"];
  // LaserStream needs its own endpoint on top of the key; helius_logs derives
  // both of its URLs from the key alone.
  if (env.INGEST_SOURCE === "laserstream") required.push("LASERSTREAM_ENDPOINT");
  const issues: z.ZodIssue[] = required
    .filter((key) => env[key] === undefined)
    .map((key) => ({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `${key} is required when INGEST_SOURCE=${env.INGEST_SOURCE}`,
    }));
  // A ZodError so every caller's existing error formatting still applies.
  if (issues.length > 0) throw new z.ZodError(issues);
  return env;
}

/** True when metadata can fall back to Helius DAS for mints DexScreener has not indexed. */
export const hasChainCredentials = (env: Env): boolean => env.HELIUS_API_KEY !== undefined;

export interface ConfigPaths {
  dir: string;
  thresholds: string;
  kolWallets: string;
}

export function configPaths(env: Pick<Env, "ARGUS_CONFIG_DIR">): ConfigPaths {
  const dir = resolve(env.ARGUS_CONFIG_DIR);
  return {
    dir,
    thresholds: resolve(dir, "thresholds.yml"),
    kolWallets: resolve(dir, "kol-wallets.json"),
  };
}

// --- thresholds.yml ---------------------------------------------------------

const Weight = z.number().min(0).max(1);
const Seconds = z.number().int().positive();
const Fraction = z.number().min(0).max(1);

export const ThresholdsSchema = z.object({
  windows: z.object({
    short: Seconds,
    medium: Seconds,
    /** Trailing baseline the short window is compared against for the z-score. */
    baseline: Seconds,
  }),
  signals: z.object({
    volume_zscore: z.object({
      weight: Weight,
      /** Floor. Without it every dead token with three trades scores infinite. */
      min_volume_sol: z.number().nonnegative(),
      saturate_at: z.number().positive(),
    }),
    unique_buyer_rate: z.object({
      weight: Weight,
      saturate_at: z.number().positive(),
      exclude_common_funder: z.boolean(),
    }),
    buy_pressure: z.object({
      weight: Weight,
      neutral: Fraction,
      saturate_at: Fraction,
    }),
    kol_cluster: z.object({
      weight: Weight,
      /** One wallet is noise. This is why the signal has a floor. */
      min_distinct: z.number().int().positive(),
      saturate_at: z.number().positive(),
      tier_multipliers: z.object({
        "1": z.number().min(0),
        "2": z.number().min(0),
        "3": z.number().min(0),
      }),
    }),
    migration: z.object({
      weight: Weight,
      decay_seconds: Seconds,
    }),
    vamp_of_runner: z.object({
      weight: Weight,
      runner_score: z.number().min(0).max(100),
      runner_ttl: Seconds,
      min_similarity: Fraction,
      candidate_max_age: Seconds,
    }),
  }),
  safety: z.object({
    reject_if_mint_authority_live: z.boolean(),
    reject_if_freeze_authority_live: z.boolean(),
    max_top_holder_pct: Fraction,
    max_dev_holding_pct: Fraction,
    require_resolvable_metadata: z.boolean(),
  }),
  alerting: z.object({
    min_score: z.number().min(0).max(100),
    cooldown_seconds: Seconds,
    escalation_delta: z.number().min(0).max(100),
  }),
  wall: z.object({
    max_panels: z.number().int().positive(),
    evict_below: z.number().min(0).max(100),
    panel_ttl_seconds: Seconds,
  }),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export function loadThresholds(path: string): Thresholds {
  return ThresholdsSchema.parse(parseYaml(readFileSync(path, "utf8")));
}

// --- kol-wallets.json -------------------------------------------------------

/** Unknown keys are stripped, which is how the file's `$comment` survives. */
export const KolWalletsFileSchema = z.object({
  wallets: z.array(KolWalletSchema),
});
export type KolWalletsFile = z.infer<typeof KolWalletsFileSchema>;

export function loadKolWallets(path: string): KolWalletsFile {
  return KolWalletsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

// --- Hot reload -------------------------------------------------------------

export interface ConfigHandle<T> {
  readonly current: T;
  /** Returns an unsubscribe function. */
  onChange(listener: (next: T) => void): () => void;
  close(): void;
}

export interface WatchOptions {
  /** A single editor save emits several fs events. Coalesce them. */
  debounceMs?: number;
  /** Called when a reload fails. The previous value is kept. */
  onError?: (error: unknown, path: string) => void;
}

/**
 * Watch a config file and re-parse it on change.
 *
 * The initial load throws — a broken config at boot should stop the process.
 * A failed *reload* does not: it reports through `onError` and keeps the last
 * good value. An engine mid-session on a live stream must not die because of a
 * typo in thresholds.yml, and hot reload that crashes on a bad edit is worse
 * than no hot reload at all.
 */
export function watchConfigFile<T>(
  path: string,
  load: (path: string) => T,
  options: WatchOptions = {},
): ConfigHandle<T> {
  const target = resolve(path);
  const name = basename(target);
  const debounceMs = options.debounceMs ?? 150;

  let current = load(target);
  const listeners = new Set<(next: T) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reload = (): void => {
    timer = undefined;
    let next: T;
    try {
      next = load(target);
    } catch (error) {
      options.onError?.(error, target);
      return;
    }
    current = next;
    for (const listener of listeners) listener(next);
  };

  // Watch the directory, not the file. Editors save by writing a temp file and
  // renaming over the target, which detaches an inode-bound watcher after the
  // first save — the classic "hot reload worked once" bug.
  const watcher = watch(target === "" ? "." : dirname(target), (_event, filename) => {
    if (filename !== null && basename(filename.toString()) !== name) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  });
  watcher.unref();

  return {
    get current(): T {
      return current;
    },
    onChange(listener: (next: T) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
      listeners.clear();
    },
  };
}

export const watchThresholds = (path: string, options?: WatchOptions): ConfigHandle<Thresholds> =>
  watchConfigFile(path, loadThresholds, options);

export const watchKolWallets = (
  path: string,
  options?: WatchOptions,
): ConfigHandle<KolWalletsFile> => watchConfigFile(path, loadKolWallets, options);
