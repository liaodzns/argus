/**
 * Narrative matching.
 *
 * Decides whether a new launch is a clone of something you hold. Measured
 * against 123 real launches captured on 2026-09-17, which happen to contain a
 * genuine vamp wave: "Thursday Arena" spawned ~25 clones in four minutes with
 * the ticker mutating across THURSDAY, THURSDAYARENA and CUPCAKE while the name
 * stayed recognisable. See `fixtures/README.md`.
 *
 * Two things that sample settled:
 *
 * Normalisation does almost all the work. Matching only on exact equality after
 * normalisation found 6.03 of the 6.14 mean matches that a 0.85 similarity
 * threshold found. The fuzzy layer is worth keeping for a wave that renames more
 * creatively, but it is not what makes this work, and it is not worth tuning.
 *
 * The result is bimodal, which is the real signal. Half of all launches match
 * nothing at all; a wave member matches about twenty-six. The gap between those
 * two states is what a threshold has to sit in, and almost any value does.
 */
import type { MintEvent, NarrativeMatch, TokenMeta } from "@argus/shared";

/**
 * Filler that clones add or drop freely, so it must not count as a difference.
 * Deliberately short: over-stripping turns distinct tokens into collisions.
 */
const FILLER = /\b(?:coin|token|sol|solana|official|the|v2|ii)\b/g;
const TRAILING_VERSION = /\b\d+\s*\.\s*\d+\b/g;

/**
 * Reduce a name or ticker to its recognisable core.
 *
 * Case, emoji, punctuation, accents and spacing are all things a clone varies
 * without changing what it is pretending to be. NFKD decomposition also folds
 * the lookalike characters used to dodge exact-match filters.
 */
export function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(TRAILING_VERSION, " ")
    .replace(FILLER, " ")
    .replace(/\s+/g, "")
    .trim();
}

/** Jaro similarity. */
function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aUsed = new Array<boolean>(a.length).fill(false);
  const bUsed = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bUsed[j] || a[i] !== b[j]) continue;
      aUsed[i] = true;
      bUsed[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aUsed[i]) continue;
    while (k < b.length && !bUsed[k]) k++;
    if (a[i] !== b[k]) transpositions += 1;
    k++;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

/**
 * Jaro-Winkler. The prefix bonus is the point: the most common clone keeps the
 * original and appends to it, so a shared start matters more than a shared end.
 */
export function jaroWinkler(a: string, b: string): number {
  const base = jaro(a, b);
  if (base < 0.7) return base;
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  return base + prefix * 0.1 * (1 - base);
}

export interface NarrativeConfig {
  /** Similarity at or above which a pairing counts as a match. */
  minSimilarity: number;
  /** Shortest normalised string worth comparing. */
  minLength: number;
}

export interface NarrativeMatchResult {
  similarity: number;
  matchedOn: NarrativeMatch[];
}

/**
 * Compare a launch against the token you hold.
 *
 * Every pairing of the two fields is tried, in both directions, and the best
 * wins. Requiring name *and* ticker to agree would have missed the real wave
 * outright: one of its clones used the ticker CUPCAKE with the name
 * thursdayarena, so the ticker carried no signal and the name carried all of it.
 * Either field alone is enough.
 *
 * An identical metadata URI short-circuits to 1. Two launches pointing at the
 * same metadata are the same token described twice, and it costs no network
 * call to notice.
 *
 * `matchedOn` names which of *your* token's fields was recognised in the clone,
 * not which pair of fields happened to line up. When the real wave's CUPCAKE
 * clone is matched, both `name` and `symbol` are reported because both the
 * parent's name and its ticker turn up inside the clone's name field. Read it
 * as "this is what was recognisable", never as "both fields are identical".
 */
export function matchNarrative(
  parent: Pick<TokenMeta, "name" | "symbol"> & { uri?: string | undefined },
  launch: Pick<MintEvent, "name" | "symbol" | "uri">,
  config: NarrativeConfig,
): NarrativeMatchResult | null {
  const matchedOn: NarrativeMatch[] = [];

  if (parent.uri !== undefined && parent.uri.length > 0 && parent.uri === launch.uri) {
    return { similarity: 1, matchedOn: ["metadata"] };
  }

  const pairings: Array<[NarrativeMatch, string, string]> = [
    ["name", parent.name, launch.name],
    ["symbol", parent.symbol, launch.symbol],
    ["name", parent.name, launch.symbol],
    ["symbol", parent.symbol, launch.name],
  ];

  let best = 0;
  for (const [field, left, right] of pairings) {
    const a = normalize(left);
    const b = normalize(right);
    // A blank or near-blank field scores 1.0 against another blank one and would
    // match everything. Real launches with no name exist — eight of the sampled
    // 123 — so this guard is load-bearing, not defensive.
    if (a.length < config.minLength || b.length < config.minLength) continue;
    const score = jaroWinkler(a, b);
    if (score < config.minSimilarity) continue;
    best = Math.max(best, score);
    if (!matchedOn.includes(field)) matchedOn.push(field);
  }

  if (matchedOn.length === 0) return null;
  return { similarity: best, matchedOn };
}
