# NOTES.md

Running record of what we learned building Argus, why the code looks the way it
does, and what is going to bite later.

`CLAUDE.md` says what to build. This says what actually happened when we tried.
Where the two disagree, `CLAUDE.md` has been amended and the amendment is noted
here.

Dates are when something was verified, because several of these facts are about
third-party services that will drift.

---

## Cross-cutting decisions

Four calls that shaped the type contract and are easy to misread later as
mistakes.

**`AlertPayload.triggeredAt` is wall clock.** It is the single exception to
"block time, never `Date.now()`". `triggeredAt - earliestEventAt` is meant to be
detection latency, which is how long Argus took. If both sides were block time
the subtraction would measure how long the market took, which is not a number
anybody wants.

**`SafetyFlags` fields are nullable, and `null` means unresolved.** Not safe.
The filter at step 7 must treat null as a rejection when the matching
`reject_if_*` rule is on. Unknown reading as safe is how a wall fills with rugs.

**`TradeEvent` carries `decimals` on every trade.** It is denormalized on
purpose. The engine prices on the hot path, so a Redis lookup per trade to fetch
it from `TokenMeta` would be the wrong trade-off, and a trade arriving before
enrichment resolves would otherwise be unpriceable. The decode path already has
it in hand.

**Shared exports a `./config` subpath.** `index.ts` is browser-safe and holds
the contract plus constants. Config loading touches `node:fs` and would drag
Node built-ins into the web bundle if it were re-exported from the index.

---

## Step 1 — Shared types

**Hot reload has three details that decide whether it works at all.**

- Watch the parent *directory*, not the file. Editors save by writing a temp
  file and renaming over the target, which detaches an inode-bound watcher after
  one save. This is the classic "hot reload worked exactly once" bug.
- Debounce. One save emits several `fs.watch` events.
- A failed *reload* keeps the last good value and reports through `onError`. The
  first load still throws. An engine mid-session on a live stream must not die
  because of a typo in `thresholds.yml`.

**Root `tsconfig.json` only references packages that have source.** The others
have `include: ["src/**/*"]` and no `src/`, and `tsc --build` fails an empty
project with TS18003. Each step re-adds its own reference as it lands.

**`config/programs.ts` later moved to `packages/shared/src/programs.ts`.**
`config/` sits outside every package's `rootDir`, so nothing under project
references could import it. The better reason is that `config/` holds
hot-reloadable operator tuning, and a program id is neither tunable nor
something you want editable without a redeploy.

---

## Roster import (Axiom)

The Axiom export is a bare array keyed `trackedWalletAddress`, with `name`,
`emoji`, `groups`, and alert flags. No `tier`.

| Check | Result |
|---|---|
| Wallets | 230 |
| Addresses failing base58 | 0 |
| Duplicate addresses | 0 |
| Duplicate labels | 4 |

The four repeated labels (`Marcell`, `whashywash`, `Cented`, `rowdy`) are one
trader on several wallets, which is fine and allowed.

**The only field carrying conviction signal was `groups`.** Everything else was
flat: `highlightColor` null on all 230, `alertsOnToast` true on exactly one,
`sound` varying only by capitalization. The groups split 126 in both Main and
TopBlast List, 52 in Main only, 52 in TopBlast only.

**Every wallet is tier 1 by decision.** Two consequences to keep in mind:

- `kol_cluster` is currently an unweighted count. The tier 2 and 3 multipliers
  in `thresholds.yml` are dead config until wallets get demoted.
- 230 watched wallets against `min_distinct: 2` over a 60-second window will
  fire very often on pump.fun. This is the first thing to tune against a real
  recording.

`config/kol-wallets.json` is gitignored. `config/kol-wallets.example.json` is
the committed template, mirroring the `.env` / `.env.example` split.

---

## Step 2 — Ingest

### PumpPortal is no longer viable (verified 2026-09-10)

The spec originally called for it. Do not go back.

- `subscribeTokenTrade` and `subscribeAccountTrade` now answer: *"only available
  when connecting with an API key funded with at least 0.02 SOL."* The free feed
  carries token creations and migrations, and no trades at all.
- No frame carries `slot` or `blockTime`, which makes the block-time rule
  impossible to honour from that source.
- The `migrate` frame's `pool` field is the string `"pump-amm"`, a venue label,
  not the base58 pool address `MigrationEvent.pool` needs.
- Funding a key would put wallet custody into a read-only project.

Replaced with Helius `logsSubscribe` on the free Developer tier. The cost of the
free path is one `getTransaction` per candidate signature, because
`logsSubscribe` pushes a signature and a slot but not the transaction. Step 10
removes that round trip.

### Program IDs are verified, not copied

Both read off real mainnet transactions on 2026-09-10 and cited in
`packages/shared/src/programs.ts`.

| Program | Evidence |
|---|---|
| `6EF8rre…` PUMP_FUN | top-level on a token creation, slot 445994548 |
| `pAMMBay…` PUMP_SWAP | inner instruction of a migration, slot 445994886 |

A wrong program id fails silently: the filter matches nothing and it reads as a
connection problem. Re-verify the same way rather than trusting a copy.

### Decoding

**The RPC reports `blockTime` in seconds. The contract is milliseconds.**

**pump.fun mints are Token-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`),
not classic SPL. This will matter for mint and freeze authority checks at
step 7, because the account layout differs.

**Instruction names vary wildly**, which is the empirical case for decoding via
balance deltas rather than instruction layout. Six consecutive transactions
sampled off mainnet carried `Buy`, `SellV2`, `BuyExactQuoteInV2`,
`BuyExactSolIn` and `SwapV2`, several wrapped in a Jupiter `Route`. Any decoder
keyed on layout would already be broken.

**26 of 40 sampled signatures had failed on chain.** Dropping failed
transactions is the common path, not an edge case.

**SOL volume prefers the counterparty's own lamport change.** For a bonding
curve trade that is exactly what entered or left the curve, with no transaction
fee, no rent for a freshly created associated token account, and no platform fee
mixed in. Where an aggregator stands between the trader and the curve there is
no such change, so it falls back to the trader's own movement with the fee added
back. Measured against one routed sell, that fallback came in about 5% light.
Fine for a volume signal, not fine for anything claiming to be a fill price.

**The public RPC rate-limits `getTransaction`.** Fine for pulling a handful of
fixtures, useless for sustained work.

---

## Step 3 — Redis bus

**Batching works and is necessary.**

| Measure | Result |
|---|---|
| Events published | 5000 |
| Redis round trips | 3 |
| Largest batch | 4500 |

Batching lives in the transport only. Each event is still its own `PUBLISH`, so
a subscriber gets one message per event rather than a bundle, and
`redis-cli SUBSCRIBE argus:stream:trades` shows what it should.

**A silent-stall bug, found by publishing into a paused container.** ioredis
queues commands while the server is unreachable rather than rejecting them. An
unguarded `pipeline.exec()` therefore never settles, the in-flight guard stays
set, every later flush becomes a no-op, and the buffer grows forever with
nothing logged. Flushes are now time-bounded and a stall is counted and logged.

**Re-queueing a timed-out batch can republish events that landed.** That is
deliberate. Windows are sorted sets keyed by signature, so a duplicate is a
no-op, while a dropped event is a permanent hole in an aggregate.

---

## Step 4 — Engine and the KOL signal

**Windows are sorted sets scored by block time, evicted with
`ZREMRANGEBYSCORE`.** The keys also carry a generous TTL, but that is garbage
collection only: a mint that stops trading stops receiving writes, so nothing
would ever evict its key. The TTL is far longer than any window and never
decides a boundary.

**Reads re-apply the cutoff.** Eviction only happens on write, so a key whose
newest event is old would otherwise report members that expired long ago.

**Trades are serialised per mint.** Two trades on one token were interleaving
between a window write and the count read that follows it, so the reported
distinct count depended on which promise resolved first. One promise chain per
mint, deleted once it drains.

**Buys only.** A KOL selling is information, but counting it would make the
distinct-buyer count mean something other than its name.

---

## Step 5 — One panel

### Metadata has a real gap

`TokenMeta` resolution is layered, because the two sources fail in opposite
directions.

1. **DexScreener.** Free, no key, carries image and socials. **It does not carry
   brand-new mints.** Both captured fixture tokens returned no pairs two days
   later, and a token minutes old will not be indexed. Since Argus exists to
   catch exactly those, this gap matters.
2. **Helius DAS.** Reads the mint's own on-chain metadata, so it answers from
   the moment the token exists. Costs quota, which is why it is second.

An unresolvable mint produces **no alert**, counted as `unresolvedMeta`. That
anticipates the step 7 safety rule: a panel with no name on it is not worth the
space it takes on the wall.

### Score is real, not a placeholder

`score` is a weight-normalised mean over the signals that actually exist. With
one signal that reduces to its own normalised value. Step 7 widens the
denominator to the full weight set without changing shape. Nothing invents a
number it cannot justify. `safety` is all nulls because nothing has looked yet.

### Frontend

- **`ServerFrame` was added to the contract.** One socket carries both alerts
  and ticks, so a frame has to say which it is. Section 6 says WebSocket frames
  conform to the contract, so inventing that shape inside the gateway would have
  broken the "never define an ad-hoc event shape" rule.
- **Chart precision is 10 decimal places.** pump.fun prices sit around 1e-8 SOL,
  and the library's default of 2 would render every candle as a flat zero.
- **Five-second candles, bucketed on block time.** The engine sends ticks; the
  browser only decides which candle a tick belongs to. Shipping raw trades and
  letting twelve panels each bucket them is how a monitoring surface turns into
  a space heater.
- **Axiom deep link is `https://axiom.trade/meme/<mint>`**, confirmed by hand.
  It could not be verified programmatically: Cloudflare returns 403 to every
  non-browser request, including deliberately invalid paths, so a wrong path is
  indistinguishable from a right one. Probing harder would mean defeating
  Turnstile, which section 2 rules out.

---

## Step 6 — Recording and replay

Shrunk from the spec: newline-delimited JSON files, not Postgres. A recording
you can grep, diff and commit as a fixture is worth more than a table here, and
it replays with no database running.

**What gets recorded is `StreamEvent`, not raw RPC.** The engine is the thing
being tuned and the engine consumes stream events. Recording a layer lower would
re-run the decoder on every replay and couple every recording to its
implementation.

**The gate is same alerts, not identical bytes.** Every `AlertPayload` carries a
fresh uuid and a wall-clock `triggeredAt`, so literal equality can never hold.
`--capture-alerts` writes the decision (mint, score, signal values, kols) for
diffing.

| Replay of the same 10-minute session | Wall time | Alerts |
|---|---|---|
| 60x | 12.6s | 5 |
| 600x | 3.3s | 5 |

**This gate immediately caught a real bug.** The per-mint cooldown used a Redis
TTL, so it was measured in wall clock while every window is measured in block
time. Under replay those clocks diverge by the speed factor. Restoring the old
version to check produced **1 alert instead of 5** at both speeds, meaning
replay would not have reproduced the live run at all. Cooldown is now block-time
based; the key keeps a TTL for garbage collection only.

**Redis pub/sub is not namespaced by database.** `SELECT 1` isolates keys but
not channels, so a recording made while another ingest is running will be
contaminated regardless. Stop other publishers or use a separate Redis instance.

**`--reset` preserves slot cursors.** It used to match `argus:*`
indiscriminately. Cursors belong to ingest and record how far a live stream
actually reached, so wiping one to re-run a replay destroys unrelated state.

**`HELIUS_API_KEY` is now required by ingest only.** The engine, gateway and
replay tool run without one. A secret that every service demands but three of
them ignore is a secret that quietly becomes a dummy value in everyone's `.env`.
The engine warns at startup that without a key its metadata fallback is gone.

---

## Open items

Things deferred on purpose, with the step that should close them.

| Item | Why it matters | Closes at |
|---|---|---|
| All 230 wallets are tier 1 | `kol_cluster` is an unweighted count; tier multipliers are dead config | 7, against a recording |
| `min_distinct: 2` over 230 wallets | Will fire constantly on pump.fun | 7 |
| No escalation override | A score that jumps hard still waits out the full cooldown | 7 |
| Safety flags never populated | All nulls; the hard filters do not exist yet | 7 |
| Token-2022 authority checks | Layout differs from classic SPL; do not assume | 7 |
| No panel budget or eviction | `active` is an unbounded map of alerted mints | 8 |
| Late-joining browser sees nothing | No snapshot or history on connect, so it renders the empty state until the next alert | gateway history route |
| Latency numbers for the README | Needs a live run; cannot come from replay | 10 |

**The one thing that cannot be faked.** Synthetic sessions prove the machinery
works, but not whether a threshold is *right*, because the price action is
invented. Tuning needs a recording of a real window where you already know what
ran. That means a deliberate ingest session with the roster live, which does
cost Helius quota. It is the one place where spending it clearly pays, since
everything after it iterates for free.

---

## The pivot (2026-09-17)

v1 is being superseded. `PIVOT.md` holds the new spec; this records the decision
and the numbers behind it.

### Why v1 could not continue

Measured on mainnet, 30 seconds of pump.fun program logs:

| Measure | Value |
|---|---|
| Transactions per second | 460 |
| Per day | ~40,000,000 |
| Failed on chain | 88% |
| Successful swaps per second | ~49 |
| Implied `getTransaction` per day | ~4,200,000 |

The rate limiting we hit was never a tuning problem. Seeing every trade is what
the design requires, and nothing makes that cheap. Almost all of the work was
also wasted: 40 million transactions decoded to surface a handful of tokens, of
which the operator only ever cared about the ones they held.

### What replaces it

Watch one wallet. On a buy, lock onto that token's narrative and report when a
redeploy starts taking its volume. Three measurements established that this is
nearly free:

- **Instruction names are readable from `logsSubscribe` log lines**, so
  transactions can be filtered without spending a `getTransaction`. Useful, but
  not enough on its own — ~49 successful swaps a second is still 4.2M a day.
- **PumpPortal's free `subscribeNewToken` feed** delivers ~24 creations a minute
  with `mint`, `name`, `symbol`, `uri` and `bondingCurveKey` inline. No key.
  This is exactly what vamp matching needs, and it is the source we dropped at
  step 2 for lacking trades. It was never bad at creations.
- **`accountSubscribe` on a bonding curve account** pushes updated reserves on
  every trade. Price is `virtualSolReserves / virtualTokenReserves` and the
  change in `virtualSolReserves` is net SOL flow. Verified: 90 pushes across 3
  curves in 25 seconds, zero `getTransaction` calls. One curve returned 0 bytes,
  which likely means the account was not yet live at subscribe time; worth
  handling.

### Operator decisions

Recorded verbatim in intent, because they override my own suggestions.

- **This is a tool, not a product.** It makes life easier for one person. It is
  not meant to be an end-all product, and it should not be overcomplicated.
- **Track forward from the buy only.** I proposed a rolling buffer of recent
  creations so a vamp that spawned before the buy could still be matched. That
  was rejected as overcomplication and the case is accepted as invisible.
- **Vamps spawn within about a minute of the parent coin's deployment.** I had
  assumed minutes to hours, with the dangerous ones arriving later once a
  narrative proved itself. That is wrong for this use case. It is bot behaviour
  firing off a launch that starts moving, which is why the watch is short and
  intense and why detection has to be near-instant.
- **Watch the Axiom trading wallet**, not the funding wallet.
- **The volume metric is deferred.** I argued that absolute volume on the vamp
  is the wrong trigger and that share of flow relative to your token is the real
  signal. That may still be true, but it gets decided against real data rather
  than designed up front.

### Course correction: the roster stays (2026-09-17)

I had written the 230-wallet roster into the deleted column. That was wrong and
the operator caught it.

The roster is the **primary signal on a suspect**. When a clone of the held
token appears, the question that matters is whether the tracked wallets are
buying the clone. Those wallets cause the attention shift, so their buys land
before the volume those buys produce. Volume on a vamp is a lagging confirmation
of something the roster already said.

It is also the simpler design. "Three tracked wallets bought the clone" is
near-binary. "Is one-minute volume high enough" is a threshold needing data that
does not exist yet. Keeping the roster removes a tuning problem.

Why I got it wrong: the roster was expensive in v1 *only* because finding roster
buys meant decoding every trade on chain. Asked of three fresh mints for a few
minutes, the same signal is nearly free. I deleted the signal when what was
actually broken was the method of collecting it.

Related embarrassment: the wallet I picked for the step 1 live test, Cupsey, was
from that same roster. Zero of its twenty recent transactions landed, which
reflects on sniper wallets and on my test design, not on the roster.

This is the one place v2 spends real money — see the cost note in `PIVOT.md`
section 4 — so it is the first number to measure.

### Repository decision

Overhaul in place rather than starting fresh. The balance-delta decoder, the
verified program ids, the reconnect watchdog, the block-time windows, the replay
harness, the gateway fan-out and the chart panel all survive the pivot. A new
repository would discard those and this file along with them.

---

## v2 step 1 — Watching one wallet (2026-09-17)

Watched wallet: the Axiom **trading** wallet, set as `WATCHED_WALLET` in `.env`.
Axiom routes every trade through `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`,
but the trading wallet is still both signer and fee payer on real swaps, so the
existing balance-delta decoder reads them with no changes at all.

Axiom relayers (`AxiomRXZAq1…`, `AxiomRYAid8…`) pay the fee on housekeeping
transactions such as `CloseAccount`. Those correctly decode to nothing.

### Liveness is now ping and pong, not data

The firehose watcher treated 45 seconds of silence as a dead stream. For one
wallet, silence is the normal state — you had lunch. Treating it as a fault
reconnects forever; treating it as health hides a genuinely dead socket. The
websocket's own keepalive is the only honest signal, so the watcher pings every
30 seconds and tears the connection down if no pong arrives within 10.

### Three bugs the live test found

**Mainnet now carries version 1 transactions.** Asking for
`maxSupportedTransactionVersion: 0` does not downgrade them, it makes the RPC
refuse the request outright: *"Transaction version (1) is not supported by the
requested encoding"*. 186 of 186 fetches failed this way against an active
wallet. Every such fill would have been silently invisible. The ceiling is now
1. Checked that a v1 transaction still exposes what the decoder needs: account
keys resolve inline, no loaded addresses, and `accountKeys.length` still matches
`preBalances.length`.

**Helius throttles with a non-JSON body.** A 429 carries the bare string
`Too Many Requests`. Calling `.json()` on that throws a `SyntaxError`, which
looks nothing like rate limiting, so a retry policy that only inspects a parsed
JSON-RPC error will not recognise it. Check the HTTP status before parsing.

**No concurrency bound.** Every notification started a fetch immediately. One
wallet never fills that, but pointing the watcher at a busy address fired
hundreds of simultaneous requests and every one was throttled. Bounded at four.

### Choosing a wallet to test against is harder than it looks

Two of the first candidates were useless, for opposite reasons. One sniper
wallet had **0 of 20 recent transactions land** — it spams attempts, so the
watcher correctly emitted nothing and it looked like a bug. Another had a 100%
landing rate but simply did not trade during the window. This is the same 88%
chain-wide failure rate from the v1 notes, concentrated.

### What is verified, and what is not

Verified: the subscription delivers (≈250 notifications in 50s against an active
wallet), fetch survives throttling and version 1, and decoding plus the
trader filter reproduce **4 of 4** of the operator's real fills with correct
side, size, mint and venue. Two buys and two sells, across both the bonding
curve and PumpSwap.

Not yet verified: a single live run where a notification becomes a printed fill.
That needs a real buy, and it is exactly what the step 1 gate asks for.

### Redis is optional here

A dead Redis warns and the watcher keeps printing. This is a tool you leave
running; infrastructure being down is not a reason to go blind. Positions at
step 2 will need the bus.

---

## Spec amendments

`CLAUDE.md` has been edited where reality disagreed with it. Each change is
recorded in the file itself.

- Section 5 — layout updated: `programs.ts` moved into shared, `publish.ts`
  added, `recordings/` added, PumpPortal replaced by `helius-logs`.
- Section 6 — `TradeEvent.decimals` added with rationale; `ServerFrame` added.
- Section 10 step 2 — rewritten for Helius, with the PumpPortal finding recorded
  so it is not retried.
- Section 10 step 5 — gate extended to check price magnitude against an
  independent source, since a wrong exponent draws a plausible curve.
- Section 10 step 6 — rewritten for file-based recording, with the achievable
  gate and the wall-clock trap.
- Section 11 — program ids marked verified with evidence; the balance-delta note
  extended to cover `decimals` and the lossy `uiAmount`.
