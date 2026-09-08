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
