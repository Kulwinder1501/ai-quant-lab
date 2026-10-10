# 2026-10-10 - Order-flow / liquidity audit fixes

Scope: ten audited defects in the ORDERBOOK-01 gate, the liquidity-candidate / contact-label
pipeline, depth-frame sequencing, and the Python research scripts that read them. Code and tests
changed; **no stored data was rewritten, no script was re-run, no migration was executed.**

## READ THIS FIRST - which stored data and which verdicts are now known-bad

| Artefact | Status | Why |
|---|---|---|
| `orderbook01_verdict.json`, `orderbook01_oos_rerun_*.json`, any quoted ORDERBOOK-01 CASE A-E verdict | **Produced by defective code. Do not cite as evidence either way.** | Look-ahead labels; pooled/duplicated population; every provider_symbol; missing totals as DI 0; raw DI is a per-day constant; mixed sign conventions; future depth frames accepted. The CASE E "falsified" conclusion is not *confirmed* by these files either; the experiment has to be re-run on rebuilt data. |
| `liquidity_contact_labels` rows with `labeling_version = 'v1-legacy'` (all existing rows after migration 132) | **Known-bad (look-ahead).** | Window started at the candidate's OPEN stamp (before the confirming bar closed); the "30s" horizon was derived from 1m bars; `contact_time` was the bar OPEN. |
| `liquidity_pool_candidates` rows with `candidate_version = 'v1-legacy'` | **Known-bad (duplicates).** | PDH/PDL re-registered after a breach, plus repeated re-registration of the same level; inflates n. |
| `depth_frames.is_regression` (and the NULL `gap_before` that goes with it) | **Wrong on every day with a sequence reset without snapshot.** | The capture marker never moved down, so every frame after the reset was flagged (29,954 frames on 2026-09-11). |
| `liquidity-geometry-scorer.ts` trained weights | **Trained on legacy v1 labels.** | Exposed as `isTrainedOnLegacyLabels` / `trainedOnLabelingVersion` on every score. Not retrained (out of scope). |

Rebuild decision for the parent (nothing below was run):

1. Register + apply migration `132-contact-label-versioning` (`contactLabelVersioningMigration`).
2. Re-run `generate-liquidity-candidates` (writes `v2-dedup`, idempotent) then `generate-contact-labels`
   (writes `v2-causal`). Legacy rows stay in place beside the new ones and are never mixed because every
   reader filters on the version columns.
3. Only then re-run `run_orderbook01_oos.py` (it now defaults to `v2-causal`). Expect far smaller n:
   the pre-registered floors (3,000 / 1,000) now apply to **distinct level-days**, so most windows will
   report `INSUFFICIENT_DATA` (-> `INCONCLUSIVE`), not `FALSIFIED`.

## Per-item summary

1. **Live gate kill switch.** `applyOrderbookGateToProposal` adjusts confidence only when
   `ORDERBOOK01_LIVE_GATE_ENABLED === "true"`; the shadow verdict is always recorded in
   `evidence.orderbookGate` (`adjustmentApplied` says whether confidence was touched).
2. **Raw DI is a day constant.** DI is causally standardised within the day before any sign or
   threshold: subtract the mean of the last DI of each of the previous 30 complete minutes (at least
   10 populated minutes), strictly before the current minute. The window is documented a priori, not
   tuned. Insufficient history / missing depth -> `null` / `UNAVAILABLE`, never 0. The
   `raw_di || null` bug (turned a real 0 into null) is replaced by explicit null checks. Mirrored in
   `apps/ml/ai_quant_lab_ml/orderbook_di.py` and used by the three research scripts.
3. **Contact-label look-ahead.** `labeling_version = 'v2-causal'`: the window starts at
   `known_at_time + timeframe` (the confirming bar's CLOSE); only 1m bars that close inside the horizon
   count; horizons are 60/120/300/900 s (no 30 s); `contact_time` is the touch bar's close; a window
   only partly covered with no event seen is `NULL` (unknown), not "no breach".
4. **Duplicate candidates.** One candidate per `(instrument, timeframe, pool_type, price, session_date)`;
   PDH/PDL registered once per session and never re-registered after a breach. Enforced in code and by
   a partial unique index on `candidate_version = 'v2-dedup'` (legacy rows untouched).
5. **OOS population.** One symbol / timeframe / `is_active_candidate` / `labeling_version`; depth only
   from the front-month BANKNIFTY future (`contract_for_date`); missing totals are skipped; events are
   collapsed to one per level-day and the n floors apply to that effective n; matching is past-only.
   Sign convention everywhere (experiment, feature_select, OOS, live gate): **`di_tilde = -DI`**
   (detrended), identical for every level and tier. Tier-2 (PDL) uses the 60 s v2 horizon. When the n
   floor is the only failed criterion the status is `INSUFFICIENT_DATA`, not `FALSIFIED`.
6. **`is_regression`.** The capture marker now re-bases on every usable sequence number, so only the
   reset frame is flagged. Trade-off: if a stale frame arrives, the next fresh frame is a (conservative)
   false gap. `DepthFrameRow.is_regression` is a chain break in `cks_ofi_touch.py`. Research code no
   longer trusts the stored flags (see recompute below).
7. **Hybrid-liquidity strategy.** Pillar B is honestly named `STATIC_DEPTH_IMBALANCE` (a book snapshot,
   not order-flow imbalance) and is evaluated on `signedRawDi = -rawDi` so LONG is reachable; confidence
   is on the 0-1 scale (0.85-0.95). Still disabled (`executableSides: []`). Pillar C untouched.
8. **Fabricated defaults.** Phase C: missing OFI -> `None` (was 0.0), `depthNormFactor` -> `None` (was a
   made-up 1000.0), `meanTop5Depth` -> `None` (was 0.0); depth rows recompute flags per capture session,
   a session start is a chain break, a NULL touch field makes the frame not-comparable instead of a
   zero-size queue. Cost stack: real `is_snapshot` / `is_duplicate` / `gap_before` / `is_regression`.
   `orderFlowAvailable=False` semantics are unchanged. `BANKNIFTY26OCTFUT` is valid to 2026-10-27 (last
   Tuesday of October 2026), not 2026-12-31.
9. **ICT liquidity.** `isMitigated` uses the path (high/low) since confirmation for every pool type via a
   stateful resolver. Liquidity-response adjustments are documented as **unvalidated heuristics**; the
   geometry scorer is flagged as trained on legacy v1 labels.
10. **Kyle's lambda / shadow audit.** `compute_signed_volume` requires a caller-supplied signed flow
    (the tick-rule `volume * sign(dP)` is circular - it manufactures impact - and is opt-in via
    `allow_circular_tick_rule=True`); rolling lambda propagates NaN instead of `fillna(0)`.
    `shadow_orderbook_audit.py` now computes a clearly labelled **counterfactual** net-protection line
    (minus the realized PnL of BLOCKED paper trades) and its docstring no longer promises drawdown /
    points-saved that were never computed.

## Read-only SQL (NOT run) - recompute depth sequence flags per day

Do not UPDATE `depth_frames`. For inspection only (per symbol, session and day, in received order):

```sql
WITH ordered AS (
  SELECT provider_symbol, capture_session_id, received_at, sequence_no, is_snapshot,
         is_regression AS stored_reg,
         LAG(sequence_no) OVER (
           PARTITION BY provider_symbol, capture_session_id, (received_at AT TIME ZONE 'Asia/Kolkata')::date
           ORDER BY received_at, sequence_no
         ) AS prev_seq
  FROM depth_frames
  WHERE received_at >= '2026-08-21' AND received_at < '2026-10-10'
)
SELECT (received_at AT TIME ZONE 'Asia/Kolkata')::date AS day, provider_symbol,
       COUNT(*)                                                              AS frames,
       COUNT(*) FILTER (WHERE stored_reg)                                    AS stored_regression,
       COUNT(*) FILTER (WHERE NOT is_snapshot AND sequence_no < prev_seq)    AS recomputed_regression,
       COUNT(*) FILTER (WHERE NOT is_snapshot AND sequence_no = prev_seq)    AS recomputed_duplicate
FROM ordered GROUP BY 1, 2 ORDER BY 1, 2;
```

The fixed rule re-bases the marker on the *previous* frame's sequence number, which is exactly what
`LAG` gives, so a reset is counted once. (Frames with a NULL / negative sequence are ignored by the
comparisons here; `cks_ofi_touch.recompute_sequence_flags` handles them by leaving the marker unchanged.)
The exact implementation is `recompute_sequence_flags`, and `apps/ml/recompute_depth_sequence_flags.py`
(read-only connection, never run here) prints stored vs recomputed duplicate/regression counts per
symbol, capture session and day:

```
python apps/ml/recompute_depth_sequence_flags.py --from 2026-08-21 --to 2026-10-09
```

## Not done (deliberately)

* No rewrite of result JSON, no re-run of any research script, no `UPDATE`/`DELETE` of stored rows.
* No retraining of the geometry scorer; no legacy-row deletion or dedupe (an inspection-only dedupe query
  is documented inside the migration file).
* `run_hybrid_confluence_backtest.py` and `run_ofi_impulse_oos.py` (not in this audit's file list) still
  filter `is_regression = FALSE` / hard-code `is_duplicate=False, gap_before=None`; the Phase C episode
  covariate `l2DepthLiquidity=0.0` (a constant column in `run_phase_c_pipeline.py`'s episode builder and in
  `experiments_f1_f4.py`) is untouched because it needs changes in files outside this scope.
* The migration SQL and the v2 candidate-insert `ON CONFLICT` were reviewed by eye and unit-tested as
  strings only; they were not executed against Postgres (DDL was not permitted in this session).
* (Superseded for the first bullet's two scripts by the **2026-10-10 follow-up (code gaps)** below.)

## 2026-10-10 follow-up (code gaps)

Three code gaps left by the audit were fixed in `apps/ml`. **Only code and tests changed. No study,
backtest or experiment was re-run, no database row was read for this work or mutated, no stored result
JSON was edited, nothing was committed.** Governance is unchanged: dated amendments, no re-scoring of
earlier results, one exploratory run.

### GAP 1 - hybrid-confluence backtest and OFI-impulse OOS trusted the stored sequence flags

* **What was wrong.** `run_hybrid_confluence_backtest.py` filtered `AND is_duplicate = FALSE AND
  is_regression = FALSE` in SQL; `run_ofi_impulse_oos.py` hard-coded `is_snapshot=False,
  is_duplicate=False, gap_before=None` for every frame. After a sequence reset without a snapshot
  every later pre-fix frame is stored `is_regression = TRUE` (the first script silently dropped the whole
  rest of such sessions) and neither script treated duplicates, gaps or resets as OFI chain breaks (the
  second differenced straight across them).
* **What changed.** Both load frames in received order including `sequence_no` / `is_snapshot` and
  recompute the flags with the existing `cks_ofi_touch.recompute_sequence_flags` (no logic copied). Two
  small shared helpers were added next to it: `recompute_sequence_flags_by_stream` (per
  provider-symbol / capture-session stream, also marks each stream's first row) and
  `drop_reset_and_duplicate_rows`.
  * Hybrid backtest: `clean_depth_frames_from_rows` keeps every frame except duplicates and the single
    SEQUENCE_RESET frame; a NULL total stays missing (skipped, not 0). The SQL no longer references the
    stored flags. Its population is still "all symbols that day, nearest frame <= 5 s" exactly as before -
    that separate pre-existing choice was not touched.
  * OFI-impulse: `build_ofi_frames_and_quote_rows` builds `DepthFrameRow`s with the recomputed
    `is_duplicate` / `gap_before` / `is_regression`; the first frame of a capture session is a chain
    baseline (`is_snapshot`), so OFI is never differenced across a reset, duplicate, gap or session
    start. Duplicate and reset frames are also dropped from the rows used for decision / horizon quotes.
* **Tests.** `tests/test_depth_flag_recompute_scripts.py`: a reset-without-snapshot stream where the
  stored-flag filter keeps 3 of 8 frames and the recomputed flags keep 7 of 8; duplicates; snapshots;
  interleaved streams / capture sessions; the SQL has no stored-flag filter; OFI is not differenced
  across the reset.

### GAP 2 - the baseline next to a model was only the trivial global majority

* **What changed.** `train.py` now reports, next to the existing `trivial_majority_metrics`, the
  **time-of-day-stratified majority** (`time_of_day_baseline_metrics`), which reuses
  `volatility_expansion.time_of_day_majority_predictions` / `time_of_day_key` unchanged (only its type
  hints were generalised from the volatility alphabet to any label string). Bucket = IST bar-of-day of
  the example's close over the bar length; per-bucket majority is fitted on the **TRAIN rows only** and
  applied to the validation rows; an unseen bucket falls back to the global train majority. Daily bars
  have no time of day, so there the two baselines coincide (stated, not hidden).
  `compare_to_baselines` reports both and the model's edge over the **stronger** one per metric (ties go
  to the trivial baseline).
* **Verdict.** `promotion_assessment(..., baselines=...)` records `assessment["baselines"]` and refuses
  with `DID_NOT_BEAT_STRONGEST_BASELINE` when the candidate's macro-F1 does not exceed the stronger
  baseline's macro-F1 (checked before any incumbent comparison). Accuracy edge vs the stronger baseline is
  reported (`beatsStrongestOnAccuracy`) but is not itself a gate. `main()` always supplies the final-fold
  baselines and prints them; `cpcv_summary(..., time_of_day_metrics=...)` adds `timeOfDay*`,
  `strongestBaseline*`, `*MinusStrongest` and `*WinRateVsStrongest` keys (all existing keys unchanged);
  `backfill_volatility_shadow.py` adds per-window time-of-day numbers and
  `*WonWindowsVsStrongestBaseline`. Existing `trivial*` keys keep their meaning.
* **Not changed.** `train_tcn.py` uses its own `trivial_macro_f1` helper; it was not part of this fix.
* **Tests.** `tests/test_tod_stratified_baseline.py`: label perfectly determined by time of day (trivial
  accuracy 0.5, stratified 1.0); flipping the holdout labels does not move the baseline (train-only fit);
  unseen-bucket fallback; daily coincidence; stronger-baseline selection and ties; verdict refuses a model
  that only beats the trivial baseline; CPCV reports both.

### GAP 3 - forward label windows that crossed the overnight gap

* **Where it was already right.** The SQL loaders (`postgres_repository`) partition the forward `LEAD`
  and the forward path by IST trading date, and `run_phase_c_pipeline.py` already requires the exit bar
  on the same date within the horizon. Those were left alone.
* **Where it was not (intraday only).** `structure_intelligence.run_calibration_experiment` and
  `run_confluence_calibration.py` took `bars_5m[g_idx + 3]` on the whole series; `run_straddle_confluence_gate.py`
  took `bars_5m[idx + horizon]`; `volatility_gate.price_straddle` took `records[i + horizon]`;
  `run_cost_stack_validation.py` took the first frame >= entry + 15 min (even on the next day for a
  multi-day capture session); `pattern_vs_volatility.py` took `candles[i+1 : i+1+5]` for 15m. The Python
  builders (`build_labeled_examples`, `build_triple_barrier_examples`, `build_volatility_expansion_examples`)
  also trusted whatever future close / forward path the loader supplied.
* **Semantics.** The whole forward window must lie inside the source bar's IST session
  (`session_forward.py`; "intraday" = minute/hour timeframe, identical to the SQL rule). A row whose full
  horizon would pass the session close gets **no label and is dropped** (builders: omitted; scripts:
  skipped / not recorded as a NEUTRAL event and not allowed to consume a level's one-per-session
  trigger), never filled from the next day. Triple-barrier: the walk stops at the session close, a
  horizontal touch inside the session still counts, and a VERTICAL (time-out) label on a short path is
  censored. Daily and longer bars are untouched (one bar per session; the next bar is the horizon).
* **Existing tests.** No existing test relied on a cross-session intraday label; the full suite passed
  unchanged before any expectation was edited.
* **Tests.** `tests/test_session_scoped_forward_labels.py`: last bars of a session get no label in all
  three builders (with a +50% overnight jump in the fixture that would be visible if it leaked); labels
  never use next-day prices; helpers; daily bars unaffected; `run_calibration_experiment` drops the
  last-bar event whose forward bar is on the next day.

### What is NOT re-run, and the status of earlier results

Nothing above was executed against data. **Every earlier result from these scripts remains unreliable
until re-run under a NEW pre-registration**: hybrid-confluence backtest (stored-flag session loss),
OFI-impulse OOS (no chain breaks), STRUCTURE-01 / CONFLUENCE calibration, the confluence straddle gate,
the volatility gate and the cost-stack validation (cross-session forward windows), and any model verdict
produced by `train.py` / `backfill_volatility_shadow.py` that was judged only against the trivial
baseline. No result JSON was edited or re-scored; re-running is a separate, pre-registered step
(one exploratory run).
