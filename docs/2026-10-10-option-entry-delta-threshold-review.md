# Review: the 0.75 → 0.55/0.65 option-entry delta threshold — 2026-10-10

## What changed, and where

Commit `aebc868` ("feat(option-buyer): implement 0.55 delta threshold and
structured rejection provenance", 2026-10-08) changed two constants in
`prepare-option-entry.ts`:

```
- const MIN_ENTRY_DELTA = 0.75;
- const TARGET_DELTA = 0.75;
+ const MIN_ENTRY_DELTA = 0.55;
+ const TARGET_DELTA = 0.65;
```

This is the live strike-selection gate for every option-buyer trade opened by
the index paper-trading bots (`run-paper-trading-bot.ts`,
`run-gold-paper-trading-bot.ts` via `PrepareOptionEntry`): it decides which
listed strike qualifies as "eligible" and which eligible strike is actually
bought. Lowering `MIN_ENTRY_DELTA` admits strikes that were previously
rejected outright; changing `TARGET_DELTA` from 0.75 to 0.65 changes *which*
of the eligible strikes ranks first once several qualify.

**`git show --stat aebc868` adds no `docs/*.md` file.** No commit message
body, no PR description (this landed as a direct commit on
`feature/stock-intelligence-m01`, not a squash-merged PR), and no code
comment anywhere in the diff explains why 0.55/0.65 are the right numbers
rather than, say, 0.60/0.70 or back to 0.75/0.75. That is a real departure
from this repo's own convention — every other strategy-parameter change of
comparable weight (`docs/2026-09-29-atm-vs-itm-strike-backtest.md`,
`docs/2026-09-16-scalp1m-rvol-falsification-v1.md`,
`docs/2026-10-08-ofi-replenishment-hypothesis-preregistration.md`, etc.) ships
with a measurement doc.

**This is already live.** `aiquantlab-api-v2:latest` was rebuilt 2026-10-09
20:46 IST — after `aebc868` (2026-10-08 22:02 IST) — and the container is
currently running. The 0.55/0.65 thresholds are governing real paper-trading
entries right now, not sitting in an unreleased branch.

## Searched for a justification; found none

- `git show --stat aebc868`: no `docs/` file touched.
- `grep -rn "0\.55\|0\.65" docs/` matched nothing about this gate.
- `find . -iname "*delta*"`: nothing under `docs/` or `apps/api` other than
  the file itself and an unrelated `scratch/calc_delta.js` throwaway.
- The commit's own test changes
  (`prepare-option-entry.test.ts`) only update fixtures and expectations to
  match the new constants — they verify the *mechanics* (ranking, provenance
  shape, the empty-universe case) work correctly, not that 0.55/0.65 produce
  better P&L than 0.75. One test is even named `"approves a contract with
  0.65 delta even if 0.75 is unavailable (the treatment/control test)"` —
  despite the name, this is a unit test of code paths, not an actual
  treatment/control backtest on market data. No real fills, no P&L, no
  significance test anywhere in the diff.
- `git log -S"MIN_ENTRY_DELTA"`: the 0.75 value itself was only introduced
  three commits earlier, on 2026-10-01 (`02fc604`, "implement O1 engine and
  gold isolation") — also with no accompanying doc. So neither 0.75 nor
  0.55/0.65 has ever been backtested in this repo; both are undocumented
  guesses, two days apart.

## The one piece of real evidence that *does* exist — and it argues the other way

`docs/2026-09-29-atm-vs-itm-strike-backtest.md`, written nine days before
`aebc868`, replayed all 354 real closed `momentum-scalp` /
`momentum-scalp-index` option trades at ATM (delta ≈ 0.5, what the system
bought at the time — this was written before the 2026-10-01 commit
introduced delta-gating at all) versus one strike further ITM ("ITM1",
delta roughly 0.58–0.76 depending on strike/day, i.e. the same neighborhood
`TARGET_DELTA = 0.65` now aims at). Its findings, Šidák-corrected across four
comparisons:

| group | n | mean P&L diff (ITM1 − ATM) | paired t |
|---|---:|---:|---:|
| momentum-scalp-index, BANKNIFTY | 154 | **-77.39** | **-2.509** (significant, negative) |
| momentum-scalp-index, NIFTY50 | 133 | -18.74 | -1.119 |
| momentum-scalp, BANKNIFTY (the live-executing cell) | 26 | +3.54 | 0.235 |
| momentum-scalp, NIFTY50 (the live-executing cell) | 29 | -20.58 | -1.983 |

Its own conclusion: *"ITM+1 does not improve real P&L on either strategy
that matters... the delta/leverage argument is real in isolation... but it
does not survive contact with real fills."* And liquidity/spread was
explicitly ruled out as the explanation — ITM1's spread was comparably tight
or tighter than ATM's in 3 of 4 groups.

This is not a precise replay of the 0.55/0.65 rule (it compares fixed
strike-step offsets, not a delta target, and the live selection logic didn't
exist yet when it was run), so it should not be read as a direct refutation
of the new thresholds. But it is the only real-fill evidence in this repo
that touches the question "does nudging option-buyer entries toward higher
delta/more-ITM help this book's real P&L," and the answer it found was no —
flat on the live cell, negative and significant on the much larger
`momentum-scalp-index` BANKNIFTY cell. Nothing produced since then
contradicts it.

## Is the removed `usableChain.quotes.length === 0` guard actually unsafe?

The same commit also changed the chain-usability check:

```
- if (usableChain === null || usableChain.quotes.length === 0) {
+ if (usableChain === null) {
```

Traced this through — it is **not** a safety regression. With zero quotes:

1. `matchingQuotes` (filtered from `usableChain.quotes`) is still `[]`.
2. The idea price-drift check above it reads `usableChain.underlyingValue`,
   which is a property of the snapshot, not derived from `quotes`, so it is
   unaffected by an empty quote list.
3. The per-quote loop over `matchingQuotes` simply doesn't execute.
4. `eligible.length === 0`, so the function falls through to the
   `NO_OPTION_ENTRY` refusal a few lines down — the same reason code the old
   guard would have returned directly.

So the net behavior for an empty chain is unchanged: refusal with
`NO_OPTION_ENTRY`. What changed is *which* return statement produces it, and
the new one is strictly more informative — it now attaches
`rejectionProvenance` with `candidateCount: 0`, `deltaAvailableCount: 0`,
etc., instead of a bare message. This is exercised directly by the commit's
own new test, `"Provenance Test: Empty universe"`, which passes.

The one minor (non-functional) regression: the refusal's `explanation`
string now reads `"no contract satisfied abs(delta) >= 0.55"` even when
there were literally zero quotes to evaluate, which slightly overstates what
was checked. `rejectionProvenance.candidateCount: 0` disambiguates this for
anything that reads the structured field, but a human reading only the
`explanation` string could be misled into thinking a delta filter — rather
than an empty chain — was the cause. Not worth blocking on; worth a one-line
fix if this file is touched again.

## A third, unflagged change bundled into the same commit

Separately from `prepare-option-entry.ts`, this same commit also swapped the
gold bot's live quote source from `TwelveDataQuoteClient` to
`OandaQuoteClient` in `run-gold-paper-trading-bot.ts` — a live-data-provider
change with its own correctness surface (symbol mapping, auth, rate limits),
described nowhere in the commit message either. Not in scope for this
review, but it reinforces the pattern: this commit's title names one change
("0.55 delta threshold") and actually contains three (the delta/target
rework, the guard removal, and the gold quote-provider swap).

## Addendum (same day): the operational cause, checked against real data

After this review was written, the user supplied the missing context: the
bot took **no trades for most of the week before `aebc868`**, and the
0.75→0.55/0.65 change was made to fix that, on the understanding that the
chain never actually offered a 0.75-delta contract. I verified this directly
against the live database rather than taking it on trust, by replaying the
project's own `solveContractGreeksFromChain` against the real
`option_chain_snapshots` rows at the exact instants the gate refused trades.

**`candidate_decisions` for 2026-10-05 through 2026-10-08** (BANKNIFTY/NIFTY50
only instruments, `PrepareOptionEntry` only reached via `momentum-scalp`):

| day | BANKNIFTY | NIFTY50 |
|---|---|---|
| 10-01 | 7 EXECUTED | — |
| 10-05 | 0 EXECUTED, 5× `NO_FRESH_EXECUTABLE_QUOTE`, 3× `NO_OPTION_ENTRY` | 1 EXECUTED, 5× `NO_OPTION_ENTRY`, 1× `OPTIONS_ENTRY_REJECTED` |
| 10-06 | 0 EXECUTED, 3× `FILL_NOT_DERIVABLE`, 5× `OPTIONS_ENTRY_REJECTED` | 0 EXECUTED, 2× `OPTIONS_ENTRY_REJECTED` |
| 10-07 | 0 EXECUTED, 3× `FILL_NOT_DERIVABLE`, 6× `OPTIONS_ENTRY_REJECTED` | 0 EXECUTED, 5× `OPTIONS_ENTRY_REJECTED` |
| 10-08 | 0 EXECUTED, 7× `NO_OPTION_ENTRY`, 5× `OPTIONS_ENTRY_REJECTED` | 0 EXECUTED, 5× `OPTIONS_ENTRY_REJECTED` |

So: real drought, confirmed — one NIFTY50 fill on 10-05, nothing else through
10-08, across both instruments.

**Every BANKNIFTY `NO_OPTION_ENTRY` in that window reads**
`"no contract satisfied abs(delta) >= 0.75 with valid two-sided quotes"`
for the `2026-10-27` monthly PE. I pulled the exact `option_chain_snapshots`
row set in effect at each refusal instant and ran it through
`solveContractGreeksFromChain` — the same function the gate itself calls —
to get the real solved delta at every strike the chain carried:

| decision instant | max abs(delta) among liquid, two-sided BANKNIFTY PE quotes |
|---|---:|
| 10-05 04:50 | 0.7273 |
| 10-05 05:50 | 0.7046 |
| 10-05 09:35 | 0.7188 |
| 10-08 04:15 | 0.7481 |
| 10-08 04:20 | 0.7481 |
| 10-08 05:55 | 0.7434 |
| 10-08 06:50 | 0.7475 |
| 10-08 08:05 | 0.7477 |
| 10-08 08:35 | 0.7411 |
| 10-08 09:35 | 0.7431 |

**Confirmed: `MIN_ENTRY_DELTA = 0.75` was never once reachable for BANKNIFTY
in this window.** The chain's own deepest-ITM strike topped out at
0.70–0.748 every single time — a few points of delta, consistently, forever
short of the bar. This isn't "ITM strikes are rare," it's "the gate asked for
something the chain structurally cannot supply" for BANKNIFTY's
monthly-only, longer-dated expiry (consistent with this file's own
docstring on `MAXIMUM_IDEA_PRICE_DRIFT_FRACTION`, which already documents a
near-identical BANKNIFTY-delta-0.75-is-too-far-out failure mode on the CE
side). **Lowering `MIN_ENTRY_DELTA` was the correct, necessary fix for
BANKNIFTY** — not a guess, a response to a real and now-confirmed lockup.
I was wrong to treat this half of the change as unjustified; retracting that
part of the original recommendation below.

**NIFTY50 is a different story.** Its `NO_OPTION_ENTRY` refusals in the same
window were `"No usable option chain found... within maximum age of 40
minutes"` — stale-chain, unrelated to delta — and its other refusals were
`OPTIONS_ENTRY_REJECTED` (the separate `validateOptionsEntry` gate: volume/
confidence/reasoning checks). I checked whether delta 0.75 was even hard to
reach for NIFTY50's weekly expiry the way it is for BANKNIFTY's monthly one:
replaying the same `solveContractGreeksFromChain` check against a live
NIFTY50 chain (2026-10-13 weekly, 2026-10-09) found a liquid, two-sided
0.75+ delta strike readily available — **max abs(delta) 0.974** in that
chain. NIFTY50's shorter time-to-expiry makes delta much steeper per strike
step, so 0.75 was never the bottleneck there.

That matters because `TARGET_DELTA` is one shared constant across both
instruments. Lowering it from 0.75 to 0.65 didn't just stop rejecting
BANKNIFTY outright — it also pulled **NIFTY50's** target strike from "as
close to 0.75 (deep ITM) as the chain allows" to "as close to 0.65" even on
days when a 0.75-delta NIFTY50 contract was sitting right there in the
chain, available and liquid. For NIFTY50 (steep delta/strike slope, short
DTE), that 0.75→0.65 move plausibly falls in the same moneyness neighborhood
the 2026-09-29 ATM-vs-ITM study already measured and found flat-to-negative
(see above) — unlike BANKNIFTY, where the actual achievable strikes under
either threshold (now topping out ~0.70–0.75) sit roughly 1,300+ points from
spot, far beyond anything that study tested (it only measured 1–2 strike
steps of ~100–500 points).

## Recommendation

**Revised after the addendum above — do not blanket-revert to 0.75/0.75.**
That would reinstate the exact BANKNIFTY lockup this change fixed; I was
wrong to suggest it as the default-safe option in the first draft of this
doc. The picture is now instrument-specific:

- **`MIN_ENTRY_DELTA`: the 0.75→0.55 drop is justified by a confirmed
  operational fact**, not a guess — 0.75 was never once reachable for
  BANKNIFTY in the week of data checked. Something at or below ~0.70 was
  necessary just to let BANKNIFTY trade at all. 0.55 is lower than the data
  strictly requires (observed reachable max was 0.70–0.748), but it isn't
  wrong, and I have no evidence it's harmful either.
- **`TARGET_DELTA`: the 0.75→0.65 drop is a separate decision riding on the
  same commit, and it's still unjustified.** For BANKNIFTY it's close to
  moot (the achievable ceiling is ~0.70–0.75 regardless of target, so the
  ranking mostly still picks the deepest available strike). For **NIFTY50**,
  where 0.75-delta contracts are readily available, this constant change
  actively pulls the selected strike shallower on every trade, in exactly
  the direction the 2026-09-29 study found flat-to-negative. Nothing in this
  repo justifies that move for NIFTY50, and the change wasn't forced by any
  reachability problem there the way `MIN_ENTRY_DELTA` was for BANKNIFTY.

Given that, the options are:

1. **Keep `MIN_ENTRY_DELTA = 0.55`** (or raise it to something like 0.65–0.70
   if you want the floor tighter while still clearing BANKNIFTY's observed
   0.70–0.748 ceiling — your call, both clear the real constraint).
2. **Reconsider `TARGET_DELTA`** separately: either revert it to 0.75 (it
   was never the thing forcing the drought, and 0.75 is what the one
   relevant backtest's "closer to ATM is worse" finding argues against
   moving away from, for NIFTY50 specifically), or leave it at 0.65 with
   your explicit sign-off, or split it per-instrument if you want
   BANKNIFTY's and NIFTY50's very different delta/strike-step slopes handled
   differently (the code currently has no such split — it's one shared
   constant).
3. **Commission a real backtest** if you want data instead of a judgment
   call on `TARGET_DELTA`: extend `run-atm-vs-itm-strike-backtest.ts` to
   select strikes by solved delta via `solveContractGreeksFromChain` instead
   of a fixed strike-step offset, so it can replay 0.75-target vs.
   0.65-target selection on NIFTY50's real historical fills specifically
   (BANKNIFTY's constraint is already settled by the reachability data
   above, so this would only need to cover NIFTY50). A few hours of work,
   not attempted in this pass.

**I still have not changed `MIN_ENTRY_DELTA` / `TARGET_DELTA` in the
source.** `MIN_ENTRY_DELTA = 0.55` looks correct and I'd leave it; flagging
`TARGET_DELTA = 0.65` back to you rather than picking a number myself, since
it's a judgment call this repo's evidence doesn't currently settle for
NIFTY50.

## Resolution: per-instrument, DTE-aware thresholds (2026-10-10, later same day)

You asked for exactly the option-3-shaped fix above: NIFTY50 held to 0.75+
always, BANKNIFTY lower in general, and BANKNIFTY raised back to 0.75 once
its own listed expiry is close enough that 0.75 is actually reachable.
Implemented as `resolveOptionEntryDeltaThresholds(underlyingSymbol,
daysToExpiry)` in `prepare-option-entry.ts`, replacing the two flat
constants:

- `NIFTY50` → always `{ minEntryDelta: 0.75, targetDelta: 0.75 }` (weekly
  expiry, 0.75+ is essentially always on offer — a live chain sampled
  2026-10-09 had a liquid 0.974-delta strike).
- `BANKNIFTY` with its own listed expiry `daysToExpiry <= 10` → the same
  strict `0.75/0.75`.
- `BANKNIFTY` otherwise (most of its ~30-day monthly cycle), and any other
  underlying (gold never reaches this gate — it trades spot via
  `PrepareDirectEntry`, not an option strike) → the permissive `0.55/0.65`.

The `<= 10` days cutover is itself evidence-based, not a guess: replaying
the prior (2026-09-29) BANKNIFTY monthly expiry's real chain through
`solveContractGreeksFromChain` at several days-to-expiry points gave:

| DTE | max liquid abs(delta) |
|---:|---:|
| 24.98 | 0.760 |
| 19.17 | 0.775 |
| 14.18 | 0.808 |
| 10.98 | 0.900 |
| 7.17 | 0.917 |
| 5.17 | 0.929 |
| 3.98 | 0.961 |
| 1.17 | 0.951 |

Both sampled points at or inside DTE 10-11 clear 0.75 with real margin
(0.90+), so the cutover is set inside the comfortably-confirmed zone rather
than right at the boundary where the earlier (2026-10-05/08) replay already
showed cycle-to-cycle variance (DTE~19-22 ranged 0.70-0.78 depending on the
cycle).

Added `resolveOptionEntryDeltaThresholds` as its own exported, unit-tested
function plus two new `PrepareOptionEntry` integration tests (NIFTY50
refusing a 0.58-0.64-delta chain that BANKNIFTY's floor would accept, and
approving once a 0.76-delta contract is offered). All 45 tests in the file
pass (verified by running the real `vitest` suite inside the live
`ai-quant-lab-api-v2` container against the modified source, then restoring
the container's files to their original state — nothing in the running
image was left changed).

**Not yet deployed.** This worktree's branch started from an old point of
`main` and was missing 46 commits already on `feature/stock-intelligence-m01`
(including `aebc868` itself) — the stale base was corrected by pulling the
three affected files' current content from the local `feature/stock-
intelligence-m01` ref before editing, so this diff applies cleanly on top of
the real deployed code. The change still needs to be applied in the main
checkout, built, and the `aiquantlab-api-v2` container redeployed before it
takes effect live.
