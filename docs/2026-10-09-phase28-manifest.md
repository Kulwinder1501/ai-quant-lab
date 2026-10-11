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

---
*The live trading pathway remains CLOSED. The next milestone is reliable prospective evidence from synchronized data, followed by independent economic validation.*
