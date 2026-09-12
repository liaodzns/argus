/**
 * The entire Axiom integration.
 *
 * Axiom has no official public API. Every third-party SDK claiming otherwise is
 * reverse-engineered: they drive headless Chrome to defeat Cloudflare Turnstile
 * and ask for an account password plus IMAP credentials to read login OTPs out
 * of an inbox. None of that goes anywhere near this project.
 *
 * A deep link delivers the same workflow — see it here, act on it there — with
 * none of the risk, and it is one function.
 */
export function axiomLink(mint: string): string {
  return `https://axiom.trade/meme/${encodeURIComponent(mint)}`;
}
