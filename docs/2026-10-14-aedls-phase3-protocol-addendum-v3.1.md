# AEDLS Phase 3 — Protocol Addendum v3.1
## Prospective Validation Design & Sealed Historical Holdout Governance

**Document ID:** `AEDLS-PHASE3-ADDENDUM-v3.1`  
**Date:** 2026-10-14  
**Status:** `FROZEN GOVERNANCE ADDENDUM — PRIOR TO PROSPECTIVE SCORING`  
**Governance Authority:** Senior Quant Architecture Review Harmonization  
**Operational Policy:** Shadow Evaluation Only (`appliedConfidenceDelta = 0`); Zero Live Execution Impact  

---

## 1. Summary of Development Findings & Diagnostic Interpretation

Execution of the Phase 3 evaluation harness ([`evaluate-aedls-ablation.ts`](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/apps/api/src/interfaces/cli/evaluate-aedls-ablation.ts)) on the 368 development candidates across 18 trading sessions produced the following quantitative findings:

| Arm | Prediction Model | Brier Score ($BS$) | Brier Skill Score ($BSS$) | Mean $\hat{p}$ | Interpretation |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Arm 0** | Baseline (Empirical Prior) | `0.249882` | `0.0000%` | `0.4891` | Reference baseline |
| **Arm 1** | Semantic Only ($\alpha=2.0$) | `0.249882` | `0.0000%` | `0.4891` | 100% fallback to baseline prior |
| **Arm 2** | Structural Only ($\alpha=5.0$) | `0.247090` | **`+1.1174%`** | `0.4893` | Small in-sample structural skill |
| **Arm 3** | Full Dual-Cohort Vector | `0.249882` | `-0.0000%` | `0.4891` | 100% fallback to baseline prior |

### Root Cause of Development Semantic Inactivity:
- **Strict Point-in-Time Availability Guard**: For any candidate at $T_{\text{decision}}$, only historical reviews where $\max(t_{\text{close}}, t_{\text{evidence}}, t_{\text{review}}, t_{\text{embedding}}) < T_{\text{decision}}$ are eligible.
- Because historical trading sessions in August 2026 had no pre-existing settled forensic reviews in `ai_journal_reflections`, all early queries returned zero matches ($N_{\text{matches}} = 0$) and mathematically shrunk directly to the baseline prior ($\hat{p} = \bar{p}_{\text{dev}} = 0.4891$).
- At the pre-registered cutoff $p_{\text{cut}} = 0.55$, zero candidates exceeded the threshold, resulting in zero shadow rejections and $\Delta E = 0.00R$.

---

## 2. Formal Classification of Current Validation Partition

- **Candidate Count**: 20 candidates across 6 trading sessions (September 22–30, 2026).
- **Audit Rule**: Pre-registered protocol requires $N_{\text{episodes}} \ge 40$ independent episodes for confirmatory evaluation.
- **Formal Status**:
  ```text
  STATUS: MANDATORY STATISTICAL HOLD — MODEL_INCONCLUSIVE
  REASON: INSUFFICIENT_VALIDATION_SAMPLE
  DETAIL: 20 candidates across 6 sessions < 40 required independent episodes
  ```
- **Constraint**: Lowering the 40-episode threshold to force a premature pass/fail is strictly prohibited.

---

## 3. Sealed Historical Holdout & Chronological Sequencing

### 3.1 Sealing Historical Holdout Batch 1 (October 1–14, 2026)
- The 44 candidates from October 1–14, 2026 remain **sealed, unopened, and uninspected**.
- **Chronological Causality Rule**: Any new baseline trading sessions collected after October 14 occur *chronologically after* this sample. Therefore, if post-October 14 data were used for validation or calibration, the October 1–14 batch could no longer represent the chronologically final holdout for that expanded experiment.
- **Disposition**: The October 1–14 cohort is permanently archived as `Historical Sealed Holdout Batch 1`. It will not be retroactively opened or reclassified.

### 3.2 Prospective Validation & New Chronological Holdout Reservation
To achieve a properly powered, statistically valid Phase 3 evaluation:

```text
========================================================================================
EXPANDED CHRONOLOGICAL EVALUATION TIMELINE
========================================================================================

[ Historical Dev ] ──► [ Sealed Holdout 1 ] ──► [ Prospective Validation ] ──► [ Prospective Holdout 2 ]
(368 Candidates)       (44 Candidates)           (New Live Paper Sessions)      (Chronologically Later)
 2026-08-19 to          2026-10-01 to             Target: >= 40 Episodes         Strictly Reserved
 2026-09-21             2026-10-14                Clustered Bootstrap            Confirmatory Only
 (Calibrated)           (SEALED / UNOPENED)       (Confirmatory Test)            (Untouched)
```

1. **Prospective Data Accumulation**:
   - The operational trading bot continues executing trades via the **unchanged baseline path**.
   - As trades close, the Phase 1 forensic pipeline writes immutable reviews and embeddings to `ai_journal_reflections` and shadow records to `aedls_shadow_recommendations`.
2. **Prospective Validation Partition**:
   - Defined as the subsequent continuous block of live trading sessions starting immediately after the sealed holdout.
   - Accumulates until satisfying the registered sample power requirement: **at least 40 independent session-clustered episodes** ($N_{\text{episodes}} \ge 40$).
3. **Prospective Holdout Reservation**:
   - A subsequent, chronologically distinct continuous block of trading sessions reserved strictly *after* the prospective validation partition.
   - Remains unopened and sealed until the prospective validation partition achieves a definitive pass.

---

## 4. Frozen Governance Invariants

1. **Phase 4 ML Promotion Gate**: Remains strictly **GATED / NOT AUTHORIZED**.
2. **Live Execution Veto**: Runtime order blocking via `REJECTED_BY_ERROR_MODEL` remains **STRICTLY PROHIBITED**.
3. **Operational Decoupling**: `appliedConfidenceDelta = 0` is locked in database check constraints. AEDLS has zero access to order routing, position sizing, or broker execution.
