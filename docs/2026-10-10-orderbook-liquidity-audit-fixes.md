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
