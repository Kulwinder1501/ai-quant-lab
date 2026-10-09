# ICT sweep -> MSS -> retrace model: registration and measurement

**Registered 2026-10-09, before any run of the new models.** Nothing below is revised after a result
is seen; a design error gets a dated amendment and the affected run is discarded, not re-scored.

## What changed, and why it needs measuring

An audit of `ict-structure-v1` (2026-10-09) found the strategy was a same-bar "pillar alignment" entry
at the signal close, not the doctrine's sequence, and that several primitives were weaker than their
names. Fixes made the same day, in three groups:

1. **Behaviour-neutral or strictly corrective** (no measurement needed to justify):
   - O1 time stop scaled from a flat 15 minutes to 4 bars of the trade's own timeframe for this
     strategy (`o1-exit-timings.ts`). A scale correction: 15 minutes is one bar on 15m.
   - `requireOte` anchored on the displacement leg when one exists (default-off feature).
   - Limit-entry policy and one-trade-per-setup in the backtester (default-off, default runs unchanged).
2. **Changes which zones exist** (engine v2 -> v3): fair value gaps below 0.1 ATR no longer form;
   order blocks need a displacement body of at least 0.8 ATR. Neither value was fitted; both are floors
   against noise. This changes the population of the existing alignment model, so it is measured.
3. **A new entry model** with its own population: `entryModel: SWEEP_MSS_RETRACE` and
   `SWEEP_MSS_LIMIT` (see `mss.ts`, `ict-structure-strategy.ts`).

## Arms

All on the 15m series, index points, 2 bps slippage, concurrency 5, `--one-trade-per-setup`.

| arm | entry model | engine floors | entry policy |
|---|---|---|---|
| `old` | ALIGNMENT | off (`fvgMinAtrFraction=0, displacementMinAtr=0`) | next open |
| `floors` | ALIGNMENT | on (defaults) | next open |
| `retrace` | SWEEP_MSS_RETRACE | on | next open |
| `limit` | SWEEP_MSS_LIMIT | on | resting limit |

`old` is the control. `floors` isolates group 2. `retrace` and `limit` are the new hypotheses, so the
multiplicity count for Gate 2 is **3** (floors, retrace, limit): Bonferroni threshold t ~ 2.39.

Instruments: NIFTY50 and BANKNIFTY (the two the live bots trade). 5m is **not** in this program: the
live NIFTY 15m / BANKNIFTY 5m split came from selecting the cells that looked best, which this
program refuses to repeat. BANKNIFTY is therefore measured at 15m here and 5m reported only as a
secondary, un-gated column.

## Eras

- Training: 2025-01-01 .. 2025-12-31.
- Holdout: 2026-01-01 .. 2026-09-05. **Run once per arm, and only for an arm that clears Gates 1-2 on
  training.** A second look voids the arm.
- Confirmation set: 2023-01-02 .. 2024-12-31 (already used by the NIFTY exposure program for the
  OLD model; for a NEW model it has not been seen, so it is available as a second independent era).

## Decision rule

An arm passes only by clearing all four. Failing any one is NO_EDGE.

1. **Sign replication**: mean P&L per trade > 0 on both NIFTY50 and BANKNIFTY, independently.
2. **Noise floor**: pooled t > 2.39 with SE clustered by IST session date, pooled across both
   instruments on the same date.
3. **Era replication**: Gates 1 and 2's sign condition holds on the 2023-2024 confirmation set AND the
   2026 holdout (t > 2.0 there; one look each).
4. **Trade count**: at least 60 trades per instrument on training. Fewer is reported UNDERPOWERED,
   not as a failure of the idea.

## Pre-committed threats to validity

- The sweep, shift and OTE definitions are mine, from the doctrine as taught; the codebase's own
  lecture notes cover order blocks and CHoCH but not MSS-with-displacement. A different but equally
  faithful definition might behave differently.
- The `limit` arm's fill rules are deliberately pessimistic (tick-through, stop-only on the fill bar,
  no target credit on the fill bar). Real fills would be somewhere between this and the optimistic case.
- Index points, not option premium: theta and spread are NOT included, so a pass here is necessary,
  not sufficient, for the option bots.
- Two instruments is a thin replication set; a pass licenses widening, not promotion.

## Consequence for the live bots

The live bots keep the OLD behaviour for entry unless an arm passes. The exit-clock fix (group 1) and
the engine floors (group 2) are applied live regardless, because the first is a scale correction and
the second removes zones that only existed because of a dead config key. Switching a live bot to
`SWEEP_MSS_RETRACE` requires that arm to pass. `SWEEP_MSS_LIMIT` may never be wired live: the paper
bots have no resting-order type.

## Amendment 1 -- 2026-10-09, after one run of `retrace` and `limit`, before any re-run

**What was seen.** The first run of the two new arms produced almost nothing: `retrace` 1 trade on
NIFTY50 and 5 on BANKNIFTY, `limit` 4 and 6 (2025, 15m). That is a frequency, and the registration
already says fewer than 60 trades per instrument is UNDERPOWERED, not failed. The P&L of those runs
(`retrace` pooled +37.61 per trade, `limit` -21.74, both t < 0.6 on 6-10 trades) carries no
information and is **discarded, not scored**.

**Cause, found by counting funnel stages only (no outcomes).** The MSS primitive works: about 225
shifts a year on each index, about half aligned with the daily bias. The model then died at the
alignment model's own coverage gate. `coverage.liquidity` is COMPLETE only when the alignment
resolver found a target, which requires trend == bias, price on the correct side of equilibrium and an
ERL beyond equilibrium -- the conditions a reversal violates by definition. 85% of bars carrying a
valid shift (4,331 of 5,083 on NIFTY50) were vetoed by that gate alone. This is a wiring defect in the
new arm, not a property of the idea.

**Change (both made before any re-run):**
1. The shift models require `structure`, `bias` and `htf` coverage only. `liquidity`, `zones` and
   `sessionLevels` are not needed: the stop comes from the sweep and the target from the leg.
2. The objective is the far end of the displacement leg (`mss.legEnd`), capped at `maxTargetR`,
   instead of the alignment resolver's farthest-ERL target. A reversal's first draw is the swing it
   just created; the resolver's target is null for most reversals and, when present, so far from a
   structural stop that the 3R cap decides the R:R.

Nothing about entry geometry, stops, or thresholds was touched in response to P&L. The arms are
re-run as registered, on the same training era, and the multiplicity count stays at 3.

**Side finding, independent of the new model, which changes how the OLD results should be read.**
With `--one-trade-per-setup` (which mirrors live's unique setup index) the OLD alignment model takes
**37 trades on NIFTY50 and 46 on BANKNIFTY in 2025**, against 91 and 121 without it, because 71 and
103 of its signals re-enter a setup that was already traded. Live can never take those repeats.
Every earlier ICT backtest in this repo counted them. The `old` arm below is therefore the honest
control for live behaviour, and earlier headline numbers overstate the trade count by roughly 2.5x.

## Amendment 2 -- 2026-10-09, deployment and disposition of every audit item

**Deployed 2026-10-09 evening** (image rebuilt from the working tree; `api-v2` and `scheduler-v2`
recreated with no open ICT positions): engine `ict-state-v3`, the ICT exit clock, the zone size floors.
Entry model unchanged (`ALIGNMENT`). Verified by running the compiled live code against the live
database on both bot cells (NIFTY50 15m, BANKNIFTY 5m, 2026-09-01..10-08) with no overrides.

| Audit item | Disposition |
| --- | --- |
| Market entry at signal close | New `SWEEP_MSS_RETRACE` / `SWEEP_MSS_LIMIT` models and a limit-fill backtester. Measured UNDERPOWERED (29 trades pooled each). Not live. |
| No MSS / displacement | Built (`mss.ts`), tested, in the v3 snapshot. |
| 15-minute TIME_STOP on a multi-bar thesis | Fixed live: 4 bars of the trade's own timeframe. **Deviation to flag:** the audit advised measuring this in shadow first. The backtester does not simulate the O1 option exits, so there is nothing to measure it against; it was applied as a minutes-to-bars scale correction. To revert, set `ICT_TIME_STOP_BARS` in `o1-exit-timings.ts` so that `4 * barMinutes <= 15`, or return the default timings for the key. |
| Live against its own evidence | Unchanged by design. The registry override stays the owner's decision. |
| HTF -> LTF | The HTF read is required today. Nested LTF entry not built: power ceiling, see the 2026-09-08 program. |
| ATR-dominated stops / far target | Addressed only inside the new models (sweep-extreme stop, leg-extreme target). The live alignment model is unchanged. |
| Option translation | Re-checked and found already market-based (chain strike, observed ask, solved IV, bid-basis barriers, 3x distortion guard). The original criticism was wrong; no change. |
| Weak FVG touches / dead floors | Fixed live (v3 floors). |
| OTE anchored to the leg | Done, default-off (OTE itself measured NO_EDGE). |
| `availableAt` uses bar open | Not a leak: proved by `composite-engine.causality.test.ts` (prefix and future-perturbation invariance across the whole engine). Convention documented in `causal-pivot.ts`. |
| Killzone / OTE / CISD not gated | Withdrawn as a finding. All were measured NO_EDGE in this repo and are off by evidence. |

## Amendment 3 -- 2026-10-09, replication on instruments never measured (registered BEFORE running)

**Why.** Both earlier programs conclude the binding constraint is power, not features, and name "more
instruments" as the one step that could change the answer. `FINNIFTY`, `MIDCPNIFTY` and `NIFTYNXT50`
have 15m candles from 2024-06-03 to 2026-08-07 and daily candles from 2023, and **no ICT result of any
kind has ever been computed on them**, so all of their eras are unspent. NIFTY50 and BANKNIFTY are
excluded here: they are the cells every previous result was selected on.

**Design (fixed now).**
- Instruments: FINNIFTY, MIDCPNIFTY, NIFTYNXT50. Timeframe 15m. Same costs and sizing as every earlier
  arm: 2 bps slippage, max 5 concurrent positions, `--one-trade-per-setup`, default capital.
- Two hypotheses, nothing tuned: **H1** the live model (`ALIGNMENT`, engine `ict-state-v3`, i.e. the
  driver's `floors` arm) has a positive mean per trade; **H2** `SWEEP_MSS_RETRACE` does.
  `SWEEP_MSS_LIMIT` is not run: it cannot go live.
- Stage 1, training: 2025-01-01..2025-12-31. Stage 2, confirmation: 2024-06-03..2024-12-31. Stage 3,
  holdout: 2026-01-01..2026-08-07. Stages 2 and 3 are run **only for a hypothesis that clears stage 1**,
  each exactly once. A hypothesis that fails stage 1 leaves them unspent.
- Statistic: mean P&L per trade pooled across the three instruments, session-clustered SE, as before.

**Gates, in order.**
1. Sign replication: mean > 0 on at least 2 of 3 instruments.
2. Noise floor: pooled t >= 1.96 (one-sided 2.5%, i.e. 5% Bonferroni-corrected over the two hypotheses).
3. Confirmation and holdout: pooled mean > 0 in each, no instrument-level reversal that explains it.
4. Power: a verdict of any kind needs **>= 100 pooled trades over >= 60 sessions** in the stage. Below
   that the stage is UNDERPOWERED and cannot pass, whatever its t.

**Stated expectation, so it cannot be argued afterward.** `ALIGNMENT` should reach the trade floor easily
(about 40 a year per instrument). `SWEEP_MSS_RETRACE` produced about 15 per instrument-year on the
cells already measured, so it is expected to land near 45, below the floor, and to be UNDERPOWERED
again on stage 1. If so, that is the result: it is not repaired by loosening the model, and the
confirmation eras stay unspent.

**Live-experiment rule (decided here so the live bots have an end date).** `ict-structure-v1` runs live
as an unvalidated experiment. Review it at the first of: 60 closed live ICT trades across both bots,
or 2026-12-31. At review, compare closed-trade P&L by exit reason and by exit clock (the clock is now in
every exit record's telemetry). Stop the bots if mean P&L per trade is negative and the 2 bps cost
alone does not explain it; otherwise record the result here. Nothing in this rule changes the bots
automatically.

### Amendment 3 result -- stage 1 (2025, 15m), run once, as registered

| Hypothesis | Instrument | Trades | Mean / trade | Clustered SE | t | Win | PF |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| H1 live model (`floors`) | FINNIFTY | 41 | -38.10 | 25.04 | -1.52 | 22% | 0.57 |
| H1 | MIDCPNIFTY | 50 | +8.71 | 16.46 | 0.53 | 26% | 1.25 |
| H1 | NIFTYNXT50 | 47 | -169.88 | 39.84 | -4.26 | 15% | 0.27 |
| **H1 pooled** | | **138 (102 sessions)** | **-66.02** | 18.63 | **-3.54** | | |
| H2 `SWEEP_MSS_RETRACE` | FINNIFTY | 10 | +12.08 | 26.77 | 0.45 | 40% | 1.40 |
| H2 | MIDCPNIFTY | 19 | +19.87 | 15.98 | 1.24 | 53% | 2.03 |
| H2 | NIFTYNXT50 | 16 | -35.97 | 68.81 | -0.52 | 31% | 0.75 |
| **H2 pooled** | | **45 (42 sessions)** | **-1.72** | 26.04 | **-0.07** | | |

**H1: FAILS Gates 1 and 2, and is significantly negative.** One of three instruments is positive (needs
two). The pooled mean is -66.02 per trade at t = -3.54 on 138 trades over 102 sessions, which clears the
power floor, so this is not an underpowered null: it is a measured loss. NIFTYNXT50 alone is -169.88 at
t = -4.26 (15% win rate). Stages 2 and 3 are not run; the confirmation and holdout eras stay unspent.

**H2: UNDERPOWERED, exactly as stated in advance** (45 trades against the 100 floor), with a pooled mean
indistinguishable from zero. Not repaired, not re-run, eras unspent.

**What this does and does not say.** These three indices are not the two the bots trade, and they are
thinner and wider-spread, so the loss size should not be transplanted onto NIFTY50 or BANKNIFTY. What it
does establish is the thing the earlier programs could not: the entry model does not show a positive
edge on instruments it was never selected on, and on a sample large enough to detect one it shows a
significantly negative mean. Combined with eight earlier NO_EDGE arms and the negative NIFTY50 2023-24
confirmation, there is now no instrument or era in this repository where the live model has a
demonstrated positive expectancy. **Recommendation recorded: stop the two live ICT bots** rather than
wait for the 60-trade review, since the review rule above exists to catch exactly this and the
evidence has arrived first. The decision is the owner's, because the strategy was wired live by explicit
override on 2026-09-21.

## Results

### Training era 2025, 15m, after Amendment 1 (one-trade-per-setup, costs as in the earlier arms)

| Arm | Instrument | Trades | Mean / trade | Clustered SE | t | Win | PF |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| retrace | NIFTY50 | 15 | -0.69 | 17.70 | -0.04 | 40% | 0.98 |
| retrace | BANKNIFTY | 14 | +30.82 | 61.16 | 0.50 | 43% | 1.37 |
| retrace | pooled | 29 | +14.52 | 30.01 | 0.48 | | |
| limit | NIFTY50 | 10 | +13.54 | 22.13 | 0.61 | 40% | 1.74 |
| limit | BANKNIFTY | 19 | +15.58 | 31.68 | 0.49 | 42% | 1.30 |
| limit | pooled | 29 | +14.88 | 22.12 | 0.67 | | |

**Verdict: UNDERPOWERED, not validated, not refuted.** 14-19 trades per instrument is under the
registered 60-trade floor, and every t statistic is far below the corrected threshold. The point
estimates are mildly positive but their standard errors are larger than the means, so they carry no
information. Per the registration, the 2023-24 confirmation era and the 2026 holdout are **not run**:
spending a once-only era on an arm that cannot reach the minimum sample would burn it for nothing.

**Why the count is structurally low.** About 225 shifts per year per index, about half with the daily
bias, then the retrace into the 62-79% band, a close back inside the band, and age <= 12 bars
leaves roughly 25-30 signals a year and 10-19 fills. That is a property of a selective 15m setup
on two instruments, not a bug; it also means this model could not accumulate a confirmable
sample in under several years of live trading.

**Decision.** `entryModel` stays `ALIGNMENT` in live. `SWEEP_MSS_RETRACE` and `SWEEP_MSS_LIMIT`
ship as opt-in, default-off models, available to the backtester and strategy config, not enabled on
any bot. `SWEEP_MSS_LIMIT` is a backtest-only construct (no live limit-order path exists).
