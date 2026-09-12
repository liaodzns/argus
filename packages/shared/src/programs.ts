/**
 * pump.fun program IDs.
 *
 * Verified against mainnet on 2026-09-10, not copied from a blog post. A wrong
 * id fails silently — the filter matches nothing and it reads as a connection
 * problem — so both were read off real transactions:
 *
 *   PUMP_FUN   top-level program of a token creation in slot 445994548
 *              (signature 3kiACFvXBcQgV8nqfRBXyHxXExKRJ8QcXqQbhNyKyvwRM5Lc…)
 *   PUMP_SWAP  invoked as an inner instruction of the migration that moved
 *              41hFTAVkXc3hAThWKeqtucLMfLucxwLn9dANQShSpump to the AMM in
 *              slot 445994886
 *
 * These live beside the type contract rather than in config/ because they are
 * compile-time constants, not operator tuning. Nothing in config/ that is not
 * hot-reloadable belongs there, and a wrong program id is not something you
 * want editable without a redeploy.
 */
export const PROGRAMS = {
  /** Bonding curve — pre-migration trades. */
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  /** PumpSwap AMM — post-migration trades. */
  PUMP_SWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
} as const;

/** Subscribe to both. A token that migrates mid-session must not vanish from
 *  the wall just because its trades moved to a different program. */
export const WATCHED_PROGRAMS: readonly string[] = [PROGRAMS.PUMP_FUN, PROGRAMS.PUMP_SWAP];
