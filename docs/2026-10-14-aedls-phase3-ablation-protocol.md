# AEDLS Phase 3 — Retrieval Ablation & Counterfactual Evaluation Protocol
## Formal Research Specification & Pre-Registered Evaluation Plan

**Document ID:** `AEDLS-PHASE3-ABLATION-PROTOCOL-FROZEN`  
**Protocol Version:** `v3.0-FROZEN`  
**Freeze Date:** 2026-10-14  
**Status:** `ACTIVE RESEARCH PROTOCOL — FROZEN BEFORE CONFIRMATORY EVALUATION`  
**Governance Authority:** Senior Quant Architecture Review Harmonization  
**Engine Contract:** Exact Sequential Scan Default (`AedlsPitRetrievalService`), HNSW Benchmarked Alternative  
**Operational Policy:** Shadow Evaluation Only (`appliedConfidenceDelta = 0`); Zero Live Execution Impact  

---

## 1. Primary Research Question & Evaluation Boundaries

> **Primary Quantitative Question:**  
> *Does conditioning on retrieved historical trade reflections improve AEDLS's discrimination of subsequent trade candidate risk beyond the memory-free baseline policy?*

### 1.1 Study Population Boundary
- **Candidate Universe**: Strictly bounded to the **432 historically executed candidates** in `candidate_decisions` (`decision = 'EXECUTED'`) where the baseline strategy admitted the trade and an authoritative, verified fill was recorded in `paper_trades` with `status = 'CLOSED'`.
- **Exclusion of Refused Candidates**: Refused setups (`decision = 'REFUSED'`) are excluded because they lack verified fills and realistic execution prices. **Fabricating counterfactual returns for refused candidates is strictly prohibited.**
- **Generalization Boundary**: Findings apply strictly to the historically executed, baseline-selected candidate stream.

### 1.2 Execution Path Decoupling
- **`appliedConfidenceDelta = 0`**: Locked in database schema check constraints.
- Baseline orders, fills, and account equity trajectories remain 100% untouched.

---

## 2. Chronological Session Partitioning & PIT Integrity

### 2.1 Complete Trading Session 60/20/20 Partitioning
To eliminate data leakage caused by repeated intraday market setups, partitioning is strictly performed by **complete trading sessions** (trading dates), not arbitrary row counts. All candidates occurring within the same trading session belong exclusively to the same partition.

The 30 historical trading sessions (2026-08-19 to 2026-10-14) are partitioned as follows:

| Partition | Share | Trading Sessions | Date Range | Candidate Count | Permitted Usage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Development** | **60%** (18 sessions) | Sessions 1–18 | 2026-08-19 to 2026-09-21 | 368 candidates | Build retrieval policies, calibrate probability estimators, select similarity floors |
| **Validation** | **20%** (6 sessions) | Sessions 19–24 | 2026-09-22 to 2026-09-30 | 20 candidates | Confirmatory selection of final policy; test against registered economic & skill hurdles |
| **Final Holdout** | **20%** (6 sessions) | Sessions 25–30 | 2026-10-01 to 2026-10-14 | 44 candidates | **Strictly reserved.** One-time final verification; zero hyperparameter tuning permitted |

### 2.2 Outcome-Horizon Purging & Embargo at Boundaries
1. **Purging Overlapping Holding Periods**: If a trade opened in session $T_k$ remained open into session $T_{k+1}$, its outcome and evidence cannot be used as memory for any candidate evaluated in session $T_{k+1}$ until the position was formally closed and reconciled.
2. **Strict 4-Timestamp Point-in-Time Availability Guard**:
   For any candidate $c$ evaluated at timestamp $T_{\text{decision}}(c)$:
   $$\max\left(t_{\text{close}}(r),\, t_{\text{evidence}}(r),\, t_{\text{review}}(r),\, t_{\text{embedding}}(r)\right) < T_{\text{decision}}(c)$$
   If any timestamp is missing, null, or $\ge T_{\text{decision}}(c)$, reflection $r$ is excluded prior to similarity computation.
3. **Decision-Time Features Only**:
   The candidate query embedding $\mathbf{q}(c)$ is generated exclusively from features observable at $T_{\text{decision}}(c)$. Future excursions, exit reasons, or realized returns are strictly excluded.

---

## 3. Four Comparative Research Arms

All four research arms evaluate the **identical eligible candidate set** chronologically:

| Arm | Name | Retrieval Mechanism | Query Specification |
| :--- | :--- | :--- | :--- |
| **Arm 0** | **Memory-Free Baseline** | None | Operational baseline logic. Emits frozen baseline event probability $\bar{p}_{\text{dev}}$. |
| **Arm 1** | **Semantic-Only Retrieval** | Pure Vector Similarity | Top-10 nearest neighbors by vector cosine similarity without structural pre-filtering. |
| **Arm 2** | **Structural-Only Retrieval** | Exact Metadata Filter | Exact match on `(instrument_symbol, trade_side, setup_family, regime_class)` without vector ranking (recency-ordered). |
| **Arm 3** | **Full AEDLS Retrieval** | Pre-Filtered Dual-Cohort Vector Search | Structural pre-filtering + dual-cohort vector retrieval (`EVENT_POSITIVE` failure risk vs. `EVENT_NEGATIVE_CONTROL`). |

---

## 4. Separation of Retrieval Relevance, Prediction & Economics

Evaluation is divided into three mathematically independent layers:

### 4.1 Layer A: Retrieval Relevance (Independent of Outcome Filters)
- **Top-10 Precision & Recall**: Evaluated against an independently labelled semantic query-memory benchmark without filtering the database to pre-labeled outcome cohorts.
- **Opposing-Regime False Match Rate**: Fraction of top-10 retrieved memories that contradict the candidate's structural regime or directional bias. (Arm 1 acts as the unconstrained control; Arm 3 must demonstrate zero opposing-regime leakage).

### 4.2 Layer B: Event-Risk Probability Forecasting
For every candidate $i$, each arm must output a calibrated probability forecast $\hat{p}_i \in [0, 1]$ predicting the occurrence of the target failure event:  
$$y_i = \mathbb{I}\left(\text{Candidate } i \text{ experiences verified } IMMEDIATE\_ADVERSE\_EXCURSION\right)$$
where $y_i = 1$ if $MAE_3 \ge 1.0R \land MFE_3 < 0.2R$ under admissible evidence (`TICK_VERIFIED` or `BAR_DERIVED_UNAMBIGUOUS`), and $y_i = 0$ if validly observed non-failure. The true label $y_i$ is hidden from the retrieval query.

#### Formal Probability Estimators for Each Arm:

1. **Arm 0 (No Memory)**:
   $$\hat{p}_{\text{Arm0}, i} = \bar{p}_{\text{dev}}$$
   where $\bar{p}_{\text{dev}}$ is the empirical failure rate observed across the Development partition:
   $$\bar{p}_{\text{dev}} = \frac{1}{N_{\text{dev}}} \sum_{j \in \text{Dev}} y_j$$

2. **Arm 1 (Semantic Only)**:
   $$\hat{p}_{\text{Arm1}, i} = \frac{\sum_{k=1}^K s_{i,k} \cdot y_{i,k} + \alpha \cdot \bar{p}_{\text{dev}}}{\sum_{k=1}^K s_{i,k} + \alpha}$$
   where $s_{i,k} \ge 0.5$ is the semantic similarity of the $k$-th retrieved neighbor, $y_{i,k} \in \{0, 1\}$ is its verified failure status, and $\alpha = 2.0$ is the Bayesian prior smoothing weight. If $K=0$, $\hat{p}_{\text{Arm1}, i} = \bar{p}_{\text{dev}}$.

3. **Arm 2 (Structural Only)**:
   $$\hat{p}_{\text{Arm2}, i} = \frac{N_{\text{struct, failure}} + \alpha \cdot \bar{p}_{\text{dev}}}{N_{\text{struct, total}} + \alpha}$$
   calculated over historical candidates sharing the identical structural partition `(symbol, side, setup, regime)`.

4. **Arm 3 (Full AEDLS Dual-Cohort)**:
   $$\hat{p}_{\text{Arm3}, i} = \sigma\left( \text{logit}(\bar{p}_{\text{dev}}) + \beta_{\text{pos}} \cdot \bar{s}_{\text{positive}, i} - \beta_{\text{neg}} \cdot \bar{s}_{\text{negative}, i} \right)$$
   where $\bar{s}_{\text{positive}, i}$ is the mean similarity of top-matched `EVENT_POSITIVE` memories, $\bar{s}_{\text{negative}, i}$ is the mean similarity of top-matched `EVENT_NEGATIVE_CONTROL` memories, $\sigma(z) = \frac{1}{1 + e^{-z}}$, and weights $\beta_{\text{pos}}, \beta_{\text{neg}}$ are calibrated strictly on the Development partition. When no valid matches are retrieved above similarity floor, $\hat{p}_{\text{Arm3}, i} \to \bar{p}_{\text{dev}}$.

#### Evaluation Metrics for Risk Prediction:
- **Brier Score (BS)**:
  $$BS_{\text{arm}} = \frac{1}{N} \sum_{i=1}^N \left( \hat{p}_{\text{arm}, i} - y_i \right)^2 \quad (\text{lower is better})$$
- **Brier Skill Score (BSS)**:
  $$BSS_{\text{arm}} = 1 - \frac{BS_{\text{arm}}}{BS_{\text{Arm0}}}$$
- **Statistical Significance**: Paired session-clustered bootstrap (1,000 resamples by trading session). Holm-Bonferroni correction applied across the 3 pairwise comparisons (Arm 3 vs Arm 0, Arm 3 vs Arm 1, Arm 3 vs Arm 2).

---

## 5. Economic Counterfactual Evaluation & Decision Thresholds

### 5.1 Clean Binary Rejection Policy (No Sizing Hybrid)
- **Shadow Policy**: Candidates with $\hat{p}_{\text{Arm3}, i} \ge p_{\text{cut}}$ (calibrated in Development) are hypothetically rejected (`hypotheticalAdmissionDecision = 'REJECT'`).
- **Zero Risk Reallocation**: Freed risk budget remains in cash ($R=0$ for rejected trade; margin is not dynamically reallocated to subsequent setups).

### 5.2 Primary & Secondary Economic Metrics

1. **Primary Comparison Metric — Incremental Net Expectancy per Candidate ($\Delta E_{\text{candidate}}$)**:
   $$\Delta E_{\text{candidate}} = \frac{1}{N} \sum_{i=1}^N \left( R_{\text{shadow}}(c_i) - R_{\text{baseline}}(c_i) \right)$$
   where:
   - For an admitted trade: $R_{\text{shadow}}(c_i) = R_{\text{baseline}}(c_i) = R_{\text{observed,net}}(c_i)$.
   - For a hypothetically rejected trade: $R_{\text{shadow}}(c_i) = 0$, $R_{\text{baseline}}(c_i) = R_{\text{observed,net}}(c_i)$.  
     (If $R_{\text{observed,net}} = -1.0R$, delta is $+1.0R$; if $R_{\text{observed,net}} = +1.5R$, delta is $-1.5R$).
   - **Acceptance Requirement**: Paired session-clustered bootstrap 95% confidence interval for $\Delta E_{\text{candidate}}$ must have its **lower bound strictly $> 0$**.

2. **Secondary Portfolio Metric — Cumulative Incremental $R$ ($\Delta R_{\text{total}}$)**:
   $$\Delta R_{\text{total}} = \sum_{i=1}^N \left( R_{\text{shadow}}(c_i) - R_{\text{baseline}}(c_i) \right)$$
   - **Validation Hurdle**: Cumulative $\Delta R_{\text{total, validation}} \ge +5.0R$ across the full validation partition.

3. **False Rejection Rate on Winning Candidates ($FRR_{\text{winners}}$)**:
   $$FRR_{\text{winners}} = \frac{\sum_{i=1}^N \mathbb{I}\left( c_i \text{ is Rejected} \land R_{\text{observed,net}}(c_i) > 0 \land \text{outcomeValidity} = \text{'VALID\_RECONCILED'} \right)}{\sum_{i=1}^N \mathbb{I}\left( R_{\text{observed,net}}(c_i) > 0 \land \text{outcomeValidity} = \text{'VALID\_RECONCILED'} \right)}$$
   - **Acceptance Requirement**: $FRR_{\text{winners}} < 15.0\%$ evaluated on the Validation partition.

---

## 6. Pre-Registered Decision Thresholds & Phase 4 Gate Disposition

At the conclusion of the evaluation, results are classified into one of three pre-registered outcomes:

1. **POSITIVE SKILL DEMONSTRATED (Authorize Phase 4 Gate)**:
   - Arm 3 achieves $BSS > 0$ with paired session-clustered 95% CI lower bound $> 0$ against Arms 0, 1, and 2.
   - Primary expectancy delta $\Delta E_{\text{candidate}} > 0$ with 95% CI lower bound $> 0$.
   - Cumulative validation hurdle $\Delta R_{\text{total, validation}} \ge +5.0R$ satisfied.
   - False rejection rate of baseline winners $FRR_{\text{winners}} < 15.0\%$.
   - **Disposition**: Authorized to proceed to Phase 4 (Quantitative Admission & Adverse-Risk Models).

2. **NO INCREMENTAL VALUE (Archive Hypothesis)**:
   - $\Delta E_{\text{candidate}} \le 0$, or Arm 3 fails to outperform Arm 2 (structural-only baseline), or $FRR_{\text{winners}} \ge 15.0\%$.
   - **Disposition**: Formally falsify semantic memory hypothesis; system remains memory-free baseline.

3. **INCONCLUSIVE (Insufficient Statistical Power)**:
   - Fewer than 40 independent failure episodes ($N_{\text{episodes}} < 40$) observed in the validation set, or confidence intervals cross zero after Holm-Bonferroni correction.
   - **Disposition**: Classified as `INSUFFICIENT_SAMPLE`. Model promotion remains gated.

---

## 7. Execution Engine Standard

- **Default Search Engine**: `exactSearchOnly = true` via `AedlsPitRetrievalService` (exact sequential scan on PostgreSQL 18 with pgvector 0.8.5, measured latency p95 = 4.34 ms).
- **Benchmarked Alternative**: HNSW (`hnsw.ef_search = 100`, `hnsw.iterative_scan = strict_order`, measured latency p95 = 5.47 ms).
