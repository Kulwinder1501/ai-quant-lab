# AutoBot-Scalp1m SMC confidence gate — falsification program v1

**Registered 2026-09-17, before any measurement of disabling the SMC confidence adjustment.**
Nothing below may be revised after a result is seen. If the design turns out to be wrong, this
document gets a dated amendment saying so and the run is discarded, not re-scored.

## Why this exists

Live case 2026-09-17: a NIFTY50 momentum-scalp LONG at 11:55 IST scored 66.6% base confidence, then
`smc-v2` docked it 8 points (a bearish liquidity sweep + bearish order block at entry) to 58.6% —
below the 0.6 minimum required for options entries, so the trade was never opened. The underlying
subsequently blew past target by 60+ points.

Checked whether this was a one-off by walking 429 historical SMC-adjusted trade ideas
([[smc-adjustment-no-signal-on-1m]]): on `momentum-scalp`/1m specifically (n=93), a contradicted
idea hits target 44.8% of the time vs. 45.3% for a confirmed one — no measurable difference. On
`momentum-scalp-index`/5m (n=336) there's a real 9-point gap in the expected direction (36.1% vs
26.9%).

**That analysis has a real limitation the user asked to close before touching live code**: it only
covers ideas that already survived the base strategy gate and happened to carry an SMC signal in
live trading — not a full historical population, and not a controlled comparison. This program
re-tests the same question properly: a backtest, pre-registered, over historical candles.

**Expected outcome, given the live-idea result, is that disabling SMC does not help on 1m and may
hurt on 5m** — this program is not designed to find a positive result, it is designed to make sure
one isn't claimed without a real look first.

## What gets built

`SmcConfidenceGatedStrategy` in `entry-filters.ts`: replays the live decision pipeline exactly —
optionally applies the real `applySmcConfluenceToProposal` (the same function
`generate-trade-ideas.ts` calls, not a re-implementation), then drops anything below the literal
`0.6` options-entry floor (`options-entry-validator.ts`). `applySmc: true` is the **control** — the
closest a backtest can get to today's live behaviour, since the generic backtest engine never calls
`applySmcConfluenceToProposal` on its own. `applySmc: false` is the **arm under test**.

Verified before registering that this is a meaningful comparison, not a no-op: `smc-v2` indicators
are backfilled across the full 1m candle history (2026-01-01 onward, ~190k snapshot rows, all 6
signal codes) and are loaded into backtest contexts by `PostgresBacktestMarketDataRepository`
unfiltered, so the control arm sees real historical SMC signals, not an empty set.

## Unit of analysis

**The trade.** Expectancy in the underlying's own points per trade (matching
[[scalp1m-time-of-day-gate-no-edge]] and [[scalp1m-rvol-gate-no-edge]] for direct comparability).
Standard errors clustered by session (IST calendar date), pooled across both instruments on the
same day.

## Decision rule

- **Gate 1 — sign replication.** Mean expectancy with SMC disabled is positive on **both** NIFTY50
  and BANKNIFTY independently, on `momentum-scalp`/1m.
- **Gate 2 — noise floor.** Session-clustered t > 2.0 on the delta (off minus on), Bonferroni-
  corrected for 2 timeframes tested (1m primary, 5m sanity check).
- **Gate 3 — paired delta, done on the control's own trades.** Split the control (SMC-on) 1m
  population by whether SMC would have raised or lowered each trade's confidence (its own
  `evidence.smc.adjustment` sign), and compare mean expectancy between the two halves directly —
  same method as the ICT program's "Gate 4, done properly" and the earlier live-idea analysis, now
  on backtest data instead of only live ideas.
- **Gate 4 — 5m sanity check.** Run the identical on/off comparison on `momentum-scalp-index`/5m.
  If SMC-on does not clearly beat SMC-off there (replicating the live-idea 9-point gap), that is a
  reason to distrust this program's methodology on 1m too, not just a side note — it would mean the
  backtest isn't reproducing what the live-idea analysis already found, and the 1m result should not
  be trusted until that's understood.

## Pre-committed threats to validity

- `SmcConfidenceGatedStrategy` gates at a fixed `0.6`, matching the live options-entry floor exactly
  — but the backtest engine trades the underlying directly, not an option, so friction/fill
  differences from the live premium path are not modelled here, same caveat as every other
  entry-filter program this cohort.
- Disabling SMC changes *which* trades are admitted, not just their scoring — a population-size
  shrink/expansion in either direction must be read against Gate 3's paired split, not the raw
  aggregate alone, for the same reason the chop-filter and RVOL programs required it.
- This is a scoring change to the live decision pipeline if it passes, not a research-only entry
  filter like the time-of-day/RVOL programs — a pass here is necessary but not sufficient to change
  `generate-trade-ideas.ts`; that would still need its own review before shipping.

## Stopping condition

If 1m does not clear all four gates, the verdict is **NO_VIABLE_SMC_DISABLE** and the live SMC
confidence adjustment stays applied to `momentum-scalp`/1m unchanged. `SmcConfidenceGatedStrategy`
stays in the tree, default-off, with the measurement attached.

## Results

Executed 2026-09-17, same day as registration. `momentum-scalp@6` (1m) and `momentum-scalp-index@1`
(5m), both instruments, 2026-08-01..09-16 (a shorter window than first attempted -- the full
2026-01-01..09-16 history timed out well past 120s and was abandoned rather than debugged further,
since this window already matches the other two falsification programs' and is more than adequate
for the gates below).

| strategy | instrument | ON trades | ON expectancy | OFF trades | OFF expectancy | delta |
|---|---|--:|--:|--:|--:|--:|
| momentum-scalp (1m) | NIFTY50 | 242 | -49.27 | 234 | -49.18 | +0.09 |
| momentum-scalp (1m) | BANKNIFTY | 250 | -62.00 | 241 | -62.61 | -0.61 |
| momentum-scalp-index (5m) | NIFTY50 | 231 | -49.55 | 233 | -49.41 | +0.14 |
| momentum-scalp-index (5m) | BANKNIFTY | 231 | -63.86 | 233 | -64.72 | -0.86 |

### Gate 4 fails, and it is diagnostic rather than a dead end

**5m does not replicate the 9-point live-idea gap** ([[smc-adjustment-no-signal-on-1m]]) at all --
the ON/OFF delta on 5m (+0.14 / -0.86) is exactly as small as on 1m. Checked why before drawing any
conclusion, per this document's own pre-committed rule: BANKNIFTY 5m's ON and OFF arms differ by
**2 trades out of ~231-233**. Across all four rows, the ON/OFF trade counts differ by 2-9 trades.

**Root cause: `SmcConfidenceGatedStrategy` only detects SMC's effect through one narrow channel --
whether its ±8-10 point adjustment tips a proposal across the literal 0.6 floor.** That is a
different, much narrower question than the one [[smc-adjustment-no-signal-on-1m]] actually
answered (does SMC's directional sign correlate with outcome, across *every* SMC-adjusted idea,
not just the ones sitting close enough to 0.6 to flip). Most proposals' confidence is nowhere near
that boundary, so this decorator's admit/reject toggle barely ever fires -- on 5m as much as 1m --
which is sufficient on its own to explain why both timeframes show a near-zero aggregate delta,
independent of whether SMC carries real information.

`backtest_trades.reasoning` also turned out not to preserve the strategy's own proposal reasoning
(the BacktestEngine writes its own execution-mechanics text -- signal candle, entry/exit policy,
costs -- discarding the proposal's original `reasoning`/`evidence`, SMC line included). So Gate 3
(splitting the control population by SMC's own sign, replicating the live-idea method with backtest
volume) could not be run without adding new instrumentation to capture the sign per trade
separately, which was not built today.

### Verdict

**INCONCLUSIVE, not NO_VIABLE_SMC_DISABLE.** This program does not confirm the live-idea finding,
but it does not contradict it either -- it tested a narrower mechanism than intended and, by its
own pre-registered Gate 4, caught that its test design cannot resolve the question on *either*
timeframe. Per this document's own rule, a 5m sanity-check failure is a reason to distrust the 1m
reading from this specific test, not a green light to report 1m as independently reconfirmed.

**What this means practically:** the best evidence for "does SMC help momentum-scalp/1m" remains
[[smc-adjustment-no-signal-on-1m]] (429 live ideas, n=93 on 1m, sign-correlation method) --
unchanged and not undermined by today's attempt. Today's attempt shows that validating it through
this backtest would need a different design: either instrument `SmcConfidenceGatedStrategy` to log
each admitted trade's SMC sign to a side channel joinable against `backtest_trades` (the "Signal
source candle" UUID already in its stored reasoning is a usable join key), or extend the backtest
engine to preserve proposal evidence on the stored trade. Neither was built today.

**Decision: do not ship the live `generate-trade-ideas.ts` change today.** The diagnosis stands
(documented, real, not undermined), but shipping a live decision-logic change deserves a backtest
that actually tests the mechanism, not one that technically ran but measured something narrower
than intended. `SmcConfidenceGatedStrategy` and this program's infrastructure stay in the tree,
default-off, for whoever picks this up next -- rebuilding it would waste the one thing today's run
did establish cleanly (the toggle-population-size diagnosis).
