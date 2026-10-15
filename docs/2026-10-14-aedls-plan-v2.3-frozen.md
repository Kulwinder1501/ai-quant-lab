# Adaptive Error-Driven Learning System (AEDLS) Specification v2.3
## Final Frozen Architecture, Empirical Governance & Research Implementation Contract

**Document ID:** `AEDLS-SPEC-v2.3-FROZEN`  
**Freeze Date:** 2026-10-14  
**Status:** `RESEARCH & SHADOW APPROVED — LIVE TRADING VETO PROHIBITED`  
**Scope:** AI Autonomous Agent (`ai-autonomous-agent.ts`), Strategy Engine & Quantitative ML Pipelines (`apps/ml`)  
**Target Instruments:** NSE Index Derivatives (NIFTY 50 / BANKNIFTY)  
**Governance Authority:** Senior Quant Architecture Review Harmonization  

---

## 1. Executive Disposition & Phase Authorization Matrix

Following final Senior Quant Architecture Review harmonization, the Adaptive Error-Driven Learning System (AEDLS) specification is **formally approved and frozen for staged research implementation**.

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

## 2. Core Architecture: Physically Decoupled Execution & Shadow Paths

To prevent any possibility of AEDLS inadvertently acting as an operational gate before formal promotion, the runtime execution path is **physically decoupled** from the shadow evaluation path.

```text
========================================================================================
1. OPERATIONAL BASELINE EXECUTION PATH (Authoritative & Unmodified)
========================================================================================

Live / Paper Market Feed 
      │
      ▼
Candidate Setup Generated ───► Immutable Decision Snapshot Written to DB
      │                        (candidate_decisions table with decision_at)
      ▼
[ Hard Safety & Risk Engine ] ──► Authoritative Pass / Veto
      │
      ▼
Baseline Strategy Execution ───► Orders Routed to Paper / Shadow Broker
                                  (AEDLS has ZERO access to this path)

========================================================================================
2. AEDLS SHADOW EVALUATION PATH (Asynchronous & Advisory Only)
========================================================================================

candidate_decisions Event
      │
      ▼ (Asynchronous queue / event listener)
AEDLS Shadow Consumer
      ├─ 1. Query Embedder (Decision-time features only)
      ├─ 2. PIT Memory Retriever (Pre-filtered 4-timestamp query)
      ├─ 3. Meta-Model Evaluator (Offline trained risk model)
      │
      ▼
Emits Immutable ShadowRecommendationRecord to DB:
      ├── hypotheticalAdmissionDecision: "ADMIT" | "REJECT"
      ├── appliedConfidenceDelta: 0 (LOCKED at 0; no effect on live engine)
      ├── proposedConfidenceDelta: number | null
      └── reasonCodes: string[]
      (Written strictly to aedls_shadow_recommendations; no live routing)

========================================================================================
3. POST-TRADE FORENSIC DECOMPOSITION (T = review_available_at)
========================================================================================

Trade Closed at t_close
  └─► Forensic Engine (buildTradeReview) executes at t_review
        ├─ Calculates R_planned,₹, realizedGrossR, realizedNetR
        ├─ Measures MFE and MAE in normalized price excursion units
        ├─ Multi-label extraction: observedEvents[] (objective path events)
        ├─ Categorizes terminalOutcome (exit type) and reviewDataStatus
        ├─ Formulates causalHypothesis and assigns attributionStatus
        └─ Asynchronous Worker computes vector embedding at t_embedding
              └─► Persists immutable record to ai_journal_reflections
```

### The Three Independent Decisions
1. **Safety Decision (Execution & Risk Controls):** Hard execution boundaries (spread, stale feeds, broker downtime, risk caps). Enforced by the core risk engine. Candidates rejected here are preserved in the audit ledger but excluded from admission evaluation (AEDLS does not evaluate whether to override a hard safety cap).
2. **Admission Decision (AEDLS Meta-Policy):** Evaluates whether an approved, independently validated model or memory policy rejects the candidate. **In shadow mode, this is an advisory simulation emitting a recommendation record. Passing AEDLS never authorizes a trade; it only permits consideration.**
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

  // 3. Normalized risk and excursion metrics (Nullable if reviewDataStatus != 'COMPLETE')
  plannedRiskRupees: number;          // R_planned,₹ denominator
  realizedGrossRupees: number;        // Gross P&L in rupees
  realizedNetRupees: number;          // Net P&L in rupees after all costs
  realizedGrossR: number | null;      // realizedGrossRupees / plannedRiskRupees
  realizedNetR: number | null;        // realizedNetRupees / plannedRiskRupees
  maxFavourableExcursionR: number | null; // Price excursion magnitude / stop distance
  maxAdverseExcursionR: number | null;    // Price excursion magnitude / stop distance
  underlyingExcursionPoints: number | null;// Reference index move for options

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
  taxonomyVersion: "taxonomy-v2.3";
  reviewerVersion: "reviewer-v2.3";
  proposedResearchTags: string[];
}
```

### 3.2 Complete Position Risk Unit $R_{\text{planned,₹}}$ & Normalization Rules

1. **Planned Decision-Time Risk Unit ($R_{\text{planned,₹}}$)**:
   - Defined using the frozen decision-time reference prices, total planned units, and multipliers:
     $$R_{\text{planned,₹}} = \left|P_{\text{entry,decision}} - P_{\text{initial stop,decision}}\right| \times Q_{\text{units}} \times M$$
     where $Q_{\text{units}}$ is total planned quantity in underlying units/contracts, and $M$ is the contract multiplier. Avoid multiplying lot size twice.
2. **Realized Outcome Metrics**:
   - $\text{realizedGrossR} = \frac{\text{realizedGrossRupees}}{R_{\text{planned,₹}}}$
   - $\text{realizedNetR} = \frac{\text{realizedNetRupees}}{R_{\text{planned,₹}}}$ (accounting for brokerage, exchange fees, SEBI charges, GST, STT, and slippage).
3. **Excursion Sign & Scale Convention**:
   - $\text{MFE}$ and $\text{MAE}$ are strictly **non-negative magnitudes** measured in direction-adjusted price points relative to the stop distance:
     $$\text{MFE} = \frac{\max(\text{favorable excursion in points})}{\left|P_{\text{entry,decision}} - P_{\text{initial stop,decision}}\right|}, \quad \text{MAE} = \frac{\max(\text{adverse excursion in points})}{\left|P_{\text{entry,decision}} - P_{\text{initial stop,decision}}\right|}$$
   - **Mandatory Rule**: Conflating point excursion ratios with realized net rupee P&L ratios is strictly prohibited.
4. **Executable Mark Price Convention**:
   - Excursion and P&L mark-to-market calculations must use **executable bid prices for long liquidations** and **executable ask prices for short coverings**; midpoint or indicative spot prices are strictly prohibited for option execution evaluation.
5. **Event Measurement Windows**:
   - `IMMEDIATE_ADVERSE_EXCURSION`: Evaluated over the first **3 completed 1-minute bars** immediately following entry (excluding the entry bar).
   - `UNDERLYING_OPTION_PNL_DIVERGENCE`: Evaluated within the first **15 minutes** post-entry. Triggers if underlying index moves $\ge +0.05\%$ in favor while option bid premium $\le$ entry premium.
   - `EXCESSIVE_SPREAD_SLIPPAGE`: Bid-ask spread at fill + slippage $> 0.5R$. Tracked as entry friction and accounted for in net realized $R$, not double-counted.
6. **Intrabar Ambiguity Resolution**:
   - If an OHLC bar touches both stop and favorable thresholds without verified tick sequencing, mark `intrabarOrdering = "AMBIGUOUS"`. In outcome simulation, apply the conservative rule: **assume adverse excursion occurred first**. This is an execution rule, not asserted historical truth.

---

## 4. Strict Point-in-Time (PIT) Retrieval & Pre-Filtered Vector Correctness

### 4.1 SQL Retrieval Guard with Structural Pre-Filtering

To guarantee that structural compatibility is applied **before** result truncation (`LIMIT 10`), compatibility predicates are applied directly in SQL alongside the 4-timestamp availability guard:

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
  -- Structural Pre-Filtering (Applied BEFORE LIMIT):
  AND r.instrument_symbol = $3
  AND r.trade_side = $4
  AND r.setup_family = $5
  AND r.regime_class = $6
  AND 1 - (r.embedding <=> $1) >= $7 -- Calibrated similarity floor
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

> [!CRITICAL]
> **Query Invariant**: `$2` is the immutable **candidate decision timestamp**. Query embeddings must be generated using versioned templates (`query_template_version`) containing **only features known at $T_{\text{decision}}$**. A candidate's future outcome is **never** an input to retrieval.

### 4.2 Dual Failure vs Control Retrieval
To determine if a context is genuinely failure-prone rather than ubiquitous across all trades:
* The retriever executes **two separate queries**:
  1. **Failure Cohort**: Historical records with $R_{\text{net}} \le 0$ or specific observed failure events.
  2. **Control Cohort**: Comparable historical records with $R_{\text{net}} > 0$.
* The policy evaluates the contrast between failure similarity and control similarity before proposing a risk adjustment.

### 4.3 pgvector HNSW Recall Acceptance Standard
* **Version Requirement**: Pin `pgvector >= 0.8.0` with support for `hnsw.iterative_scan = strict_order`.
* **Exact-Scan Benchmark**: In Phase 2, benchmark HNSW recall@10 against brute-force sequential scans (`SET enable_indexscan = off`) across 500 test queries using identical pre-filters.
* **Transaction Isolation**: Per-query HNSW settings must use `SET LOCAL` inside transaction blocks to prevent polluting connection pools.
* **Acceptance Bar**: If HNSW achieves $< 95\%$ recall@10 against exact search at acceptable latency, exact retrieval must be used for production research; **relaxing PIT or structural filters to inflate result counts is strictly prohibited**.

---

## 5. Shadow-Mode Memory Policy & Deduplication

### 5.1 Memory Risk Assessment Interface

The shadow recommendation record is decoupled from operational execution:

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
* **Operational Fallback (`MODEL_UNAVAILABLE`)**: If the embedding model or vector store times out or fails, the system outputs `status: "MODEL_UNAVAILABLE"`. It logs the incident to `aedls_shadow_recommendations` and leaves the baseline strategy and risk engine completely unaffected. It never blocks trades and never acts as a veto.

---

## 6. Machine Learning Populations & Targets

### 6.1 Strict Cohort Segmentation (No Unvalidated Pooling)

To prevent mixing observed fills with hypothetical simulations, training populations are strictly segmented:

| Population Subset | Source Table | Criteria | Permitted Target |
| :--- | :--- | :--- | :--- |
| **Executed Trades Cohort** | `paper_trades` | Orders executed with verified fills | Observed realized net $R$ |
| **Counterfactual Cohort** | `candidate_decisions` | Eligible setups with verified executable depth/quotes | Modeled net return $\hat{R}_{\text{sim}}$ |
| **Invalid Counterfactuals** | `candidate_decisions` | Setups with stale quotes, wide spreads, or no fills | **Excluded from return targets** (never assigned $R=0$ or arbitrary loss) |

> [!CRITICAL]
> **No Unvalidated Pooling**: Executed trades and simulated counterfactuals must be maintained and analyzed as **separate cohorts**. They may not be pooled into a single unweighted target unless the simulator independently demonstrates:
> 1. Mean absolute tracking error $< 0.05R$.
> 2. Directional bias $|\text{mean error}| < 0.02R$.
> 3. Realistic queue priority and fill latency validation across all target instruments.

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

## 7. Promotion Gates, Statistical Standards & Policy Evaluation

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

### 7.2 Competing Policy Evaluation (Gate D)

A policy cannot appear superior simply by accepting fewer trades with a higher average $R$ per accepted trade. Evaluation must measure performance across the **common opportunity set**:

$$\Delta E_{\text{candidate}} = \frac{1}{N_{\text{candidates}}} \sum_{i=1}^{N_{\text{candidates}}} \left(R_{\text{AEDLS, net}, i} - R_{\text{baseline, net}, i}\right)$$

* **Skipped Candidates**: A candidate rejected by AEDLS that the baseline accepts contributes **$R = 0$ to the AEDLS portfolio** (freeing capital/risk budget), while the baseline realizes its actual net return.
* **Portfolio Metrics**: Must report both incremental net expectancy per eligible candidate ($\Delta E_{\text{candidate}}$) and aggregate portfolio net P&L after realistic costs.

### 7.3 Gate Definitions (A through E)

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
│   ΔE_candidate > 0 across common candidate opportunity set
├── 95% session-clustered bootstrap confidence interval: CI_lower > 0
├── Zero catastrophic folds across chronological walk-forward partitions
└── Realistic transaction costs (brokerage, exchange fees, STT, and slippage)

GATE E: Operational Shadow Promotion
├── Stable shadow execution (minimum 4 weeks and 100 candidate events)
├── Distribution shift stability (PSI < 0.1 across all primary features)
├── 100% reconciliation between shadow logs and frozen research artifacts
└── Documented rollback script and operator approval
```

### 7.4 Frozen Definition of a Catastrophic Fold
A candidate model fails Gate D if **any single walk-forward fold** breaches any of the following boundaries:
* Single-fold maximum drawdown $> 6.0R$.
* Single-fold net expectancy $< -0.15R$.
* Single-session loss concentration $> 50\%$ of the fold's total gross losses.
* *Note on sample size*: A fold with $< 40$ candidate setups is classified as `INCONCLUSIVE_INSUFFICIENT_SAMPLE`, which blocks promotion without labeling the model catastrophic.

### 7.5 Distribution Shift Standards (Gate E)
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
