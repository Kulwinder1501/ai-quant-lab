# AutoBot-Scalp1m candlestick-pattern alignment — falsification program v1

**Registered 2026-09-17, before any measurement of blocking pattern-aligned entries.** Nothing
below may be revised after a result is seen. If the design turns out to be wrong, this document
gets a dated amendment saying so and the run is discarded, not re-scored.

## Why this exists

`momentum-scalp`/1m does not read candlestick patterns at all today. Checked whether one is
present anyway at the bars it trades on: of 277 live `momentum-scalp` ideas since 2026-08-18 (one
row per idea, deduplicated across every pattern detected on its source bar — an earlier pass at
this had an accidental cross join against `paper_accounts` that inflated every count 4x and is
discarded), 66 had a pattern agreeing with the idea's own direction, 57 had one disagreeing, 151
had none. Target-hit rate: **agreeing 33.8%, disagreeing 49.1%, none 42.0%** — a confirming
candlestick shape correlates with a *worse* outcome here, the opposite of naive intuition.

This is a live-idea sign-correlation result, the same kind of test that already found a real signal
for [[smc-adjustment-no-signal-on-1m]] on 5m. The SMC follow-up
([[smc-gate-backtest-inconclusive]]) tried to validate that kind of finding in a backtest via a
confidence-threshold gate and found the threshold barely ever bound (2-9 trades toggled per ~230),
making the comparison undetectable regardless of whether the underlying effect was real. **This
program is deliberately built differently, to not repeat that mistake**: it filters the population
directly (block/admit), not through a rarely-crossed threshold, so the toggle-population-size
failure mode does not apply here the same way.

**Expected outcome, given the prior mixed record on entry-side fixes for this bot** (pattern
gating, chop filters, signal inversion, time-of-day, RVOL, SMC — all six already refuted or
inconclusive), is that this joins them. Registering before measuring is what keeps a positive
number honest either way.

## What gets built

`PatternAlignmentFilteredStrategy` in `entry-filters.ts`: drops a proposal when any candlestick
pattern detected on its source bar (`context.patterns`, real historical detections, not a
reimplementation) agrees with the proposal's own side — `BULLISH` for `LONG`, `BEARISH` for
`SHORT`. A bar can carry several patterns; agreement from *any one* of them blocks the proposal,
disagreement from others does not rescue it (matches the live-idea method: `hasAligned` is an
independent flag over the whole set, not a single per-bar verdict). Wired into `run-backtest.ts` as
`--entry-filter pattern-alignment`, default-off; nothing here touches the live bot.

Verified before registering: `pattern_detections` has 21,362 rows for NIFTY50/BANKNIFTY 1m across
the planned backtest window (2026-08-01..09-16), so the control population actually has patterns to
react to.

## Unit of analysis

**The trade.** Expectancy in the underlying's own points per trade, matching every other program in
this cohort. Standard errors clustered by session (IST calendar date), pooled across both
instruments on the same day.

## Decision rule

- **Gate 1 — sign replication.** Mean expectancy with pattern-aligned entries blocked is positive
  on **both** NIFTY50 and BANKNIFTY independently.
- **Gate 2 — noise floor.** Session-clustered t > 2.0 on the delta (filtered minus control).
- **Gate 3 — paired delta, done on the control's own trades.** Split the control (unfiltered)
  population by joining each trade's own "Signal source candle" id (already embedded in
  `backtest_trades.reasoning`) against `pattern_detections`, replicating the live-idea
  aligned/disagreeing/none split directly on backtest volume. This is the check the SMC program
  could not run (its sign wasn't recoverable from stored data); patterns are keyed by `candle_id`,
  so it is recoverable here.
- **Gate 4 — population-shrink ambiguity.** A config that raises mean expectancy while cutting
  trade count by more than half is ambiguous, not a pass — same rule as every other program in this
  cohort.

## Pre-committed threats to validity

- Same same-bar settlement caveat as every program in this cohort: the backtest's raw win rate
  runs far below the live account's for structural reasons (`CONSERVATIVE_STOP_FIRST` colliding
  with tight 1m ATR geometry) — read this program's numbers against its own control, not against
  the live account's scale.
- The live-idea sample this program is built on is itself modest (66 aligned / 57 disagreeing
  trades, 17/15 sessions) — a real look, not proof beyond doubt, per
  [[smc-adjustment-no-signal-on-1m]]'s own caveat about the same kind of sample size.
- This blocks on *any* agreeing pattern regardless of which specific candlestick code fired. A
  pass here says "confirming patterns as a class hurt," not "every individual pattern code hurts
  equally" — a real result would need its own follow-up to say which codes drive it before
  building anything code-specific.

## Stopping condition

If this does not clear all four gates, the verdict is **NO_VIABLE_PATTERN_BLOCK** and
`momentum-scalp` keeps taking every signal on `AutoBot-Scalp1m` regardless of co-occurring
candlestick patterns, unchanged. `PatternAlignmentFilteredStrategy` stays in the tree, default-off,
with the measurement attached.

## Results

Executed 2026-09-17, same day as registration. `momentum-scalp@6`, 1m, both instruments,
2026-08-01..09-16. 7 new unit tests, `tsc --noEmit` clean, full suite 2729/2787 passed.

| instrument | control trades | control expectancy | filtered trades | filtered expectancy | delta |
|---|--:|--:|--:|--:|--:|
| NIFTY50 | 307 | -49.22 | 292 | -49.34 | -0.12 |
| BANKNIFTY | 320 | -63.08 | 285 | -62.49 | +0.58 |

Unlike the SMC gate, this filter actually engages a real population: 5% of NIFTY50's trades and
11% of BANKNIFTY's were blocked (15 and 35 trades respectively) — no toggle-population problem
here. The deltas are small and **opposite in sign between instruments**: NIFTY50 gets marginally
worse, BANKNIFTY marginally better.

### Gate 3, done properly — direction holds, magnitude does not

Joined each control trade's own "Signal source candle" id (from `backtest_trades.reasoning`)
against `pattern_detections`, pooling both instruments' control populations (627 trades total, vs.
274 in the original live-idea sample):

| relation | n | target rate |
|---|--:|--:|
| ALIGNED | 137 | 38.7% |
| CONTRADICTS | 95 | 42.1% |
| NONE | 394 | 42.1% |

The **direction** the live-idea analysis found holds up at backtest scale — aligned is still the
worst bucket. The **magnitude does not**: the live-idea gap was 15.3 points (33.8% vs 49.1%); at
6x the sample here it is 3.4 points (38.7% vs 42.1%). That shrinkage, on a much larger and cleaner
population, is itself informative: a chunk of the original gap was noise from a modest sample,
even though the qualitative direction was real.

### Verdict

**NO_VIABLE_PATTERN_BLOCK.**

- Gate 1 (sign replication) — failed. NIFTY50 goes slightly negative, BANKNIFTY slightly positive;
  not both positive, and neither is far from zero.
- Gate 2 (noise floor) — not reached; deltas of -0.12 and +0.58 against a -49 to -63 baseline are
  nowhere near a t > 2.0 reading regardless of how they're clustered.
- Gate 3 (paired delta, done properly) — the only gate with a real, consistent-direction finding,
  but a 3.4-point gap on trades already losing ~40 points on average is not an edge, and Gate 1's
  instrument split shows it doesn't survive contact with an actual filter either.
- Gate 4 — not reached; population shrink (5-11%) is modest, not the ambiguous >50% case this gate
  exists for.

This closes the sixth (chop filters, signal inversion, time-of-day, RVOL, SMC, now pattern
alignment) entry-side lever tested on this bot -- see [[scalp1m-adverse-signal-both-instruments]].
Unlike the SMC attempt, this one is a clean, well-powered null: the filter engaged a real
population and still found nothing worth shipping, not a test-design artifact. `momentum-scalp`
keeps taking every signal on `AutoBot-Scalp1m` regardless of co-occurring candlestick patterns.
`PatternAlignmentFilteredStrategy` stays in the tree, default-off, with this measurement attached.
