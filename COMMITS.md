# COMMITS.md

Commit breakdown for each change set: a title, what changed, why it changed, and
what evidence backed it. Newest first.

`NOTES.md` explains the project's findings over time. This explains how a change
set was split, and survives the split so the reasoning is still readable once
several defects are squashed into one commit message.

---

## Change set: step 4, price and flow

**Branch:** `feat/v2-price-and-flow` · **Base:** `1410b91` (step 3 merged)

**Context.** Clones are now identified but nothing measures whether one is
taking money. Step 4 adds that, for a parent that may be pre-bond or post-bond
and a clone that is always pre-bond, as one mechanism rather than two.

**The shape change.** The plan called for reading bonding curve accounts. That
is abandoned: PumpSwap's pool holds no reserves (they sit in separate vaults, so
no byte offsets reproduced its price across three tokens), and the curve's
values did not reconcile with the creation feed's own figures. Monitoring now
keys on the **mint**, which never changes when a token bonds, so pre-bond and
post-bond are the same code path with no switchover.

| Gate check | Result |
|---|---|
| Concurrent subscriptions on one socket | 30 of 30 confirmed |
| Post-bond price vs DexScreener | 1.8% apart |
| Pre-bond price, stable | 4 to 13% apart |
| Independently decoded buy vs sell, same moment | agree to 0.5% |
| Sampling ceiling held | 16 samples in 60s against a ~30 allowance |
| Control loop restart recovery | recovered correct mint from the set alone |
| Stranger's sell closing a watch | did not |

**Diff:** 14 files, +418 / −47, plus two new source files.

---

### 1. `feat(shared): add MintActivity for free flow monitoring`

A new `StreamEvent` kind carrying mint, signature, landed and `observedAt`, on a
new `CHANNELS.activity`. Plus `KEYS.activityWindow` and `KEYS.monitored`.

It deliberately carries no amount and no direction, because neither is readable
from a log notification. One mint surfaced seventeen distinct trade instruction
names plus aggregator traffic where a `Swap` could go either way.

The slot cursor in the publisher becomes an allow-list of chain-derived kinds
rather than a deny-list, so the next slotless event is excluded by default
instead of breaking it. The type checker found that, and the replay recorder,
both at compile time.

**Files.** `packages/shared/src/events.ts`, `packages/ingest/src/publish.ts`,
`scripts/replay.ts`.

---

### 2. `feat(ingest): monitor price and flow by mint, on both venues`

One log subscription per monitored mint, driven by a Redis set the engine writes
and this polls. Free notifications forwarded as activity; decoding rate-limited
to one sample per mint per interval, spent on the busiest mints rather than the
first seen, because during a wave the dangerous clone is whichever is taking
volume and you cannot know which without watching for free first.

Carries forward both lessons from step 1: the sample fetch matches the
subscription's commitment, and a rejected subscription is counted rather than
looking identical to a quiet mint.

**Files.** `packages/ingest/src/streams/monitor.ts`,
`packages/ingest/src/main.ts`, `config/thresholds.yml`,
`packages/shared/src/config.ts`.

---

### 3. `feat(engine): aggregate flow and publish the monitored set`

Per-mint readings: exact trades per minute, landed ratio, latest sampled price,
and an estimated volume that is labelled an estimate everywhere it appears
because it is sampled size times rate, not a sum.

The monitored set is rewritten in full and swapped in by renaming a temp key, so
ingest never observes a half-written set and a missed delta cannot leave a stale
subscription alive.

Activity and sampled trades go in **separate windows** on different clocks,
arrival versus block time, and a count from one is never compared against the
other. That conflation is what broke the cooldown at step 6.

**Files.** `packages/engine/src/flow.ts`, `packages/engine/src/main.ts`.

---

### 4. `feat(engine): hold suspects on a watch and guard observe() on the wallet`

Watches carry the clones found against them, which is what the monitored set is
built from. Market trades now share a channel with your own fills, so
`createWatches` takes the watched wallet and `observe()` refuses anything else.

The guard lives in the module rather than at the call site deliberately: the
failure it prevents is a stranger's sell closing your watch, which means missing
a vamp. Verified it holds.

**Files.** `packages/engine/src/watches.ts`.

---

### 5. `chore(engine): drop fastest-levenshtein`

Unused since step 3 hand-rolled Jaro-Winkler rather than adding a dependency.

**Files.** `packages/engine/package.json`.

---

### 6. `docs: record step 4 and why DexScreener is not ground truth`

The pre-bond price looked 23% wrong and was not. Buys and sells were both biased
the same direction, which ruled out slippage, and a full delta dump showed the
decoder reading exactly what moved. A hundred-second series then showed
DexScreener reporting an identical value across three windows while the real
fill price halved.

The lesson is about the gate rather than the code: "tracks an independent chart"
is only meaningful while that chart is fresh, and it is least fresh exactly when
a token is moving, which is the only time this tool runs.

**Files.** `NOTES.md`, `PIVOT.md`, `COMMITS.md`.

---

### Suggested order

1 → 2 → 3 → 4 → 5 → 6. Contract, then the producer, then the consumer, then the
guard that the consumer needs. Each typechecks alone.

---

## Change set: step 3, narrative capture and clone matching

**Branch:** `feat/v2-narrative-matching` · **Base:** step 2

**Context.** A watch now learns what it holds, and every new pump.fun launch is
matched against the open ones. This is the part the product exists for.

**Gate passed against a real recorded vamp wave**, preserved as
`fixtures/launches-2026-09-17.json`: 123 launches over four minutes containing
"Thursday Arena" spawning ~25 clones with the ticker mutating across `THURSDAY`,
`THURSDAYARENA` and `CUPCAKE`.

| Run | Result |
|---|---|
| Parent is a THURSDAY launch in the fixture | 24 clones |
| Parent is an unrelated token | 0 clones |
| Blank launches matching a blank parent | 0 of 8 |
| URI-sharing groups caught on metadata alone | 7 of 7 |
| Live: launches onto the bus in 45s | 23, zero invalid |

**Diff:** 14 files, +410 / −44, plus three new source files and a fixture.

---

### 1. `feat(shared): reshape MintEvent to its only producer`

PumpPortal's creation feed sends no `slot` and no `blockTime`. Those fields were
specified for a chain-derived source and lost their producer when the firehose
was deleted, so carrying them meant carrying two fields nothing could fill.
`observedAt` replaces them, documented as wall clock and as the second
deliberate exception to the block-time rule after `AlertPayload.triggeredAt`.

Adds `bondingCurve`, which the feed gives free and step 4 needs, and `metadata`
to `NarrativeMatchSchema` for the identical-URI case.

Also adds `eventTime()`, because a mixed stream can no longer assume every event
has a `blockTime`. The type checker found both places that assumed it: the
publisher's slot cursor and the replay tool's pacing. That is precisely what the
contract is for.

**Files.** `packages/shared/src/events.ts`, `packages/ingest/src/publish.ts`,
`scripts/replay.ts`.

---

### 2. `feat(engine): match launches against a held narrative`

Normalisation, Jaro-Winkler, the four cross-field pairings, and the free
identical-URI check.

**The rule is best-of-four, not a weighted sum.** One clone in the recorded wave
used the ticker `CUPCAKE` with the name `thursdayarena`, so its ticker carried
no signal and its name carried all of it. Requiring both fields to agree would
have missed it outright, which is the exact case the operator raised.

**Normalisation is load-bearing; the fuzzy layer is not.** Exact equality after
normalisation finds 6.03 of the 6.14 mean matches a 0.85 threshold finds, and
the threshold is near-irrelevant between 0.85 and 1.00. Jaro-Winkler stays for a
wave that renames more creatively, and the comment says plainly that tuning it
is not where effort belongs.

**`min_length` is load-bearing.** Eight of 123 sampled launches have no usable
name, and Jaro similarity of two empty strings is 1.0, so without the guard a
nameless token matched everything.

**Files.** `packages/engine/src/narrative.ts`, `config/thresholds.yml`,
`packages/shared/src/config.ts`.

---

### 3. `feat(ingest): add the free pump.fun launch feed`

PumpPortal `subscribeNewToken`, ~31 launches a minute, no key, published onto
`argus:stream:mints` through the existing batched publisher. Runs alongside the
wallet watcher with its own reconnect loop, so a dead launch feed cannot take
your fills down with it.

Note the liveness inversion against its neighbour. The wallet watcher must never
treat silence as death because a quiet wallet means lunch; at 31 a minute,
silence here means the socket died. Same `SilenceWatchdog` module, opposite
conclusion, both correct.

**Files.** `packages/ingest/src/streams/launches.ts`,
`packages/ingest/src/main.ts`.

---

### 4. `feat(engine): capture a narrative on watch open and report clones`

Watches carry a resolved `TokenMeta`, filled by reusing `createEnricher`
unchanged: DexScreener first, Helius DAS second, because DAS is the only one
that answers for a mint minutes old. Matching tolerates a watch whose narrative
has not resolved yet, and the identical-URI check still works without one.

**Excludes self-matching.** The launch feed reports the very mint you just
bought, so without a guard the parent appeared as the first clone of itself. The
most alarming possible false positive, and it cost one line.

Matching is permissive on purpose: step 5's roster gate is the strict filter, so
a false positive here wastes a subscription while a false negative is a missed
vamp.

**Files.** `packages/engine/src/main.ts`, `packages/engine/src/watches.ts`.

---

### 5. `test: preserve a recorded vamp wave as a fixture`

123 real launches including the Thursday Arena wave, with a README explaining
what makes them worth keeping. Waves cannot be caught on demand and step 5's
alerting gate needs one.

Known limitation, recorded in the README: the capture predates the launch source
and holds only the four matching-relevant fields, so a replay harness
synthesises the rest. Future recordings go through `scripts/replay.ts` and will
be complete.

**Files.** `fixtures/launches-2026-09-17.json`, `fixtures/README.md`.

---

### 6. `docs: record step 3 and the matching calibration`

**Files.** `NOTES.md`, `PIVOT.md`, `COMMITS.md`.

---

### Suggested order

1 → 2 → 3 → 4 → 5 → 6. The contract first, then the pure matcher, then the feed
that supplies it, then the wiring that joins them. Each typechecks on its own.

---

## Change set: step 2, watches

**Branch:** `feat/v2-wallet-watch` · **Base:** `7a6f640 fix wallet watcher bugs`

**Context.** A buy opens a watch, your sell closes it, and the window closing
closes it. Held in memory, nothing persisted, nothing reconciled against
on-chain balances.

That last part is the substance of the change set. An earlier design had token
balances as the source of truth for whether a position was open, because
accumulating from fills drifts the moment a fill is missed and this branch had
already lost one to the commitment bug. The operator cut it: positions are always
closed out, and longer holds are monitored with other tools. So there is no
durable position, only a timer, and balance reads, token account subscriptions,
restart reconciliation and a dust threshold all went away with it.

**Gate passed** against the operator's real fills, re-timed to the present.
Five events exercised every branch: two opened, one closed by sell, one by
expiry, one orphan sell ignored, one top-up correctly not opening a second watch.

**Diff:** 7 files. The engine entry point loses 206 lines and gains 50.

| File | Change |
|---|---|
| `packages/engine/src/watches.ts` | new |
| `packages/engine/src/main.ts` | rewritten, −206 / +50 |
| `packages/shared/src/config.ts` | +4, `watch` section on `ThresholdsSchema` |
| `config/thresholds.yml` | +6, `watch.window_seconds` |
| `NOTES.md`, `PIVOT.md`, `COMMITS.md` | docs |

---

### 1. `feat(config): add the watch window to thresholds`

`watch.window_seconds`, default 180. Vamps land within about a minute of the
parent's deployment, so the window is short by nature; the margin is there
because closing early is the expensive direction. Tunable without a redeploy
like everything else in that file.

**Files.** `config/thresholds.yml`, `packages/shared/src/config.ts`.

---

### 2. `feat(engine): add watches, opened by a buy and closed by a sell or timeout`

The tracker itself, in memory, with counters for every branch including the ones
that do nothing: a sell with no matching watch, and a buy that only adds to one
already open.

Three decisions are documented at the lines that hold them. A second buy does
not restart the clock, because risk is measured from the parent's deployment and
a top-up does not make the token younger. Any sell closes the watch, including a
partial one, following the operator's statement that they close out in full.
And `sweep` takes the clock as an argument rather than reading one, because live
it must be wall clock and under replay it must be event time — the same trap the
cooldown fell into at step 6.

**Files.** `packages/engine/src/watches.ts`.

---

### 3. `refactor(engine): drop the v1 alerting loop for watch tracking`

The engine entry point loses the KOL cluster alerting, metadata enrichment,
panel ticks and rolling windows it ran under v1, and gains the watch wiring, a
sweep tick and a heartbeat. Those modules stay in the package because steps 3
through 5 need them; they are simply not wired.

It also stops loading the roster, so a fresh clone no longer needs
`kol-wallets.json` to start the engine. That comes back at step 5.

Counters now print on shutdown as well as on the heartbeat, because the first
test run ended before the 60-second heartbeat and reported nothing at all.

**Files.** `packages/engine/src/main.ts`.

---

### 4. `docs: record step 2 and why watches are timers, not positions`

`NOTES.md` gains the gate result and the three decisions above, plus a note that
I had been designing for durability the scenario never asked for. `PIVOT.md`
points at the config key and records the settled decision. This file gains the
entry above.

**Files.** `NOTES.md`, `PIVOT.md`, `COMMITS.md`.

---

### Suggested order

1 → 2 → 3 → 4. Config before the code that reads it, the module before the
wiring that replaces the old loop. Each compiles and typechecks on its own.

---

## Change set: wallet watcher bug fixes

**Branch:** `feat/v2-wallet-watch` · **Base:** `0446134 feat: project overhaul`

**Status.** Landed as two commits rather than the four proposed below:

| Proposed | Landed as |
|---|---|
| 1. commitment mismatch | `78103da fix(ingest): match getTransaction commitment to the subscription` |
| 2, 3, 4 | `7a6f640 fix wallet watcher bugs` |
| 5. docs | pending, with this file |

The squash is fine — they are one incident. The detail below is why this file
exists: `7a6f640` covers three distinct defects, and the commit message cannot
carry which was the cause, which was the concealment, and which was the red
herring.

**Context.** The first real trade through the v2 wallet watcher was lost. The
heartbeat read one notification in, zero fills out, and no error, skip or
counter of any kind to say where it went:

```
notifications: 1   fills: 0   queueDepth: 1
rpcErrors: 0       skips: {}  lastSeenAt: null
```

Three separate defects, one of which caused the loss and one of which hid it.

**Diff:** 2 files, +122 / −6.

| File | Change |
|---|---|
| `packages/ingest/src/streams/wallet.ts` | +79 / −6 |
| `NOTES.md` | +49 |

---

### 1. `fix(ingest): match getTransaction commitment to the subscription`

**The defect.** `logsSubscribe` fires at `confirmed`. `getTransaction` defaults
to `finalized`, which trails by roughly thirteen seconds. The watcher was told
about a transaction and then immediately asked for one that did not yet exist at
the commitment it was asking for, so the call returned null and the fill was
lost. This is the bug that ate the trade.

Matching the subscription is also correct on latency. Waiting for finality would
add thirteen seconds to a tool whose entire risk window is about sixty.

**Evidence.** A just-confirmed signature caught off the wire and requested both
ways in the same instant:

```
commitment = default (finalized)  ->  NULL
commitment = confirmed            ->  found
```

**Files.** `packages/ingest/src/streams/wallet.ts` — `fetchTransaction` params.

---

### 2. `fix(ingest): count unresolved transactions instead of dropping them silently`

**The defect.** `handleSignature` did `if (raw === null) return;` with no
counter. A dropped fill therefore produced perfect silence rather than a number
going up, which is why the heartbeat had nothing to chase. This is separate from
the commitment bug: it is the reason the commitment bug was invisible.

Nulls are now retried four times with increasing backoff, since a signature can
briefly fail to resolve while it propagates even at matching commitment, and
then counted as `notFound` and logged at warn.

**The general rule.** An early return on an unexpected value is a silent failure
unless it increments something.

**Files.** `packages/ingest/src/streams/wallet.ts` — new `fetchWithRetry`,
`handleSignature`, `notFound` on `WalletWatcherStats`.

*Could reasonably be squashed with commit 1. They are one incident, but two
distinct defects, and only this one generalises.*

---

### 3. `fix(ingest): update queueDepth when work leaves the queue`

**The defect.** `queueDepth` was written when a signature was pushed and never
after it was shifted off, so it read `1` permanently and looked like a stuck
queue. It was stale, not stuck, and it sent the first pass of the investigation
in the wrong direction.

**Files.** `packages/ingest/src/streams/wallet.ts` — `drain`.

---

### 4. `feat(ingest): require confirmation that the log subscription was accepted`

**The gap.** The watcher sent `logsSubscribe` and never checked the reply. A
rejected subscription and a wallet that simply is not trading are the same
observable: an open socket delivering nothing, forever. That is exactly the
failure mode this project refuses to have.

The subscription id is now required, its absence within ten seconds fails the
connection into the normal reconnect path, and success is logged:

```
[watching wallet] {"wallet":"7DEy6…","subscription":8048121}
```

That line is what makes an idle console prove the watch is attached rather than
merely connected.

**Files.** `packages/ingest/src/streams/wallet.ts` — `SUBSCRIBE_ID`,
`subscribeTimeoutMs`, subscribe confirmation handling in the message listener,
timer cleanup in `finish`.

---

### 5. `docs: record the commitment mismatch and what made it invisible`

Adds four sections to `NOTES.md`: the lost fill and its cause, the silent-return
rule, subscriptions being confirmed rather than assumed, and a warning that
quiet wallets are the norm.

That last one is a testing note worth keeping. Four live runs against wallets
that had landed a trade minutes earlier all saw zero notifications. Polling the
chain in parallel during two of them showed zero transactions actually occurred,
so the watcher was correct every time. Any future live test needs the concurrent
poll, or a quiet wallet reads as a broken subscription.

**Files.** `NOTES.md`.

---

### Suggested order

1 → 2 → 3 → 4 → 5. The cause lands before the instrumentation that would have
revealed it, which keeps the story readable in `git log`. Commits 1 through 4
each compile and typecheck on their own.

### Verified

These changes close the step 1 gate. A live round trip printed both fills within
about a second of block time, and `argus:cursor:wallet` ended at the sell's slot,
confirming the publish path as well as the console.

    BUY   0.0317 SOL  BPPA1dyE…  pumpswap  slot 447847039
    SELL  0.0215 SOL  BPPA1dyE…  pumpswap  slot 447847138
