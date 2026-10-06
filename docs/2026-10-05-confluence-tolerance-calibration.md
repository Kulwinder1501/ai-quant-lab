# Confluence-Merge Tolerance Sensitivity Sweep

> **Document Type:** Calibration / Falsification Report
> **Date:** October 5, 2026
> **Status:** No tolerance change made. `DEFAULT_CONFLUENCE_TOLERANCE_PCT` stays at `0.0005` (0.05%), now checked rather than arbitrary.
> **Scope:** `apps/ml/ai_quant_lab_ml/structure_intelligence.py`, `apps/ml/run_confluence_calibration.py`.

---

## 1. What this checks

`structure_intelligence.py` merges a session's PDH (prior-day high) and P4HH (prior 4H-block
swing high) into a single `CONFLUENCE_HIGH` level when the two sit within a tolerance of each
other (as a fraction of price); otherwise both are kept as separate, isolated levels. The same
rule applies to PDL/P4HL -> `CONFLUENCE_LOW`. This tolerance was a bare `0.0005` (0.05%) literal,
duplicated at two call sites (`structure_intelligence.py:234`/`243` pre-refactor, and
`run_confluence_calibration.py:155`/`161` pre-refactor), and had never been calibrated or swept.

The question this document answers: **does merging two nearby structural levels into one
"confluence" level actually identify a reaction zone with a materially different
REJECTION/SWEEP/NEUTRAL outcome distribution than treating the two levels as isolated -- at any
tolerance -- or is the merge an arbitrary grouping with no measurable effect?**

This is a check of a *descriptive grouping rule*, not a predictive parameter being fit for later
live use, so it deliberately uses each instrument's full available history rather than only the
Jan-Jun 2026 "calibration, OOS-blind" window `run_confluence_calibration.py`'s single-run mode
defaults to -- there is no held-out trading decision at stake here to protect from a look-ahead
leak, only "does this grouping concept have any measurable content."

## 2. Method

1. `build_active_levels()` (new, extracted from the duplicated inline logic in both files) takes
   `confluence_tolerance_pct` as a parameter and merges PDH/P4HH (resp. PDL/P4HL) when
   `abs(pdh - p4hh) / min(pdh, p4hh) <= confluence_tolerance_pct`.
2. `compute_confluence_merge_stats()` (new) counts, per session where both PDH/PDL and
   P4HH/P4HL exist, how many sessions merge vs stay isolated, at a given tolerance -- independent
   of whether price ever traded near either level.
3. `run_calibration_experiment()` (existing harness, now threaded with the same
   `confluence_tolerance_pct` parameter instead of a hardcoded literal) walks every 5m bar across
   each session, flags proximity to each active level (<=15bps, forward_window=3 bars / 15
   minutes, reaction_threshold=10bps -- all held fixed, unchanged from the existing harness
   defaults), and classifies each proximity touch as REJECTION/SWEEP/NEUTRAL. Its
   `by_level_type` breakdown gives rejection/sweep counts per level type (`PDH`, `P4HH`, `PDL`,
   `P4HL`, `CONFLUENCE_HIGH`, `CONFLUENCE_LOW`) directly.
4. `run_confluence_calibration.py --tolerance-sweep` (new CLI mode) runs steps 2-3 across
   `{0.0002, 0.0005, 0.0010, 0.0020}` (0.02%/0.05%/0.10%/0.20%) on BANKNIFTY and NIFTY50's full
   available history, pools `CONFLUENCE_HIGH + CONFLUENCE_LOW` events as "merged" and
   `PDH + P4HH + PDL + P4HL` events as "isolated," and runs a chi-square test of independence
   between `{merged, isolated}` and `{REJECTION, SWEEP, NEUTRAL}` at each tolerance, per
   instrument and pooled.

Reproduce with `python apps/ml/run_confluence_calibration.py --tolerance-sweep`.

### Data

- **BANKNIFTY**: 2026-01-01 to 2026-10-05. 14,092 5m candles, 1,179 1d candles. 1,178 sessions
  have a daily PDH/PDL; only **187** also have a 5m-derived P4HH/P4HL (5m coverage is the
  constraint -- consistent with this project's prior finding that BANKNIFTY 5m/index-volume
  coverage is gapped, not the bar count). Merge eligibility (and therefore every number below) is
  bounded by those 187 sessions, not the full 1,178.
- **NIFTY50**: 2024-01-01 to 2026-10-05. 15,742 5m candles, 2,418 1d candles, 2,417 sessions with
  daily levels, but only **209** sessions with 5m-derived 4H levels -- NIFTY50's 5m history is
  sparse before 2026 (consistent with `fyers-index-volume-break`: Fyers 5m coverage is
  materially better from 2026 onward than before).

## 3. Results

### Merge counts (session-level: eligible pairs that merge vs stay isolated)

| Symbol | Tolerance | High merged | High isolated | Low merged | Low isolated |
|---|---|---|---|---|---|
| BANKNIFTY | 0.0002 | 68 | 118 | 77 | 109 |
| BANKNIFTY | 0.0005 | 76 | 110 | 82 | 104 |
| BANKNIFTY | 0.0010 | 90 | 96 | 94 | 92 |
| BANKNIFTY | 0.0020 | 103 | 83 | 102 | 84 |
| NIFTY50 | 0.0002 | 74 | 134 | 98 | 110 |
| NIFTY50 | 0.0005 | 82 | 126 | 106 | 102 |
| NIFTY50 | 0.0010 | 97 | 111 | 117 | 91 |
| NIFTY50 | 0.0020 | 122 | 86 | 137 | 71 |

As expected mechanically, looser tolerance merges more pairs -- this is just confirmation the
parameter works, not a finding about reaction rates.

### Reaction-rate distribution: merged (confluence) vs isolated events

| Symbol | Tolerance | Merged n | Isolated n | Merged Rej% | Isolated Rej% | Chi2 p |
|---|---|---|---|---|---|---|
| BANKNIFTY | 0.0002 | 100 | 246 | 24.0% | 24.4% | 0.4966 |
| BANKNIFTY | 0.0005 | 109 | 228 | 24.8% | 23.7% | 0.3849 |
| BANKNIFTY | 0.0010 | 125 | 195 | 22.4% | 25.6% | 0.6637 |
| BANKNIFTY | 0.0020 | 138 | 168 | 21.0% | 24.4% | 0.7085 |
| NIFTY50 | 0.0002 | 98 | 229 | 23.5% | 27.1% | 0.0398 |
| NIFTY50 | 0.0005 | 105 | 214 | 24.8% | 26.2% | 0.0309 |
| NIFTY50 | 0.0010 | 122 | 178 | 23.8% | 28.7% | 0.0359 |
| NIFTY50 | 0.0020 | 147 | 128 | 23.8% | 29.7% | 0.4420 |
| Pooled | 0.0002 | 198 | 475 | 23.7% | 25.7% | 0.0383 |
| Pooled | 0.0005 | 214 | 442 | 24.8% | 24.9% | 0.0220 |
| Pooled | 0.0010 | 247 | 373 | 23.1% | 27.1% | 0.0657 |
| Pooled | 0.0020 | 285 | 296 | 22.5% | 26.7% | 0.4045 |

Pooled sweep-rate columns (from the CLI's pooled table) tell the more informative part of the
story: **Merged Sweep% runs 30.5-34.8% against Isolated Sweep% of 24.7-26.7%** across all four
tolerances -- merged events are *swept through* more often than isolated ones, not *rejected*
more often. That is the opposite of what a "confluence identifies a stronger support/resistance
zone" story would predict (a stronger zone should reject more, not sweep more).

### Multiple-comparison correction

Twelve chi-square tests were run (4 tolerances x [BANKNIFTY, NIFTY50, Pooled]). Applying
Holm-Bonferroni across all twelve (sorted ascending, smallest p=0.0220 needs to clear
`0.05/12 = 0.00417` to be rejected at step 1):

| Rank | Test | p | Holm threshold | Survives? |
|---|---|---|---|---|
| 1 | Pooled 0.0005 | 0.0220 | 0.00417 | No |
| 2 | NIFTY50 0.0005 | 0.0309 | 0.00455 | No |
| 3 | NIFTY50 0.0010 | 0.0359 | 0.00500 | No |
| 4 | Pooled 0.0002 | 0.0383 | 0.00556 | No |
| 5 | NIFTY50 0.0002 | 0.0398 | 0.00625 | No |
| 6-12 | (remaining, p >= 0.065) | -- | -- | No |

**None of the twelve tests survive correction.** Even restricting to a per-instrument Bonferroni
family of 4 tests each (alpha/4 = 0.0125), NIFTY50's smallest raw p (0.0309) still does not clear
the bar.

## 4. Honest conclusion

1. **BANKNIFTY shows no effect at any tested tolerance.** Chi2 p-values range from 0.38 to 0.71 --
   nowhere close to significant, at any of the four tolerances.
2. **NIFTY50 alone shows a nominally low p-value at 3 of 4 tolerances** (0.0309-0.0398), but:
   - the direction is *opposite* the hypothesis under test (merged events reject less and sweep
     more, not the reverse),
   - it does not replicate in BANKNIFTY (the same pattern this project has flagged before --
     see `htf-confluence-below-noise-floor` and the ICT sign-flipping cells in
     `strategy-registry.ts` -- a single-instrument result is not treated as a real effect here
     either), and
   - none of it survives Holm-Bonferroni correction across the 12 tests run, nor even a
     per-instrument Bonferroni correction restricted to NIFTY50's own 4 tolerances.
3. **No tolerance in `{0.02%, 0.05%, 0.10%, 0.20%}` is an empirically superior "stronger reaction
   zone" classifier.** The honest finding is the null one this project's own discipline asks for:
   the confluence-merge concept does not show a reliable, replicated, correction-surviving
   predictive effect on reaction-type distribution at any tested tolerance.
4. **0.05% is not "wrong."** It was never justified by evidence before this sweep, and it is not
   justified by evidence now, in the sense of being provably better than its neighbors -- but
   none of the other three values is provably better either. There is no basis here to change it,
   and no basis to claim it was secretly right all along. It is being kept as a documented,
   checked, arbitrary geometric choice.

## 5. What shipped as a result

- `DEFAULT_CONFLUENCE_TOLERANCE_PCT` stays `0.0005` in `structure_intelligence.py`, now a named
  module constant (was a bare literal duplicated at two call sites) with a comment citing this
  sweep and its actual result.
- `build_active_levels()` (new) replaces the duplicated inline merge logic in both
  `structure_intelligence.py::run_calibration_experiment` and
  `run_confluence_calibration.py::main`, parameterized by `confluence_tolerance_pct`.
- `compute_confluence_merge_stats()` (new) in `structure_intelligence.py` -- session-level merge
  counts, independent of price proximity.
- `CalibrationSummary` gained a `confluence_tolerance_pct` field for traceability.
- `run_confluence_calibration.py` gained `--confluence-tolerance-pct` (override the single-run
  tolerance) and `--tolerance-sweep` (run this document's sweep and exit).
- Tests: `apps/ml/tests/test_structure_intelligence.py` -- unit tests for `build_active_levels`
  (merge/isolate/switch-at-the-boundary behavior, low-side and missing-level handling),
  `compute_confluence_merge_stats` (session-level counting), and an end-to-end test
  (DB mocked via `monkeypatch`) proving `confluence_tolerance_pct` threaded into
  `run_calibration_experiment` actually changes which `level_type` proximity events are recorded
  under, at the exact boundary this sweep's own grid crosses (0.0002% isolated vs 0.0005% merged
  for a ~0.0206%-apart PDH/P4HH pair).

## 6. Caveats

1. **Merge eligibility is bounded by 5m coverage, not daily-level availability.** Only 187
   (BANKNIFTY) and 209 (NIFTY50) sessions have both a daily PDH/PDL and a 5m-derived P4HH/P4HL --
   far fewer than the 1,178 / 2,417 sessions with daily levels alone. NIFTY50's 5m history is
   sparse before 2026.
2. **No cost model.** This is a reaction-type classification exercise (REJECTION/SWEEP/NEUTRAL on
   a 15-minute forward return), not a P&L backtest -- it says nothing about whether trading either
   population would be profitable after costs.
3. **This is not a held-out OOS check.** As explained in Section 1, that is a deliberate,
   documented choice for a descriptive-grouping question, not an oversight -- but it also means
   this result should not be cited as validating any *predictive* parameter choice derived from
   it.
