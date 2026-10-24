# Research Manifest: Phase 28 Microstructure Information Flow

**Status:** CLOSED & SEALED  
**Date**: 2026-10-09  
**Git Commit**: `99dfd7b27c3ec39bc0405ac41b25185b9252a772`

This manifest officially seals the retrospective Phase 28 research branch, separating historical statistical verdicts from executable economic policies. No further retrospective strategy tuning will be performed on this sample.

## 1. Reproducibility & Provenance
- **Cost Validation Report**: `docs/2026-10-09-cost-validation-report.json`
- **Report SHA-256 Checksum**: `cb645516913c0a3d065f4e4eda159dd8d7ca9ad76d562f8a8fcd69bdd91be9ca`
- **Evaluator Script**: `apps/ml/scratch/run_cost_stack_validation.py`
- **Data Window**: Pre-OOS (`2026-09-19` to `2026-09-26`), OOS (`2026-09-26` to `2026-10-08`)
- **Cost Schedule Version**: NSE STT effective April 1, 2026; NSE Transaction Charges effective March 1, 2026. Brokerage: ₹20/executed order cap. Provisional baseline slippage: 0.5 bps/leg.

## 2. Research Registry: Final Outcomes

| Hypothesis Stream | Status | Resolution |
| :--- | :--- | :--- |
| **H_OFI_RESILIENCY** (Static depth) | **FALSIFIED** | Depth-as-resiliency rejected. Do not retune to rescue it. |
| **H_RESILIENCY_MEASUREMENT_V1** | **PASS** | Depth-recovery measurement successfully validated within tested scope. (Execution-driven causality not established). |
| **H_OFI_REPLENISHMENT** (Dynamic recovery state) | **EVIDENCE (Stat) / FAIL (Econ)** | Discovered `Q1` return heterogeneity (+8.42 gross bps edge). However, it failed the modeled cost-stack validation (-1.27 net bps). Do not promote to an executable trading rule. |
| **H_OFI_IMPULSE** (Tail response) | **INCONCLUSIVE** | Insufficient independent extreme-tail events due to the 15-minute refractory constraint. Do not weaken rules. |
| **H_CROSS_ASSET_OFI_V1** | **FROZEN / BLOCKED** | Preregistration successfully locked. Execution blocked pending missing historical dual-instrument L2 coverage. |

## 3. Next Phase Exit Criteria: Dual-Instrument L2 Capture Qualification

Before commencing the `30-session` prospective evaluation window or unfreezing `H_CROSS_ASSET_OFI_V1`, the infrastructure must strictly pass the following exit criteria:

- `[ ]` Capture NIFTY and BANKNIFTY futures concurrently using the intended live collection configuration.
- `[ ]` Verify event timestamps and receipt timestamps separately; record clock offsets, feed latency and stale-data intervals.
- `[ ]` Verify contract symbols, expiries, lot metadata, order-book side definitions and the frozen OFI calculation.
- `[ ]` Measure per-instrument session coverage, missing intervals, reconnect gaps and cross-instrument timestamp alignment.
- `[ ]` Run a capture-only qualification session and publish an immutable data-quality report before permitting hypothesis evaluation.
- `[ ]` Freeze the collection configuration and prohibit interim alpha-based rule changes during the confirmatory window.

## 4. Correction Notice (added 2026-10-24; sections 1-3 above are unchanged)

This is an annotation, not a re-run. The sealed report, its checksum and the evaluator were not modified.

**Affected: `H_OFI_REPLENISHMENT` (Dynamic recovery state). Its "EVIDENCE (Stat)" result should not be read as evidence of a depth-recovery effect.**

- **Cause.** `depth_frames.total_buy_qty` / `total_sell_qty` drop to 0 on one side for a single frame (a feed dropout, not an empty book side: a 50-level book cannot be empty on one side in session). The cost-stack evaluator uses these totals as a depth-depletion series: a shock fires when `(d_pre - d_min) / d_pre >= X`, and its BANKNIFTY threshold is `X = 1.0`. That expression reaches 1.0 only when `d_min == 0`, so a BANKNIFTY shock can only fire on a zero-total frame. (The NIFTY threshold is 0.0, which the code treats as "no episodes".)
- **Measurement.** Re-running the evaluator's own `extract_episodes` read-only over the sealed pre-OOS window (2026-09-19 to 2026-09-26, `NSE:BANKNIFTY26SEPFUT`, 121,781 frames, 2,477 of them (2.03%) with a zero or missing total) gives 674 buy-side and 592 sell-side episodes; after excluding the unusable-total frames it gives 0 and 0. Every episode in that window is a dropout, so the `Q1`-`Q4` recovery states built from them describe dropout timing, not book resiliency.
- **Scope of the check.** It used the current `apps/ml/run_cost_stack_validation.py` (post-audit-fix), because the evaluator named in section 1 (`apps/ml/scratch/run_cost_stack_validation.py`) is not in the repository. The OOS window (2026-09-26 to 2026-10-08) uses the same code and thresholds and has zero-total frames on every day, but its episodes were not separately recounted.
- **Unchanged conclusion.** `H_OFI_REPLENISHMENT` was already not promoted (it failed the modeled cost stack, -1.27 net bps). The correction removes its statistical support too; the "+8.42 gross bps" `Q1` edge is a heterogeneity across dropout-derived states.
- **Not checked.** Whether `H_RESILIENCY_MEASUREMENT_V1` (PASS above) depends on the same totals series was not investigated; treat that PASS as unconfirmed until it is.
- **Related fixes (separate commits, 2026-10-24).** The live gate and the Python research mirrors that derive an imbalance from these totals now treat a one-sided zero as unavailable. `run_cost_stack_validation.py` itself was deliberately left as sealed.

---
*The live trading pathway remains CLOSED. The next milestone is reliable prospective evidence from synchronized data, followed by independent economic validation.*
