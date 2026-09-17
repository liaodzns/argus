# Argus v2 — proposed direction

Proposed replacement for `CLAUDE.md`. Nothing here is in force yet. On approval
this folds into `CLAUDE.md` and `NOTES.md` keeps its record of how we got here.

---

## 1. Why change

The v1 design required seeing every pump.fun trade. Measured on mainnet,
2026-09-17, over a 30-second window on the pump.fun program:

| Measure | Value |
|---|---|
| Transactions per second | 460 |
| Per day | ~40,000,000 |
| Failed on chain | 88% |
| Successful swaps per second | ~49 |

The architecture spends one `getTransaction` per candidate signature. That is
roughly **4.2 million RPC calls a day** just to keep up, before any enrichment.
No free tier survives that and no paid tier makes it cheap. The rate limiting
is not a tuning problem, it is the design.

Worse, almost all of that work is wasted. We decode 40 million transactions to
surface a handful of tokens, and the operator only ever cares about the ones
they actually hold.

**The pivot inverts the question.** Instead of watching everything and hoping
something interesting appears, watch one wallet and react to what it does.

---

## 2. What Argus becomes

> Argus watches your wallet. When you buy a pump.fun token it locks onto that
> token's narrative, and tells you when somebody else starts stealing it.

The trade this protects against: you buy the original, a redeploy with the same
name and ticker spawns, attention moves to the redeploy, and the original bleeds
out while you are still holding it. You want to know that is happening while
there is still an exit.

This keeps the interesting half of v1 — vamp clustering — and deletes the
expensive, generic half. Vamp detection stops being step 9 and becomes the
product.

### Design principle

**This is a tool, not a product.** It exists to make one decision easier for one
person. Every feature earns its place against that, and where a simpler version
would work, the simpler version wins.

Concretely: track forward from the buy and do not reconstruct history. Do not
add state that only pays off in a case that has not happened. Do not generalise
for users who do not exist. When in doubt, build less.

**Still read-only.** Watching your own wallet is an address subscription. No
keys, no signing, no execution, ever. Argus tells you; you act on Axiom.

---

## 3. How it works

### Timing

The vamps that matter spawn **within about a minute of the parent coin's
deployment**. That is bot behaviour reacting to a launch that starts moving, not
people noticing a narrative hours later. This is the operator's own observation
from trading it, and it sets the shape of everything below.

The watch is therefore short and intense rather than long and patient, and
detection has to be close to instant. That is why every stage is push-based
rather than polled.

Five stages. Note what each one costs.

**1. Watch the wallet.** `logsSubscribe { mentions: [YOUR_WALLET] }`. Fires only
on your transactions, a few dozen a day. Decode with the existing balance-delta
decoder to get mint, side and size.
*Cost: one `getTransaction` per trade you make.*

**2. Open a watch, in memory.** A buy opens a watch on that mint. Your sell
closes it, and so does the window expiring.

Nothing is persisted and nothing is reconciled against on-chain balances. The
operator closes out of positions, and has other tools for anything held longer
than an hour, so a watch is a short-lived timer rather than a durable position.
A restart losing its watches is acceptable: the risk window it was covering has
passed anyway.

This deletes a whole category of work — balance reads, token account
subscriptions, dust thresholds, restart reconciliation — that only pays off for
holds this tool is not for.

The window length is `watch.window_seconds` in `config/thresholds.yml`, hot
reloaded, defaulting to three minutes. Expiry is swept on a five-second tick, so
a watch closes within that of its deadline; against a window measured in minutes
the granularity does not matter.

**3. Capture the narrative.** Name, symbol, and image for the token you bought.
*Cost: one metadata lookup, cached.*

**4. Match new mints against the position, forward only.** From the moment you
buy, every new pump.fun creation is compared against your token's narrative.
PumpPortal's free `subscribeNewToken` feed delivers ~31 creations a minute with
`mint`, `name`, `symbol`, `uri` and `bondingCurveKey` inline.

The rule is the **best of four cross-field pairings**, not a weighted sum
requiring both fields to agree: parent name against clone name, ticker against
ticker, and both crossings. A real recorded wave settles this — one clone used
the ticker `CUPCAKE` with the name `thursdayarena`, so the ticker carried no
signal at all and the name carried everything. Either field alone is enough.

Each pairing is normalised hard first (case, accents, emoji, punctuation,
filler words, spacing), then scored with Jaro-Winkler whose prefix bonus suits
the common append-something clone. Normalisation does nearly all the work:
exact-match-after-normalisation finds 6.03 of the 6.14 mean matches a 0.85
threshold finds. An identical metadata URI matches outright, for free.

**Forward only.** Nothing is buffered and no attempt is made to catch a vamp
that spawned before the buy landed. Carrying a rolling window of recent
creations to cover that case costs more than the case is worth.
*Cost: free. No key, no RPC, no image fetching.*

**5. Watch the suspects, and your own token.** One
`logsSubscribe { mentions: [mint] }` per monitored token, which is
venue-agnostic by construction: the mint never changes while the bonding curve
and the AMM pool do, so the same subscription follows a token across bonding
with no switchover logic. Pre-bond and post-bond are therefore one mechanism,
not two.

This replaced an attempt to read reserves out of the curve and pool accounts.
PumpSwap's pool account holds no reserves at all, they live in separate vaults,
and the curve's values did not reconcile with the creation feed's own figures.
Guessing at either layout produces a confident chart at the wrong magnitude.

Two tiers, because they cost very differently:

- **Free.** Every notification forwarded as `MintActivity`. Exact trade count
  and landed ratio, no RPC calls, identical on both venues. Verified: 360
  notifications over 45 seconds on a post-bond token, zero `getTransaction`.
- **Paid, rate-limited.** One decoded trade per mint per
  `monitor.price_sample_ms`, giving price and an estimated SOL volume. A hot
  clone does ~7 landed trades a second, so decoding everything during a wave
  would need hundreds of calls a second and fall behind exactly when it matters.

Direction is not free either: one mint surfaced seventeen different trade
instruction names plus aggregator traffic where a `Swap` could go either way, so
counting `Buy` and `Sell` log lines would miss most of the volume.

Which mints to hold is decided by the engine, which writes a set to Redis that
ingest polls and diffs. No control channel, no re-announce protocol, and either
process can restart without intervention.

**6. Ask who is buying the clone, for free.** Subscribe to the 230 roster
wallets permanently, alongside the clone mints. Both are `mentions` filters, so
a transaction touching a roster wallet *and* a clone is delivered twice with the
same signature. Joining on that signature proves a tracked wallet traded that
clone with no `getTransaction` at all.

Verified: 100% of one mint's transactions also appeared in a second
subscription's stream, and 255 subscriptions held on a single socket with no
failures.

Only a joined signature gets decoded, because the join proves the wallet traded
the clone but not in which direction, and a tracked wallet *exiting* a clone is
not a vamp signal. That is rare by construction: it needs both halves at once.
Measured over 70 seconds of live operation with 230 roster wallets and 25 clones
monitored, 259 roster transactions produced zero joins and zero decodes.
*Cost: proportional to danger rather than to activity.*

### The alert condition

A vamp existing is not the signal; same-name collisions happen all day and
almost all of them die within a minute.

**The alert is about your position, not about the clone.** `AlertPayload` is
keyed on the token you hold and carries its clones as evidence, because that is
the direction the decision runs. A 25-clone wave is one alert with 25 entries
rather than 25 alerts about tokens you do not own.

**The signal is the roster buying the clone.** Those 230 wallets are the ones
whose entries move attention, so their buys land *before* the volume those buys
cause. Volume on a vamp is a lagging confirmation of something the roster
already told you.

This is also the simpler design, not the more elaborate one. "Three of my
tracked wallets just bought the clone" is close to binary and needs no
threshold. "Is one-minute volume high enough" is a number that has to be tuned
against data that does not exist yet, and tuned again per market condition.
Keeping the roster removes a tuning problem rather than adding machinery.

Volume stays as a secondary confirmation and a tiebreak, not the trigger. Tier
weighting from the roster applies here exactly as it was specified for v1;
every wallet is currently tier 1, so it is a flat count until they are demoted.

---

## 4. Cost, before and after

| | v1 | v2 |
|---|---|---|
| Must observe | every pump.fun transaction | one wallet, plus new mints |
| New-mint discovery | firehose decode | free PumpPortal feed |
| Price and volume | decode every trade | bonding curve account pushes |
| Roster buys | required the firehose | only on suspect mints |
| Paid provider | required, and still throttled | free tier, probably |

Reading the roster on a suspect is the **one place v2 spends real money**, so it
is worth being precise rather than optimistic.

A suspect is a token minutes old, and it is only watched while you hold the
parent. A clone that is genuinely running might do a few hundred trades in its
first two minutes; three suspects is therefore on the order of a thousand
`getTransaction` calls per vamp wave. That happens on days you trade, not
continuously. Against v1's ~4,200,000 a day it is nothing, but it is not zero
and it is the number to measure first.

Two ways to bring it down if it bites. Gate the roster lookup behind bonding
curve flow, so a suspect that is not moving is never fetched. Or move to
Helius' `transactionSubscribe`, which streams full transactions filtered by
account and removes the per-trade fetch entirely — a paid feature, and the
honest upgrade path if this ever becomes the constraint.

---

## 5. Repository: overhaul, not restart

**Overhaul in place, on a branch.** Roughly two thirds of the code carries over,
and most of what carries is the part that was expensive to get right.

**Carries over unchanged**

- `decode/swap.ts` — still needed to read your own fills. The hardest-won code
  in the repo, and it survives the pivot intact.
- `shared/programs.ts` — verified program ids.
- `streams/reconnect.ts` — backoff and silence watchdog.
- `windows.ts` — block-time rolling aggregates.
- `scripts/replay.ts` — more valuable now, not less.
- Gateway fan-out, the chart panel, the Axiom deep link.

**Reshaped**

- The type contract. `TradeEvent` and `TokenMeta` stand. `AlertPayload` changes
  meaning from "this token is running" to "your position is being vamped".
  `KolWallet` becomes a single watched address.
- The engine. Position tracking replaces scoring across all tokens.
- The panel. It shows your token against its suspected vamps, side by side,
  rather than one token in isolation.

**Deleted**

- `volume_zscore`, `unique_buyer_rate`, `buy_pressure` as global signals. Volume
  still matters, but only on a suspect you are already watching.
- The firehose ingest path.

**Kept, and repurposed**

- **The 230-wallet roster and the `kol_cluster` signal.** These were only
  expensive in v1 because spotting a roster buy meant reading every trade on
  the chain. In v2 the question is asked of three or four fresh mints for a few
  minutes, which costs almost nothing. `buildRoster`, `observeKolTrade` and the
  KOL window survive intact; what changes is the question they answer. v1 asked
  "are the KOLs buying anything interesting". v2 asks "are the KOLs buying the
  clone of what I hold", which is the question that was worth asking all along.

A new repository would throw away the verified program ids, the decoder, the
replay harness, and the record in `NOTES.md` of what we already learned the hard
way. There is nothing to gain.

---

## 6. Settled, and still open

**Settled.**

- **Watch the Axiom trading wallet**, not the funding wallet. That is where the
  buys execute. The address itself is still needed before step 1.
- **Forward only from the buy.** No backward matching, no buffer of recent
  creations.
- **Vamps land within ~60s of the parent's deployment**, so the risk window is
  the first few minutes after the buy, not the whole holding period.
- **The roster stays, and its buys are free.** Primary signal on a clone, via a
  signature join across two subscription streams. Volume is confirmation as a
  share of combined trade rate; an absolute threshold stays deferred.
- **The alert is keyed on your position**, carrying `clones[]`.
  `NarrativeCluster` is gone: it pointed the wrong way for v2 and had no
  producer.
- **No persistence and no restart recovery.** A watch is a timer, not a
  position. The operator closes out and monitors longer holds elsewhere.
- **Monitoring keys on the mint, never on a venue account.** That is what makes
  pre-bond and post-bond one mechanism. Reading curve or pool layouts is
  abandoned; see stage 5.
- **The watch window is `watch.window_seconds`**, default 180. Short by nature,
  with margin because closing early is the expensive direction.
- **Matching is `narrative.min_similarity`**, default 0.90, and
  `narrative.min_length`, default 3. The threshold is insensitive; the length
  guard is not optional, because blank names are real and score 1.0 against
  each other.
- **`MintEvent` carries `observedAt`, not `slot` or `blockTime`.** The creation
  feed has no chain timestamp. `eventTime()` in shared is the only place that
  decides which timestamp an event is ordered by.

**Still open.**

**What happens when your token migrates?** Settled: nothing. Monitoring keys on
the mint, which does not change when a token bonds, so there is no switchover to
get wrong. Unverified only because a token bonding mid-watch cannot be summoned.

**Superseded question:** Once the bonding curve completes,
liquidity moves to PumpSwap and the curve account stops being the price source.
A migrated position needs a different reader. Vamps themselves are always fresh,
so they stay on the curve.

**Do we keep four processes?** The ingest and engine split was justified by
throughput we no longer have. Two processes would be honest for a tool this
size. Four still buys independent restarts and reads as deliberate. This is a
judgement call about whether the repository is still meant to double as a
portfolio piece, and that is yours to make.

---

## 7. Known limits

- **Only pump.fun launches are seen.** A vamp deployed elsewhere is invisible.
  Acceptable for v1, worth stating.
- **Same-name collisions are constant.** Generic tickers repeat all day. Expect
  false positives until the relative-flow gate is tuned.
- **This is a sell-side signal now.** A missed alert costs real money and a late
  one is worthless, which is why every stage above is push-based rather than
  polled.
- **A vamp that spawned before your buy is invisible.** Accepted deliberately;
  see the design principle.
- **Not financial advice, and not an execution path.** Argus never holds a key
  and never places an order.

---

## 8. Build order

Each step keeps a verification gate. Same discipline as before.

1. **Watch the wallet.** Subscribe, decode your own fills, print them.
   *Gate:* you buy something, it appears in the terminal within seconds.
2. **Watches.** Open on buy, close on your sell or on the window expiring.
   In memory, no persistence.
   *Gate:* a buy opens a watch in the log, a sell closes it, and an untouched
   watch closes itself when the window runs out.
3. **Narrative capture and the new-mint feed.** From your buy forward, match new
   creations against the position and log the matches.
   *Gate:* a same-ticker redeploy spawned after your buy is identified.
4. **Price and flow.** One log subscription per mint, free activity counting
   plus rate-limited price sampling, covering pre-bond and post-bond alike.
   *Gate:* price agrees with an independent source, and independently decoded
   buys and sells agree with each other at the same moment.
5. **The alert.** Roster buys on a clone trigger it; trade-rate share confirms.
   *Gate:* the same recorded wave fires with roster buys and stays silent
   without them.
6. **The panel.** Your position against its suspects, one screen, Axiom link.
   *Gate:* you can decide in under three seconds.

Step 5 is the one that needs real recorded sessions, and it is the reason the
replay harness survives the pivot.
