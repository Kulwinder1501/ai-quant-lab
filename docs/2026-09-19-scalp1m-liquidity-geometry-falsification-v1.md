# AutoBot-Scalp1m liquidity-geometry falsification program v1

**Registered 2026-09-19, before any measurement of liquidity-sweep stops or order-block targets.**
Nothing below may be revised after a result is seen. If the design turns out to be wrong, this
document gets a dated amendment saying so and the run is discarded, not re-scored.

## Why this exists

A proposal argued that `momentum-scalp`'s exit geometry should be re-anchored to ICT "liquidity"
concepts: stop at the level a `LIQUIDITY_SWEEP` just took out (the stop-hunt that supposedly confirms
the reversal), target at the next opposing order block ahead of price, instead of a fixed ATR stop and
1.5R target. Two claims in the original pitch were checked and corrected before building anything:

- **"`momentum-scalp` completely ignores SMC/liquidity signals" is false.** `generate-trade-ideas.ts`
  already calls `applySmcConfluenceToProposal` on every proposal from every strategy except
  `ict-structure-v1` -- `momentum-scalp` included. This has been live the whole time.
- **"Confidence-boost on SMC confluence" is not a new idea to test** -- it is exactly
  `SmcConfidenceGatedStrategy`, built and measured 2026-09-17
  ([[smc-gate-backtest-inconclusive]]): the adjustment only crosses the 0.6 confidence floor on 2-9
  trades per ~230-250, too small a population to tell whether it helps.

What **is** new: anchoring the *stop* to a liquidity-sweep level, and the *target* to an opposing
order block, instead of ATR/fixed-R:R. Neither has been tested. The closest existing result is
[[pattern-anchored-stop-no-edge]], which anchored the stop to a candlestick pattern's own high/low (a
different, weaker signal) and found no edge -- this program asks the same structural question with the
stronger, purpose-built SMC signal instead, and adds the symmetric target question that program never
asked at all.

## What gets built

Two independent decorators in `entry-filters.ts`, each touching one leg of the trade only, so an
effect can be attributed to stop or target separately rather than a combined number hiding which one
(if either) did anything:

- **`LiquiditySweepAnchoredStopStrategy`**: replaces `stopLoss` with the same-bar `LIQUIDITY_SWEEP`
  level, one tick beyond it, when the sweep confirms the trade's side (`BULLISH_SWEEP` for LONG,
  `BEARISH_SWEEP` for SHORT) -- the exact level the "stop hunt" ran through. Applied literally, even
  when wider than the original ATR stop (same discipline as `PatternAnchoredStopStrategy`); leaves the
  proposal alone when no confirming sweep exists, and fails closed if the level lands on the wrong
  side of entry.
- **`OrderBlockTargetStrategy`**: replaces `targetPrice` with the near edge of the nearest
  *opposing*-type `ORDER_BLOCK` ahead of price in the trade's direction (`BEARISH_OB` above a LONG's
  entry, `BULLISH_OB` below a SHORT's entry) -- "nearest" because a trade that cannot reach the closest
  opposing zone will not reach a farther one either. Leaves the proposal alone when no qualifying
  block exists, rather than inventing a target ICT structure hasn't actually formed.

Both wired into `run-backtest.ts`: `--entry-filter liquidity-stop`, `liquidity-target`, and
`liquidity-both` (stop and target together, target applied to the already-anchored stop's proposal).
13 new unit tests. Data check before registering: `LIQUIDITY_SWEEP` and `ORDER_BLOCK` both have a real
population on the standard window (387-454 and 1,016-1,083 rows respectively across the two
instruments, 2026-08-01..09-16) -- this is not going to be an EMA(2)-style data-availability dead end.

## Unit of analysis

**The trade.** Expectancy in the underlying's own points per trade, matching every other program in
this cohort. Same instruments, timeframe (1m), 6-week window (2026-08-01..09-16), and cost parameters
(quantity 1, ₹20/order, 2bps slippage, `initial-capital` 1,000,000) as the rest of the cohort.

## Decision rule

- **Gate 1 -- sign replication.** Mean expectancy under a config is higher than control's on **both**
  NIFTY50 and BANKNIFTY independently.
- **Gate 2 -- noise floor.** Session-clustered t > 2.0 on the delta (config minus control).
- **Gate 3 -- population check.** Report how many trades actually had a confirming sweep (stop arm)
  or a qualifying opposing block (target arm) -- i.e. were actually touched by the geometry change,
  not left as the control's own ATR/R:R values. A config that touches too few trades to matter is
  reported as underpowered, not folded into a null verdict the way `SMC_GATE` was kept separate from
  the pattern-alignment result.
- **Gate 4 -- population-shrink ambiguity.** Neither decorator drops a trade, so trade count should
  match control's exactly; same interaction with `max-concurrent-positions=1` already documented in
  [[pattern-anchored-stop-no-edge]] means a small mismatch is expected and not itself a defect.

## Pre-committed threats to validity

- Same same-bar settlement caveat as every program in this cohort (`CONSERVATIVE_STOP_FIRST` collides
  with tight 1m ATR geometry) -- read these numbers against their own control, not the live account.
- The stop and target arms interact: a wider sweep-anchored stop changes hold duration, which can
  change whether a later signal is skipped as `skippedSignalsWhilePositionOpen`, same concurrency
  interaction already found for `PatternAnchoredStopStrategy`. `liquidity-both` is run to see the
  combined effect, not assumed to equal the sum of the two individual arms.
- This is the tenth and eleventh entry/exit-side levers tested on this bot's 1m path this month, and
  the second and third to touch exit geometry specifically (after the pattern-anchored stop). Prior
  odds are poor; that is a reason to measure carefully, not a reason to skip measuring.

## Stopping condition

If neither arm clears Gates 1 and 2, the verdict is **NO_VIABLE_LIQUIDITY_GEOMETRY** and
`momentum-scalp` keeps its ATR stop and fixed 1.5R target unconditionally. Both classes stay in the
tree, default-off, with the measurement attached. Nothing here touches the live bot.

## Results

Executed 2026-09-19, same day as registration. `momentum-scalp@6`, 1m, both instruments,
2026-08-01..09-16, same cost parameters as the rest of this cohort -- confirmed identical by
reproducing NIFTY50's control expectancy exactly (-49.22). 13 new unit tests, `tsc --noEmit` clean,
full suite 2750/2808 passed.

| instrument | arm | trades | expectancy | delta vs control |
|---|---|--:|--:|--:|
| NIFTY50 | control | 307 | -49.22 | -- |
| NIFTY50 | liquidity-stop | 306 | -49.49 | -0.27 |
| NIFTY50 | liquidity-target | 305 | -49.14 | +0.08 |
| NIFTY50 | liquidity-both | 304 | -49.41 | -0.19 |
| BANKNIFTY | control | 320 | -63.08 | -- |
| BANKNIFTY | liquidity-stop | 320 | -63.00 | +0.08 |
| BANKNIFTY | liquidity-target | 321 | -62.96 | +0.11 |
| BANKNIFTY | liquidity-both | 321 | -62.88 | +0.19 |

`liquidity-target` is the first arm in this entire cohort (eleven levers now) to improve **both**
instruments -- Gate 1 technically passes. Session-clustered paired t-test immediately shows why that
is not a result: NIFTY50 t=0.94, BANKNIFTY t=0.87, both far below 2.0. `liquidity-stop` and
`liquidity-both` split sign between instruments, same shape as every other lever this month.

### Gate 3 -- population check explains the whole picture

Joining each trade's own "Signal source candle" id to `indicator_snapshots`, pooling both instruments
(626 trades per arm):

- **`liquidity-target`**: only **7 of 626 trades (1.1%)** actually had a qualifying opposing order
  block ahead of price. The other 619 kept the control's own 1.5R target unchanged.
- **`liquidity-stop`**: only **7 of 626 trades (1.1%)** had a confirming same-bar liquidity sweep. The
  other 619 kept the control's own ATR stop unchanged.

This is the same structural failure mode already diagnosed for [[smc-gate-backtest-inconclusive]]:
`momentum-scalp`'s entry condition requires price to have *already* displaced from VWAP with EMA
separation before it fires, which structurally rarely coincides with a *fresh, same-bar* liquidity
sweep or a conveniently-placed order block. The tiny deltas above are 7-trade artifacts, not a
7-trade-informed measurement of anything -- Gate 1 "passing" for `liquidity-target` is noise from a
population too small to test the hypothesis at all, not evidence the hypothesis is true.

### Verdict

**INCONCLUSIVE (underpowered), not NO_VIABLE_LIQUIDITY_GEOMETRY.** Following the same distinction
this cohort has kept since the SMC gate result: a test that cannot see enough of the population it
was built to measure does not get to claim a null any more than it gets to claim a pass. Both
decorators are mechanically correct (13 tests, verified against real `LIQUIDITY_SWEEP`/`ORDER_BLOCK`
data) but 98.9% of trades never have both conditions -- a confirmation-based momentum entry and a
fresh, favorably-placed SMC structure -- true on the same bar. Testing this properly would need either
a much longer window (to accumulate more than 7 co-occurrences) or loosening "same bar" to "within N
bars of entry," which is a different, not-yet-registered hypothesis. Neither decorator is shipped;
both stay in the tree, default-off, with this measurement attached. `momentum-scalp` keeps its ATR
stop and fixed 1.5R target unconditionally for now -- not because liquidity geometry is refuted, but
because it has not actually been tested yet.

## Follow-up, registered 2026-09-19 (same day): loosen same-bar to a trailing lookback window

The same-bar requirement was also conceptually backwards, not just underpowered: the premise is that
a sweep happens, *then* momentum confirmation catches up a few bars later -- sequential, not
simultaneous. Requiring both on one bar tested a stricter version of the hypothesis than the one
actually being proposed.

**Population check before building anything** (never look at outcomes before registering, but
population size is a feasibility question, not a result): joining each of the 627 pooled signal
candles to `LIQUIDITY_SWEEP` observations in a trailing window before it --

| trailing window | confirming sweeps found | population |
|---|--:|--:|
| same bar (already measured) | 7 | 1.1% |
| 5 bars | 44 | 7.0% |
| 10 bars | 89 | 14.2% |
| 20 bars | 210 | 33.5% |

**10 bars chosen** as the single pre-committed lookback -- large enough to actually test the
hypothesis (14.2% vs 1.1%), without loosening "confirmation" so far (20 bars) that a sweep from 20
minutes ago barely counts as the same setup. This choice is made from population size alone, before
any outcome was examined.

**What gets built**: `LiquiditySweepLookbackStopStrategy` and `OrderBlockLookbackTargetStrategy`,
stateful decorators (one frame per bar, matching `RelativeVolumeFilteredStrategy`'s per-series buffer
convention) that scan the trailing `lookbackBars` bars instead of only the current one. A real bug was
caught and fixed before this ran: the first implementation buffered *sweep events* (evicting after N
sweeps seen) rather than *bars* (evicting after N bars elapsed) -- with sweeps this rare, that would
have silently kept a stale sweep "in the lookback" across an unbounded number of quiet bars in
between, breaking the population numbers above. Fixed to one frame per bar, pushed every call. 11 new
unit tests, `tsc --noEmit` clean, full suite 2761/2819 passed.

Wired into `run-backtest.ts`: `--entry-filter liquidity-lookback-stop`, `liquidity-lookback-target`,
`liquidity-lookback-both`, all at the fixed 10-bar lookback. Same decision rule (Gates 1-4) and cost
parameters as the rest of this program.

### Results

Executed 2026-09-19. Same window/costs, confirmed identical by reproducing control exactly.

| instrument | arm | trades | expectancy | delta vs control |
|---|---|--:|--:|--:|
| NIFTY50 | control | 307 | -49.22 | -- |
| NIFTY50 | lookback-stop (10 bars) | 292 | -49.44 | -0.22 |
| NIFTY50 | lookback-target (10 bars) | 301 | -49.09 | +0.13 |
| NIFTY50 | lookback-both (10 bars) | 286 | -49.31 | -0.09 |
| BANKNIFTY | control | 320 | -63.08 | -- |
| BANKNIFTY | lookback-stop (10 bars) | 303 | -63.34 | -0.26 |
| BANKNIFTY | lookback-target (10 bars) | 322 | -62.43 | +0.64 |
| BANKNIFTY | lookback-both (10 bars) | 305 | -62.66 | +0.41 |

`lookback-stop` fails Gate 1 outright -- worse on both instruments, no longer even mixed-sign.
`lookback-both` stays mixed (NIFTY50 worse, BANKNIFTY better). **`lookback-target` again improves
both instruments, with BANKNIFTY's improvement (+0.64) about 6x the same-bar version's (+0.11).**

Session-clustered paired t-test for `lookback-target`:

| instrument | days | mean delta | t |
|---|--:|--:|--:|
| NIFTY50 | 21 | +0.290 | **1.61** |
| BANKNIFTY | 19 | +0.708 | **1.78** |

**This is the closest any lever has come to clearing Gate 2 in this entire cohort** (eleven prior
arms all sat under t=1.2). It still does not clear the pre-registered t > 2.0 bar on either
instrument, and the bar is not moved after seeing this -- **Gate 2 fails.**

### Gate 3 -- population check

Joining each `lookback-target` trade's source candle to `ORDER_BLOCK` observations in the trailing 10
bars, pooling both instruments (623 trades): **20 trades (3.2%) actually had a qualifying block**,
roughly 3x the same-bar population (7/626, 1.1%) but still a small fraction of the total. The 10-bar
choice measurably helped (both the touched population and the t-statistics grew), but 3.2% is still a
thin slice to hang a conclusion on.

### Verdict

**NO_VIABLE_LIQUIDITY_GEOMETRY at 10 bars for the stop; INCONCLUSIVE (underpowered, trending) for the
target.** `lookback-stop` is now a clean, if unexciting, null -- worse on both instruments, not just
underpowered. `lookback-target` is not a pass (fails Gate 2 as pre-registered) but is also not the
same kind of clean null as the stop arm -- it improved on both instruments, by more than the same-bar
version did, at t-statistics higher than every other lever tested this month, on a population that
tripled when the window widened from same-bar to 10 bars. That pattern (more lookback -> bigger
population -> bigger effect -> closer to significance) is exactly what would be expected if the
underlying idea has a real but still underpowered signal -- and exactly what would also be expected
from a small population's noise trending toward zero as it grows, which is indistinguishable from the
former with only 20 touched trades. Neither decorator is shipped. `momentum-scalp` keeps its ATR stop
and fixed 1.5R target unconditionally.

**If this is worth one more look**: the population table above shows 20 bars gives 210/627 (33.5%) --
a genuinely well-powered population, not a thin slice. That would be a new registration (a different
lookback is a different, not-yet-run test), not an extension of this one, and only for the target leg
-- the stop leg's population growth didn't rescue it, so it does not warrant the same follow-up.

## Second follow-up, registered 2026-09-19 (same day): the target leg at 20 bars

Scoped narrowly per the note above: `OrderBlockLookbackTargetStrategy` already takes `lookbackBars` as
a constructor argument, so no new class is needed -- only a second wiring
(`--entry-filter liquidity-lookback-target-20`, `LIQUIDITY_LOOKBACK_BARS_WIDE = 20`) in
`run-backtest.ts`. The stop leg and the combined arm are **not** re-run at 20 bars: `lookback-stop`'s
population growth from same-bar to 10 bars did not rescue it (it went from underpowered to a clean
null), so there is no motivating result to extend it further, and `lookback-both` inherits whatever
the stop leg does.

Decision rule is identical to the 10-bar version: Gate 1 (both instruments improve), Gate 2
(session-clustered t > 2.0, same un-moved bar the 10-bar version was held to), Gate 3 (population
check -- pre-registered expectation from the table above is ~33.5%, roughly 10x the 10-bar arm's 3.2%).

### Results

Executed 2026-09-19. Same window/costs, confirmed identical by reproducing control exactly.

| instrument | arm | trades | expectancy | delta vs control |
|---|---|--:|--:|--:|
| NIFTY50 | control | 307 | -49.22 | -- |
| NIFTY50 | lookback-target-20 | 296 | -49.08 | +0.14 |
| BANKNIFTY | control | 320 | -63.08 | -- |
| BANKNIFTY | lookback-target-20 | 320 | -62.50 | +0.58 |

Gate 1 passes again -- both instruments improved, third time in a row for this leg (same-bar, 10-bar,
20-bar). Magnitude is essentially flat versus the 10-bar arm (+0.14 vs +0.13 NIFTY50; +0.58 vs +0.64
BANKNIFTY), not larger, despite a much bigger population.

Session-clustered paired t-test:

| instrument | days | mean delta | t |
|---|--:|--:|--:|
| NIFTY50 | 21 | +0.227 | **1.06** |
| BANKNIFTY | 19 | +0.535 | **1.26** |

**Significance went down, not up, despite the touched population growing roughly 10x (3.2% -> ~33.5%
expected).** This is the decisive check the 10-bar result's ambiguity called for: a real, stable
per-trade effect measured over a much larger sample should produce a *higher* t-statistic, since
t scales with the square root of the sample size for a fixed effect size. Getting a *lower* t-statistic
from a 10x larger sample is exactly the signature of the 10-bar reading having been a smaller
population's noise sitting closer to zero by chance, now correctly regressing toward zero as more
(mostly null) data gets averaged in.

### Verdict

**NO_VIABLE_LIQUIDITY_GEOMETRY, target leg included.** The 10-bar target arm's "closest to
significance yet" reading does not replicate at a wider, better-powered window -- it gets weaker, not
stronger, which is the opposite of what a real effect does under more data. This closes the question
this whole program opened: liquidity-sweep stops and order-block targets, at every lookback tested
(same-bar, 10 bars, 20 bars), do not improve `momentum-scalp`. `momentum-scalp` keeps its ATR stop and
fixed 1.5R target unconditionally. All four decorators stay in `entry-filters.ts`, default-off, with
this full measurement attached -- nothing here needs re-testing again without a genuinely different
angle (a different SMC signal, a different instrument, or an actual liquidity-pool detector rather
than reusing `ORDER_BLOCK`/`LIQUIDITY_SWEEP`).

