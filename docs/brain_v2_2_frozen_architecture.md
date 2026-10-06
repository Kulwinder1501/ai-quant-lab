# Brain V2.2: The Autonomous Research Orchestrator (Frozen Specification)

**Status:** AUTONOMOUS ENGINE V2.2 — ARCHITECTURALLY FROZEN / PHASED  
**Revision:** 2026-08-31 — phasing split after a code-and-database verification pass

> [!IMPORTANT]
> **The architecture is unchanged and the V1 extraction map verified accurate in every particular** —
> every artifact it names exists at the responsibility claimed (`patterns[0]` selection, the
> `newsSentiment <= -0.7` position mutation, in-memory `Map<string, number>` idempotency, 8 raw SQL
> statements in a 1,308-line orchestrator).
>
> What changed is **phasing**. This programme is now split along a line the original did not draw:
>
> ```
> INTEGRITY / RESEARCH INFRASTRUCTURE      →  BUILD NOW  (Tier 1)
>   P1 Contracts · P2 Context+Snapshot · P3 Ledger · P11 Outcomes · P12 Replay
>
> DIRECTIONAL TRADING DELIVERY             →  HOLD       (Tier 3)
>   P14-P18 ML Edge · P19 Paper authority
> ```
>
> The integrity half has immediate research value independent of whether a directional edge is ever
> established — see §7. The delivery half waits for a defensible target: the measured directional
> record is negative across triple-barrier, 15m direction, the tier sweep, HTF confluence, pattern
> gating and RAG retrieval, and volatility expansion (the one target with signal) fails the
> cost-aware straddle gate. **This pauses directional prediction delivery, not the Brain
> architecture.**

## 1. The 29 Architectural Invariants

These rules are immutable. Implementation testing must heavily focus on *proving* these invariants are never violated by the codebase.

**I1.** Pattern Intelligence never predicts profitability.
**I2.** Pattern Intelligence never authorizes trades.
**I3.** Opportunity Resolver never scores or ranks.
**I4.** Thesis Builder never uses ML probabilities.
**I5.** Edge Engine never modifies risk limits.
**I6.** Risk Engine never creates directional signals.
**I7.** Option Policy never changes the underlying thesis.
**I8.** Execution Engine never changes instrument selection.
**I9.** Position Supervisor never creates new entries.
**I10.** No component receives post-decision information.
**I11.** Every decision is tied to an immutable point-in-time context.
**I12.** Every decision has a deterministic identity.
**I13.** Every state transition is recorded.
**I14.** Every approved downstream object proves its upstream approvals through its type.
**I15.** Historical ledger events are never updated in place.
**I16.** V1 has no authority over V2.
**I17.** ML cannot bypass risk controls.
**I18.** No composite confidence score exists anywhere in Brain V2.
**I19.** Underlying thesis and option expression are separately evaluated.
**I20.** Every paper trade is fully replayable.
**I21.** `SnapshotRef` must resolve to immutable/content-addressed data — **content hash, never a timestamp range query.** See §8.
**I22.** Every downstream approval must carry and validate upstream lineage IDs.
**I23.** Ledger append must enforce `expectedVersion` atomically.
**I24.** `decisionKey`, `eventId`, and `aggregateVersion` uniqueness must be enforced by persistence.
**I25.** No decision stage may read mutable "current state" for decision-critical inputs.
**I26.** Sealed decision context cannot be refreshed during evaluation. Once a Snapshot is sealed, no stage may resolve a newer version.
**I27.** Post-decision outcomes cannot flow into the originating/live decision plane.
**I28.** Every ML assessment is reproducible from immutable model/data/feature/calibration provenance.
**I29.** No strategy/model/policy receives paper authority without a predefined validation/falsification promotion gate.

## 2. Compile-Time State Enforcement & Lineage

The pipeline relies on strictly typed proof. An `ExecutionDecision` cannot be evaluated unless the compiler is provided a `InstrumentApproved` state, which itself carries the `TradeThesis`, `EdgeAssessment`, and `RiskDecision`.

```typescript
// Strict Discriminated Evaluation Outcomes
export type Approved<T> = { outcome: "APPROVED"; value: T; };
export type Rejected<R extends string = string> = { outcome: "REJECTED"; reason: R; };
export type Deferred<R extends string = string> = { outcome: "DEFERRED"; reason: R; retryAt?: Instant; blockingDependency?: string; };
export type NoAction<R extends string = string> = { outcome: "NO_ACTION"; reason: R; };

export type EvaluationResult<T, R extends string = string> = 
  | Approved<T> | Rejected<R> | Deferred<R> | NoAction<R>;

// State-Carrying Pipeline Proofs
export type CandidateApproved = { kind: "CANDIDATE_APPROVED"; candidate: OpportunityCandidate; context: BaseDecisionContext; };
export type MarketStateApproved = { kind: "MARKET_STATE_APPROVED"; candidate: OpportunityCandidate; marketState: MarketStateInterpretation; context: BaseDecisionContext; };
export type ThesisApproved = { kind: "THESIS_APPROVED"; thesis: TradeThesis; candidate: OpportunityCandidate; marketState: MarketStateInterpretation; context: BaseDecisionContext; };
export type EdgeApproved = { kind: "EDGE_APPROVED"; thesis: TradeThesis; edge: EdgeAssessment; context: BaseDecisionContext; };
export type RiskApproved = { kind: "RISK_APPROVED"; thesis: TradeThesis; edge: EdgeAssessment; risk: RiskDecision; context: RiskDecisionContext; riskSnapshotRef: SnapshotRef; };
export type InstrumentApproved = { kind: "INSTRUMENT_APPROVED"; thesis: TradeThesis; edge: EdgeAssessment; risk: RiskDecision; instrument: InstrumentDecision; context: InstrumentDecisionContext; };
export type ExecutionApproved = { kind: "EXECUTION_APPROVED"; thesis: TradeThesis; edge: EdgeAssessment; risk: RiskDecision; instrument: InstrumentDecision; execution: ExecutionDecision; context: InstrumentDecisionContext; };
```

## 3. The Event-Sourced Ledger & Scoping

Event sourcing is explicitly scoped to the **Decision Aggregate** and **Position Aggregate**. Market data (quotes, features) is stored via immutable point-in-time object/time-series storage—not as an event stream—and is accessed strictly via `SnapshotRef`.

Ledger writes must explicitly declare the expected aggregate version to prevent race conditions (I23). 

```typescript
export interface BaseLedgerEvent {
  eventId: string;
  decisionId: string;
  aggregateId: string;
  aggregateVersion: number;
  sequence: number;
  occurredAt: Instant;
  eventType: DecisionEventType;
  schemaVersion: number;
  stateFrom: LifecycleState;
  stateTo: LifecycleState;
  contextRef: DecisionContextRef;
  policyVersions: PolicyVersions;
  causationId?: string;
  correlationId: string;
  payloadRef?: RefId;
  payloadHash?: string;
  producer: { service: string; version: string; instanceId: string; };
  previousEventHash?: string;
}

export interface DecisionLedger {
  append(aggregateId: string, expectedVersion: number, event: LedgerEvent): Promise<AppendResult>;
}
```

## 4. ML Provenance & Reproducibility (I28)

Every ML outcome is tied to an explicit provenance chain to guarantee full traceability against leakage and selection bias.

```typescript
export interface MLProvenance {
  modelVersion: string;
  trainingDatasetRef: SnapshotRef;
  trainingCutoff: Instant;
  featureSetVersion: string;
  trainingRunId: string;
  randomSeed: number;
  codeVersion: string;
  calibrationArtifactRef: SnapshotRef;
}
```

## 5. Implementation Sequence (P0 - P19)

*   **P0:** V1 quarantine + compatibility adapter scaffolding
*   **P1:** Contracts + state machine
*   **P2:** Context + snapshots
*   **P3:** Ledger + idempotency
*   **P4:** Pattern adapter
*   **P5:** Opportunity resolver
*   **P6:** State interpreter + thesis
*   **P7:** Deterministic edge
*   **P8:** Risk
*   **P9:** Instrument policy
*   **P10:** Execution simulator
*   **P11:** Outcomes (3-layer: Underlying / Instrument / Execution)
*   **P12:** Replay
*   **P13:** V1/V2 differential test suite
*   **P14:** Dataset / label audit
*   **P15:** ML Edge Engine
*   **P16:** ML validation + falsification
*   **P17:** ML shadow
*   **P18:** Promotion gate
*   **P19:** V2 paper authority

## 6. Migration Discipline (V1 → V2.2)

> [!IMPORTANT]
> Brain V2.2 architecture remains frozen. This section governs how V1 behavior is migrated, not whether V2.2 should be redesigned.

### V1 Code Extraction Map

Every piece of V1 logic must be classified before being touched:

| Bucket | V1 Artifacts | Action |
| :--- | :--- | :--- |
| **KEEP AS PRINCIPLE** | Data freshness checks, observed execution pricing (`resolvePanicExitPremium`), empirical side restrictions, dual-thesis recording, MFE/MAE review, contract sanity checks | Extract the *behavioral rule*, prove it under V2.2 tests — do not copy code verbatim |
| **ADAPTER / REFACTOR** | `OpenOptionPositionFromIdea`, indicator versioning, driver tape, news context, FII/DII context, position evaluation, operational rate limiting | Decompose into V2.2 components behind a `LegacyAdapter` boundary |
| **QUARANTINE** | `scoreDirectionalSetup`, legacy candlestick ranking, composite confidence, `patterns[0]`, news-based trading authority | Retain as benchmark only; zero import path into `autonomous-v2/` |
| **DELETE FROM V2** | In-memory decision idempotency (`Map<symbol, timestamp>`), raw SQL inside orchestrator, post-outcome feedback into decision path, direct position mutation from contextual scores | Do not migrate; replaced by V2.2 structural equivalents |

### Compatibility Adapter Pattern

V1 must not be big-bang rewritten. The migration ladder is:

```
LEGACY V1
   │
   ├── Legacy Benchmark (frozen, runs in parallel as control group)
   │
   └── Legacy Compatibility Adapters
          ├── PatternAdapter          (legacy pattern → PatternObservation)
          ├── MarketContextAdapter    (legacy bar/indicator → MarketSnapshot)
          ├── ThesisAdapter           (differential analysis only, not live decisions)
          └── Execution/OutcomeAdapter (legacy trade → OutcomeRecord)
                    ↓
             V2.2 Contracts
                    ↓
             Brain V2.2 Orchestrator
```

**The critical rule for every adapter:**

> An adapter translates legacy information into a V2.2 contract. It must not reproduce V1 decision logic inside V2.2.

Each adapter is temporary and is deleted once the real V2.2 subsystem replaces it. This prevents V1 assumptions from hardening into permanent V2.2 assumptions.

#### How that rule was satisfied for the thesis (implemented 2026-09-02)

The ladder above is the design; this is what satisfying it actually required, because the thesis is the
one adapter where the rule and the need collide.

P13 grades whether V2.2 can **substitute** for V1. A V2.2 carrying a *different* entry rule cannot
answer that -- every bar differs, every difference is expected, and the gate measures two strategies
instead of one platform. So V1's entry rule has to run through V2.2's thesis port unchanged. But the
rule above forbids reproducing V1 decision logic inside V2.2, and the QUARANTINE bucket adds "zero
import path into `autonomous-v2/`", which a guard enforces by walking the real import graph.

Both hold at once by **inverting the dependency**. `portedV1ThesisProducer` lives in
`strategy-engine/application/v22-thesis-bridge.ts` -- inside the legacy module, not inside
`autonomous-v2/`. V2.2 defines the port and knows nothing about V1; the legacy module adapts *itself*
to the new contract and hands the result in. The arrow points from the system being replaced toward
the system replacing it, which is also what lets V1 be deleted later without touching V2.2.

Two further consequences of the rule, both now enforced rather than documented:

- **"Differential analysis only, not live decisions" is typed.** Producers carry
  `NATIVE | DIFFERENTIAL_ONLY`, and `assertMayHoldAuthority` throws on the latter. As prose this was
  unenforceable the moment P19 grants paper authority to *some* producer. Trading a ported rule
  requires re-deriving it natively under V2.2's tests -- deliberately not a flag.
- **The bridge refuses to select.** V1's evaluators return lists and three strategies own the 5m
  timeframe. Ranking candidates by confidence would be `scoreDirectionalSetup` rebuilt; taking the
  first would be `patterns[0]`. Both are quarantined *by name*, so two distinct candidates yield
  `AMBIGUOUS_PROPOSALS` and no thesis. I3's Opportunity Resolver is the component entitled to choose,
  and it does not exist yet. Identical geometry from two strategies is one decision, not an ambiguity.

V2.2's own measured gates still run first, unchanged, by delegating to the native producer rather than
restating it. V1 has none of them, so on a frozen-tape bar V1 proposes and the ported producer refuses.
That divergence is the finding, not a fault: it classifies as `EXPECTED_ARCHITECTURAL_CHANGE` with the
D3 measurement attached. **Porting the entry rule is not porting V1 wholesale** -- the rule comes
across, the defects stay behind.

See Readiness Plan Gap 15 for the track's state and the four defects found by running it.

### Executable Side Restrictions: Structural vs Research-Approved

V1's `AGENT_EXECUTABLE_SIDES = ["LONG"]` is an empirical research finding, not a structural rule. These must remain separate in V2.2:

```typescript
interface ThesisPolicy {
  // What the engine can structurally produce
  structuralEligibleSides: ("LONG" | "SHORT")[];
}

interface ResearchPromotionRecord {
  // What research currently endorses — reversible and auditable
  currentlyApprovedSides: ("LONG" | "SHORT")[];
  baselineRef: string;
  evaluationWindow: string;
  trainingCutoff: Instant;
  policyVersion: string;
}
```

The restriction is re-evaluated from new data, not hardcoded. Both-thesis candidate records must still be persisted even when one side is currently unapproved.

### Three-Layer Outcome Split

V1's `buildTradeReview()` MFE/MAE data seeds the V2.2 `OutcomeEngine`, split into three independent measurement layers:

| Layer | Measures |
| :--- | :--- |
| **Underlying Outcome** | Did the underlying asset reach the target before invalidation? |
| **Instrument Outcome** | Did the selected option capture the underlying move efficiently? |
| **Execution Outcome** | Did fills, spreads, and slippage erode the captured P&L? |

This lets research isolate: pattern failure vs. instrument selection failure vs. execution failure.

> [!IMPORTANT]
> **Implemented, adopted, and amended by what it measured (2026-09-02).** The split above is correct
> and is now live over the closed book. Two things had to change before it could answer its own
> question, both found by running it on real data. Full detail in the readiness plan's *Gap 14*.

#### A fourth verdict: `EXITED_UNRESOLVED`

The three layers name three failures, and there was no way to say **the position was closed while its
thesis was still live** — neither invalidated nor reached. `attributeShortfall` returned null there,
which reads as "cannot tell" when the layers in fact agree on something specific.

It was the dominant real case: the first trades carrying an observed underlying exit all stopped
**short of the thesis stop** (33–86% of the way) while the option position closed first, on its own
stop or a 20-minute stall timer.

It is deliberately **not** a layer name, because no layer failed, and deliberately neutral about
whether the exit was wrong — an early stop may be sound risk management on a cheap option, or a stop
too tight for the geometry it expresses. It says the position never got the chance to be right or
wrong, which points at holding period and stop placement rather than at thesis, strike or fill.
`EXECUTION` is evaluated first, so a fill that erased a real gain is never absorbed by it.

#### The underlying layer needs a *path*, not an endpoint

`Instrument Outcome` failure — "the thesis was right, the expression was wrong" — requires the
underlying to have reached its target. Measured across 22 trades: **none ever finished at target**, so
that verdict was structurally unreachable. Two causes:

1. The option's own target sits nearer than the thesis target, firing at **18–53%** of the distance,
   so the position closes before the underlying arrives.
2. Resolution read only the exit instant, so a target touched mid-hold and given back was invisible.

The second was fixable from data already stored: a paper trade's `instrument_id` is the **index**, so
its own 1m candles cover the hold. The underlying layer now carries real excursions and the barrier
touched **first** — order matters, because a thesis that reached target before its stop was right
first, whatever followed. A bar spanning both barriers is given to the stop, matching the existing
`CONSERVATIVE_STOP_FIRST` convention: crediting the target on an ambiguous bar would manufacture
"the thesis was right" out of a bar that may never have got there.

`resolutionBasis` (`ENDPOINT` | `PATH_TOUCH`) travels on the layer, because the two are not equally
strong claims. Candle extremes are an upper bound, so a path-derived target may be a 1m wick nobody
could have exited on; an endpoint `UNRESOLVED` means "not resolved at the end", never "never reached
a barrier". Attribution rests entirely on that distinction, so it is recorded rather than inferred.

#### What the split has actually found

| Verdict | Live count | Reading |
| :--- | ---: | :--- |
| `UNDERLYING` | 6 | thesis invalidated |
| `EXECUTION` | 1 | −₹7 realised on **+₹95** theoretical, ₹102 fees — the instrument captured the move and costs took it |
| `EXITED_UNRESOLVED` | 6 | closed while the thesis was still live |
| `INSTRUMENT` | 0 | **honest absence**, not blindness — see below |

`INSTRUMENT` at zero is now a measurement rather than a gap. Two trades did touch target: one was
profitable, and the other is the `EXECUTION` row above, where a positive theoretical P&L proves the
instrument captured the move and so it is a fill failure by definition.

Reconciliation over the same book: **361 of 362 within a paisa**. The single residual is a trade
closed by hand outside the application (see migration 088), and its residual is exactly its own fees.

### V1 / V2 Differential Testing (P13)



Before V1 is retired, both systems must run against identical sealed snapshots. Every divergence must be formally classified — not just explained with a free-text reason:

| Classification | Meaning | Example |
| :--- | :--- | :--- |
| `EXPECTED_ARCHITECTURAL_CHANGE` | V2.2 intentionally works differently by design | Composite score removed → V2 evaluates gate-by-gate |
| `DATA_DIFFERENCE` | V2.2 consumed a different (more correct) data boundary | V1 used live price; V2 used sealed snapshot price |
| `POLICY_DIFFERENCE` | Different thesis or risk policy version in effect | V2 risk policy rejects a size V1 would have approved |
| `RISK_DIFFERENCE` | V2 risk engine correctly caught an exposure V1 missed | Correlated NIFTY + BANKNIFTY exposure blocked |
| `EXECUTION_DIFFERENCE` | V2 execution conditions differ from V1 | V2 observed stale option chain; V1 did not check |
| `BUG` | A defect in the V2 implementation | V2 incorrectly rejects a valid candidate |
| `UNKNOWN` | Cannot be explained | **→ Promotion blocker** |

**Promotion rule:** Any divergence classified as `UNKNOWN` blocks promotion to V2 paper authority until resolved. `BUG` must also be resolved before promotion. All other classifications are acceptable and must be logged.

### Clarifications on Invariant Wording

**`patterns[0]` and I3:** V1 has no formal Opportunity Resolver, so I3 cannot be literally violated by code that predates the concept. The correct framing is: *V1 contains an implicit, unstated observation-selection mechanism that V2.2 eliminates*. Simply sorting and selecting `patterns[0]` would still violate V2.2's design intent even if it passed a surface reading of I3.

**News panic exit and I6/I8:** V1's `newsSentiment <= -0.7 → close positions` is not specifically an I6 or I8 violation. I6 governs the Risk Engine generating directional signals; I8 governs the Execution Engine changing instrument selection. The actual violation is a **responsibility boundary failure**: an external context signal directly mutates position state without flowing through the governed circuit-breaker → Position Supervisor path. The correct V2.2 design is: `ExternalContext → CircuitBreakerPolicy → PositionSupervisor → exit`.

### Freshness Gate ≠ Sealed PIT Context

V1's `assessDataFreshness()` answers: *"Is this data recent enough?"*

V2.2's sealed `DecisionContext` answers: *"Was this exactly the information available at the decision boundary, and did every downstream stage consume that same information?"*

These are different guarantees. The freshness rules should be extracted, formalized as `DataQualityGate` behavior, and **proved with tests under the V2.2 / Directional V2 P0 contracts** — not copied verbatim.

### Shared PIT Platform Primitives

The point-in-time timestamps and data-integrity concepts are **platform primitives owned by a shared layer**, not re-invented per module:

```
              PIT PLATFORM (shared)
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
 Directional V2  Brain V2.2  Pattern Intel
 Research Plane  Decision     Observation
                 Plane        Plane
```

The shared platform owns:

| Primitive | Meaning |
| :--- | :--- |
| `eventAt` | When the market event occurred |
| `knownAt` | When it became knowable to the system |
| `dataThrough` | The latest bar/tick the observation was built from — **meaningless without the bar-label convention it was stamped in; see Readiness Plan Gap 10** |
| `earliestExecutionAt` | First moment a decision could act on the observation |
| `referenceAt` | Anchor for forward-outcome measurement |
| `TradingSession` | Exchange calendar and session windows |
| `UniverseVersion` | Which instruments and contracts were valid at time T |
| `DataVintage` | Which data-source version produced the snapshot |
| `SnapshotIdentity` | Content-addressed reference to immutable data |

> [!CAUTION]
> Three different modules inventing three subtly different interpretations of "available at time T" would recreate the coupling V2.2 is designed to remove. **This already happened:** Pattern Intelligence labels a bar by its open and the scalp harness by its close, so the two record `dataThrough` one bar-duration apart for the same bar. Measured, and detailed in Readiness Plan Gap 10. Brain V2.2 must consume these primitives from the shared platform, not re-derive them.

> [!WARNING]
> **This does not extend to canonical hashing.** "Consume from the shared platform, do not re-derive"
> is right for the PIT primitives and wrong for the hash encodings. The repository already holds four
> deliberately different canonicalizers, two of them exporting a function of the same name with
> different byte semantics, and existing research rows depend on the current digests. The shared
> platform **relocates** the research identity implementation verbatim and pins it with golden digest
> tests; it does not unify the others. See Readiness Plan **Gap 1a / D1**.

### OpenOptionPositionFromIdea: Decompose, Do Not Discard

V1's `OpenOptionPositionFromIdea` bundles several responsibilities that map directly to V2.2 components:

| V1 Responsibility | V2.2 Component |
| :--- | :--- |
| Strike selection | `OptionPolicy` |
| Risk gate | `RiskEngine` |
| Position sizing | `PositionSizer` |
| Contract sanity check | `InstrumentEligibility` |
| Paper order creation | `PaperExecutor` |

---

## 7. Why the Integrity Half Pays for Itself Now

P11 (Outcomes) and P12 (Replay) are pulled into Tier 1 rather than waiting on the ML tract, because
existing measured defects already demonstrate their value. Both are **execution-layer** faults that
the three-layer outcome split isolates immediately and that were not diagnosable without replay:

| Defect | What happened | Which layer |
| :--- | :--- | :--- |
| Model mark flipped the P&L sign | +₹2,032 reported on a position that was down ₹651 | Instrument / Execution |
| Dense tick lookup discarded future rows | Three defects booked a target as a stop-loss; the barrier was crossed between 5-minute runs | Execution |
| Unsettleable verdicts went stale | Clearing 215 ungradeable verdicts moved headline accuracy from 91.7% to 69.6% | Outcome |

Each was a conclusion drawn from a number that turned out to describe a different layer than assumed.
That is precisely the confusion the Underlying / Instrument / Execution split exists to prevent, and
it is a research capability, not a trading one.

---

## 8. I21 in Practice: `SnapshotRef` vs Auto-Healing Storage

There is a live mechanism in this system that violates I21 if `SnapshotRef` is implemented as a range
query: **index candle gaps self-heal nightly at 16:18, append-only.**

A reference meaning *"everything through 15:00"* therefore resolves to one byte sequence before the
heal and a different one afterwards — same reference, different data, no error raised. Content
addressing is not a stylistic preference here; it is the only implementation that satisfies I21 given
this healer.

```
WRONG                               RIGHT
SnapshotRef                         SnapshotRef
    ↓                                   ↓
timestamp query                     immutable object version
    ↓                                   ↓
current database state              content hash
```

### The required invariant test (Platform P0, Gate B2)

```
seal a snapshot                              → record bytes + hash
heal a gap in the underlying source storage    (append a bar)
resolve the SAME ref
assert bytes identical
assert hash identical
```

Treat this as the highest-value single test in Platform P0. It is the test that decides whether
I20 ("every paper trade is fully replayable") and P12 mean anything at all.
