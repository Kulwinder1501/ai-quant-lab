# AEDLS Phase 3 — Protocol Addendum v3.4: Event Taxonomy Separation, Power-Calibrated Validation Gates & Promotion Hierarchy

**Date**: 2026-10-14  
**Author**: Quantitative Architecture & Research Team  
**Review Status**: Formal Senior Quant Addendum v3.3 Review Alignment — Governs Stage A Execution & Pre-Validation Power Contract  
**Execution Authority**: Live Veto strictly **PROHIBITED** (`appliedConfidenceDelta = 0`); Phase 4 ML Model Promotion **GATED**  
**Predecessors**:
- [Phase 3 Ablation Protocol (v3.0)](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-ablation-protocol.md)
- [Protocol Addendum v3.1](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-protocol-addendum-v3.1.md)
- [Protocol Addendum v3.2](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-protocol-addendum-v3.2.md)
- [Protocol Addendum v3.3](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-protocol-addendum-v3.3.md)
- [Simulation-Based Power Report](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-power-report.md)
- [Phase 3 Evaluation Harness Report](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-harness-report.md)

---

## 1. Executive Summary & Senior Quant Directives Addressed

This addendum closes the three statistical contract issues and the calibration-readiness issue identified in the Senior Quant Review of v3.3:
1. **P0.1 — Separation of Adverse Excursion Events from Trade PnL Outcomes**:
   Formally decouples the target event label (`IMMEDIATE_ADVERSE_EXCURSION`) from trade profitability (`realized_net_r > 0`). Unobservable and intrabar-ambiguous assessments are strictly prohibited from being treated as negative controls.
2. **P0.2 — Simulation-Based Power & Sample-Size Calibration**:
   Using the empirical session-clustering parameters from the Development partition ($\rho = 0.0472, \text{DEFF} = 1.92$), a 2,000-iteration Monte Carlo simulation establishes that increasing the required validation sample from 15 sessions to **20 sessions** guarantees **83.6% joint statistical power** (surpassing the $\ge 80.0\%$ target).
3. **P0.3 — Frozen Hierarchy of Mandatory Promotion Conditions**:
   Consolidates all predictive, practical, economic, winner-protection, cumulative return, and risk limits into an unambiguous frozen promotion gate hierarchy.
4. **Stage B Evidence-Availability Gating**:
   Supplements the operational fallback rate ($f_{\text{fallback}} \le 25\%$) with six concrete corpus scale, verified label coverage, instrument balance, and Point-in-Time integrity requirements.

---

## 2. Event Taxonomy Separation Contract (P0.1)

Trade profitability and adverse excursion events are non-equivalent orthogonal dimensions. An execution may be highly profitable while having suffered an immediate adverse excursion, or unprofitable without having breached the excursion threshold:

```mermaid
quadrantChart
    title Orthogonal Classification: Adverse Excursion vs PnL Outcome
    x-axis Unprofitable (Loser) --> Profitable (Winner)
    y-axis Adverse Excursion Avoided (N_neg) --> Adverse Excursion Experienced (N_pos)
    quadrant-1 "Profitable with Excursion"
    quadrant-2 "Unprofitable with Excursion"
    quadrant-3 "Unprofitable, No Excursion"
    quadrant-4 "Profitable, Clean Entry"
```

### Exact Metric Definitions

| Metric | Database Query Predicate & Definition | Purpose |
| :--- | :--- | :--- |
| **$N_{\text{pos}}$** | `targetEvent = 'IMMEDIATE_ADVERSE_EXCURSION' AND label = 'POSITIVE' AND evidenceStatus IN ('TICK_VERIFIED', 'BAR_DERIVED_UNAMBIGUOUS')` | Event-positive training & retrieval cohort |
| **$N_{\text{neg}}$** | `targetEvent = 'IMMEDIATE_ADVERSE_EXCURSION' AND label = 'NEGATIVE' AND evidenceStatus IN ('TICK_VERIFIED', 'BAR_DERIVED_UNAMBIGUOUS')` | Event-negative control retrieval cohort |
| **$N_{\text{winners}}$** | `outcomeValidity = 'VALID_RECONCILED' AND realized_net_r > 0` | Opportunity set denominator for False Rejection Rate ($FRR_{\text{winners}}$) |
| **$N_{\text{losers}}$** | `outcomeValidity = 'VALID_RECONCILED' AND realized_net_r <= 0` | Reconciled unprofitable trade cohort |
| **$N_{\text{episodes}}$** | Distinct market trade executions clustered by underlying symbol and discrete intraday wave window | Measures statistical sample independence |

> [!CAUTION]
> **Admissibility Prohibition**:
> Records with `evidenceStatus = 'INTRABAR_AMBIGUOUS'` or `label = 'UNOBSERVABLE'` are **strictly excluded** from $N_{\text{neg}}$ and from the negative control retrieval cohort. An ambiguous excursion must never be assumed as a ground-truth negative example.

---

## 3. Power-Calibrated Validation Sample Gates (P0.2)

Per the empirical Monte Carlo power analysis ([docs/2026-10-14-aedls-phase3-power-report.md](file:///c:/Users/Kulwinder%20Singh/Desktop/personal/AI%20Quant%20Lab/docs/2026-10-14-aedls-phase3-power-report.md)), the Stage C Validation partition requirements are frozen as follows:

| Parameter | Previous Minimum (v3.2) | Power-Calibrated Requirement (Addendum v3.4) | Empirical Expectation | Joint Power Impact |
| :--- | :--- | :--- | :--- | :--- |
| **Trading Sessions ($N_{\text{sessions}}$)** | `15` | **`>= 20` distinct trading dates** | 20 sessions | Elevates joint power from $79.2\% \to \mathbf{83.6\%}$ |
| **Candidate Opportunities ($N_{\text{val}}$)** | `100` | **`>= 120` executed candidates** | $\sim 406$ candidates | Sufficient candidate volume |
| **Independent Episodes ($N_{\text{episodes}}$)** | `40` | **`>= 50` round-trip episodes** | $\ge 50$ episodes | Independent observation units |
| **Verified Adverse Excursions ($N_{\text{pos}}$)** | `15` | **`>= 25` verified positive assessments** | $\sim 199$ events | Reliable positive retrieval |
| **Verified Negative Controls ($N_{\text{neg}}$)** | `15` | **`>= 25` verified negative assessments** | $\sim 207$ events | Reliable negative retrieval |
| **Reconciled Baseline Winners ($N_{\text{winners}}$)** | N/A | **`>= 30` reconciled winning trades** | $\sim 151$ winners | Reliable $FRR_{\text{winners}}$ estimation |
| **Joint Statistical Power ($1 - \beta$)** | Assumed | **`83.6%`** | Measured via MC simulation | **PASSES $\ge 80.0\%$ BAR** |

If any of these 6 gates is not met when the prospective observation block closes, the validation result is formally registered as **`MODEL_INCONCLUSIVE`**. Lowering sample thresholds ex-post is strictly prohibited.

---

## 4. Frozen Hierarchy of Mandatory Promotion Conditions (P0.3)

To resolve any potential ambiguity across previous addenda, the following 6 mandatory conditions form the immutable Promotion Gate:

| Gate | Category | Exact Metric Specification | Mandatory Hurdle |
| :--- | :--- | :--- | :--- |
| **Gate 1** | Predictive Multiplicity | Paired Brier comparison of Arm 3 against **both** Arm 0b and Arm 2 under Holm-Bonferroni correction ($\alpha_1 = 0.025, \alpha_2 = 0.05$) | $\Delta BS = BS_{\text{benchmark}} - BS_{\text{Arm 3}} > 0$ (Statistically significant) |
| **Gate 2** | Practical Skill Effect | Raw paired Brier difference and Brier Skill Score relative to Arm 0b | $BSS_{\text{vs Arm 0b}} \ge +2.0\%$ (Report both raw $\Delta BS$ and $BSS$) |
| **Gate 3** | Incremental Expectancy | Paired incremental net expectancy per candidate with session-clustered bootstrap 95% CI | $\Delta E_{\text{candidate}} \ge +0.05R$ AND $\text{CI}_{\text{lower}} > 0.00R$ |
| **Gate 4** | Winner Protection | False Rejection Rate of verified baseline winners ($N_{\text{winners}}$) | $FRR_{\text{winners}} < 15.0\%$ |
| **Gate 5** | Cumulative Validation Edge | Total cumulative incremental return generated across the validation partition | $\Delta R_{\text{total, validation}} \ge +5.0R$ |
| **Gate 6** | Catastrophic Risk Limits | Walk-forward partition boundary conditions across all sub-folds | $\text{Max DD} \le 6.0R$, $\text{Net Exp} \ge -0.15R$, $\text{Session Loss} \le 50\%$ |

All 6 conditions must be satisfied simultaneously. A positive point estimate on expectancy or Brier score alone does not authorize promotion without satisfying the confidence interval lower bound and winner protection constraints.

---

## 5. Stage B Evidence-Availability Gate

The calibration phase (Stage B) will not begin solely based on the operational fallback fraction. It requires passing the **Evidence-Availability Gate**:

```text
STAGE B EVIDENCE-AVAILABILITY GATE (FROZEN):
├── 1. Operational Activity: Fallback fraction f_fallback <= 25% for 5 consecutive sessions
├── 2. Historical Corpus Scale: Total eligible reviews N_corpus >= 100 in database
├── 3. Independent Episodes: N_episodes >= 40 independent round-trip trades
├── 4. Target Coverage: N_pos >= 20 verified IMMEDIATE_ADVERSE_EXCURSION reviews
├── 5. Control Coverage: N_neg >= 20 verified negative control reviews
├── 6. Instrument Balance: N_pos >= 10 and N_neg >= 10 for BOTH NIFTY50 and BANKNIFTY
└── 7. Point-in-Time Integrity: Zero PIT timestamp violations (max(t_close, t_evidence, t_review, t_embed) < T_decision)
```

Only after all 7 criteria are met will rolling-origin forward folds begin. Model coefficients ($\beta_{\text{pos}}, \beta_{\text{neg}}$), similarity thresholds, query templates, and the admission cutoff ($p_{\text{cut}}$) will be frozen into an immutable SHA-256 digest before any Stage C validation data is observed.

---

## 6. Current Operational Disposition & Governance

| Stage | Activity | Authorization | Constraints |
| :--- | :--- | :--- | :--- |
| **Stage A** | Prospective Memory Accumulation | **ACTIVE (GO)** | Baseline execution untouched; daily telemetry logged |
| **Stage B** | Calibration & Policy Freeze | **CONDITIONAL** | Triggers only upon passing Evidence-Availability Gate |
| **Stage C** | Prospective Validation | **GATED** | Requires $\ge 20$ sessions, $\ge 50$ episodes, $\ge 120$ candidates |
| **Stage D** | Prospective Holdout Batch 2 | **GATED** | Reserved chronologically after Stage C |
| **Historical Batch 1** | October 1–14, 2026 Archive | **SEALED** | Permanently unopened and uninspected |
| **Phase 4** | Live Model Promotion | **GATED** | Zero live authority; `appliedConfidenceDelta = 0` |
| **Live Veto** | Order rejection / confidence alteration | **PROHIBITED** | Database schema CHECK constraints locked |
