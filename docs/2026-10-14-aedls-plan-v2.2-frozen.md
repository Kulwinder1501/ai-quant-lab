# Adaptive Error-Driven Learning System (AEDLS) Specification v2.2
## Final Frozen Architecture, Empirical Governance & Research Implementation Contract

**Document ID:** `AEDLS-SPEC-v2.2-FINAL-FROZEN`  
**Freeze Date:** 2026-10-14  
**Status:** `RESEARCH & SHADOW APPROVED — LIVE TRADING VETO PROHIBITED`  
**Scope:** AI Autonomous Agent (`ai-autonomous-agent.ts`), Strategy Engine & Quantitative ML Pipelines (`apps/ml`)  
**Target Instruments:** NSE Index Derivatives (NIFTY 50 / BANKNIFTY)  
**Governance Authority:** Senior Quant Architecture Review Harmonization  

---

## 1. Executive Disposition & Phase Authorization Matrix

Following final Senior Quant Architecture Review redlines, the Adaptive Error-Driven Learning System (AEDLS) specification is **formally approved and frozen for staged research implementation**.

### Phase Authorization Matrix

| Phase | Description | Operational Authority | Status |
| :--- | :--- | :--- | :--- |
| **Phase 0** | Baseline Audit, Authority Map & Candidate Inventory | Read-only | **APPROVED / GO** |
| **Phase 1** | Forensic Review Schema, Excursion Math & Migration | Database instrumentation | **APPROVED / GO** |
| **Phase 2** | Isolated Semantic Embeddings & PIT Retrieval | Asynchronous, zero live impact | **APPROVED / GO** |
| **Phase 3** | Retrieval Ablation & Counterfactual Evaluation | Shadow mode | **Pending Gates A–C** |
| **Phase 4** | Quantitative Admission & Risk Models | Offline ML (Walk-Forward / CPCV) | **Pending Dataset Readiness** |
| **Phase 5** | Operational Shadow Promotion Review | Advisory shadow logging | **Pending Gate D ($\Delta E > 0$)** |
| **Live Veto** | Runtime order blocking via `REJECTED_BY_ERROR_MODEL` | Hard trading veto | **STRICTLY PROHIBITED** |

---

## 2. Core Architecture & Three Independent Decision Surfaces

AEDLS operates under a strict principle of least authority: **learning components hold zero trade-authorizing authority**.

```text
========================================================================================
TIMELINE T = decision_at (Live / Paper Setup Candidate Evaluated)
========================================================================================

Candidate Setup ───► Capture Immutable Decision Snapshot (Features + PIT Availability Timestamps)
                            │
       ┌────────────────────┼─────────────────────────────────┐
       ▼                    ▼                                 ▼
[ Decision 1: Safety ]   [ Decision 2: Candidate Admission ] [ Decision 3: Risk Budget ]
Hard spread limits,       Evaluates AEDLS Meta-Model /        Allocates lot-rounded sizing
data freshness, account   Memory Risk Assessment Policy       based strictly on portfolio
drawdown caps.            (Advisory only in shadow mode).     risk budget.
       │                            │                                 │
  Reject/Pass                  Reject/Pass                       Sizing S
       └────────────────────┬───────┘                                 │
                            ▼                                         ▼
                 Follows Baseline Strategy ────────────────► Execute Paper / Shadow

========================================================================================
TIMELINE T = review_available_at (Post-Trade Forensic Decomposition)
========================================================================================

Trade Closed at t_close
  └─► Forensic Engine (buildTradeReview) executes at t_review
        ├─ Measures MFE, MAE, Realized R, and Intrabar Ordering Ambiguity
        ├─ Multi-label extraction: observedEvents[] (objective path events)
        ├─ Categorizes terminalOutcome (exit type) and reviewDataStatus
        ├─ Formulates causalHypothesis and assigns attributionStatus
        └─ Asynchronous Worker computes vector embedding at t_embedding
              └─► Persists immutable record to ai_journal_reflections
```

### The Three Independent Decisions
1. **Safety Decision (Execution & Risk Controls):** Hard execution boundaries (spread, stale feeds, broker downtime, risk caps). Enforced by the core risk engine. Candidates rejected here are preserved in the audit ledger but excluded from admission evaluation (AEDLS does not evaluate whether to override a hard safety cap).
2. **Admission Decision (AEDLS Meta-Policy):** Evaluates whether an approved, independently validated model or memory policy rejects the candidate. **Passing AEDLS never authorizes a trade; it only permits consideration.**
3. **Risk Decision (Position Sizing):** Allocates lot-rounded sizing based strictly on the portfolio risk budget. AEDLS cannot increase risk.

---

## 3. P0 Forensic Schema: Path Events, Terminal Outcomes & Risk Unit $R$

### 3.1 Separation of Path Events from Terminal Outcomes

To prevent conflating dynamic execution paths with exit reasons, `observedEvents` records path dynamics while `terminalOutcome` records how the trade exited:

```typescript
export type ObservedTradeEvent =
  | "IMMEDIATE_ADVERSE_EXCURSION"       // MAE >= 1.0R within 3 completed bars while MFE < 0.2R
  | "FAVORABLE_STALL_REVERSAL"          // MFE >= 1.0R followed by drawdown to initial stop
  | "UNDERLYING_OPTION_PNL_DIVERGENCE"  // Spot moved >= 0.05% in favor, Option bid P&L <= 0
  | "EXCESSIVE_SPREAD_SLIPPAGE";        // Realized spread + slippage exceeded 0.5R

export type TerminalTradeOutcome =
  | "STOP_LOSS"
  | "TARGET"
  | "TIMEOUT"
  | "MANUAL_EXIT"
  | "OTHER";

export type ReviewDataStatus =
  | "COMPLETE"           // Verified per-tick/per-bar holding data
  | "INSUFFICIENT_DATA"   // Missing bars or truncated tape; excursions set to null
  | "CONFLICTING_DATA";   // Timestamp anomalies or contradictory prices

export type IntrabarOrdering = "DETERMINISTIC" | "AMBIGUOUS";

export interface TradeFailureReview {
  tradeId: string;
  candidateId: string;

  // 1. Objective measured path events (multi-label array)
  observedEvents: ObservedTradeEvent[];
  primaryObservedEvent: ObservedTradeEvent | null; // Nullable if no registered path event occurred

  // 2. Terminal exit classification
  terminalOutcome: TerminalTradeOutcome;
  reviewDataStatus: ReviewDataStatus;
  intrabarOrdering: IntrabarOrdering;

  // 3. Continuous excursion metrics (Nullable if reviewDataStatus != 'COMPLETE')
  maxFavourableExcursionR: number | null;
  maxAdverseExcursionR: number | null;
  realizedR: number | null;
  underlyingExcursionPoints: number | null; // Kept separate for option contracts

  // 4. Falsifiable causal hypotheses
  causalHypothesis:
    | "OPPOSING_ORDER_FLOW"
    | "VOLATILITY_CRUSH_VEGA"
    | "LIQUIDITY_VACUUM_SLIP"
    | "COUNTER_DRIVER_TAPE"
    | "UNATTRIBUTED_MARKET_VARIANCE";

  attributionStatus: "SUPPORTED" | "REFUTED" | "UNKNOWN";

  // 5. Exact availability timestamps (Strict 4-Timestamp PIT Contract)
  tradeClosedAt: string;              // ISO-8601 when position closed
  evidenceAvailableAt: string;       // ISO-8601 when holding-period tick/bar tape settled
  reviewAvailableAt: string;         // ISO-8601 when review calculation completed
  embeddingAvailableAt: string | null;// ISO-8601 when vector was written

  // 6. Versioning & Provenance
  taxonomyVersion: "taxonomy-v2.2";
  reviewerVersion: "reviewer-v2.2";
  proposedResearchTags: string[];
}
```

### 3.2 Frozen Definition of Initial Risk Unit $R$, Excursions & Event Windows

1. **Initial Risk Unit ($1.0R$)**:
   - The rupee risk established at decision time using the frozen entry price, initial stop loss, and contract lot size:
     $$1.0R = \left|\text{entry\_price} - \text{initial\_stop\_loss}\right| \times \text{lot\_size}$$
   - For option buying: $\text{premium stop distance in rupees} \times \text{contract lot size}$.
2. **Excursion Sign & Scale Convention**:
   - $\text{MFE}$ and $\text{MAE}$ are strictly **non-negative magnitudes** measured in units of $1.0R$:
     $$\text{MFE} = \frac{\max(\text{favorable excursion in points})}{\text{stop distance in points}}, \quad \text{MAE} = \frac{\max(\text{adverse excursion in points})}{\text{stop distance in points}}$$
3. **Executable Mark Price Convention**:
   - Excursion and P&L mark-to-market calculations must use **executable bid prices for long liquidations** and **executable ask prices for short coverings**; midpoint or indicative spot prices are strictly prohibited for option execution evaluation.
4. **Event Measurement Windows**:
   - `IMMEDIATE_ADVERSE_EXCURSION`: Evaluated over the first **3 completed 1-minute bars** immediately following the entry timestamp (excluding the entry bar).
   - `UNDERLYING_OPTION_PNL_DIVERGENCE`: Evaluated within the first **15 minutes** post-entry. Triggers if underlying index moves $\ge +0.05\%$ in favor while option bid premium $\le$ entry premium.
   - `EXCESSIVE_SPREAD_SLIPPAGE`: Bid-ask spread at fill + slippage $> 0.5R$. Tracked as entry friction and accounted for in net realized $R$, not double-counted.
5. **Intrabar Ambiguity Resolution**:
   - If an OHLC bar touches both stop and favorable thresholds without verified tick sequencing, mark `intrabarOrdering = "AMBIGUOUS"`. In outcome simulation, apply the conservative rule: **assume adverse excursion occurred first**. This is an execution rule, not asserted historical truth.

---

## 4. Strict Point-in-Time (PIT) Retrieval & Vector Correctness

### 4.1 Complete 4-Timestamp SQL Retrieval Guard

When evaluating an incoming setup candidate at decision timestamp $T_{\text{decision}}$, the SQL query must enforce that all four lifecycle events settled strictly before $T_{\text{decision}}$:

$$\max\left(t_{\text{close}}, t_{\text{evidence}}, t_{\text{review}}, t_{\text{embedding}}\right) < T_{\text{decision}}$$

```sql
-- Must execute inside a transaction block with SET LOCAL for pooled connections:
-- SET LOCAL hnsw.ef_search = 100;
-- SET LOCAL hnsw.iterative_scan = strict_order;

SELECT 
    r.id,
    r.trade_id,
    r.observed_events,
    r.primary_observed_event,
    r.terminal_outcome,
    r.causal_hypothesis,
    r.attribution_status,
    r.structural_context,
    1 - (r.embedding <=> $1) AS semantic_similarity
FROM ai_journal_reflections r
WHERE r.trade_closed_at < $2
  AND r.evidence_available_at < $2
  AND r.review_available_at < $2
  AND r.embedding_available_at < $2
  AND r.review_data_status = 'COMPLETE'
  AND r.embedding IS NOT NULL
  AND 1 - (r.embedding <=> $1) >= $3 -- Calibrated similarity floor
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

> [!CRITICAL]
> **Query Invariant**: `$2` is the immutable **candidate decision timestamp**. Query embeddings must be generated using versioned templates (`query_template_version`) containing **only features known at $T_{\text{decision}}$**.

### 4.2 Compound Match Policy (Decision-Time Inputs Only)

An incoming candidate has not yet experienced an outcome. Therefore, structural compatibility matches **decision-time context**, comparing the candidate against known historical outcome subsets:

$$\text{MemoryMatch} = \text{SemanticMatch}(X_{\text{cand}}, X_{\text{hist}}) \land \text{StructuralCompatibility}(C_{\text{cand}}, C_{\text{hist}})$$

```text
Decision-Time Structural Dimensions:
├── Instrument: Exact match (e.g., NIFTY50 == NIFTY50)
├── Trade Side: Exact match (LONG == LONG, SHORT == SHORT)
├── Setup Family: Exact match (Reversal == Reversal, Breakout == Breakout)
└── Regime: Compatible volatility/trend state
```

### 4.3 pgvector HNSW Recall Acceptance Standard
HNSW does not guarantee candidate depth when scalar filters are applied. The following acceptance standards are mandatory:
* **Version Requirement**: Pin `pgvector >= 0.8.0` with support for `hnsw.iterative_scan = strict_order`.
* **Exact-Scan Benchmark**: In Phase 2, benchmark HNSW recall@10 against brute-force sequential scans (`SET enable_indexscan = off`) across 500 test queries.
* **Transaction Isolation**: Per-query HNSW settings must use `SET LOCAL` inside transaction blocks to prevent polluting connection pools.
* **Acceptance Bar**: If HNSW achieves $< 95\%$ recall@10 against exact search at acceptable latency, exact retrieval must be used for production research; **relaxing PIT or structural filters to inflate result counts is strictly prohibited**.

---

## 5. Shadow-Mode Memory Policy & Deduplication

### 5.1 Memory Risk Assessment Interface

To eliminate any contradiction between shadow mode and hypothetical penalty evaluation, the applied delta is strictly decoupled from the research proposal:

```typescript
export interface MemoryRiskAssessment {
  status: "NO_MATCH" | "MATCH_UNVALIDATED" | "MATCH_VALIDATED" | "MODEL_UNAVAILABLE";
  matchedReviewIds: string[];
  rawReviewCount: number;
  deduplicatedEpisodeCount: number;

  // Operational authority: LOCKED AT ZERO in shadow mode
  appliedConfidenceDelta: 0;

  // Research counterfactual: logged for offline ablation studies only
  proposedConfidenceDelta: number | null;

  reasonCodes: string[];
  episodeIds: string[];
}
```

### 5.2 Episode Deduplication & Operational Fallback
* **Deduplication**: Trades sharing the same `episode_id` (derived from continuous volatility regime or intraday price bracket) are collapsed into 1 independent evidence point. Both `rawReviewCount` and `deduplicatedEpisodeCount` are recorded.
* **Operational Fallback (`MODEL_UNAVAILABLE`)**: If the embedding model or vector store times out or fails, the system outputs `status: "MODEL_UNAVAILABLE"`. It logs the incident and defers candidate evaluation entirely to the baseline strategy and risk engine. It never blocks trades and never acts as a veto.

---

## 6. Machine Learning Populations & Targets

### 6.1 Delineation of Candidate Populations

To prevent mixing observed fills with hypothetical simulations, training populations are strictly segmented:

| Population Subset | Source Table | Criteria | Permitted Target |
| :--- | :--- | :--- | :--- |
| **Executed Trades Cohort** | `paper_trades` | Orders executed with verified fills | Observed realized net $R$ |
| **Counterfactual Cohort** | `candidate_decisions` | Eligible setups with verified executable depth/quotes | Modeled net return $\hat{R}_{\text{sim}}$ |
| **Invalid Counterfactuals** | `candidate_decisions` | Setups with stale quotes, wide spreads, or no fills | **Excluded from return targets** (never assigned $R=0$ or arbitrary loss) |

> [!IMPORTANT]
> **No Pooling Rule**: Actual paper-trade executions and simulated counterfactuals must not be pooled into a single unweighted training target unless the simulator is independently validated to reproduce observed executions with $< 0.05R$ mean tracking error.

### 6.2 Experiment Definitions

#### Experiment A: General Candidate Admission Model
* **Objective**: Estimate conditional expected net return to identify high-payoff candidates:
  $$\hat{\mu}(X) = \widehat{E\left[R_{\text{net}} \mid X\right]}$$
* **Secondary Classification Benchmark**:
  $$Y_{\text{adm}} = \mathbf{1}\left[R_{\text{net}} > 0\right]$$
* **Baselines**: Unconditional admission, trivial mean return, regularized linear regression.

#### Experiment B: Failure-Specific Adverse Risk Model
* **Objective**: Predict elevated probability of severe adverse excursion:
  $$Y_{\text{adverse}} = \mathbf{1}\left[\text{IMMEDIATE\_ADVERSE\_EXCURSION} \in \text{observedEvents}\right]$$
* **Action**: Acts as an advisory risk filter when predicted adverse probability exceeds a calibrated cutoff.

---

## 7. Promotion Gates, Statistical Standards & Validation Hierarchy

### 7.1 Validation Hierarchy

```text
1. Primary Promotion Test:
   Chronological Walk-Forward Validation (Expanding/Rolling)
   ├── Enforces historical ordering (train strictly before test)
   ├── Purged outcome horizons (removes overlapping trade durations)
   └── Minimum 1-session embargo at fold boundaries

2. Secondary Robustness Check:
   Combinatorial Purged Cross-Validation (CPCV)
   └── Evaluates path-distribution stability across permutations

3. Untouched Final Holdout:
   Chronologically last 20% of data reserved untouched.
   └── Zero feature tuning, threshold selection, or model tweaking permitted.
```

### 7.2 Gate Definitions (A through E)

```text
GATE A: Data & PIT Integrity
├── 100% adherence to 4-timestamp availability rule
└── Zero future leakage in query templates or feature inputs

GATE B: Label & Taxonomy Reliability
├── Deterministic MFE/MAE excursion math verified across 100% of historical trades
├── Trades with missing source data marked INSUFFICIENT_DATA (no fabricated zeros)
└── Explicit intrabarOrdering ambiguity flags persisted

GATE C: Retrieval Usefulness
├── Precision/recall evaluated on manually curated query-memory benchmark
└── HNSW recall >= 95% verified against exact brute-force vector scan

GATE D: Incremental Economic Value (Primary Research Gate)
├── Paired incremental net expectancy strictly positive:
│   ΔE = E[R_AEDLS, net] - E[R_baseline, net] > 0
├── 95% session-clustered bootstrap confidence interval: CI_lower > 0
├── Zero catastrophic folds across chronological walk-forward partitions
└── Realistic transaction costs (brokerage, exchange fees, STT, and slippage)

GATE E: Operational Shadow Promotion
├── Stable shadow execution (minimum 4 weeks and 100 candidate events)
├── Distribution shift stability (PSI < 0.1 across all primary features)
├── 100% reconciliation between shadow logs and frozen research artifacts
└── Documented rollback script and operator approval
```

### 7.3 Frozen Definition of a Catastrophic Fold
A candidate model fails Gate D if **any single walk-forward fold** breaches any of the following boundaries:
* Single-fold maximum drawdown $> 6.0R$.
* Single-fold net expectancy $< -0.15R$.
* Single-session loss concentration $> 50\%$ of the fold's total gross losses.
* *Note on sample size*: A fold with $< 40$ candidate setups is classified as `INCONCLUSIVE_INSUFFICIENT_SAMPLE`, which blocks promotion without labeling the model catastrophic.

### 7.4 Distribution Shift Standards (Gate E)
* **Population Stability Index (PSI)**:
  $$\text{PSI} = \sum_{k=1}^{10} \left(P_k - Q_k\right) \times \ln\left(\frac{P_k}{Q_k}\right) < 0.10$$
  Evaluated across 10 quantile-based reference bins with zero-frequency smoothing ($\epsilon = 10^{-4}$).
* Supplemented by Wasserstein distance monitoring. Insufficient sample size is treated as `INCONCLUSIVE`, never a stability pass.

---

## 8. Final Governance Invariants

1. **Zero Live Veto Authority**: `REJECTED_BY_ERROR_MODEL` remains an advisory diagnostic flag until formal promotion under Gate E.
2. **Current State Precedence**: A historical reflection cannot override a current structural price invalidation, order-book imbalance conflict, or hard risk limit.
3. **No Retrospective Mutation**: Updating a forensic review appends a new immutable row with its own `reviewAvailableAt` timestamp. Historical decisions remain evaluated against what was known at that exact moment.
4. **Independent Fallback**: An infrastructure failure in the embedding service or ML engine outputs `MODEL_UNAVAILABLE` and leaves execution to the independent risk engine.
