# AutoBot-Scalp1m confirmation-lag falsification program v1

**Registered 2026-09-18, before any measurement of retuning `momentum-scalp`'s own entry
parameters.** Nothing below may be revised after a result is seen. If the design turns out to be
wrong, this document gets a dated amendment saying so and the run is discarded, not re-scored.

## Why this exists

Every entry/exit-side lever tested on this bot so far (chop filters, signal inversion, time-of-day,
RVOL, SMC gate, pattern alignment, pattern-anchored stops -- see
[[scalp1m-adverse-signal-both-instruments]]) has been a **filter bolted onto the existing signal**:
something that decides whether to admit or block a proposal the base strategy already produced. All
eight came back null or inconclusive.

A live trade on 2026-09-18 (NIFTY50 LONG, entered on the 06:43 UTC candle's close at 23322.80,
stopped out four minutes later at 23315.80 as price fell to a 23305.95 low) illustrated a different,
un-tested hypothesis: the entry condition itself is structurally lagged. `momentum-scalp` requires
price to have already displaced `minimumVwapDisplacementAtr` (0.10 ATR) past VWAP, with EMA(3/8)
already separated and RSI already inside a confirming band, before it can fire at all
(`momentum-scalp-strategy.ts:675-688`). That is confirmation *of a move that already happened*, and
on the live trade above the move had already reversed one bar after the entry condition was
satisfied. [[index-scalp-signal-is-adverse-not-weak]] and [[scalp-entry-timing-adverse-selection]]
already documented this pattern in aggregate; this program tests whether loosening the confirmation
threshold -- catching the same kind of move earlier, before it is as far along -- changes the
outcome, rather than filtering the same late population after the fact.

**This is not a new code path.** `run-backtest.ts` already supports `--strategy-config` as a JSON
override merged over the registered configuration (`run-backtest.ts:279-287`), so every arm here is
the existing, unmodified `MomentumScalpStrategy` running under different parameter values -- nothing
new to unit-test, no new decorator.

**Expected outcome, given the prior mixed record and that the base signal already loses on
frictionless daily data** ([[momentum-scalp-no-edge]]): retuning the confirmation threshold changes
*which* trades get taken, not necessarily *whether* the underlying setup has edge. A null here would
extend, not contradict, that finding. Registering before measuring is what keeps a positive number
honest either way.

## What gets tested

Three configs, each changing exactly one parameter group from the registered v6 default, so an
effect can be attributed rather than confounded:

| config | change | rationale |
|---|---|---|
| LAG_A | `minimumVwapDisplacementAtr: 0.05` (was 0.10), `idealVwapDisplacementAtr: 0.35` (was 0.60) | halves the displacement required before the hard gate admits a bar, and halves where the score peaks -- confirms with less of the move already spent |
| LAG_B | `indicatorParameters.EMA_FAST.period: 2` (was 3), `EMA_SLOW.period: 5` (was 8) | a faster-crossing EMA pair separates sooner after a direction change |
| LAG_C | `rsiLongMin: 50, rsiLongMax: 70` (was 55/75), `rsiShortMin: 30, rsiShortMax: 50` (was 25/45) | same band width, shifted 5 points toward the neutral midline so RSI does not have to travel as far before it confirms |

All other parameters (ATR stop 1.0x, RRR 1.5, `maximumVwapDisplacementAtr` 2.5, confidence floor 0.5)
are left at the v6 default in every arm, including control.

## Unit of analysis

**The trade.** Expectancy in the underlying's own points per trade, matching every other program in
this cohort. Same instruments (NIFTY50, BANKNIFTY), same timeframe (1m), same 6-week window
(2026-08-01 to 2026-09-16), same cost parameters (quantity 1, ₹20/order, 2bps slippage,
`initial-capital` 1,000,000) as the rest of this cohort.

## Decision rule

- **Gate 1 -- sign replication.** Mean expectancy under a config is higher than control's on **both**
  NIFTY50 and BANKNIFTY independently.
- **Gate 2 -- noise floor.** Session-clustered t > 2.0 on the delta (config minus control).
- **Gate 3 -- population check.** Report trade count and win rate per arm. A looser confirmation
  threshold should, mechanically, admit *more* trades (LAG_A, LAG_C) or admit them *sooner in a move*
  without necessarily changing count (LAG_B); a config that instead produces *fewer* trades than
  control failed to loosen anything and did not test the stated hypothesis.
- **Gate 4 -- population-shrink ambiguity.** A config that raises mean expectancy while cutting trade
  count by more than half is ambiguous, not a pass -- same rule as every other program in this cohort.

## Pre-committed threats to validity

- Same same-bar settlement caveat as every program in this cohort: `CONSERVATIVE_STOP_FIRST` collides
  with tight 1m ATR geometry, so raw win rates run well below the live account's. Read these numbers
  against their own control, not the live account's scale.
- A looser displacement floor or faster EMA pair will fire on bars the control never considered at
  all, so this is not a subset/superset comparison the way the entry filters were -- it is a genuinely
  different population, and Gate 3's population check exists specifically to characterise that
  difference rather than let a trade-count change pass unremarked.
- This is the ninth entry-side lever tested on this bot's 1m path this month, and the first that
  retunes the base signal rather than filtering around it -- worth naming as a different kind of test,
  not assuming it inherits the odds of the previous eight mechanically, but also not assuming it is
  exempt from them.

## Stopping condition

If no config clears Gates 1 and 2, the verdict is **NO_VIABLE_LAG_REDUCTION** and `momentum-scalp`
keeps its v6 default parameters unconditionally. Nothing here touches the live bot regardless of
outcome -- these are backtest-only configuration overrides, not a new registered strategy version.

## Results

Executed 2026-09-18, same day as registration. `momentum-scalp@6`, 1m, both instruments,
2026-08-01..09-16, quantity 1, ₹20/order, 2bps slippage, `initial-capital` 1,000,000 -- confirmed
identical to the rest of this cohort by reproducing NIFTY50's control expectancy exactly (-49.22)
before running the new configs.

| instrument | arm | trades | expectancy | delta vs control |
|---|---|--:|--:|--:|
| NIFTY50 | control | 307 | -49.22 | -- |
| NIFTY50 | LAG_A | 315 | -49.04 | +0.18 |
| NIFTY50 | LAG_B | **0** | **n/a** | **n/a** |
| NIFTY50 | LAG_C | 377 | -49.81 | -0.59 |
| BANKNIFTY | control | 320 | -63.08 | -- |
| BANKNIFTY | LAG_A | 326 | -63.47 | -0.40 |
| BANKNIFTY | LAG_B | **0** | **n/a** | **n/a** |
| BANKNIFTY | LAG_C | 394 | -63.18 | -0.10 |

### LAG_B did not test anything -- it is a data-availability gap, not a result

Before treating "0 trades on both instruments" as a finding, checked why: `indicator_snapshots` has
**no EMA rows at all for period 2 or period 5** -- only periods 3, 8, 9 and 20 have ever been
computed (1.5-1.6M rows each). `resolveIndicators` returns `null` the instant either EMA lookup
misses, so `evaluate()` returned `[]` on literally every bar regardless of price action -- the same
failure mode already named in this cohort's own convention (a filter that silently changes the
population because its input is absent reports the wrong thing under the real name). **LAG_B is
untestable with existing data, not refuted.** Testing a faster EMA pair for real would need those
periods backfilled into `indicator_snapshots` first -- not done here, since the two hypotheses that
could be tested with existing data (LAG_A, LAG_C) already give a clear enough answer below.

### Gate 3 -- population check

Both testable configs behaved as mechanically expected: LAG_A (looser displacement floor) and LAG_C
(shifted RSI band) both admitted *more* trades than control on both instruments (315/326 and
377/394 vs 307/320) -- confirming the loosened threshold actually loosened something, not an
artifact.

Session-clustered paired t-test (LAG_A, the only arm with a positive delta on either instrument):

| instrument | days | mean delta | t |
|---|--:|--:|--:|
| NIFTY50 | 21 | +0.159 | 0.67 |
| BANKNIFTY | 19 | -0.452 | -1.02 |

### Verdict

**NO_VIABLE_LAG_REDUCTION.**

- Gate 1 (sign replication) -- failed for both testable configs. LAG_A improves NIFTY50 marginally
  (+0.18) and worsens BANKNIFTY (-0.40) -- the same opposite-signed-between-instruments shape as
  every other lever tested this month. LAG_C worsens both instruments outright.
- Gate 2 (noise floor) -- not reached for LAG_C (already failed Gate 1 both ways); for LAG_A,
  |t| = 0.67 and 1.02, far below 2.0.
- Gate 3 (population check) -- passed on its own terms (both configs demonstrably loosened the
  gate), which rules out "nothing changed" as the explanation for the null -- the loosened
  population is real and still shows no edge.
- LAG_B -- inconclusive by data availability, not by measurement; flagged as a gap rather than
  folded into the verdict.

Catching a `momentum-scalp` move earlier does not help: entering sooner just means entering into more
noise before the same underlying signal quality asserts itself, consistent with
[[momentum-scalp-no-edge]]'s frictionless-daily finding that the base setup lacks a stable edge to
catch early or late. This is the ninth entry-side lever tested on this bot's 1m path and the first
to retune the base signal rather than filter around it -- and it joins the other eight at null. No
config here beats leaving `momentum-scalp` at its registered v6 parameters. Nothing is deployed;
these are backtest-only `--strategy-config` overrides, not a new strategy version.

