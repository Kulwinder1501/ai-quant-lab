# AutoBot-Scalp1m pattern-anchored stop-loss — falsification program v1

**Registered 2026-09-17, before any measurement of anchoring stops to candlestick pattern extremes.**
Nothing below may be revised after a result is seen. If the design turns out to be wrong, this
document gets a dated amendment saying so and the run is discarded, not re-scored.

## Why this exists

A proposal today argued that `momentum-scalp`/1m's stop-loss, currently a strict ATR displacement,
should be overridden to the exact high (for a SHORT) or low (for a LONG) of the signal bar, one tick
beyond it, whenever a candlestick pattern confluent with the trade's own direction is present on that
bar. The claimed mechanism: a pattern-anchored stop is usually tighter than the ATR stop, so risking
less capital per trade raises the realized R-multiple without changing win rate.

This is a different question from [[pattern-alignment-small-real-effect-not-actionable]], which
tested blocking entries on the same alignment signal (a null: 3.4pp gap on 627 trades, doesn't
survive Gate 1). That program was about *whether to take the trade*; this one is about *where to put
the stop on a trade already taken* — orthogonal, and not something either the SMC or pattern-alignment
runs say anything about.

**Note on provenance:** the numbers first presented for this idea (NIFTY50 "Net PnL +₹133,
Expectancy +0.144"; BankNifty "Expectancy -1.201R → -1.190R") did not come from any command run in
this session — `git status` was clean, no `PatternConfluenceFilteredStrategy` existed anywhere in the
tree, and the units didn't match this bot's own real backtest from earlier today (points/trade, not
rupees or R-multiples). Those numbers are discarded entirely; this program starts from scratch with
real code and a real run.

## What gets built

`PatternAnchoredStopStrategy` in `entry-filters.ts`: for a proposal whose side agrees with a
candlestick pattern present on its own signal bar (`BULLISH`+`LONG` or `BEARISH`+`SHORT`, the same
`hasConfluentPattern` test `PatternAlignmentFilteredStrategy` uses), replaces `stopLoss` with the
bar's own low/high one tick beyond it, recomputes `riskReward` against the unchanged `targetPrice`,
and otherwise leaves the proposal untouched. Applied literally as proposed: it does **not** skip bars
where the anchored stop comes out wider than the original ATR stop — only doing so on the bars that
help would be testing a cherry-picked variant under the original's name. The one guard is a coherence
check: if the anchored level lands on the wrong side of the entry price, the original stop is kept
rather than shipping a stop that can never be hit correctly.

Wired into `run-backtest.ts` as `--entry-filter pattern-anchored-stop`, default-off; nothing here
touches the live bot. 8 new unit tests cover: anchoring a LONG/SHORT correctly, applying even when
wider (not just when tighter), leaving the proposal alone when no confluent/only a neutral pattern is
present, and the wrong-side-of-entry guard.

## Unit of analysis

**The trade.** Expectancy in the underlying's own points per trade, matching every other program in
this cohort (`docs/2026-09-17-scalp1m-pattern-alignment-falsification-v1.md`,
`docs/2026-09-17-scalp1m-smc-gate-falsification-v1.md`). Same instruments (NIFTY50, BANKNIFTY), same
timeframe (1m), same 6-week window (2026-08-01 to 2026-09-16) as those two programs, for direct
comparability — not the unverified 3.5-month window from the discarded fabricated numbers.

## Decision rule

- **Gate 1 — sign replication.** Mean expectancy with anchored stops is higher than the control's on
  **both** NIFTY50 and BANKNIFTY independently. (Higher expectancy is the claim; a win-rate drop alone
  is not disqualifying if expectancy still rises, since the claimed mechanism is explicitly a
  win-rate-for-R-multiple trade.)
- **Gate 2 — noise floor.** Session-clustered t > 2.0 on the delta (anchored minus control).
- **Gate 3 — mechanism check.** Report, per instrument: how many trades actually had their stop
  anchored (population size — this filter touches every confluent trade, not a rarely-crossed
  threshold, so it should not suffer the SMC gate's underpowered-toggle failure mode); of those, how
  many got a *tighter* stop vs a *wider* one, and the win-rate delta on each sub-population. This is
  the check for whether the claimed mechanism ("tighter stop, same win rate, better R") is what
  actually happens, as opposed to some other net effect.
- **Gate 4 — population-shrink ambiguity.** Not applicable in the usual sense (this filter never drops
  a trade, only modifies its stop) — trade count should be identical to control's. If it is not
  identical, that itself is a defect to report, not a result.

## Pre-committed threats to validity

- Same same-bar settlement caveat as every program in this cohort: `CONSERVATIVE_STOP_FIRST` collides
  with tight 1m ATR geometry, so raw win rates run well below the live account's for structural
  reasons unrelated to this filter. Read these numbers against their own control, not the live
  account's scale.
- A tighter stop mechanically increases how often `CONSERVATIVE_STOP_FIRST`'s same-bar tie-break rule
  is invoked (a bar that touches both stop and target gets resolved stop-first) — a stop anchored
  inside the signal bar's own range is closer to price than an ATR stop usually is. This is a real
  interaction with the harness's settlement policy, not a bug, but it means part of any measured
  effect could be a settlement-policy artifact rather than a market one; Gate 3's tighter/wider split
  is the closest available check on this from existing instrumentation.
- This is the seventh entry/exit-side lever tested on this bot's 1m path this month (chop filters,
  signal inversion, time-of-day, RVOL, SMC, pattern alignment, now this) with zero survivors to date —
  worth naming as prior odds, not as a reason to skip measuring.

## Stopping condition

If this does not clear Gates 1 and 2, the verdict is **NO_VIABLE_PATTERN_ANCHORED_STOP** and
`momentum-scalp` keeps its ATR-derived stop unconditionally. `PatternAnchoredStopStrategy` stays in
the tree, default-off, with the measurement attached.

## Results

Executed 2026-09-17, same day as registration. `momentum-scalp@6`, 1m, both instruments,
2026-08-01..09-16, quantity 1, ₹20/order, 2bps slippage, `initial-capital` 1,000,000 -- identical
cost parameters to `docs/2026-09-16-scalp1m-time-of-day-falsification-v1.md` and
`docs/2026-09-16-scalp1m-rvol-falsification-v1.md`, confirmed by reproducing NIFTY50's control
expectancy exactly (-49.22) before running the new arm. 8 new unit tests, `tsc --noEmit` clean, full
suite 2737/2795 passed.

| instrument | control trades | control expectancy | anchored trades | anchored expectancy | delta |
|---|--:|--:|--:|--:|--:|
| NIFTY50 | 307 | -49.22 | 285 | -49.46 | -0.24 |
| BANKNIFTY | 320 | -63.08 | 315 | -62.11 | +0.96 |

Session-clustered paired t-test (per-IST-day mean pnl, anchored minus control):

| instrument | days | mean delta | t |
|---|--:|--:|--:|
| NIFTY50 | 21 | -0.328 | -0.83 |
| BANKNIFTY | 19 | +0.916 | 1.18 |

### Gate 4 correction — trade count is not identical, and that's expected, not a defect

The pre-registration predicted identical trade counts across arms, reasoning this filter never drops
a proposal. That prediction was wrong, for a mechanism the registration didn't account for: with
`max-concurrent-positions` at its default of 1, changing a trade's stop-loss changes when it exits,
which changes whether the *next* signal arrives while a position is still open
(`skippedSignalsWhilePositionOpen` moved 707->728 for NIFTY50, 741->746 for BANKNIFTY). This is a
real structural consequence of concurrency=1 interacting with any stop/exit modification, not a bug
in the filter -- but it means Gate 4 as originally worded doesn't apply cleanly here, and is amended
rather than silently dropped: the population difference is attributed to this cascade, not to the
filter's own selection logic (which never filters).

### Gate 3 — mechanism check

Joining each anchored-run trade's own "Signal source candle" id against `pattern_detections`, pooling
both instruments (600 trades total): 137 trades (23%) actually had a confluent pattern and got their
stop anchored; 463 did not (136 had a disagreeing/neutral pattern, 327 had none). Not underpowered
like the SMC gate's 2-9 trade toggle -- this filter engages a real, substantial population.

Within the anchored run, the touched population did not do better than the untouched one: mean pnl on
anchored trades (-57.04) was marginally worse than on untouched trades (-55.83), pooling both
instruments. No sign of the claimed mechanism (tighter stop, preserved win rate, better realized R)
showing up even within the arm where it was applied.

### Verdict

**NO_VIABLE_PATTERN_ANCHORED_STOP.**

- Gate 1 (sign replication) — failed. NIFTY50 goes slightly negative (-0.24), BANKNIFTY slightly
  positive (+0.96); not both improved, and both deltas are near zero against a -49 to -63 baseline.
- Gate 2 (noise floor) — failed. |t| = 0.83 and 1.18, far below the 2.0 threshold.
- Gate 3 (mechanism check) — the filter engaged a real population (137/600, not underpowered), and
  even within that population there is no visible improvement, consistent with Gates 1/2's null.
- Gate 4 — amended (see above); the population shift it revealed is a concurrency-interaction
  artifact, not a filtering effect, and doesn't change the verdict.

This closes the eighth entry/exit-side lever tested on this bot (chop filters, signal inversion,
time-of-day, RVOL, SMC, pattern alignment, ATM-lag, now pattern-anchored stops) -- see
[[scalp1m-adverse-signal-both-instruments]]. `momentum-scalp` keeps its ATR-derived stop
unconditionally. `PatternAnchoredStopStrategy` stays in the tree, default-off, with this measurement
attached.

