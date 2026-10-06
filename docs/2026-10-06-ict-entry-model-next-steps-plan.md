# ICT entry model — next-steps plan

**Written 2026-10-06, continuing `docs/2026-09-08-ict-entry-model-falsification-program.md`.**
That document is the authority on what has already been measured; this one is a plan for what to
do next, not a new measurement. No numbers in this file should be read as results.

## Where the program actually stands

Eight arms measured against the two live cells (NIFTY50 15m, BANKNIFTY 5m), all **NO_EDGE**:
`poiPreference` (BLOCK_FIRST), killzone, OTE-as-filter, `requireProtectedLevelIntact`, CISD,
inverted-POI, BPR — plus a 9-month BANKNIFTY-5m-only re-check on 2026-10-06 that reproduces the
same shape on a different window (killzone/OTE/CISD/BPR all still net negative, none flip the sign).

Two findings matter more than any individual arm's result:

1. **The non-replication signature is identical across every arm**: NIFTY50 improves or stays flat,
   BANKNIFTY breaks or stays flat, and nothing about any individual filter's own doctrine predicts
   which cell should win. Five-plus unrelated filters cannot all coincidentally target BANKNIFTY's
   real losers — this says more about the two cells than about any filter.
2. **The binding constraint is power, not doctrine** (program doc, "the binding constraint is power
   not the doctrine" section). 2025's training era yields 65 session-clustered sessions on two
   indices — the cell cannot resolve an effect below roughly ±195 per trade, and nothing measured
   has come close. No amount of further feature work changes that ceiling.
3. **Three of the eight arms (`poiPreference`, OTE, BPR) are not really falsified — they're
   untestable as currently built.** Entry, stop and target are computed from `currentPrice`,
   `liquidity.invalidationLevel` and `targetPool.price` alone; none of them read which POI supplied
   the evidence. A placement claim ("enter AT the block's mean threshold / AT the OTE retracement")
   needs the backtester to support a limit-style entry at a specific price, and it currently only
   supports `NEXT_CANDLE_OPEN`. These three NO_EDGE verdicts are honestly "NOT YET TESTABLE", not
   "tested and failed."

## Do not re-run these — already closed

- `poiPreference: BLOCK_FIRST` — byte-identical output to control, proven structural no-op.
- `requireKillzone`, `requireOte` (filter form), `requireCisdConfirmation`,
  `requireProtectedLevelIntact`, `invertedBlocksRemainPoi`, `considerBpr` — all measured NO_EDGE on
  both live cells with session-clustered significance testing. Re-running these on the same cells
  without new data or a new mechanism is not a new result.

## What's genuinely still open

### Option A — Widen the replication set (lowest effort, directly addresses the stated binding constraint)

The program doc's own conclusion: more sessions or more instruments, not more features, is the only
next step that could produce a different answer. This repo already has other NSE index instruments
registered: `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50` (confirmed present in the `instruments` table).

- Re-run the existing control (no new code) on these additional indices, same timeframe(s) as the
  live cells, same Gate 1-4 discipline (sign replication, t > Bonferroni-corrected threshold,
  era holdout, paired delta).
- Zero new code. Pure measurement. Cheapest option on this list.
- If a real cross-instrument edge exists in the NIFTY family, more sessions should start showing it.
  If it stays thin, that's a fast, cheap confirmation the program really is power-starved, not wrong.

### Option B — Give the backtester a POI-level limit-entry mode (moderate effort, unlocks 3 stalled arms)

Needed before `poiPreference`, OTE-placement, or BPR can be fairly tested at all. Current execution
model enters at `NEXT_CANDLE_OPEN` unconditionally; these three doctrinal claims are about entering
AT a specific level, not merely in the next bar.

- Scope: `backtest-engine.ts` needs an execution mode that rests a limit order at the chosen POI's
  mean threshold / OTE band and only fills if price actually trades there (with the gap-fill
  asymmetry convention already established elsewhere in this codebase — adverse fills at open,
  favourable fills don't chase).
- This is a change to shared execution infrastructure, so it must be measured as a byte-identical
  control run first (same signals, same fills, `NEXT_CANDLE_OPEN` mode unchanged) before any arm
  built on top of it means anything.
- Worth doing only if Option A suggests there's a real signal worth refining — otherwise this is
  infra work in service of a cell that may simply have no edge.

### Option C — Build the un-built doctrine pieces (highest effort, most speculative)

Explicitly out of scope in the original program registration, still untouched:

- Full HTF fractal cascade (Daily → 4H → 1H → 30m → 15m → 5m → 1m, each with its own structure/POIs)
  replacing the current single daily-session-candle HTF read.
- "Order Flow" — selecting the first untapped pullback zone working outward from IDM, distinct from
  order-block/FVG selection, never implemented.
- Volume imbalance / gap imbalance as their own POI types (currently only OB/FVG/BPR exist).
- ITH/ITL/STH/STL used as the structure source itself, not just as the `requireProtectedLevelIntact`
  overlay already measured NO_EDGE.

Each of these is a real, named doctrinal gap — but building any of them onto a cell that has already
failed 8 independent, well-measured arms is the same shape as the HTF-confluence and scalp-pattern
programs that were also closed after the same kind of monotone-but-non-replicating result. Only
worth starting after Option A gives a reason to believe there's something here to refine.

### Option D — Close the program

Given 8/8 arms NO_EDGE with an identical cross-instrument signature, and given this project's
broader 111-model overfitting check (Sidak-corrected) found only volatility-expansion ever clears
the bar across the entire model registry, the highest-expected-value move may simply be: leave
`ict-structure-v1` `TERMINAL_UNOWNED`, stop spending further measurement budget on its entry model,
and reallocate effort elsewhere. This should be a decision made explicitly, not drifted into by
quietly moving on to Option C.

## Recommended order

1. **Option A first.** Cheapest, directly targets the one constraint the program doc itself names as
   binding, and its result tells you whether B/C are worth doing at all.
2. **Then decide between B and D based on A's result.** A real signal on a wider replication set
   justifies B (unlocking the placement-claim arms). A still-thin result justifies D.
3. **C only after a positive A, never before.** Building more doctrine onto an unproven cell has
   already been tried (that's most of the first 8 arms) and the result is this document.

## Keep using the same gates

Whichever option is run, use the original program's Gate 1-4 (sign replication on both/all
instruments independently, session-clustered t > Bonferroni-corrected threshold, train/holdout era
split, paired delta against the same bars) — not a new, softer standard. Comparability to the
existing 8-arm table is the only reason this program's results mean anything.
