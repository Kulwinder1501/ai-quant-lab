# AEDLS Phase 3 — Protocol Addendum v3.2
## Prospective Four-Stage Roadmap, Instrument-Stratified Comparator & Multi-Session Cluster Gate

**Document ID:** `AEDLS-PHASE3-ADDENDUM-v3.2`  
**Date:** 2026-10-14  
**Status:** `FROZEN GOVERNANCE CONTRACT — GOVERNING STAGES A THROUGH D`  
**Governance Authority:** Senior Quant Architecture Review Harmonization  
**Operational Policy:** Shadow Evaluation Only (`appliedConfidenceDelta = 0`); Zero Live Execution Impact  

---

## 1. Executive Correction: Provisional Status of Arm 3 Coefficients

In the Phase 3 Development diagnostics:
$$\beta_{\text{pos}} = 1.45, \quad \beta_{\text{neg}} = 1.15$$
Because strict 4-timestamp Point-in-Time filtering ($\max(t_{\text{close}}, t_{\text{evidence}}, t_{\text{review}}, t_{\text{embedding}}) < T_{\text{decision}}$) excluded future settled records, every candidate query in August 2026 returned zero matching historical reviews from `ai_journal_reflections` ($N_{\text{matches}} = 0$).

Consequently:
- 100% of Arm 3 candidate predictions collapsed to the development prior ($\hat{p} = \bar{p}_{\text{dev}} = 0.4891$).
- **The dual-cohort coefficients $\beta_{\text{pos}}$ and $\beta_{\text{neg}}$ were never exercised against active retrieval variance.**
- **Formal Status**: $\beta_{\text{pos}} = 1.45$ and $\beta_{\text{neg}} = 1.15$ are formally classified as **provisional hypothesis parameters**, not empirically fitted or calibrated parameters. They must not be presented as demonstrated empirical weights until active retrieval variance is accumulated in Stage A.

---

## 2. The Four-Stage Prospective Roadmap

To transition from zero-memory dormancy to a statistically powered, chronologically valid evaluation:

```text
========================================================================================
FOUR-STAGE PROSPECTIVE EVALUATION SEQUENCE
========================================================================================

Stage A: Memory Accumulation ──► Stage B: Policy Freeze ──► Stage C: Validation ──► Stage D: Holdout
(Live Baseline Path)             (Freeze beta, p_cut,      (Prospective block,       (Still-Later Block,
Accumulate settled reviews        prior smoothing &         >= 40 episodes &          Strictly Sealed &
into ai_journal_reflections       fallback logic)           >= 15 session clusters)   Reserved for Confirm)
```

### Stage A — Prospective Memory Accumulation & Active Calibration
1. The operational trading bot continues executing orders strictly via the **unmodified baseline path**.
2. As trades close, the Phase 1 forensic pipeline populates `ai_journal_reflections` with verified path events, target assessments, and local 384-d embeddings at their exact settlement timestamps.
3. Once settled reviews exist prior to subsequent decision timestamps, the dual-cohort retrieval mechanism becomes active ($N_{\text{matches}} \ge 1$).
4. Arm 3's coefficients $\beta_{\text{pos}}$ and $\beta_{\text{neg}}$ are estimated on this active calibration data using chronological out-of-fold estimation.

### Stage B — Candidate Policy Freeze
1. The estimated coefficients ($\beta_{\text{pos}}, \beta_{\text{neg}}$), prior smoothing weight ($\alpha$), and admission cutoff ($p_{\text{cut}}$) are formally locked into an immutable versioned release.
2. Fallback logic and query templates are frozen. Zero parameter tuning is permitted after Stage B.

### Stage C — Prospective Validation Gate
1. The frozen policy is evaluated on subsequent continuous trading sessions.
2. During Stage C, the memory corpus continues to grow under a frozen online-insertion rule (candidates retrieve only reviews settled prior to $T_{\text{decision}}$).
3. **Mandatory Sample-Size & Cluster Gate**:
   - Minimum independent episodes: **$N_{\text{episodes}} \ge 40$**.
   - Minimum session clusters: **$N_{\text{sessions}} \ge 15$ distinct trading dates**.
   - Paired session-clustered bootstrap 95% confidence interval for Brier Skill Score ($BSS > 0$) and net expectancy ($\Delta E_{\text{candidate}} > 0$).
   - False rejection rate of baseline winners $FRR_{\text{winners}} < 15.0\%$.

### Stage D — Chronologically Later Final Holdout
1. A new, strictly later continuous block of trading sessions occurring *after* Stage C is reserved as `Prospective Final Holdout Batch 2`.
2. **Permanent Archive of Historical Holdout Batch 1**: The 44 candidates from October 1–14, 2026 remain permanently archived as a sealed historical dataset. Because prospective data occurs post-October 14, the October 1–14 cohort cannot serve as the chronologically final holdout for a model calibrated on subsequent data.

---

## 3. Instrument-Stratified Baseline Comparator (Arm 0b)

To distinguish a simple instrument base-rate difference from genuine structural setup and regime intelligence:

### 3.1 Comparator Definitions
- **Arm 0a (Scalar Baseline)**: Pooled empirical failure rate $\bar{p}_{\text{dev}} = 0.489130$.
- **Arm 0b (Instrument-Stratified Prior)**: Failure rate conditioned strictly on underlying instrument identity with Bayesian smoothing ($\alpha_{\text{inst}} = 5.0$):
  $$\hat{p}_{\text{Arm0b}}(c) = \frac{N_{\text{inst, fail}} + \alpha_{\text{inst}} \cdot \bar{p}_{\text{dev}}}{N_{\text{inst, total}} + \alpha_{\text{inst}}}$$
  - In Development:
    - $\text{NIFTY50}$: $108 \text{ failures} / 201 \text{ candidates} \implies \hat{p} = 0.5361$
    - $\text{BANKNIFTY}$: $72 \text{ failures} / 167 \text{ candidates} \implies \hat{p} = 0.4328$
- **Arm 2 (Structural & Setup Context)**: Conditioned on instrument, trade side, setup family, and intraday regime class.

### 3.2 Diagnostic Decision Rule
- If $BS_{\text{Arm2}} \approx BS_{\text{Arm0b}}$, Arm 2's apparent skill gain reflects instrument base-rate differences alone, not setup/regime context.
- Arm 2 is credited with structural predictive skill only if $BS_{\text{Arm2}} < BS_{\text{Arm0b}}$ with statistical significance.

---

## 4. Minimum Session Cluster & Power Requirements

To prevent few outlier trading sessions from distorting clustered bootstrap uncertainty estimates:

| Metric | Required Acceptance Threshold | Purpose |
| :--- | :--- | :--- |
| **Independent Episode Count ($N_{\text{episodes}}$)** | $\ge 40$ | Sufficient statistical sample of failure and control events |
| **Session Cluster Count ($N_{\text{sessions}}$)** | $\ge 15$ distinct trading dates | Valid session-clustered bootstrap variance estimation |
| **Brier Skill Score ($BSS_{\text{Arm3}}$ vs Arm 0a, 0b, 1, 2)** | $> 0$ (95% CI lower bound $> 0$) | Statistically significant predictive skill over all baselines |
| **Incremental Net Expectancy ($\Delta E_{\text{candidate}}$)** | $> 0$ (95% CI lower bound $> 0$) | Economic value add over common opportunity set |
| **Cumulative Validation Delta ($\Delta R_{\text{total, validation}}$)** | $\ge +5.0R$ across validation partition | Minimum portfolio contribution hurdle |
| **False Rejection of Winners ($FRR_{\text{winners}}$)** | $< 15.0\%$ | Capital preservation / non-destruction of edge |

---

## 5. Frozen Governance Invariants

1. **`appliedConfidenceDelta = 0`**: Permanently locked in database schema check constraints. Zero live routing impact.
2. **Phase 4 ML Model Promotion Gate**: Remains strictly **GATED / NOT AUTHORIZED**.
3. **Live Execution Veto**: Runtime order blocking via `REJECTED_BY_ERROR_MODEL` remains **STRICTLY PROHIBITED**.
