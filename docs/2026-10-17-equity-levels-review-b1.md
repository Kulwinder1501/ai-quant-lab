# Review record: WP-B Step B1 (levels engine domain), reviewer: planner, 2026-10-17

Commit reviewed: `5a80520a` on `feature/equity-levels-r0`.

## Verdict: ACCEPTED WITH CONDITIONS

Verified by the reviewer: 26 levels tests and 64 domain tests pass; `tsc` clean; `tsc` build to a scratch folder copies
`equity-rules-v1.json` next to `levels.js` and the compiled module runs in plain Node (Docker image uses Node 22, import
attributes supported); an independent Python implementation of plan section 5.2 matched the engine on 15 cases (SUZLON,
RELIANCE, TMPV at the full series and four truncations): 228 level items, 0 mismatches (tolerance only for the engine's 2-decimal
rounding); speed 1.9 ms per call on 9,032 bars; no banned word in any output string; suspended state returns no levels; no crash on
flat, halted, zero-volume, 13-bar and power-of-ten series. Gate L3 (Python parity) waits for the R0 code. Gate L2 is trivial for this
API (the last bar is always T); the real look-ahead test belongs to R0 (gate R3).

## Conditions (fix in a follow-up commit before B2 starts)

1. Honour `artifactMovePct` (0.40). Evidence: TMPV cut at 2025-12-24 (close 359.20) returns swing levels 631 to 744, volume-profile
   POC 680 and 52-week high 810, all on the pre-demerger scale (demerger bar 2025-10-14: 660.75 to 395.45). Rule: compute swing
   pivots, gaps, volume profile, averages and 52-week levels only from bars after the latest bar whose absolute one-day move exceeds
   `artifactMovePct`; if too few bars remain, return INSUFFICIENT_HISTORY with a warning that names the date. Add a fixture built from the
   TMPV numbers above and a test that no pre-event level appears.
2. No rounding inside the domain. The engine rounds prices, strength, distances and ATR (2 to 4 decimals) before computing side, zone and
   risk distance. That breaks the 1e-9 parity gate (R4) and biases zones on low-priced stocks. Return full precision; format in the API or web.
3. Below `lookbackBars + pivotHalfWindow + 1` (258) bars the plan says swing levels are not produced (reference levels still shown). The engine
   produces them from as few as 11 bars. Follow the plan or justify a change in writing.
4. Remove the invented ATR fallback (`currentClose * 0.02`); if ATR is missing the state is INSUFFICIENT_HISTORY.
5. Staleness: when `asOfEvaluationDate` is omitted the engine measures staleness against the last bar, so old data looks fresh (the Slice 1
   trap). Make the date a required input, or return `isStale: null`. B2 must pass today's IST date and test an old stock through the route.

## Clarifications added to plan section 5.2 (reviewer decisions; the developer's choices below are accepted and now binding)

* Break and flip: the side of a level before the observation window is the side of the close on the bar immediately before the window
  starts (`max(T - 19, lastPivotKnownBar) - 1`); a level is BROKEN if a close beyond it by more than `w` occurs in the window, FLIPPED if the
  current side differs from that prior side.
* Ties: POC takes the lowest bin on equal volume; value-area expansion takes the lower neighbour on equal volume; value-area edges are
  bin edges (VAL lower edge of the lowest bin, VAH upper edge of the highest bin), POC is a bin midpoint.
* Volume is split equally over the bins from the bin of the low to the bin of the high, inclusive; edge values clamp to the last bin.
* Round numbers: step `m / 2` with `m = 10^floor(log10(close))`, so the step jumps at each power of ten (5 below 100, 50 from 100 up to 999).
  Accepted for v1; revisit only through a new rules version.
* A bar can be both a swing low and a swing high only if it passes both tests; each counts as its own pivot.
