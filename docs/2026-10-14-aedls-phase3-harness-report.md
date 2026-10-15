# AEDLS Phase 3 — Evaluation Harness & Calibration Report

**Date**: 2026-10-14  
**Status**: `HARNESS VERIFIED — CONFIRMATORY SCORING ON HOLD (INSUFFICIENT SAMPLE)`  
**Execution Invariant**: `appliedConfidenceDelta = 0` across all arms (zero live routing impact)  
**Retrieval Engine Default**: `exactSearchOnly = true` (PostgreSQL 18 sequential scan; pgvector 0.8.5)  

---

## 1. Executive Summary & Senior Quant Protocol Audit

| Workstream / Requirement | Measured Status | Protocol Requirement | Disposition |
| :--- | :--- | :--- | :--- |
| **Four-Arm Harness Architecture** | **OPERATIONAL** | Reproducible forecasts for Arms 0, 1, 2, 3 | **VERIFIED** |
| **Decoupled Execution Path** | `appliedConfidenceDelta = 0` | Zero baseline order alteration | **VERIFIED** |
| **Complete Trading-Session Split** | `18 Dev / 6 Val / 6 Holdout` | Indivisible session boundary rule | **ENFORCED** |
| **Development Candidates** | `368` | Calibrate estimators & parameters | **COMPLETE** |
| **Validation Candidate Count** | **`20` (6 sessions)** | `>= 40` independent episodes | **INSUFFICIENT_SAMPLE** |
| **Validation Confirmatory Verdict** | **`MODEL_INCONCLUSIVE`** | Mandatory statistical hold | **HOLD ENFORCED** |
| **Final Chronological Holdout** | **`44` (6 sessions)** | Strictly unopened & reserved | **UNOPENED / DEFERRED** |

---

## 2. Estimator Calibration on Development Partition (368 Candidates, 18 Sessions)

All hyperparameters, smoothing strengths, and logistic evidence weights were calibrated **strictly on Development data**:

- **Baseline Event Rate ($ar{p}_{	ext{dev}}$)**: `48.91%` (180 failures / 368 candidates)
- **Arm 0b Instrument Prior Smoothing ($alpha_{	ext{inst}}$)**: `5`
- **Arm 2 Structural Prior Smoothing ($alpha_{	ext{struct}}$)**: `5`
- **Arm 3 Dual-Cohort Evidence Weights**: $eta_{	ext{pos}} = 1.45$, $eta_{	ext{neg}} = 1.15$
- **Admission Cutoff ($p_{	ext{cut}}$)**: `0.55` (Reject if $hat{p} ge 0.55$)

### 2.1 Comparative Probability Distributions & Unrounded Brier Scores

| Arm | Prediction Mechanism | Mean $\hat{p}$ | Std Dev $\hat{p}$ | Range $[\min, \max]$ | Exact Brier Score | BSS vs Arm 0a | BSS vs Arm 0b |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Arm 0a** | Scalar Baseline Prior | `0.489130` | `0.000000` | `[0.4891, 0.4891]` | `0.249882` | Reference | `-1.1300%` |
| **Arm 0b** | Instrument-Stratified Prior ($\alpha=5.0$) | `0.489257` | `0.051439` | `[0.4328, 0.5361]` | `0.247090` | `+1.1174%` | Reference |
| **Arm 1** | Semantic Only ($\alpha=2.0$) | `0.489130` | `0.000000` | `[0.4891, 0.4891]` | `0.249882` | `0.0000%` | `-1.1300%` |
| **Arm 2** | Structural Only ($\alpha=5.0$) | `0.489257` | `0.051439` | `[0.4328, 0.5361]` | `0.247090` | **`+1.1174%`** | **`+0.0000%`** |
| **Arm 3** | Full Dual-Cohort Vector Search | `0.489130` | `0.000000` | `[0.4891, 0.4891]` | `0.249882` | `-0.0000%` | `-1.1300%` |

> [!IMPORTANT]
> **Empirical Attribution Note (Senior Quant Review Directive)**:
> Arm 0b reproduces the entire measured Arm 2 Brier score improvement in the development sample. That is the direct empirical result of this run (where all development candidates were `LONG`). This finding characterizes the historical development dataset; it does not constitute proof that the same exact relationship will hold across future market regimes or multi-directional opportunity sets.

### 2.2 Retrieval Coverage & Information Availability Diagnostics
- **Total Development Candidates Evaluated**: `368`
- **Fallback to Baseline Prior ($N_{\text{matches}} = 0$)**: **`368 / 368 (100.0%)`**
- **Average Positive Cohort Matches per Candidate**: `0.00`
- **Average Negative Cohort Matches per Candidate**: `0.00`
- **Finding**: Because strict 4-timestamp Point-in-Time filtering enforces $\max(t_{\text{close}}, t_{\text{evidence}}, t_{\text{review}}, t_{\text{embedding}}) < T_{\text{decision}}$, early chronological candidates (e.g. August sessions) have zero admissible historical reviews in the forensic database and fall back completely to the prior ($\hat{p} = \bar{p}_{\text{dev}}$).

### 2.3 Decision Activity & Sensitivity Across Rejection Cutoffs ($p_{\text{cut}}$)

| Cutoff $p_{\text{cut}}$ | Rejections | Rejection Rate | True Failures Prevented | False Winner Rejections | $FRR_{\text{winners}}$ | Cumulative $\Delta R_{\text{total}}$ | Incremental $\Delta E_{\text{candidate}}$ |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`0.45`** | `368` | `100.0%` | `180` | `137` | `100.0%` | `+105.89 R` | `+0.2877 R` |
| **`0.48`** | `368` | `100.0%` | `180` | `137` | `100.0%` | `+105.89 R` | `+0.2877 R` |
| **`0.50`** | `0` | `0.0%` | `0` | `0` | `0.0%` | `+0.00 R` | `+0.0000 R` |
| **`0.52`** | `0` | `0.0%` | `0` | `0` | `0.0%` | `+0.00 R` | `+0.0000 R` |
| **`0.55`** | `0` | `0.0%` | `0` | `0` | `0.0%` | `+0.00 R` | `+0.0000 R` |

> [!NOTE]
> At the frozen cutoff $p_{\text{cut}} = 0.55$, zero candidates exceeded the threshold because shrinkage to the prior ($\bar{p}_{\text{dev}} = 0.4891$) kept predictions below $0.55$. As shown in the sensitivity sweep, setting $p_{\text{cut}} = 0.50$ would trigger shadow rejections, but lower cutoffs must be evaluated strictly under prospective registration, not ex-post curve fitting.

---

## 3. Mandatory Protocol Classification: Validation Partition is Inconclusive

In strict adherence to Senior Quant directives:
1. The Validation partition contains **20 candidates across 6 trading sessions**.
2. Because $N_{	ext{val}} = 20 < 40$ required independent episodes, the validation set **lacks the statistical power** to confirm or falsify the AEDLS hypothesis.
3. Lowering the minimum-sample threshold to force a result is **strictly prohibited**.
4. The Validation partition is formally logged as:
   ```text
   STATUS: MODEL_INCONCLUSIVE
   REASON: INSUFFICIENT_VALIDATION_SAMPLE
   DETAIL: 20 candidates across 6 sessions < 40 required independent episodes
   ```
5. The **Final Holdout (44 candidates across 6 sessions) remains strictly unopened and untouched**.

---

## 4. Next Research Protocol Addendum

To advance beyond this statistical hold:
- Expand the historical execution corpus with subsequent live paper-trading sessions until the validation sample supplies at least **40 independent episodes**.
- Maintain the chronological holdout reserved for the single confirmatory test.
- No model promotion (Phase 4) is authorized until a sufficiently powered validation evaluation satisfies all registered criteria.
