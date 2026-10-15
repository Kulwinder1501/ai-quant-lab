# Adaptive Error-Driven Learning System (AEDLS) Specification v2.7
## Final Frozen Architecture & Research Implementation Contract

**Document ID:** `AEDLS-SPEC-v2.7-FROZEN-CONTRACT`  
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
| **Phase 0** | Baseline Audit, Authority Map & Candidate Inventory | Read-only codebase & database audit | **APPROVED / GO** |
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
      ├─ 1. Query Embedder (candidateQueryTemplateVersion + decision-time features only)
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
        ├─ Evaluates outcomeValidity vs excursionValidity independently
        ├─ Measures MAE_3, MFE_3, and lifetime excursions from actual fill P_entry,fill
        ├─ Multi-label extraction: observedEvents[] (objective path events)
        ├─ Target assessment: targetAssessments[] (POSITIVE, NEGATIVE, UNOBSERVABLE)
        ├─ Categorizes terminalOutcome (exit type)
        ├─ Formulates causalHypothesis (nullable) and assigns attributionStatus
        └─ Asynchronous Worker computes vector embedding at t_embedding via @huggingface/transformers
              └─► Persists immutable record to ai_journal_reflections
```

---

## 3. P0 Forensic Schema: Path Events, Terminal Outcomes & Risk Unit $R$

### 3.1 Forensic Review Schema (`TradeFailureReview`)

To guarantee that positive events, verified negative controls, and unobservable records are cleanly distinguished:

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

export type OutcomeValidity =
  | "VALID_RECONCILED"        // Realized gross/net P&L, fills and costs fully reconciled
  | "COSTS_UNRECONCILED"      // Brokerage/charges pending reconciliation
  | "INSUFFICIENT_FILL_DATA"; // Truncated execution fills

export type ExcursionValidity =
  | "COMPLETE"                // Verified holding-period tick/candle data
  | "INSUFFICIENT_DATA"        // Missing bars or truncated tape; excursions set to null
  | "CONFLICTING_DATA";        // Timestamp anomalies or contradictory prices

export interface ObservedEventEvidence {
  event: ObservedTradeEvent;
  evidenceStatus: EventEvidenceStatus;
  eventWindowStart: string;   // ISO-8601 timestamp
  eventWindowEnd: string;     // ISO-8601 timestamp
  evidenceReferences: string[];
}

export interface EventTargetAssessment {
  targetEvent: ObservedTradeEvent;
  label: "POSITIVE" | "NEGATIVE" | "UNOBSERVABLE";
  evidenceStatus: EventEvidenceStatus;
  windowStart: string;
  windowEnd: string;
  evidenceReferences: string[];
}

export interface TradeFailureReview {
  tradeId: string;
  candidateId: string;

  // 1. Detected path events (multi-label) & Supervised Training Target Assessments
  observedEvents: ObservedEventEvidence[];
  targetAssessments: EventTargetAssessment[];
  primaryObservedEvent: ObservedTradeEvent | null; // Nullable; chosen by deterministic priority

  // 2. Terminal exit classification & Independent Validity Flags
  terminalOutcome: TerminalTradeOutcome;
  outcomeValidity: OutcomeValidity;
  excursionValidity: ExcursionValidity;

  // 3. Normalized risk and excursion metrics
  plannedRiskRupees: number;          // R_planned,₹ denominator
  realizedGrossRupees: number | null; // Nullable if outcomeValidity != 'VALID_RECONCILED'
  realizedNetRupees: number | null;   // Nullable if outcomeValidity != 'VALID_RECONCILED'
  realizedGrossR: number | null;      // realizedGrossRupees / plannedRiskRupees
  realizedNetR: number | null;        // realizedNetRupees / plannedRiskRupees
  
  // Excursions from P_entry,fill (Nullable if excursionValidity != 'COMPLETE')
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

  // 6. Embedding Provenance Metadata (Review Side via @huggingface/transformers)
  reviewEmbeddingTemplateVersion: string; // e.g. "review-template-v2.7"
  embeddingModelId: string;               // e.g. "Xenova/all-MiniLM-L6-v2"
  embeddingModelRevision: string;         // pinned git commit hash
  embeddingConfigHash: string;            // SHA-256 of preprocessing/pooling params
  embeddingDim: 384;

  // 7. Versioning & Provenance
  taxonomyVersion: "taxonomy-v2.7";
  reviewerVersion: "reviewer-v2.7";
  proposedResearchTags: string[];
}
```

### 3.2 Rules for Target Assessments & Intrabar Ambiguity Invariant

For any supervised target event (principally `IMMEDIATE_ADVERSE_EXCURSION`):
* **`POSITIVE`**: Admissible evidence (`TICK_VERIFIED` or `BAR_DERIVED_UNAMBIGUOUS`) confirms $MAE_3 \ge 1.0R$ and $MFE_3 < 0.2R$.
* **`NEGATIVE`**: The complete registered 3-bar observation window is available (`excursionValidity = "COMPLETE"`) and confirms $MAE_3 < 1.0R$ or $MFE_3 \ge 0.2R$.
* **`UNOBSERVABLE`**: Missing candles, truncated tape (`excursionValidity = "INSUFFICIENT_DATA"`), or unresolved intrabar ambiguity (`evidenceStatus = "INTRABAR_AMBIGUOUS"`).

> [!CRITICAL]
> **P0.3 Intrabar Ambiguity vs Target-Label Invariant**:
> If an OHLC bar touches both $1.0R$ adverse and $0.2R$ favorable thresholds and sub-bar tick ordering is unproven, the target assessment **MUST be labeled `UNOBSERVABLE`**.
> Conservative execution simulation assumptions (e.g. assuming the adverse threshold hit first for worst-case backtesting) **must NEVER convert ambiguous observations into verified `POSITIVE` ground truth training labels**.
> Supervised classification models for Experiment B train strictly on verified `POSITIVE` and verified `NEGATIVE` records. Training on `UNOBSERVABLE` records is strictly prohibited.

### 3.3 Deterministic Primary Event Priority Rule
When multiple events coexist, select `primaryObservedEvent` using this deterministic ordering:
1. `IMMEDIATE_ADVERSE_EXCURSION` (highest severity initial path failure)
2. `UNDERLYING_OPTION_PNL_DIVERGENCE` (immediate execution/pricing divergence)
3. `FAVORABLE_STALL_REVERSAL` (subsequent trajectory failure after favorable run)
4. `EXCESSIVE_SPREAD_SLIPPAGE` (execution cost friction failure)
*If no registered path event occurred, `primaryObservedEvent = null`.*

### 3.4 Frozen Event Windows & Synchronized Option Alignment

1. **`IMMEDIATE_ADVERSE_EXCURSION`**:
   - Evaluated strictly using $MAE_3$ and $MFE_3$ over the **first 3 completed 1-minute bars post-entry** (excluding the entry bar):
     $$MAE_3 \ge 1.0R \quad \land \quad MFE_3 < 0.2R$$
   - Lifetime excursions ($MFE_{\text{lifetime}}$, $MAE_{\text{lifetime}}$) are tracked separately and can never be substituted for $MFE_3$.
2. **`UNDERLYING_OPTION_PNL_DIVERGENCE`**:
   - Scope: **Restricted exclusively to long option buyer trades** (`isOptionBuyerTrade === true`).
   - Directional Underlying Move: For Long Call, spot moved up $\ge +0.05\%$; for Long Put, spot moved down $\ge -0.05\%$.
   - **Synchronized Observation Rule**: Both the directional underlying threshold and the option bid liquidation condition (bid premium $\le$ entry fill) must hold at the **same observation timestamp** within the first **15 minutes** post-entry.
3. **`EXCESSIVE_SPREAD_SLIPPAGE`**:
   - Evaluated as total measured entry friction in rupees (spread at fill + execution slippage) divided by planned risk in rupees:
     $$\frac{\text{frictionRupees}}{R_{\text{planned,₹}}} > 0.5R$$
   - Tracked as entry friction and accounted for in net realized $R$, not double-counted.
4. **Planned Risk Unit ($R_{\text{planned,₹}}$)**:
   $$R_{\text{planned,₹}} = \left|P_{\text{entry,decision}} - P_{\text{initial stop,decision}}\right| \times Q_{\text{units}} \times M$$
   where $Q_{\text{units}}$ is total planned quantity in underlying units/contracts, and $M$ is the contract multiplier. Avoid multiplying lot size twice.

---

## 4. Strict Point-in-Time (PIT) Retrieval & Pre-Filtered Vector Correctness

### 4.1 Executable SQL Cohort Queries

To evaluate failure-specific risk and general profitability without cohort contamination, two distinct query families are frozen into active, executable SQL blocks:

#### Query Family 1: Failure-Risk Diagnostics (Experiment B)

##### Query 1A: Event-Positive (IMMEDIATE_ADVERSE_EXCURSION Failure Instances)
```sql
-- Must execute inside a transaction block with SET LOCAL for pooled connections:
-- SET LOCAL hnsw.ef_search = 100;
-- SET LOCAL hnsw.iterative_scan = strict_order;

SELECT 
    r.id,
    r.trade_id,
    r.target_assessments,
    r.structural_context,
    1 - (r.embedding <=> $1) AS semantic_similarity
FROM ai_journal_reflections r
WHERE r.trade_closed_at < $2
  AND r.evidence_available_at < $2
  AND r.review_available_at < $2
  AND r.embedding_available_at < $2
  AND r.embedding IS NOT NULL
  -- Embedding Provenance Compatibility Guard:
  AND r.embedding_model_id = $3
  AND r.embedding_model_revision = $4
  AND r.embedding_config_hash = $5
  AND r.embedding_dim = 384
  -- Structural Pre-Filtering (Applied BEFORE ORDER BY and LIMIT):
  AND r.instrument_symbol = $6
  AND r.trade_side = $7
  AND r.setup_family = $8
  AND r.regime_class = $9
  -- Active Executable Cohort Filter with Admissible Evidence Enforcement:
  AND (
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "POSITIVE", "evidenceStatus": "TICK_VERIFIED"}]'::jsonb
    OR
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "POSITIVE", "evidenceStatus": "BAR_DERIVED_UNAMBIGUOUS"}]'::jsonb
  )
  AND 1 - (r.embedding <=> $1) >= $10 -- Calibrated similarity floor
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

##### Query 1B: Event-Negative Control (Verified Non-Failure Setups)
```sql
SELECT 
    r.id,
    r.trade_id,
    r.target_assessments,
    r.structural_context,
    1 - (r.embedding <=> $1) AS semantic_similarity
FROM ai_journal_reflections r
WHERE r.trade_closed_at < $2
  AND r.evidence_available_at < $2
  AND r.review_available_at < $2
  AND r.embedding_available_at < $2
  AND r.embedding IS NOT NULL
  AND r.embedding_model_id = $3
  AND r.embedding_model_revision = $4
  AND r.embedding_config_hash = $5
  AND r.embedding_dim = 384
  AND r.instrument_symbol = $6
  AND r.trade_side = $7
  AND r.setup_family = $8
  AND r.regime_class = $9
  -- Active Executable Cohort Filter with Admissible Evidence Enforcement:
  AND (
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "NEGATIVE", "evidenceStatus": "TICK_VERIFIED"}]'::jsonb
    OR
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "NEGATIVE", "evidenceStatus": "BAR_DERIVED_UNAMBIGUOUS"}]'::jsonb
  )
  AND 1 - (r.embedding <=> $1) >= $10
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

#### Query Family 2: General Return Diagnostics (Experiment A)

##### Query 2A: Profitable Setup Cohort
```sql
SELECT 
    r.id,
    r.trade_id,
    r.realized_net_r,
    r.structural_context,
    1 - (r.embedding <=> $1) AS semantic_similarity
FROM ai_journal_reflections r
WHERE r.trade_closed_at < $2
  AND r.evidence_available_at < $2
  AND r.review_available_at < $2
  AND r.embedding_available_at < $2
  AND r.outcome_validity = 'VALID_RECONCILED'
  -- Active Executable Return Predicate:
  AND r.realized_net_r > 0
  AND r.embedding IS NOT NULL
  AND r.embedding_model_id = $3
  AND r.embedding_model_revision = $4
  AND r.embedding_config_hash = $5
  AND r.embedding_dim = 384
  AND r.instrument_symbol = $6
  AND r.trade_side = $7
  AND r.setup_family = $8
  AND r.regime_class = $9
  AND 1 - (r.embedding <=> $1) >= $10
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

##### Query 2B: Unprofitable Setup Cohort
```sql
SELECT 
    r.id,
    r.trade_id,
    r.realized_net_r,
    r.structural_context,
    1 - (r.embedding <=> $1) AS semantic_similarity
FROM ai_journal_reflections r
WHERE r.trade_closed_at < $2
  AND r.evidence_available_at < $2
  AND r.review_available_at < $2
  AND r.embedding_available_at < $2
  AND r.outcome_validity = 'VALID_RECONCILED'
  -- Active Executable Return Predicate:
  AND r.realized_net_r <= 0
  AND r.embedding IS NOT NULL
  AND r.embedding_model_id = $3
  AND r.embedding_model_revision = $4
  AND r.embedding_config_hash = $5
  AND r.embedding_dim = 384
  AND r.instrument_symbol = $6
  AND r.trade_side = $7
  AND r.setup_family = $8
  AND r.regime_class = $9
  AND 1 - (r.embedding <=> $1) >= $10
ORDER BY r.embedding <=> $1 ASC
LIMIT 10;
```

> [!CRITICAL]
> **Pre-Filter and PIT Invariants**:
> 1. `$2` is the immutable **candidate decision timestamp**. Query embeddings must be generated using `candidateQueryTemplateVersion` containing **only features known at $T_{\text{decision}}$**. A candidate's future outcome is **never** an input to retrieval.
> 2. All filters (PIT 4-timestamps, embedding provenance, structural pre-filters, cohort predicates, and similarity floor) execute **prior to the `ORDER BY ... LIMIT 10` clause**.
> 3. The exact sequential benchmark (`SET enable_indexscan = off`) must evaluate the **exact same SQL predicates** against the identical eligible candidate population.

### 4.2 pgvector HNSW Recall Acceptance Standard
* **Version Requirement**: Pin `pgvector >= 0.8.0` with support for `hnsw.iterative_scan = strict_order`.
* **Exact-Scan Benchmark**: In Phase 2, benchmark HNSW recall@10 against brute-force sequential scans (`SET enable_indexscan = off`) across 500 test queries using identical pre-filters and identical cohort populations.
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

  // Candidate query provenance (via @huggingface/transformers)
  candidateQueryTemplateVersion: string; // e.g. "candidate-query-v2.7"
  embeddingModelId: string;              // e.g. "Xenova/all-MiniLM-L6-v2"
  embeddingModelRevision: string;        // pinned commit hash
  embeddingConfigHash: string;
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
  $$Y_{\text{adverse}} = \mathbf{1}\left[\text{label} = \text{"POSITIVE"} \text{ in targetAssessments for IMMEDIATE\_ADVERSE\_EXCURSION}\right]$$
* **Action**: Acts as an advisory risk filter when predicted adverse probability exceeds a calibrated cutoff. Only trains on records with `label IN ('POSITIVE', 'NEGATIVE')`.

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

Evaluation must measure performance across the **common opportunity set**:

* **Evaluation Population**: Frozen strictly as **candidates the baseline strategy would otherwise admit after independent safety and risk checks** ($N_{\text{baseline\_admitted}}$). AEDLS may simulate rejecting those candidates, but cannot introduce new trades.
* **Policy Incremental Net Expectancy**:
  $$\Delta E_{\text{candidate}} = \frac{1}{N_{\text{baseline\_admitted}}} \sum_{i=1}^{N_{\text{baseline\_admitted}}} \left(R_{\text{AEDLS, net}, i} - R_{\text{baseline, net}, i}\right)$$
* **Skipped Candidates**: A candidate rejected by AEDLS that the baseline accepts contributes **$R = 0$ to the AEDLS portfolio** (freeing capital/risk budget), while the baseline realizes its net return.
* **Freed Risk Budget Accounting**: Primary evaluation assumes **no reallocation** (freed capital remains unallocated cash / zero risk).

### 7.3 Model Outcome Classification Matrix

| Outcome Classification | Statistical & Empirical Criteria | Next Action |
| :--- | :--- | :--- |
| **`MODEL_SUCCESS`** | Passes Gate D ($\Delta E > 0$ with 95% bootstrap $\text{CI}_{\text{lower}} > 0$ after costs) and zero catastrophic folds | Advances to Gate E Shadow Observation |
| **`INCONCLUSIVE_INSUFFICIENT_SAMPLE`** | Effective candidate sample $N < 40$ in any single fold | Blocks promotion; model remains exploratory without being marked failed |
| **`MODEL_FAILED`** | ANY single fold breaches catastrophic limits (Max DD $> 6.0R$, Net Exp $< -0.15R$, or Session Loss $> 50\%$) | Rejected; architectural or feature redesign required |
| **`AWAITING_APPROVAL`** | Completed Gate E shadow observation (4 weeks / 100 events, PSI $< 0.10$) | Operator promotion review |

### 7.4 Gate Definitions (A through E)

```text
GATE A: Data & PIT Integrity
├── 100% adherence to 4-timestamp availability rule
└── Zero future leakage in query templates or feature inputs

GATE B: Label & Taxonomy Reliability
├── Deterministic MFE/MAE excursion math verified across 100% of historical trades
├── Explicit outcomeValidity vs excursionValidity separation
├── Target assessments record verified POSITIVE and verified NEGATIVE controls
└── Intrabar ambiguity flagged as UNOBSERVABLE (never assumed as ground truth)

GATE C: Retrieval Usefulness
├── Precision/recall evaluated on manually curated query-memory benchmark
└── HNSW Recall@10 >= 95% verified against exact brute-force vector scan

GATE D: Incremental Economic Value (Primary Research Gate)
├── Paired incremental net expectancy strictly positive:
│   ΔE_candidate > 0 across common candidate opportunity set
├── 95% session-clustered bootstrap confidence interval: CI_lower > 0
├── Zero catastrophic folds across chronological walk-forward partitions (see limits below)
└── Realistic transaction costs (brokerage, exchange fees, STT, and slippage)

GATE E: Operational Shadow Promotion
├── Stable shadow execution (minimum 4 weeks and 100 candidate events)
├── Distribution shift stability (PSI < 0.1 across all primary features)
├── 100% reconciliation between shadow logs and frozen research artifacts
└── Documented rollback script and operator approval
```

#### Catastrophic Fold Thresholds Table (Gate D Boundary Conditions)

| Metric | Catastrophic Failure Threshold | Rationale & Impact |
| :--- | :--- | :--- |
| **Single-Fold Max Drawdown** | $> 6.0R$ | Unacceptable tail loss in non-stationary regime; triggers `MODEL_FAILED` |
| **Single-Fold Net Expectancy** | $< -0.15R$ | Severe negative drift undermining baseline edge; triggers `MODEL_FAILED` |
| **Single-Session Loss Concentration** | $> 50\%$ of gross fold loss | Vulnerability to clustered intraday regime shocks; triggers `MODEL_FAILED` |
| **Minimum Fold Candidate Sample** | $< 40$ candidates | Deemed `INCONCLUSIVE_INSUFFICIENT_SAMPLE`; blocks promotion without marking failure |

---

## 8. Embedding Pipeline Specification: `@huggingface/transformers`

For zero runtime python dependency during API ingestion and PIT query generation:
1. **Runtime Package**: `@huggingface/transformers` (pure JavaScript/WASM/ONNX runtime running locally inside the Node.js/TypeScript API process).
2. **Model**: `sentence-transformers/all-MiniLM-L6-v2` (or `Xenova/all-MiniLM-L6-v2`), revision pinned by SHA commit hash.
3. **Dimensions**: 384 dimensions (`vector(384)` in pgvector).
4. **Reproducibility**: Mean-pooling with normalized unit embeddings ($L_2$ norm = 1.0).
5. **Cold Start & Latency**: Pre-warmed model pipeline with inference budget $\le 50\,\text{ms}$ per candidate query vector.

---

## 9. Final Governance Invariants

1. **Zero Live Veto Authority**: `REJECTED_BY_ERROR_MODEL` remains an advisory diagnostic flag until formal promotion under Gate E.
2. **Current State Precedence**: A historical reflection cannot override a current structural price invalidation, order-book imbalance conflict, or hard risk limit.
3. **No Retrospective Mutation**: Updating a forensic review appends a new immutable row with its own `reviewAvailableAt` timestamp. Historical decisions remain evaluated against what was known at that exact moment.
4. **Independent Fallback**: An infrastructure failure in the embedding service or ML engine outputs `MODEL_UNAVAILABLE` and leaves execution to the independent risk engine.

---

## 10. Amendment 1: Implementation Contract Amendments (Senior Quant Harmonization)

The following four binding amendments govern the Phase 0–2 implementation:

### 10.1 Admissible Evidence Status in SQL Cohort Queries (P0.1)
The executable SQL queries must independently enforce verified evidence status inside JSONB predicates:
* **Event-Positive Cohort**:
  ```sql
  AND (
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "POSITIVE", "evidenceStatus": "TICK_VERIFIED"}]'::jsonb
    OR
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "POSITIVE", "evidenceStatus": "BAR_DERIVED_UNAMBIGUOUS"}]'::jsonb
  )
  ```
* **Event-Negative Control Cohort**:
  ```sql
  AND (
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "NEGATIVE", "evidenceStatus": "TICK_VERIFIED"}]'::jsonb
    OR
    r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "NEGATIVE", "evidenceStatus": "BAR_DERIVED_UNAMBIGUOUS"}]'::jsonb
  )
  ```
* Records with `evidenceStatus = 'INTRABAR_AMBIGUOUS'` or `label = 'UNOBSERVABLE'` are mathematically excluded from both positive and negative training sets and retrieval cohorts.

### 10.2 Precedence Rule: Minimum Sample vs Catastrophic Risk Breaches (P0.2)
1. Any fold with fewer than 40 candidates ($N < 40$) is classified `INCONCLUSIVE_INSUFFICIENT_SAMPLE`.
2. A model **cannot pass Gate D** while any fold remains inconclusive.
3. Insufficiency of data is strictly recorded as lack of statistical power, not empirical proof that the model is flawed.
4. If an under-sampled fold ($N < 40$) also breaches a hard catastrophic risk limit (e.g. Drawdown $> 6.0R$), it is classified as `INSUFFICIENT_SAMPLE_WITH_RISK_BREACH`. This triggers a mandatory risk hold and prevents promotion, without confounding sample sparsity with large-sample empirical invalidation.

### 10.3 Gate E Live Authority Boundary (P0.3)
* **Shadow Readiness Only**: Passing Gate E certifies **operational shadow readiness only**.
* **Zero Live Veto Authority**: Gate E **does not authorize live trading vetoes** (`REJECTED_BY_ERROR_MODEL`).
* Any future grant of live execution authority requires an independent quant risk committee review and a separate, versioned live authorization contract outside AEDLS.

### 10.4 Embedding Implementation & Hardware Acceptance Standard (P0.4)
* **Single Pinned Artifact**: Production Node.js runtime uses `@huggingface/transformers` pinned exclusively to `Xenova/all-MiniLM-L6-v2` at commit `c501e91` (local offline ONNX). No runtime fallback or interchangeable model repositories.
* **Exact Math**: 384 dimensions, token mean-pooling, and strict $L_2$ unit normalization.
* **Empirical Acceptance**: The $\le 50\,\text{ms}$ query latency budget is a benchmarked service requirement measured on local hardware (cold-start and p50/p95 latency) during Phase 2, not an unverified assumption.

