# Argus

A tool that watches one trader's wallet and warns them when copycat tokens start
draining a coin they are holding.

This document explains the whole project from scratch. It assumes you know
nothing about blockchains, Solana, or memecoins, and that you can read code but
would rather have the reasoning than the syntax. Every design choice is given
with the reason it was made, and where a measurement drove the decision, the
measurement is included.

---

## Part 1 — The world this lives in

You need about ten minutes of background before any of the engineering makes
sense. None of it is complicated; it is just unfamiliar.

### A blockchain is a public ledger

Solana is a database that nobody owns. It records accounts and how much each
one holds, and it updates roughly every 400 milliseconds. Two properties matter
here:

**Everything is public.** Every trade anyone makes is visible to everyone else,
immediately, for free. There is no permission to ask and no private API to buy.
This is the reason a tool like this can exist at all.

**Accounts are long strings.** A wallet looks like
`7DEy6ZYzEkPXGPN5WWTaSh2vbBen37B5KoLoYKNT2ySb`. So does a token. So does a
trading pool. They are all just addresses, and telling them apart is something
you do by context, not by looking at them.

To read the chain you talk to an *RPC provider*, a server that keeps a copy of
it. You can ask it questions ("what happened in this transaction?") or subscribe
to a live feed ("tell me whenever this address does anything"). Subscriptions
are free. Individual questions cost quota. That asymmetry shapes almost every
decision in this project.

### Tokens are trivial to create

Anyone can create a new token in seconds for a fraction of a cent. A token's
identity is an address called its **mint**.

Because creation is free and instant, most tokens are not companies or products.
They are jokes, references, or bets. These are **memecoins**. A memecoin has no
revenue and no roadmap. Its price is a direct measurement of how many people are
currently paying attention to it.

### How memecoins are traded

There is no order book and no matching engine. Instead there is a pool of two
assets and a formula that prices one against the other. You trade against the
formula.

**pump.fun** is a website where anyone launches a memecoin in about thirty
seconds. It starts each new token on a **bonding curve**: a formula where the
price rises automatically as people buy. If enough is bought, the token
"**bonds**" or "graduates", and its liquidity moves to a regular pool on a
larger exchange.

So a token has two lives: first on a bonding curve, then in an ordinary pool.
That distinction matters later, because a naive design ends up needing two
separate mechanisms to watch the same coin.

Roughly **31 new tokens launch every minute** on pump.fun alone. That number is
measured, not estimated.

### The problem: vamping

Here is the actual thing this tool exists for.

Suppose a coin starts running. It has a name, a ticker, and a picture, and
people are piling in. Within about a minute, other people launch **clones**:
same name, same ticker, often the same image. They are trying to catch the
attention that the original attracted.

If a clone succeeds, buyers who would have bought the original buy the clone
instead. Attention moves. The original stops rising and starts falling, often
hard. The people holding the original get "**vamped**".

This is not rare and it is not slow. A real four-minute recording captured while
building this project contains a coin called Thursday Arena spawning roughly
**25 clones**, with the ticker mutating through `THURSDAY`, `THURSDAYARENA` and
`CUPCAKE` while the name stayed recognisable. That recording is committed to the
repository as a test fixture, because waves like it cannot be produced on demand.

A human cannot watch for this. Thirty-one launches a minute is a wall of noise,
and the window in which the information is useful is about sixty seconds.

---

## Part 2 — What Argus actually does

One sentence: **it watches your wallet, and when you buy something, it watches
for clones of that thing and tells you if the people who move markets start
buying one.**

The workflow from the trader's side:

1. Leave it running. It asks for nothing and interrupts nothing.
2. Buy a coin, however you normally do.
3. Within about a second, a panel appears showing what you just bought.
4. For the next few minutes, every new token launched anywhere it can see is
   compared against yours.
5. If clones appear, it starts measuring how hard each one is trading.
6. If wallets from your tracked list start **buying** a clone, the panel goes
   loud and names them.
7. One click opens your coin on Axiom, where you can exit.

It never places a trade and never holds a key. It tells you; you act.

### Two non-negotiable constraints

**Read-only, always.** There are no private keys anywhere in the project. This
is partly safety and partly honesty: a tool that can only watch cannot lose your
money through a bug.

**No unofficial APIs.** Axiom, the trading front-end, has no public API. Every
third-party library claiming otherwise works by driving a hidden browser to
defeat bot protection, and several ask for your account password *and* your
email credentials so they can read login codes out of your inbox. None of that
is in this project. The entire integration is one function that builds a URL.

---

## Part 3 — How it is built

### Four programs, not one

Argus runs as four separate processes that talk through a shared message bus:

```
   your wallet ─┐
  new launches ─┼─►  ingest  ─►  Redis  ─►  engine  ─►  gateway  ─►  browser
 clone activity ─┘                                                      │
                                                                        └─► Axiom link
```

- **ingest** connects to the chain, decodes what it sees, and publishes plain
  events. It makes no decisions.
- **engine** consumes those events, keeps track of what you hold, matches
  clones, measures activity, and decides when to alert.
- **gateway** relays the engine's output to browsers over a WebSocket.
- **web** draws the screen.

**Why split them?** Each has one job and one way of failing. The engine can
crash and restart without dropping your chain connection. Ingest can reconnect
without losing what the engine knows. And because everything crosses a bus,
recording the bus gives you a perfect replay of a session, which is how the
tuning gets done.

**Redis** is the bus. It carries messages between processes and holds short-term
state like rolling counts.

### One shared definition of every message

There is a single file that defines every message that crosses between
processes. Nothing may invent its own shape.

The reason is that these processes are separate programs that never see each
other's code. Without a shared definition, one side quietly changing a field
produces a bug that shows up somewhere unrelated, minutes later. With it, the
change refuses to compile.

This paid off repeatedly. When one field was removed from a message, the
compiler immediately pointed at two places that still expected it — a counter
that tracked position in the chain, and the replay tool's pacing logic — both of
which would otherwise have failed silently at runtime.

Every message is also *validated* as it arrives, not merely trusted. Data coming
off a network is the one place where a mistake in another process shows up as
bad data rather than a compile error.

---

## Part 4 — The pieces, and why each is built that way

### 4.1 Watching your wallet

Argus subscribes to your wallet address and gets told whenever it does anything.
A person trades a few dozen times a day, so this costs essentially nothing.

**Design choice: silence is not a fault here.** Elsewhere in the system, a feed
that goes quiet means something broke. For a wallet, silence means you had
lunch. So the wallet watcher never treats quiet as an error. Instead it checks
the connection is alive using the network's own keepalive, which is the only
honest signal available.

**Design choice: prove the subscription was accepted.** A rejected subscription
and a quiet wallet look identical — an open connection delivering nothing,
forever. So the subscription must be confirmed, and the confirmation is logged.
That one line is what lets you tell a working tool from a broken one.

### 4.2 Reading a trade — the most important decision in the project

When a transaction arrives, Argus has to work out what was traded and for how
much. There are two ways to do this.

**The obvious way** is to look at what the transaction *said it was doing*. Every
program publishes instruction names like `Buy` or `Sell`, so you read the name
and act on it.

**The chosen way** is to ignore the names entirely and look at what *moved*.
Compare every account's balance before and after. Whoever's token balance went
up bought; whoever's went down sold; the SOL that moved the other way is the
price.

**Why the second way?** Because the first one does not survive contact with
reality. A single wallet's recent history produced these instruction names for
what are all just "a trade":

```
Buy   Sell   BuyExactIn   BuyExactQuoteIn   SellExactIn   Swap2   SwapBaseInput
```

and a broader sample surfaced seventeen distinct names including `BuyV2`,
`PumpSwapV3` and `SellPumpSwapExactQuoteOut`. Worse, trades routed through an
aggregator appear as a generic `Swap`, which could be either direction.

Balance deltas do not care. They describe what happened rather than what it was
called, so they survive new venues and program upgrades without any code change.
This decision was re-validated three separate times during the project, each
time by finding another venue that would have broken a name-based decoder.

**Design choice: measure the price from the pool's side when possible.** For a
bonding curve trade, the pool's own balance change is exactly the money that
entered or left, with no transaction fee, account rent or platform fee mixed in.
When the pool holds its funds elsewhere — which is common — it falls back to the
trader's own movement with the fee added back. That fallback runs about 5% light
because platform fees stay inside it. That is fine for judging whether a coin is
being traded heavily, and not fine for anything claiming to be an exact price,
which is written at the line where it happens.

**Design choice: decode trades at any venue, not just pump.fun.** The original
design required a pump.fun program to be present and discarded everything else.
Measured against real history, that was throwing away **59% of the trader's
fills** — Raydium, Meteora and launchpads built on top of them. A fill is a fill
wherever it executed.

Removing that filter created a new problem: without a program name to check, how
do you know a transaction was a trade rather than someone sending you a token?
The answer comes from the deltas again: **in a trade, tokens move one way and
money moves the other.** A transfer moves tokens with nothing coming back, so
its only money movement is the transaction fee. A minimum threshold separates
the two, and it has to be there — without it, every token someone sends you
reads as a purchase priced at the fee.

### 4.3 Seeing new launches

A free public feed reports every new token as it is created, with its name,
ticker and image link. No account needed, roughly 31 a minute.

**Design choice: silence here *is* a fault.** Same mechanism as the wallet
watcher, opposite conclusion. At 31 a minute, a quiet feed is a dead connection,
so this one does get a timeout. The same module is used both ways, and the
comment says why.

**Design choice: do not require a bonding curve.** An early version demanded
every launch have one, which quietly rejected **24% of the feed**, because a
different launchpad reports tokens without them. A quarter of all possible
clones were never compared against anything. The field is optional now, and the
launchpad name is recorded instead.

### 4.4 Recognising a clone

This is the heart of the product. When you buy a coin, Argus learns its name and
ticker, then compares every new launch against it.

Clones vary in every direction. Sometimes the name changes slightly, sometimes
the ticker changes completely, sometimes both. So the matcher tries **all four
combinations** — your name against theirs, your ticker against theirs, and both
crossings — and takes the best.

**Why crossings matter:** in the recorded wave, one clone used the ticker
`CUPCAKE` with the name `thursdayarena`. Its ticker carried no signal at all and
its name carried everything. A matcher requiring *both* to agree would have
missed it entirely.

The comparison itself has two stages:

**Normalisation** strips everything a copycat varies without changing meaning:
capitalisation, accents, emoji, punctuation, spacing, and filler words like
"coin" or "2.0". It also folds lookalike characters, which are used to dodge
exact-match filters.

**Fuzzy comparison** then scores what is left, favouring shared beginnings,
because the most common clone keeps the original and appends something.

**A measurement worth knowing:** normalisation does almost all of the work.
Exact matching *after* normalising finds 6.03 of the 6.14 average matches that
fuzzy matching at a loose threshold finds. The fuzzy layer stays for waves that
rename more creatively, but it earns about 2%, and the code says plainly that
tuning it is not where effort belongs.

**Design choice: be generous here, strict later.** A false match costs one free
subscription. A missed match costs you the entire point of the tool. So matching
is tuned toward catching too much, and the *alert* does the filtering.

**Two guards found by measurement**, not by reasoning:

- Tokens with blank names are real — eight of 123 sampled launches — and two
  blank names score as a perfect match, so a nameless token matched everything.
  A minimum length requirement is load-bearing, not defensive.
- A token matched *itself*, because the launch feed reports the very coin you
  just bought. The most alarming possible false positive, and it cost one line
  to fix.

### 4.5 Measuring whether a clone is actually taking money

A clone existing means nothing. Almost all of them die within a minute. What
matters is whether one is pulling real activity.

**Design choice: watch the token, not the pool.** The obvious approach is to
read the trading pool's balances directly. That was attempted and abandoned for
a concrete reason: one venue keeps no balances in the pool at all, and another's
numbers did not reconcile with the feed's own figures. Reading them would have
meant guessing at binary layouts, and a wrong guess produces a confident chart
at the wrong magnitude — the worst kind of error, because it looks fine.

Instead Argus subscribes to the **token's own address**. That works identically
before and after a coin bonds, because a token's address never changes while its
pool does. Pre-bond and post-bond become one mechanism instead of two, with no
switchover logic that could break.

**Design choice: two tiers, because they cost very differently.**

- **Free:** every notification is counted. This gives an exact trade rate with
  no paid lookups at all, on any venue.
- **Paid, rate-limited:** occasionally one trade is fetched and decoded to get a
  price. At most one every couple of seconds per token.

Why ration it? A hot token does about 7 landed trades per second. Decoding every
trade across a 25-clone wave would need hundreds of paid lookups per second and
would fall behind exactly when it matters most.

The consequence is stated honestly: the volume figure is an **estimate**,
derived from sampled trade size times the measured rate, and it is named that
way everywhere it appears.

### 4.6 Deciding when to speak

The trigger is not volume. It is **which wallets are buying**.

Argus tracks a curated list of 230 wallets whose entries tend to move markets.
Their buys arrive *before* the volume those buys cause. So the alert fires when
several of them buy a clone of what you hold.

**The trick that makes it free.** Argus subscribes to the 230 wallets *and* to
the clone tokens. Both are the same kind of subscription. When one of those
wallets trades one of those tokens, that single transaction is delivered twice —
once on each subscription — with the same identifier. Matching that identifier
across the two streams proves who traded what, **with no paid lookups at all.**

Verified: 100% of one token's transactions appeared in both streams, and 255
subscriptions run on a single connection without trouble. Over 70 seconds of
live operation, 259 tracked-wallet transactions produced **zero** paid lookups.

**Design choice: pay for direction, because it is rare and it matters.** The
match proves a wallet traded the clone, not whether it bought or sold, and a
tracked wallet *exiting* a clone is not a warning. So the one transaction that
matched gets decoded. That costs one lookup, happens rarely by construction, and
is the highest-value call the tool makes.

**Design choice: the alert is about your position, not the clone.** An earlier
version alerted about each clone and pointed back at the parent. That is
backwards for a tool whose only question is whether to exit what you hold. A
25-clone wave is now one alert with 25 entries, rather than 25 alerts about
coins you do not own.

**Design choice: one alert per position, not per clone.** The silence between
alerts is enforced against your coin, so a wave cannot produce a flood.

### 4.7 The screen

**Design choice: the panel opens when you buy, not when the alert fires.** A
screen that stays empty until something happens cannot be told apart from a
screen that is broken. Opening on the buy means you can see the tool is alive,
and when the alert comes it changes an existing panel rather than conjuring one.

**Design choice: comparison bars, not a price chart.** The question is whether a
clone is outpacing you, which is a *shape*, not two numbers to compare. Your
coin is always the top row so the comparison has a fixed anchor; each clone sits
beneath it; bars scale to the busiest row. A small price trace per row gives
direction. The wallets that bought are named, because a name is what makes the
warning credible.

Removing the charting library took the page from 66 kB to 17 kB.

**Design choice: draw only the top few clones.** A real wave produced 24, and 24
rows is not something you can read in three seconds. The engine sends all of
them and the screen decides what is worth drawing.

---

## Part 5 — The pivot, and why it happened

The project was originally something quite different, and the change is the most
instructive thing in it.

**Version one** watched the entire market. It monitored every new token, tracked
volume acceleration across all of them, and surfaced whatever was running. The
clone detection was a feature near the end of a ten-step plan.

It was built through six of those steps before running into a wall that was not
a bug. Measured on the live chain:

| | Version one |
|---|---|
| Transactions to process | 460 per second |
| Per day | ~40,000,000 |
| That fail on chain | 88% |
| Paid lookups needed per day | **~4,200,000** |

No free plan survives that, and no paid plan makes it cheap. The rate limiting
that prompted the investigation was not a setting to tune; it was the design.

Worse, nearly all of that work was wasted. Forty million transactions were being
decoded to surface a handful of coins, and the trader only ever cared about the
ones they actually held.

**Version two inverted the question.** Instead of watching everything and hoping
something interesting appears, watch one wallet and react to what it does.

| | v1 | v2 |
|---|---|---|
| Must observe | every transaction on the chain | one wallet, plus new launches |
| Paid lookups per day | ~4,200,000 | dozens |
| Provider plan | required, still throttled | free tier |

The clone detection — the interesting part — was promoted from a late feature to
the entire product. The expensive, generic half was deleted.

**What survived the pivot** is worth noting, because it says something about
which work was durable: the trade decoder, the verified program identifiers, the
reconnection logic, the block-time windows, the replay tooling, and the message
contract all carried over untouched. What was thrown away was the part that
assumed you had to see everything.

---


## Part 7 — What it deliberately does not do

- **It does not trade.** No keys, no signing, ever.
- **It does not tell you to sell.** It tells you the narrative is being taken.
- **It cannot see clones launched somewhere its feed does not cover.**
- **It does not catch a clone that launched before you bought.** Tracking
  forward only was a deliberate simplification; reconstructing history costs
  more than the case is worth.
- **It does not check whether a coin is a scam.** The fields for that exist and
  are honestly empty.
- **It is a tool for one person**, not a product. Where a simpler version would
  work, the simpler version wins.

---

## Part 8 — Running it

```
cp .env.example .env     # add a free RPC provider key and your wallet address
npm install
npm run dev              # starts the message bus and all four services
```

Then open `http://localhost:3000` and trade as you normally would.

Configuration lives in `config/`. Both files reload while running, so thresholds
and the tracked wallet list can be changed without a restart.

### The other documents

- **`PIVOT.md`** — the current specification, including the build order and the
  reasoning behind each step.
- **`NOTES.md`** — the running record of what was measured and learned, in
  order. Most of Part 6 above is a summary of it.
- **`COMMITS.md`** — how each change set was split into commits and why.
- **`fixtures/`** — real recorded data, including the vamp wave, kept because it
  cannot be produced on demand.
