# ICT entry model — falsification program v1

**Registered 2026-09-08, before any measurement of the entry model.** Nothing below may be revised
after a result is seen. If the design turns out to be wrong, this document gets a dated amendment
saying so and the run is discarded, not re-scored.

## Why this exists

`ict-structure-v1` is `TERMINAL_UNOWNED`. Four doctrinal fixes (farthest liquidity target, daily
higher-timeframe anchor, non-circular bias, CHoCH-for-IDM substitution) each improved BOTH
instruments monotonically, and the strategy still has no stable edge: the sign flips across
instrument, across timeframe, and across nested windows of the same instrument. Every one of those
fixes was, in hindsight, refining a cell that had been selected for looking promising.

One measurement taken on 2026-09-08 is the reason for trying again rather than stopping:

> Order blocks supply **36 of 1,222** BANKNIFTY entries. 1,045 come from a fair value gap being
> touched and 141 from a session level being swept.

So the doctrine's *entry model* has never been tested here. What has been tested is a loose
gap-touch strategy wearing the four-pillar gate. That is a structural gap, not a tuning gap, and
the absent features (killzones, CBDR, OTE) are exactly the entry-precision layer.

**This is therefore a falsification program, not an improvement program.** The expected outcome,
given the prior, is NO_EDGE. The purpose of writing the rule down first is that "the number went
up" will not be allowed to count as a result.

## Prerequisite (correctness, not hypothesis)

Fair value gaps are relabelled in place when they invert, so an inverted bullish gap still
advertises itself as bullish support — the strategy is offered a long at a level that has just
failed as support. Gaps supply 85% of entries, so this sits on the dominant path.

It must be fixed before any entry-model measurement, and the fix must not read the mutable `state`
field (that reads the future — see the leak below). The fix mirrors what order blocks already do: an
inverted gap re-enters the ledger as a NEW zone, dated to the inversion bar, with the polarity
already flipped.

The re-baseline delta from this fix is reported on its own, separately from the entry model. It is a
bug fix, so it is not gated — but the corrected baseline, not the old one, is what the entry model
is measured against.

### Standing leak this program must not rely on

Zone objects are shared across snapshots and the backtest builds every snapshot before replaying, so
any MUTABLE zone field (`state`, `fillPercentage`) reads its FINAL value, not its value at that bar.
Array membership was fixed on 2026-09-08; object fields were not. **No feature in this program may
branch on a mutable zone field.** Immutable fields (`type`, `top`, `bottom`, `meanThreshold`,
`midpoint`, `kind`, `createdAtBarIndex`) are safe.

## What gets built

Three features, in this order, each landing behind its own default-off switch so that every arm is
one flag away from its control:

1. **Block-first POI selection.** The gate currently short-circuits on the session sweep, then the
   gap, and reaches an order block almost never. Doctrine orders it the other way: the block (or its
   mean threshold) is the entry, and the gap is the lower-quality fallback. Switch:
   `poiPreference: "SWEEP_FIRST" | "BLOCK_FIRST"`.
2. **Killzone / CBDR session windows.** Entries restricted to the doctrine's session windows, with
   the Central Bank Dealers Range as the reference. IST-anchored, and the window definitions are
   fixed in this document before measurement (below). Switch: `requireKillzone: boolean`.
3. **OTE placement.** Entry at the 0.62–0.79 retracement of the impulse leg rather than at whatever
   price the signal bar closed at. Switch: `entryPlacement: "SIGNAL_CLOSE" | "OTE"`.

Killzone windows, fixed now (IST, NSE session 09:15–15:30):

- **Open drive**: 09:15–10:15
- **Late morning**: 10:15–11:30
- **Afternoon**: 13:00–14:30
- CBDR reference: previous day 20:30–02:00 IST equivalent is not available on an index cash series,
  so CBDR is proxied by the **previous session's 14:30–15:30 range**. This is a documented
  substitution, not the doctrine's definition, and is recorded as a threat to validity.

Not in scope, because each changes which zones EXIST rather than how they are selected, and so needs
its own program: advance-block creation, rejection-zone re-bounding onto the wick, volume imbalance,
gap imbalance, ITH/ITL/STH/STL fractal labels, pullback entries.

## Unit of analysis

**The trade.** Standard errors are clustered by **session** (IST calendar date of entry), because
trades within a session share the same regime, the same daily bias and often the same zones. Not
clustered by trade — that assumes independence the data does not have.

Reported per arm: trade count, session count, mean P&L per trade, session-clustered SE of that mean,
and t = mean / SE.

## Decision rule

An arm passes only by clearing **all four** gates. Failing any one is NO_EDGE.

- **Gate 1 — sign replication.** Mean P&L per trade > 0 on **both** BANKNIFTY and NIFTY50,
  independently. One instrument positive and one negative is a fail, regardless of the pooled total.
- **Gate 2 — noise floor.** Pooled t > 2.0 with session-clustered SE. A point estimate without this
  is not a result.
- **Gate 3 — era holdout.** Configuration is chosen on **2025-01-01 .. 2025-12-31** only. It is then
  run once on **2026-01-01 .. 2026-09-05**, which must independently satisfy Gates 1 and 2. The
  holdout is run **once per configuration**; a second look at it voids the arm.
- **Gate 4 — paired delta.** Each feature is measured against its control on the **same bars**, as a
  paired difference, and must improve the population it retains rather than merely shrink it. A
  filter that raises mean-per-trade while cutting trade count by more than half is reported as
  ambiguous, not as an improvement.

**Multiplicity.** Every configuration evaluated on the training era is counted, and Gate 2's
threshold is Bonferroni-corrected by that count. The count is written into the results table, and it
includes arms abandoned midway.

## Pre-committed threats to validity

- The CBDR proxy above is not the doctrine's CBDR.
- Killzones and OTE both narrow the population, which is the failure mode that killed the
  HTF-confluence veto (monotone on 2 ETFs, worse on 14 of 20 equities) and the scalp pattern gate.
  Gate 4 exists for exactly this.
- Two instruments is a thin replication set. A pass here is a reason to widen to equities, never a
  reason to promote.
- The engine's memory profile is still quadratic in places; runs are capped at a 10GB heap and a
  failure to complete is reported, never silently re-scoped to a shorter window.

## Stopping condition

If no arm clears all four gates, the verdict is recorded as **NO_VIABLE_ENTRY_MODEL** and
`ict-structure-v1` stays `TERMINAL_UNOWNED`. The features stay in the tree behind their default-off
switches, with the measurement attached, so the next person does not rebuild them to re-learn the
same thing.

## Amendment 1 — 2026-09-08, before any entry-model measurement

**OTE is implemented as a filter, not as placement.** Registered as
`entryPlacement: "SIGNAL_CLOSE" | "OTE"`, meaning entry AT the 0.62-0.79 retracement. The
backtester enters at the next candle's open (`NEXT_CANDLE_OPEN`) and has no way to rest a limit
order at a level, so that is not expressible without changing the execution model — which would
change every other strategy's runs too, and is out of scope here.

The arm therefore ships as `requireOte: boolean`: admit the bar only if the signal bar's close is
already inside the band. This is a **strictly weaker** version of the registered hypothesis. It can
show that trading only from deep discount/premium helps or does not; it cannot show what entering at
a better price would have done. A pass here would not license the placement claim.

Recorded before any number was seen, per the rule at the top of this document.

**CBDR is not implemented at all.** The registration paired it with killzones as "the reference".
In the doctrine CBDR supplies standard-deviation projections for TARGETS, which is a target feature,
not an entry filter — and this arm is an entry filter. `requireKillzone` is purely time-of-day. The
CBDR proxy registered above is therefore unused, and the CBDR half of feature 2 is **not built and
not measured**. Anyone reading a killzone result should not read it as a CBDR result.

**Killzone windows admit more than they exclude.** The three registered windows are contiguous in
their first two, so together they admit 225 minutes of a 375-minute session and exclude 150 (40%).
Noted because the filter is weaker than the name suggests; the windows are NOT revised, since they
were registered.

## Amendment 2 — 2026-09-08, after the training era, before any holdout look

**Arm 1 (`poiPreference`) is a structural no-op and should not have been registered as an arm.**
It returned results identical to its control to the digit: 121 trades and -3,644 on BANKNIFTY, 91
and +8,883 on NIFTY50, same standard errors, pooled t = 0.25 for both.

The reason is visible in the code and I should have seen it before registering. The chosen point of
interest sets `poiEvidence`, `poiExtreme`, `poiIdmAdjacent` and `poiKind` — all of which are
*evidence*. Entry, stop and target come from `currentPrice`, `liquidity.invalidationLevel` and
`targetPool.price`, none of which consult the POI. So reordering the candidates can only change the
outcome if it changes whether ANY point of interest was found, and it cannot: it is the same three
candidates in a different order.

The doctrine's actual claim — enter AT the block's mean threshold — is a **placement** claim, and
hits the same wall Amendment 1 records for OTE: the backtester enters at the next candle's open.
So two of this program's three arms turn out to be untestable without changing the execution model,
and the registration failed to notice. That is a defect in the registration, recorded rather than
quietly dropped.

## Results — training era only

2025-01-01 .. 2025-12-31, 15m, concurrency 5, 5,000,000 capital, 2bps slippage. Mean is P&L per
trade; SE is clustered on IST session date; pooled clusters on session date **across both
instruments**, because the two indices on the same day are not independent draws.

| arm | BANKNIFTY mean (t) | NIFTY50 mean (t) | pooled trades | pooled mean | pooled t |
|---|---|---|---|---|---|
| control | -30.11 (-0.20) | +97.61 (1.22) | 212 | +24.71 | **0.25** |
| blockfirst | -30.11 (-0.20) | +97.61 (1.22) | 212 | +24.71 | **0.25** |
| killzone | +8.70 (0.05) | +126.16 (1.47) | 178 | +60.83 | **0.49** |
| ote | +77.30 (0.33) | +101.79 (1.02) | 124 | +89.55 | **0.58** |

**Configurations evaluated: 4.** Bonferroni-corrected Gate 2 threshold is therefore t ≈ 2.50.

### Gate 4, done properly

Rather than compare arm against control across runs — where concurrency and capital change which
signals become trades and confound the comparison — the control's own 212 trades were split by
whether their **signal bar** (entry bar minus one 15m candle, since entry is `NEXT_CANDLE_OPEN`) fell
inside a killzone:

| | trades | sessions | mean | SE | t |
|---|---|---|---|---|---|
| inside killzone | 135 | 51 | +36.67 | 119.84 | 0.31 |
| outside killzone | 77 | 41 | +3.74 | 144.52 | 0.03 |

Same direction as the arm, +32.93 per trade — and both halves are indistinguishable from zero, with
the difference far inside either standard error. No evidence the window separates anything.

### Verdict

**NO_VIABLE_ENTRY_MODEL.**

- Gate 1 (sign replication) — passed by killzone and ote on the training era. Both positive on both
  instruments.
- Gate 2 (noise floor) — **failed by every arm.** The best is ote at pooled t = 0.58 against a
  corrected threshold of 2.50.
- Gate 3 (era holdout) — **never consulted.** No configuration was selected on the training era, so
  there was nothing to confirm. The 2026-01-01 .. 2026-09-05 holdout is therefore still unused and
  remains available to a future program. This is the point of running the gates in order.
- Gate 4 (paired delta) — failed. See above. `ote` additionally cut BANKNIFTY's trade count 49%,
  just inside the ambiguity threshold.

### The binding constraint is power, not the doctrine

The control's pooled SE is +-97 per trade on 65 clustered sessions, so this cell cannot resolve an
effect below roughly +-195 per trade. Nothing measured here comes close to that, and no amount of
further feature work changes it: **the 2025 era on two indices yields 65 clustered sessions, and
that is the ceiling.** A genuine test of the ICT entry model needs more sessions or more
instruments, not more features. Registering a wider replication set is the only next step that
could produce a different answer.

`ict-structure-v1` stays `TERMINAL_UNOWNED`. The three arms stay in the tree behind their
default-off switches with this measurement attached.
