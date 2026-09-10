/**
 * pump.fun program IDs.
 *
 * VERIFY THESE BEFORE RELYING ON THEM. Program IDs are the single most common
 * thing to get subtly wrong, and a wrong ID fails silently — your filter simply
 * matches nothing and you spend an evening debugging the gRPC connection.
 *
 * To confirm: open any pump.fun swap on solscan.io and read the invoked program
 * off the transaction. Do that once, now, before writing decode logic.
 */
export const PROGRAMS = {
  /** Bonding curve — pre-migration trades. */
  PUMP_FUN: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  /** PumpSwap AMM — post-migration trades. */
  PUMP_SWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
} as const;

/** Subscribe to both. A token that migrates mid-session must not vanish from
 *  the wall just because its trades moved to a different program. */
export const WATCHED_PROGRAMS = [PROGRAMS.PUMP_FUN, PROGRAMS.PUMP_SWAP];
