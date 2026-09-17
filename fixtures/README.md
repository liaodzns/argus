# fixtures

Recorded real-world data, committed on purpose.

## launches-2026-09-17.json

123 pump.fun launches captured from PumpPortal's free `subscribeNewToken` feed
over four minutes on 2026-09-17, at 31 launches per minute.

It contains a genuine vamp wave. "Thursday Arena" spawned roughly 25 clones
inside the window, and the ticker mutated across `THURSDAY`, `THURSDAYARENA` and
`CUPCAKE` while the name stayed recognisable. `CUPCAKE` paired with the name
`thursdayarena` is the case that proves a matcher cannot require both name and
ticker to agree.

It also holds several groups of launches sharing an identical metadata URI,
which are byte-identical clones detectable with no network calls, and a handful
of launches with blank names, which a naive matcher scores as identical to each
other.

Waves like this cannot be caught on demand, so this file is kept rather than
re-recorded. Step 5's alerting gate needs it.

**Known limitation.** This capture predates the launch source in
`packages/ingest/src/streams/launches.ts`, so it holds only `mint`, `name`,
`symbol` and `uri` — the fields matching needs. A replay harness has to
synthesise `signature`, `creator` and `bondingCurve`. Recordings made through
`scripts/replay.ts` carry the full `MintEvent` and need no such patching.
