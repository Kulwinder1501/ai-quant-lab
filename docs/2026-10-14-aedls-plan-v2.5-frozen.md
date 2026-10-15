# Adaptive Error-Driven Learning System (AEDLS) Specification v2.5
## Final Frozen Architecture & Research Implementation Contract

**Document ID:** `AEDLS-SPEC-v2.5-FROZEN-CONTRACT`  
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
| **Phase 4** | Quantitative Admission & Adverse-Risk Models | Offline ML (Walk-Forward / CPCV) | **Pending Dataset Readiness** |
| **Phase 5** | Operational Shadow Promotion Review | Advisory shadow logging | **Pending Gate D ($\Delta E > 0$)** |
| **Live Veto** | Runtime order blocking via `REJECTED_BY_ERROR_MODEL` | Hard trading veto | **STRICTLY PROHIBITED** |

---

## 2. Core Architecture: Physically Decoupled Execution & Shadow Paths

The operational baseline execution path and the AEDLS shadow evaluation path are strictly decoupled:

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
      ├─ 2. PIT Memory Retriever (Pre-filtered 4-timestamp query with Model Verification)
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
        ├─ Measures MAE_3, MFE_3, and lifetime excursions from actual fill P_entry,fill
        ├─ Multi-label extraction: observedEvents[] with per-event EventEvidenceStatus
        ├─ Categorizes terminalOutcome (exit type) and reviewDataStatus
        ├─ Formulates causalHypothesis (nullable) and assigns attributionStatus
        └─ Asynchronous Worker computes vector embedding at t_embedding
              └─► Persists immutable record to ai_journal_reflections
```

---

## 3. P0 Forensic Schema: Path Events, Terminal Outcomes & Risk Unit $R$

### 3.1 Per-Event Evidence Schema (`TradeFailureReview`)

To guarantee that evidence quality is tracked specifically for each event and that conservative simulation assumptions are never confused with verified historical facts:

```typescript
export type ObservedTradeEvent =
  | "IMMEDIATE_ADVERSE_EXCURSION"       // MAE_3 >= 1.0R and MFE_3 < 0.2R (First 3 completed bars)
  | "FAVORABLE_STALL_REVERSAL"          // MFE >= 1.0R followed by drawdown to initial stop
  | "UNDERLYING_OPTION_PNL_DIVERGENCE"  // Directional spot >= 0.05% in favor, Option bid P&L <= 0
  | "EXCESSIVE_SPREAD_SLIPPAGE";        // Measured friction in rupees / R_planned,₹ > 0.5R

export type TerminalTradeOutcome =
  | "STOP_LOSS"
  | "TARGET"
  | "TIMEOUT"
  | "MANUAL_EXIT"
  | "OTHER";

export type EventEvidenceStatus =
  | "TICK_VERIFIED"           // Verified from complete trade/tick sequence
  | "BAR_DERIVED_UNAMBIGUOUS" // Single extreme reached on bar; ordering mathematically unambiguous
  | "INTRABAR_AMBIGUOUS"      // Both thresholds touched within same bar; ordering unproven
  | "INSUFFICIENT_DATA";      // Missing bars or truncated tape during the event window

export type ReviewDataStatus =
  | "COMPLETE"           // Verified holding-period tick/candle data
  | "INSUFFICIENT_DATA"   // Missing bars or truncated tape; excursions set to null
  | "CONFLICTING_DATA";   // Timestamp anomalies or contradictory prices

export interface ObservedEventEvidence {
  event: ObservedTradeEvent;
  evidenceStatus: EventEvidenceStatus;
  eventWindowStart: string;   // ISO-8601 timestamp
  eventWindowEnd: string;     // ISO-8601 timestamp
  evidenceReferences: string[];
}

export interface TradeFailureReview {
  tradeId: string;
  candidateId: string;

  // 1. Objective measured path events with per-event evidence status
  observedEvents: ObservedEventEvidence[];
  primaryObservedEvent: ObservedTradeEvent | null; // Nullable; chosen by deterministic priority

  // 2. Terminal exit classification
  terminalOutcome: TerminalTradeOutcome;
  reviewDataStatus: ReviewDataStatus;

  // 3. Normalized risk and excursion metrics (Nullable if reviewDataStatus != 'COMPLETE')
  plannedRiskRupees: number;          // R_planned,₹ denominator
  realizedGrossRupees: number;        // Gross P&L in rupees
  realizedNetRupees: number;          // Net P&L in rupees after all costs
  realizedGrossR: number | null;      // realizedGrossRupees / plannedRiskRupees
  realizedNetR: number | null;        // realizedNetRupees / plannedRiskRupees
  
  // Excursions from P_entry,fill normalized by frozen initial stop distance
  mae3BarsR: number | null;           // MAE over first 3 completed bars post-entry
  mfe3BarsR: number | null;           // MFE over first 3 completed bars post-entry
  maxFavourableExcursionR: number | null; // Lifetime MFE
  maxAdverseExcursionR: number | null;    // Lifetime MAE
  underlyingExcursionPoints: number | null;// Reference index move for options

  // 4. Falsifiable causal hypotheses (EXPLICITLY NULLABLE)
  causalHypothesis:
    | "OPPOSING_ORDER_FLOW"
    | "VOLATILITY_CRUSH_VEGA"
    | "LIQUIDITY_VACUUM_SLIP"
    | "COUNTER_DRIVER_TAPE"
    | "UNATTRIBUTED_MARKET_VARIANCE"
    | null;

  attributionStatus: "SUPPORTED" | "REFUTED" | "UNKNOWN";

  // 5. Exact availability timestamps (Strict 4-Timestamp PIT Contract)
  tradeClosedAt: string;              // ISO-8601 when position closed
  evidenceAvailableAt: string;       // ISO-8601 when holding-period tick/bar tape settled
  reviewAvailableAt: string;         // ISO-8601 when review calculation completed
  embeddingAvailableAt: string | null;// ISO-8601 when vector was written

  // 6. Embedding Provenance Metadata
  embeddingModelId: string;          // e.g. "Xenova/all-MiniLM-L6-v2"
  embeddingModelRevision: string;    // e.g. "commit-hash-or-semver"
  embeddingDim: 384;
  queryTemplateVersion: string;      // e.g. "query-v2.5"

  // 7. Versioning & Provenance
  taxonomyVersion: "taxonomy-v2.5";
  reviewerVersion: "reviewer-v2.5";
  proposedResearchTags: string[];
}
```

### 3.2 Deterministic Primary Event Priority Rule
When multiple events coexist, select `primaryObservedEvent` using this deterministic ordering:
1. `IMMEDIATE_ADVERSE_EXCURSION` (highest severity initial path failure)
2. `UNDERLYING_OPTION_PNL_DIVERGENCE` (immediate execution/pricing divergence)
3. `FAVORABLE_STALL_REVERSAL` (subsequent trajectory failure after favorable run)
4. `EXCESSIVE_SPREAD_SLIPPAGE` (execution cost friction failure)
*If no registered path event occurred, `primaryObservedEvent = null`.*

### 3.3 Frozen Event Windows, Units & Measurement Rules

1. **`IMMEDIATE_ADVERSE_EXCURSION`**:
   - Evaluated strictly using $MAE_3$ and $MFE_3$ over the **first 3 completed 1-minute bars post-entry** (excluding the entry bar):
     $$MAE_3 \ge 1.0R \quad \land \quad MFE_3 < 0.2R$$
   - **Mandatory Invariant**: Never substitute lifetime MFE for $MFE_3$.
2. **`UNDERLYING_OPTION_PNL_DIVERGENCE`**:
   - Scope: **Restricted exclusively to long option buyer trades** (`isOptionBuyerTrade === true`).
   - Directional Underlying Move: For Long Call, spot moved up $\ge +0.05\%$; for Long Put, spot moved down $\ge -0.05\%$.
   - Option Valuation: Compares executable bid liquidation price with actual entry fill price within the first **15 minutes** post-entry.
3. **`EXCESSIVE_SPREAD_SLIPPAGE`**:
   - Evaluated as total measured entry friction in rupees (spread at fill + execution slippage) divided by planned risk in rupees:
     $$\frac{\text{frictionRupees}}{R_{\text{planned,₹}}} > 0.5R$$
   - Tracked as entry friction and accounted for in net realized $R$, not double-counted.
4. **Planned Risk Unit ($R_{\text{planned,₹}}$)**:
   $$R_{\text{planned,₹}} = \left|P_{\text{entry,decision}} - P_{\text{initial stop,decision}}\right| \times Q_{\text{units}} \times M$$
   where $Q_{\text{units}}$ is total planned quantity in underlying units/contracts, and $M$ is the contract multiplier. Avoid multiplying lot size twice.
5. **Verified Negative Controls**:
   - In Experiment B, an event-negative control requires that the entire 3-bar window has `evidenceStatus = "COMPLETE"` with verified absence of the event. Missing bars cannot be treated as event absence.

---

## 4. Strict Point-in-Time (PIT) Retrieval & Pre-Filtered Vector Correctness

### 4.1 SQL Retrieval Guard with Model Verification & Pre-Filtering

To prevent vector space distortion, the retrieval query enforces **embedding model identity** and applies structural and cohort filters **before result truncation (`LIMIT 10`)**:

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
  -- Embedding Model Compatibility Guard:
  AND r.embedding_model_id = $3
  AND r.embedding_model_revision = $4
  AND r.embedding_dim = 384
  -- Structural Pre-Filtering (Applied BEFORE LIMIT):
  AND r.instrument_symbol = $5
  AND r.trade_side = $6
  AND r.setup_family = $7
  AND r.regime_class = $8
  -- Cohort Filter (Applied BEFORE LIMIT):
  -- For Failure Query: AND r.realized_net_r <= 0 (or target failure event present)
  -- For Control Query: AND r.realized_net_r > 0
  AND 1 - (r.embedding <=> $1) >= $9 -- Calibrated similarity floor
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

> [!CRITICAL]
> **Query Invariant**: `$2` is the immutable **candidate decision timestamp**. Query embeddings must be generated using versioned templates (`query_template_version`) containing **only features known at $T_{\text{decision}}$**. A candidate's future outcome is **never** an input to retrieval.

### 4.2 pgvector HNSW Recall Acceptance Standard
* **Version Requirement**: Pin `pgvector >= 0.8.0` with support for `hnsw.iterative_scan = strict_order`.
* **Exact-Scan Benchmark**: In Phase 2, benchmark HNSW recall@10 against brute-force sequential scans (`SET enable_indexscan = off`) across 500 test queries using identical pre-filters.
* **Recall@10 Definition**:
  $$\text{Recall}@10 = \frac{\left|\text{HNSW}_{10} \cap \text{Exact}_{10}\right|}{\min\left(10, \left|\text{Eligible Records}\right|\right)}$$
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
> **No Unvalidated Pooling**: Executed trades and simulated counterfactuals must be maintained and analyzed as **separate cohorts**. They may not be pooled into a single unweighted target unless the simulator independently demonstrates tracking error $< 0.05R$, directional bias $< 0.02R$, and realistic fill validation across all instruments.

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
* **Action**: Acts as an advisory risk filter when predicted adverse probability exceeds a calibrated cutoff. Only trains on records with `evidenceStatus IN ('TICK_VERIFIED', 'BAR_DERIVED_UNAMBIGUOUS')`.

---

## 7. Promotion Gates, Statistical Standards & Policy Evaluation

### 7.1 Validation Hierarchy & Holdout Reserve

```text
1. Development & Parameter Calibration Period:
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

* **Evaluation Population**: Frozen strictly as **candidates the baseline strategy would otherwise admit after independent safety and risk checks** ($N_{\text{baseline\_admitted}}$). AEDLS may simulate rejecting those candidates, but cannot introduce new trades.
* **Policy Incremental Net Expectancy**:
  $$\Delta E_{\text{candidate}} = \frac{1}{N_{\text{baseline\_admitted}}} \sum_{i=1}^{N_{\text{baseline\_admitted}}} \left(R_{\text{AEDLS, net}, i} - R_{\text{baseline, net}, i}\right)$$
* **Skipped Candidates**: A candidate rejected by AEDLS that the baseline accepts contributes **$R = 0$ to the AEDLS portfolio** (freeing capital/risk budget), while the baseline realizes its net return.
* **Freed Risk Budget Accounting**: Primary evaluation assumes **no reallocation** (freed capital remains unallocated cash / zero risk).

### 7.3 Model Outcome Classification Matrix

| Outcome Classification | Statistical & Empirical Criteria | Next Action |
| :--- | :--- | :--- |
| **`MODEL_SUCCESS`** | Passes Gate D ($\Delta E > 0$ with 95% bootstrap $\text{CI}_{\text{lower}} > 0$ after costs) | Advances to Gate E Shadow Observation |
| **`MODEL_INCONCLUSIVE`** | Effective $N < 40$ in any fold, or 95% bootstrap CI spans zero | Remains exploratory; no promotion |
| **`MODEL_FAILED`** | Single-fold drawdown $> 6.0R$, expectancy $< -0.15R$, or single-session loss concentration $> 50\%$ | Rejected; redesign required |
| **`AWAITING_APPROVAL`** | Completed Gate E shadow observation (4 weeks / 100 events, PSI $< 0.10$) | Operator promotion review |

### 7.4 Gate Definitions (A through E)

```text
GATE A: Data & PIT Integrity
├── 100% adherence to 4-timestamp availability rule
└── Zero future leakage in query templates or feature inputs

GATE B: Label & Taxonomy Reliability
├── Deterministic MFE/MAE excursion math verified across 100% of historical trades
├── Verified per-event EventEvidenceStatus with strict negative control verification
└── Explicit intrabarOrdering ambiguity flags persisted

GATE C: Retrieval Usefulness
├── Precision/recall evaluated on manually curated query-memory benchmark
└── HNSW Recall@10 >= 95% verified against exact brute-force vector scan

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

---

## 8. Final Governance Invariants

1. **Zero Live Veto Authority**: `REJECTED_BY_ERROR_MODEL` remains an advisory diagnostic flag until formal promotion under Gate E.
2. **Current State Precedence**: A historical reflection cannot override a current structural price invalidation, order-book imbalance conflict, or hard risk limit.
3. **No Retrospective Mutation**: Updating a forensic review appends a new immutable row with its own `reviewAvailableAt` timestamp. Historical decisions remain evaluated against what was known at that exact moment.
4. **Independent Fallback**: An infrastructure failure in the embedding service or ML engine outputs `MODEL_UNAVAILABLE` and leaves execution to the independent risk engine.
