# Implementation Readiness Plan

**Purpose:** Close the program-level gaps before a single line of domain code is written.  
**Scope:** Shared Platform · Promotion Gate Governance · Phasing & Parallelism · Observability · Data Integrity  
**Status:** PLANNING — not a frozen architecture change  
**Revision:** 2026-09-02. Originally revised 2026-08-31 after a code-and-database verification pass
against the live system; Gaps 13-16 and the Gate A statuses were added after that.

> [!IMPORTANT]
> **What this revision changed, and why.** Every factual claim in the original was checked against the
> repository and the live v2 database. The architecture held up — the V1 extraction map was accurate
> in every particular. Three defects and one deadlock did not:
>
> | Finding | Effect |
> | :--- | :--- |
> | **D1** Canonical hashing "extract and unify" | Would have re-identified 9,218 settlements, 180 study trials and 9 pinned D2 sessions. Now **relocate and pin** (Gap 1a). |
> | **D2** 12-item checklist | Contained a circular dependency and could not be completed. Split into two gates. |
> | **D3** Frozen-tape decisions | Live defect; 41 proposals already recorded on a republished price. Harness half **fixed and shipped**; two surfaces remain open (Gap 8). |
> | **D4** Matched-control pooling | Pre-existing; needs a research decision about 404 unmatched opportunities (Gap 9). |
>
> The four rows above are **as found on 2026-08-31**, not current status. D1-D4 have since all closed
> — see **Blocking gates summary** under Readiness Gates for where each stands and what closed it. D3
> in particular is now closed on both code surfaces plus the per-instrument threshold, with no
> sub-items remaining.
>
> Sequencing changed substantially — see **The Tiered Programme**. The architecture did not.

---

## The Implementation Structure

After Platform P0, Brain V2.2 and Scalp Engine V2 advance as independent parallel programs:

```
              SHARED PLATFORM P0
                      │
        ┌─────────────┼─────────────┐
        │             │             │
        ▼             ▼             ▼
  DIRECTIONAL     BRAIN V2.2    SCALP V2
  Research        Domain        Domain
        │             │             │
        └─────────────┼─────────────┘
                      │
            Shared Observability
            Shared Governance
            Shared Risk Primitives
```

Brain and Scalp share the platform layer — they do not depend on each other.

---

## Gap 1: Shared Platform P0 (Intentionally Small)

### Problem
Both Brain V2.2 and Scalp Engine V2 depend on the same foundational contracts. Without a designated owner, both domains will build subtly incompatible local versions. However, Platform P0 must **not** become "build the entire trading platform first." It provides only the **minimum shared primitives** required by both domains.

### What Platform P0 Builds

| Component | Package | What it is |
| :--- | :--- | :--- |
| PIT Time Types | `shared/platform/pit` | `eventAt`, `knownAt`, `dataThrough`, `earliestExecutionAt`, `referenceAt` — value objects, no setters |
| Snapshot Identity / Reference | `shared/platform/snapshot` | `SnapshotRef`, content-addressed identity, immutable storage contract |
| Snapshot Registry Contract | `shared/platform/snapshot` | The interface Brain P2 and Scalp implement against |
| Trading Session Contract | `shared/platform/calendar` | Session window, `TradingSession`, special-session types |
| Canonical Hashing | `shared/platform/identity` | `canonicalJson`, `sha256Canonical`, `logicalKey` — **relocated verbatim** from `research/scalp-harness/domain/identity.ts`, never re-implemented. See Gap 1a. |
| Risk Primitives | `shared/platform/risk-primitives` | `RiskSnapshot`, `ExposurePrimitive`, `ConcurrencyPrimitive`, `CapacityPrimitive`, `RiskDecisionInterface` — infrastructure contracts only, no domain policy |
| Observability Contract | `shared/platform/observability` | `ObservabilityPolicy`, `DecisionAuditRecord` schema (see Gap 4) |
| Governance / Versioning | `shared/platform/governance` | `PromotionPolicy`, `PromotionReview` artifact types |

> [!NOTE]
> **Paths as built.** Every component landed under `apps/api/src/modules/platform/<area>/` rather than
> as a `packages/shared-platform-*` workspace. The mapping is 1:1, so promotion to a package is a
> directory move; the reason is deploy risk, and it is recorded in Gap 1a. Read the `Package` column
> above as the eventual target, not the current location.

### What Platform P0 Does NOT Build

- Full Brain Risk Engine (domain: Brain P8)
- Full Scalp risk/admission policy (domain: Scalp runtime)
- Full execution infrastructure
- Full replay system
- Full outcome system
- Full ML pipeline

Those remain domain implementations consuming the platform contracts.

### Platform P0 Invariant Tests (written before implementation)

```
✓ PIT primitives are immutable value objects — no setters, no mutation
✓ SnapshotRef resolves to content-addressed, immutable data
✓ logicalKey(namespace, fields) is deterministic and collision-resistant
✓ Risk primitive interfaces carry no domain policy — only structural contracts
✓ Trading session contract correctly handles special sessions (Muhurat etc.)
✓ Canonical hashing: same value always produces same hash, round-trips cleanly
```

### Sequencing rule

> No Brain V2.2 phase and no Scalp Engine V2 phase may begin until the Platform P0 component it depends on is complete and tested. After P0, Brain and Scalp advance independently.

---

## Gap 1a: Canonical Hashing — Relocate and Pin, Never Unify

> [!CAUTION]
> **PLATFORM GATE D1.** This is the single most dangerous refactor in the program. Unifying the
> canonicalizers would silently re-identify existing research history.

### The measured situation

The repository contains **four** distinct canonicalizers, and the divergence is deliberate:

| Location | Encoding | Purpose |
| :--- | :--- | :--- |
| `research/scalp-harness/domain/identity.ts` | JSON string → SHA-256 | `logicalKey`, `proposalKey`, research identities |
| `pattern-intelligence/domain/canonical-hash.ts` | **type-tagged bytes**, ULEB128 length-prefixed, UTF-8 key order | `observationHash` |
| `market-data/domain/data-readiness.ts` | JSON string | audit report hash |
| `research/scalp-harness/domain/live-backfill-parity.ts` | JSON string, array order preserved | parity comparison |

Two of these export a function named **`sha256Canonical`** and they produce **different digests for the
same input**. `canonical-hash.ts` documents its refusal to consolidate and gives the reason: JSON
string-joining is not injective — `{"a": "b:c"}` and `{"a:b": "c"}` can serialise to the same bytes — which
is tolerable for a research fingerprint and unacceptable for an identity hash.

### What depends on the current digests

| Artifact | Count |
| :--- | :--- |
| `research_scalp.terminal_settlements` | 9,218 |
| `research_scalp.study_trials` | 180 |
| Phase 29 D2 premium sessions under a pinned parent hash | 9 |

### The rule

```
Existing identity.ts
        ↓
   MOVE VERBATIM  (byte-identical, no "cleanup", no formatting change)
        ↓
shared/platform/identity/
        ↓
   GOLDEN DIGEST PIN TESTS
```

Leave the other three where they are. Register each as a **separately named encoding** so a future
reader cannot mistake them for accidental duplication:

- `sha256CanonicalJson` — the JSON-string encoding (relocated)
- `sha256CanonicalBytes` — the type-tagged byte encoding (stays in pattern-intelligence)

Two encodings with two different jobs is the cheaper answer than one encoding that is wrong for one
of them.

### D1 exit criteria

| Criterion | Status | Evidence |
| :--- | :--- | :--- |
| Relocated with zero semantic change | DONE | `git` reports **R100** on all three files |
| Golden digests recorded **before** the move, reproduced after | DONE | 8 pins, committed in `e3e5768` before anything moved |
| Live keys recompute identically | DONE | 1,500 stored keys (500 each `proposalKey` / `controlPointKey` / `opportunityKey`), 0 mismatches |
| No duplicated canonicalizer export name | DONE | `sha256Canonical` no longer exists; every name defined exactly once |
| Each name states its encoding | DONE | `sha256CanonicalJson` / `sha256CanonicalBytes` / `canonicalJsonForReportHash` / `canonicalJsonForParity` |

Implemented as `e3e5768` → `e8ce167` → `73e75bb`, in that order deliberately: the pins were
committed before the move so they could not be written to fit it.

Three notes for whoever picks up the rest of Platform P0:

- **Destination deviated from `shared/platform/identity`.** It landed at
  `apps/api/src/modules/platform/identity/`, which maps 1:1 so a later promotion to a workspace
  package is a directory move. The reason is deploy risk, not preference: `apps/api/Dockerfile`
  enumerates workspace packages in five separate COPY lines plus the api build chain, and a new
  package buys nothing while Brain and Scalp are the same deployable.
- **The criterion originally asked for the encoding *version* in each name.** Implemented as the
  encoding *form* instead — the version is already an exported constant, and suffixing `V1` when no
  V2 exists ages badly. What prevents the accident is that no two names collide.
- **The digest is not fully determined by this source.** `canonicalJson` sorts keys with
  `localeCompare`, which is ICU-backed, so a Node build without full ICU can change the digest of any
  object carrying a non-ASCII key with no source change at all. Real payloads key on code identifiers
  so exposure is near nil, but it means "relocate verbatim" is necessary and not sufficient. A named
  test fails specifically on that cause so it is diagnosed rather than mysterious.

---

## Gap 2: Shared Risk — Platform Primitives vs Domain Engines

### Problem
"Common Risk Engine" in both specs can become a "God Risk Engine." The platform provides contracts and primitives; each domain provides its own risk policy on top.

> [!IMPORTANT]
> **Terminology is binding, and this section amends the frozen Scalp specification.** The phrase
> "Common Risk Engine" is retired everywhere in favour of **Shared Risk Infrastructure**. The Scalp
> Engine V2 plan used the old phrase in two places (its Shared Platform Infrastructure list and its
> pipeline diagram); both are corrected. This is terminology alignment, not a conceptual redesign —
> but it is load-bearing, because an implementer reading "Common Risk Engine" in a document marked
> FROZEN will build the God engine this gap exists to prevent.

### Correct Split

```
SHARED PLATFORM P0
    RiskSnapshot contract
    ExposurePrimitive
    ConcurrencyPrimitive          ← persistence-level concurrency/capacity enforcement
    CapacityPrimitive             ← these belong centrally (harness already proved this)
    RiskDecisionInterface

        ↙                ↘

Brain P8                    Scalp Runtime
Brain-specific risk policy  Scalp-specific admission/risk policy
Thesis-aware evaluation     Uses same platform RiskDecision interface
Position sizing policy      No separate engine — same authoritative infrastructure
Circuit-breaker integration
```

This keeps the shared layer small and stable. Domain risk policies can evolve without breaking the platform.

---

## Gap 3: Phasing & Parallelism

### Critical Path

```
P0 Shared Platform (all foundations — serialized)
  │
  ├──────────────── BRAIN V2.2 ─────────────────────────────────────────────┐
  │   P1 Contracts + State Machine                                           │
  │   P2 DecisionContext + Snapshot Registry                                 │
  │   P3 Ledger + Idempotency                                                │
  │   P4 Pattern Adapter                                                     │
  │   P5 Opportunity Resolver                                                │
  │   P6 State Interpreter + Thesis                                          │
  │   P7 Deterministic Edge                                                  │
  │   P8 Risk (domain policy on shared primitives)                           │
  │   P9 Instrument Policy                                                   │
  │   P10 Execution Simulator ← FULL PIPELINE SIMULATABLE (not paper auth)  │
  │   P11 Outcomes (3-layer)                                                 │
  │   P12 Replay                                                             │
  │   P13 V1/V2 Differential Tests ← gate for V1 retirement                 │
  │   P14–P18 ML Pipeline (independent research tract)                      │
  │   P19 V2 Paper Authority ← ACTUAL PAPER AUTHORITY                       │
  │                                                                          │
  └──────────────── SCALP V2 ──────────────────────────────────────────────┘
     Phase 1  Platform Alignment (PIT, Calendar, Risk primitives)
     Phase 2  Promotion Registry ← depends on P0 only, NOT on Brain P3
     Phase 3  V2 Runtime Pipeline (Canonical Clock, Data Gate, Candidate)
     Phase 4  Strategy Host ← PRODUCTION HOST RUNNABLE (not paper auth)
     Phase 5  Replay + Differential Testing
     Phase 6  Production Cutover ← ACTUAL PAPER AUTHORITY
```

### Paper Authority Milestones (Corrected)

| System | Simulatable Milestone | Actual Paper Authority |
| :--- | :--- | :--- |
| Brain V2.2 | P10 — full deterministic pipeline simulatable end-to-end | **P19** — after ML validation, promotion gate, and V1 retirement |
| Scalp V2 | Phase 4 — host technically runnable with approved artifact | **Phase 6** — after differential testing, deprecated AutoBots, and promoted artifact |

> **P10 ≠ paper authority. Phase 4 ≠ paper authority.** Confusing these would incentivize bypassing the governance sequence.

### Parallel Execution Opportunities

| Can run simultaneously | After |
| :--- | :--- |
| Brain P1–P3 and Scalp Phase 2 (Promotion Registry) | Platform P0 complete |
| Brain P11 (Outcomes) and Scalp Phase 5 (Differential Testing) | **Brain P10 for the Brain side; Scalp Phase 4 for the Scalp side** |
| Brain P14–P18 (ML) and Scalp Phase 5–6 (Cutover) | These are fully independent |
| Research Harness continues accumulating Momentum v5 evidence | Always — independent of production build |

> [!WARNING]
> **Corrected dependency.** An earlier revision of this table gated Scalp Phase 5 on *Brain P10*,
> which contradicts this document's own opening claim that "Brain and Scalp share the platform layer —
> they do not depend on each other." Scalp Phase 5 depends on **Scalp Phase 4**. The two systems
> share Platform P0 and nothing else. Any future cross-programme edge in this table is a defect
> unless it is a Platform P0 edge.

---

## Gap 4: Operational Observability

### Principle: Three Separate Layers

```
Domain Ledger         ← meaningful transitions only (append-only, event-sourced)
Decision Telemetry    ← every tick, lightweight structured record
Aggregated Metrics    ← rolled up for dashboards and alerts
```

The event-sourced ledger must not become a high-volume observability store. Telemetry is separate.

---

### Layer 1: Versioned Observability Policy (thresholds are NOT frozen in architecture)

Alert thresholds are operational artifacts, not architecture constants. A threshold normal for one strategy may be catastrophic for another.

```typescript
interface ObservabilityPolicy {
  metric: string;
  threshold: number;
  evaluationWindow: string;
  severity: "INFO" | "WARN" | "CRITICAL";
  policyVersion: string;
}
```

Example — `OBS_POLICY_V1`:

| Metric | Threshold | Severity | Note |
| :--- | :--- | :--- | :--- |
| `data_ready_gate.defer_rate` | > threshold% | WARN | Value set by policy, not architecture |
| `risk_engine.rejection_rate` | > threshold% | WARN | Strategy-dependent; set per promoted artifact |
| `snapshot_registry.resolution_latency_p95_ms` | > threshold | WARN | Set by policy |
| `execution.fill_rate` | 0 during market hours | CRITICAL | Pipeline down |

The policy version is stored alongside the `StrategyPromotionRecord` so observability thresholds track the promoted strategy.

---

### Layer 2: Decision Audit Record (Full Funnel)

Every tick emits a lightweight structured record covering the **complete decision funnel** — including strategy evaluation status, not just gate results. This is critical because "strategy never ran" and "strategy ran but produced no candidate" are completely different pipeline states.

```typescript
interface DecisionAuditRecord {
  decisionId: string;
  symbol: string;
  decisionAt: Instant;          // canonical grid slot
  evaluationAt: Instant;        // wall-clock scheduler wakeup
  schedulerLagMs: number;       // telemetry only — never alters decisionAt

  // Snapshot
  snapshotResult: "RESOLVED" | "STALE" | "UNAVAILABLE";
  snapshotRef?: SnapshotRef;

  // Data / Feature Readiness
  featureReadinessStatus:
    | "READY"
    | "DEFERRED_FEATURE_WARMUP"       // same taxonomy as research harness
    | "DEFERRED_FEATURE_NOT_COMPUTED"
    | "DEFERRED_GRID_ALIGNMENT";

  // Strategy Evaluation (NEW — distinguishes "never ran" from "ran, no signal")
  strategyEvaluationStatus: "EVALUATED" | "SKIPPED" | "INELIGIBLE";
  candidateCount: number;
  candidateIds: string[];       // proposalKey values — enables cross-reference with research

  // Admission
  admissionResult: "APPROVED" | "REJECTED" | "DEFERRED" | "NO_CANDIDATE";
  admissionReason?: string;

  // Risk
  riskResult?: "APPROVED" | "REJECTED";
  riskRejectionInvariant?: string;   // e.g. "I5_EXPOSURE_LIMIT"

  // Execution
  executionResult?: "EXECUTED" | "NO_ACTION";
  rejectionReason?: string;
}
```

**No silent `NO_ACTION`:** Every tick must be classifiable from this record. The `strategyEvaluationStatus` and `featureReadinessStatus` fields are what make this possible.

---

### Layer 3: Daily Research Feedback Health

| Metric | Meaning |
| :--- | :--- |
| `outcome_store.write_rate` | Outcomes being recorded |
| `research_dataset_builder.lag_sessions` | How many sessions behind the dataset is |
| `momentum_v5.session_count` | Evidence accumulation for active candidate |
| `promotion_candidacy.open` | Whether a review is currently in progress |

---

## Gap 5: Promotion Gate Governance

### Promotion Authority is Policy-Configurable

The promotion authority is not hardcoded to require a human forever — it is governed by a versioned `PromotionPolicy`:

```typescript
interface PromotionPolicy {
  policyVersion: string;
  transitions: {
    from: DeploymentState;
    to: DeploymentState;
    requiredEvidenceState: StudyEvidenceState;
    approvalMode: "AUTOMATED" | "HUMAN_REQUIRED";
    additionalGates: string[];
  }[];
}
```

`PROMOTION_POLICY_V1` (current operational policy):

| Transition | Evidence Required | Approval |
| :--- | :--- | :--- |
| `RESEARCH → SHADOW` | `RESEARCH_USABLE` (20+ sessions) | Human sign-off |
| `SHADOW → PAPER` | `STRONGER_VALIDATION` (60+ sessions) | Human sign-off |
| `PAPER → PRODUCTION` | `STRONGER_VALIDATION` + differential test pass | Human sign-off |

The invariant is: **every deployment transition requires an explicit governed promotion decision**. Whether a human or an automated system makes that decision is a policy choice, not an architecture constant.

### DATA_INSPECTED Holdout Verification

```typescript
// Added to StrategyPromotionRecord
inspectedWindowEnd?: Instant;   // required when studyProvenance === "DATA_INSPECTED"
holdoutWindowStart?: Instant;   // required when studyProvenance === "DATA_INSPECTED"
// Promotion system rejects: holdoutWindowStart <= inspectedWindowEnd
```

### Research Review Cadence (Policy Artifact)

The Momentum v5 review cadence is a governed policy, not engine logic:

```
RESEARCH_REVIEW_POLICY_V1
  reviewIntervalSessions = 5
  minimumForCandidacy = RESEARCH_USABLE
```

The research governance system owns this. Strategy logic never references session count modulo.

---

## Gap 6: Evidence Thresholds Are Referenced, Never Copied

The session boundaries `5 / 20 / 60` appear as literals in these plans and also live in code as
`decisionGradeSessionMinimum = 20` (`research/scalp-harness/domain/study-registry.ts`). Duplicating
them recreates configuration drift: the registry says 20, the plan says 20, and eventually a third
service says 25.

```
StudyEvidencePolicy
  evidencePolicyVersion
        ↓
  EARLY_DIAGNOSTIC / PROVISIONAL / RESEARCH_USABLE / STRONGER_VALIDATION boundaries
```

Every document and every service reads the boundaries from the policy and records
`evidencePolicyVersion` alongside any verdict that used them.

> [!NOTE]
> **Costing note (original).** `decisionGradeSessionMinimum` exists today. `evidencePolicyVersion`
> **does not** — introducing it is new work, not a citation of something already built. Price it in
> Gate A7.

> [!IMPORTANT]
> **Correction, 2026-09-02 — this gap's premise was half wrong, and the valuable half was elsewhere.**
>
> The stated risk is duplication: *"the registry says 20, the plan says 20, and eventually a third
> service says 25."* Measured before building: **in code there was no duplication.** `evidenceState`
> is the single implementation, and every consumer either calls it or takes
> `decisionGradeSessionMinimum` as a parameter. The "referenced, never copied" property this gate asks
> for already held. The duplication is between code and *these documents*, which no code structure
> fixes.
>
> What did **not** hold was provenance. Nothing recorded *which* boundaries produced a stored verdict,
> so the day 5 / 20 / 60 change, all 180 stored `evidence_state` values silently become ambiguous —
> two rows reading `RESEARCH_USABLE` would mean different things with nothing to tell them apart.
> That is the same failure `controlPolicyVersion` exists to prevent, one table over.
>
> So `EVIDENCE_POLICY_V1` (`4e48695`) encodes what was already in force rather than deciding
> anything: 5 / 20 / 60 unchanged, 5 and 60 given names and rationales (they were anonymous inline
> literals while 20 carried a documented one), and the version stamped on the row by migration 091.
> Nothing re-graded. A test pins the boundaries and the version as one tuple so neither moves alone.
>
> The `StudyEvidencePolicy` object sketched above was **deliberately not built**: an indirection layer
> over one function with one implementation adds structure without removing a risk. Recorded here so
> it is a decision rather than an omission.
>
> Migration 091 also had to work around the table: `study_trials` is append-only, so an `UPDATE`
> backfill would have been refused by its own trigger. `ADD COLUMN … NOT NULL DEFAULT` fills history
> through the catalog with no row trigger, and the default is then **dropped** so no future insert can
> acquire a version it never declared. Backfilling is honest here, unlike migration 089: every row
> *was* graded by boundaries still in force, so the label states a fact. A version says which code
> ran; a price claims something about the market.
>
> **Whether 5 / 20 / 60 are the right numbers is untouched and still Research's.** Best asked when
> `momentum-v5-research` nears 20 sessions with real interval widths to look at; a revision is now a
> one-line version bump that the test forces.

---

## Gap 7: `SnapshotRef` Must Be Content-Addressed, Not a Timestamp Query

Invariant I21 says a `SnapshotRef` resolves to immutable data. There is a live mechanism in this
system that will violate it if `SnapshotRef` is implemented as a range query: **index candle gaps
self-heal nightly at 16:18, append-only.**

So a reference meaning *"everything through 15:00"* resolves to one byte sequence before the heal and
a different one after — same reference, different data, no error raised.

```
WRONG                               RIGHT
SnapshotRef                         SnapshotRef
    ↓                                   ↓
timestamp query                     immutable object version
    ↓                                   ↓
current database state              content hash
```

### The required test (Gate B2)

```
seal a snapshot        → record bytes + hash
heal a gap in the underlying source storage  (append a bar)
resolve the SAME ref
assert bytes identical
assert hash identical
```

This should be treated as the highest-value single test in Platform P0. It is the one that decides
whether replay means anything.

---

## Gap 8: Frozen-Market Data Is a Third Data State

### The measured defect

`GRID_POLICY_V1` admits decisions in `(09:15, 15:30]`. From 2026-08-03 the index feed freezes daily
from the 15:16 bar to the close: it keeps publishing bars, on time, correctly stamped, each repeating
the last real print. Measured 2026-08-31, NIFTY50 1m — pinned at 24050.25 with all four OHLC values
identical from 15:15 to 15:28, then a genuine close at 15:29. 41 proposals were already recorded
inside that window.

Every existing gate passes it, because this is staleness **by value**, not by clock:

```
timestamp valid              ✓
bar present and complete     ✓
grid-aligned                 ✓
features warmed up           ✓
→ admitted
```

So the taxonomy needs a third state, not a tighter version of the second:

```
DATA NOT AVAILABLE
DATA PRESENT BUT NOT YET COMPUTED
DATA PRESENT BUT ECONOMICALLY FROZEN     ← new
```

### The invariant

> A timestamp-valid sample is not decision-ready unless the underlying data contains sufficient fresh
> market information according to the instrument's declared data-activity policy.

### Separate the two policies — do not redefine the grid

```
GRID_POLICY_V1              = temporal eligibility        (unchanged)
TAPE_LIVENESS_V1            = information freshness       (new)
```

Truncating the grid to 15:15 was considered and **rejected on evidence**: validated against live bars
it discards the genuine 15:29 closing print every session, it encodes a vendor defect into a domain
policy, and it would orphan `GRID_POLICY_V1`, which is pinned into 9,218 terminal settlements.

### The rule must be volume-blind

> [!CAUTION]
> **Do not include zero volume in the condition — not as the test, and not as a conjunct.**

This is not a stylistic preference. It is a defect already observed in shipped code.
`isStaleBar` in `pattern-intelligence/domain/bar-integrity.ts` uses `zero range AND unusable volume`,
and volume across the frozen window on 2026-08-31 runs:

```
0, 0, 0, 0, 125,958,451, 2,883,823, 3,771,801, 4,447,748,
5,601,463, 6,435,973, 5,006,556, 2,782,283, 5,322,076
```

The conjunct turns a 13-bar detection into a 4-bar detection. The cause is structural: **index volume
is a constituent aggregate** (correlation 0.877 with constituent cash volume), so constituents keep
trading and the counter keeps accumulating while the price aggregate is frozen. Price and volume on
an index have independent freshness, so volume can never corroborate price freshness there.

### The rule that works

Value repetition against the time-contiguous predecessor. Calibrated, not chosen — runs of
consecutive OHLC-identical 1m bars, both indices, 21 days:

| Zone | Runs | Longest run | Mean | p99 |
| :--- | ---: | ---: | ---: | ---: |
| Healthy 09:16–15:15 | 10,800 | **1** | 1.00 | 1 |
| Frozen 15:16–15:29 | 72 | **13** | 5.83 | 13 |

Two consecutive identical bars separates the populations with no observed false positive.

Produces:

```
DEFERRED: TAPE_FROZEN
```

### Per-instrument and versioned

The threshold above is calibrated on **index 1m bars only**. An illiquid single stock can legitimately
print identical consecutive minutes, so the threshold must be a declared per-instrument policy value
rather than a global constant, and it must be versioned. Rule: if the threshold or the comparison
changes, the consuming population version changes with it.

### D3 status

| Surface | Status |
| :--- | :--- |
| Scalp research harness | **CLOSED** — implemented and pushed as `5a3d596`. Validated live: 375 session bars per index, 13 refused (15:16–15:28), zero false positives earlier in the session, genuine 15:29 close correctly admitted. `controlPolicyVersion` bumped V2 → V3. |
| Pattern Intelligence (`isStaleBar`) | **CLOSED** — fixed in `946ba5c` (PR #4). The primitive was **relocated to `market-data/domain/tape-liveness.ts`** so both modules share one implementation rather than duplicating it, the test is volume-blind, the volume-only dropout still survives via an early `high > low` return, and the production call site threads the real predecessor. Verified: 202 test files / 1,765 tests green, typecheck clean. |
| Per-instrument declared threshold | **CLOSED** `919e626`. Declared per instrument keyed by symbol; an **undeclared instrument throws** rather than inheriting the index value, because silently applying an index-calibrated threshold to an illiquid symbol would refuse its thinnest bars as a frozen tape and drop them from the sample with nothing recording the loss. Refuses nothing that runs: both consumers cover NIFTY50 and BANKNIFTY only (17,805 / 15,698 pattern observations), both declared. Verified live — two capture cycles, controls written for both symbols, zero refusals. |
| — *and it does **not** bump `controlPolicyVersion`* | Both declared values are 2, identical to the previous global default, so no bar's verdict moves. Bumping would now be harmful: **D4 refuses matched sets spanning policy versions**, so it would fragment the control population for no behavioural difference. A test pins every declared value to the default, so the first genuine change fails and lands the version obligation on whoever made it. |
| — *`isStaleBar` still uses the default* | It takes a candle and its predecessor with no instrument in scope, so it cannot read the table. The pin above is what stops the two paths diverging silently; when a value first differs, threading an instrument into `isStaleBar` becomes part of that change. |

---

## Gap 9: D4 — Matched-Control Population Homogeneity

> [!CAUTION]
> **This gate needs a research decision and cannot be closed by engineering alone.**

`matchControls` filters candidate controls on `sampleEligible` and the within-session predicates, and
**never on `controlPolicyVersion`**. The version string is persisted on every row and enforced by
nothing, so a matched set drawn across a policy bump is silently heterogeneous.

This predates the D3 work. Measured state:

```
control_points already span:  MATCHED_CONTROL_POPULATION_V1  and  V2   (now V3 as well)
opportunities:                1,881 total
still unmatched:                404  (21%)
```

Those 404 will be matched under whatever rule is in force when the matcher next reaches them.

### The options, and why engineering cannot pick

| Option | Consequence |
| :--- | :--- |
| Filter to the current version | Starves all 404 unmatched opportunities — they can never reach `commonSupport` |
| Require homogeneity, refuse mixed sets with a named reason | Loses only boundary opportunities; adds a third `ControlMatchResult.reason` value |
| Leave unenforced | Matched sets silently mix populations whose eligibility rules differ |

Deciding which population to keep is a research judgement about the evidence base, not a refactor.
**Recorded here rather than resolved silently.**

---

## The Tiered Programme

> [!IMPORTANT]
> The architecture is not changed by this section. The **sequencing** is. The driver is that the
> research plane does not yet hold a promotable artifact, and under this programme's own evidence
> taxonomy it cannot for months.

### Why the original sequencing does not fit the evidence

Measured 2026-08-31:

| Strategy | Sessions | Proposals | Evidence state |
| :--- | ---: | ---: | :--- |
| `momentum-v5-research` | 5 | 436 | `PROVISIONAL` |
| `index-v3-research` | 5 | 318 | TERMINAL |
| `pattern-v4-research` | 5 | 1,327 | TERMINAL |
| `pattern-v4-research-v2` | 2 | 374 | `EARLY_DIAGNOSTIC` |

`SHADOW` requires `RESEARCH_USABLE` (20 sessions). `PAPER` requires `STRONGER_VALIDATION` (60). At
roughly one session per trading day that is ~mid-September and ~mid-November respectively, and shadow
promotion has already been refused twice because no clean session exists yet.

Building six Scalp production phases and five Brain ML phases now means delivering a host with nothing
to host, and an ML pipeline with no defensible target.

### Tier 1 — COMPLETE (2026-09-02)

Everything here raises research integrity or observability and none of it waits on an artifact.

> [!NOTE]
> **All seven lines are built, deployed and verified live.** The two that were open longest closed on
> 2026-09-02: the Terminal Strategy Registry (`74e831d`) and the per-instrument tape thresholds
> (`919e626`). Two items in this block also grew beyond what is written below — see *Gap 13* for the
> propagation gap the registry exposed, and *Gap 14* for the fourth attribution verdict and the
> underlying-path measurement the Outcome Engine needed before it could answer its own question.

```
Platform P0
    minus hashing unification
    plus identity relocation + golden pins        (D1)

DecisionAuditRecord + strategyEvaluationStatus
Three-layer Outcome Engine
Brain P1 Contracts / P2 PIT+Snapshot / P3 Ledger
Brain P11 Outcomes / P12 Replay
Terminal Strategy Registry                          (74e831d)
Value-staleness policy + per-instrument thresholds  (919e626)  (D3 remainder)
```

Brain P11 and P12 are pulled forward deliberately. Existing defects already demonstrate their value:
a model-mark error that reported +₹2,032 on a position down ₹651, and three exit defects that booked a
target as a stop-loss. Both are **execution-layer** faults that a three-layer outcome split isolates
immediately, and neither is diagnosable without replay.

### Tier 2 — Start when evidence justifies it

```
momentum-v5  →  RESEARCH_USABLE  →  Scalp Phase 2 Promotion Registry
                                 →  Scalp Phase 3 Runtime + proposalKey equivalence test
```

Building the registry ahead of the artifact is reasonable. Building the host is not.

### Tier 3 — Hold

```
Brain P14–P18   Directional ML Edge
Brain P19       Paper authority
Scalp Phase 4–6 Strategy host, cutover
```

### The distinction that matters

The Brain architecture is **not** paused. Its integrity half is Tier 1.

```
BRAIN
  Contracts / PIT / Ledger / Outcomes / Replay   →  BUILD NOW
  Directional ML / paper authority               →  WAIT FOR A DEFENSIBLE TARGET
```

The historical directional record is what justifies the second line: negative measurements across
triple-barrier, 15m direction, the tier sweep, HTF confluence, pattern gating, and RAG retrieval.
Volatility expansion is the one target with real signal and it fails the cost-aware straddle gate.
That is a reason to pause directional *delivery*, not to abandon the decision architecture.

### Tier 3 release criteria (defined 2026-09-02)

Until now Tier 3's condition was the phrase "wait for a defensible target". Tier 2's condition is
measurable — 20 sessions, currently 7 — and Tier 3's was not, which is how a tier stays held by
default: nobody can say when it is met, so it never is.

The three items in Tier 3 do **not** share a blocker, so they do not share a criterion.

Every threshold below is **referenced, not copied**, per Gap 6: the session counts live in
`EVIDENCE_POLICY_V1` as `provisionalSessionMinimum`, `decisionGradeSessionMinimum` and
`strongerValidationSessionMinimum`. Quoting numbers here would create the second copy that gate exists
to prevent.

#### T3-A — Brain P14-P18 (Directional ML Edge)

Requires a **defensible target**, which now means a registered study whose artifact clears all six of
these. None is substitutable, and each one is here because it is what killed a previous candidate:

| # | Requirement | The candidate it killed |
| :--- | :--- | :--- |
| 1 | Pre-registered: a `study_registrations` row with a pinned `study_definition_hash` written **before** any result is read | Both of 2026-09-02's sweeps needed this to mean anything; without it a sweep is a search for a pass |
| 2 | Beats trivial on **accuracy as well as macro-F1** | Macro-F1 alone passed a directional target that accuracy then killed — class-spreading looks like skill |
| 3 | Clears a noise floor at the observed n, via the day-clustered estimator, and not on a degenerate interval | `trend-breakout` 60m: four cells above break-even, every one inside the floor at n=12-25 |
| 4 | Replicates cross-instrument on the same side | 15m LONG cleared on NIFTY50 and lost on BANKNIFTY, with SHORT flipping; HTF confluence won on 2 ETFs and made 14 of 20 equities worse |
| 5 | Survives an era/holdout confirmation outside the fold that produced it | 15m direction passed the screen and died on era holdout; the daily gate hung on one noisy fold |
| 6 | Clears the **cost-aware gate** on a tradable instrument at a real tenor | 60m volatility-expansion: precision 0.47 against a 0.24 base rate, then ~0.5 bps of spot against ~5 bps of fees |

Plus an evidence state of at least `STRONGER_VALIDATION` as `EVIDENCE_POLICY_V1` defines it.

Requirement 6 is the one to watch. It has killed the only target in this system's history with real
statistical skill, so it is not a formality appended to a list — it is the criterion the others exist
to earn the right to reach.

#### T3-B — Brain P19 (paper authority)

**Not gated on a target at all.** P19 sits *after* V1 retirement, so its criterion is the migration:

1. P13 reports `promotable: true` for a `NATIVE` producer, with `decisiveComparisons > 0` — agreement
   that nobody traded is not evidence of substitutability.
2. Every divergence classified: no `UNKNOWN` remaining, and every `BUG` carrying a resolution.
3. The producer receiving authority passes `assertMayHoldAuthority`, i.e. is `NATIVE`. A ported rule
   can never be the vehicle, by §6 and by type.

T3-B is therefore satisfiable **without** T3-A, and the consequence should be stated plainly: the only
authority-eligible producer today is `structuralGateThesisProducer`, which can never return `APPROVED`.
Meeting T3-B grants paper authority to a system that places no trades. That is coherent — "V1 retired"
and "V2.2 trading" are separate milestones — and only the first is reachable on current evidence.

#### T3-C — Scalp Phase 4-6 (strategy host, cutover)

Gated on Tier 2's artifact, not on directional work — *"building the registry ahead of the artifact is
reasonable, building the host is not"*:

1. A scalp research strategy at evidence state `STRONGER_VALIDATION` per `EVIDENCE_POLICY_V1`.
2. Shadow promotion actually granted. It has been refused twice, both times because no clean session
   existed, so this is a real condition rather than a formality.
3. That strategy's `productionEligibility` is not `NEVER_ELIGIBLE`.

#### The valve: how Tier 3 closes rather than waits forever

A held tier with no exit is a tier that misrepresents itself as open. So T3-A is reviewed on
`RESEARCH_REVIEW_POLICY_V1`'s cadence, and **marking T3-A `NEVER_ELIGIBLE` is an available outcome** —
a governed promotion decision with human sign-off, exactly like an advance. The directional record is
already negative across triple-barrier, 15m direction, the tier sweep, HTF confluence, pattern gating,
RAG retrieval, 30m/60m directional, and 60m/1d trend-breakout on adequate samples. If that record
keeps accumulating without a candidate reaching requirement 6, the honest act is to close T3-A and say
so, not to leave P14-P18 nominally pending for another year.

Closing T3-A would not close T3-B or T3-C. They have their own criteria above, and neither needs a
directional edge.

---

## Gap 10: The Bar-Label Convention (found while implementing B1)

Two implementations of the PIT instants already existed, and they disagree in a way no type could
have caught.

| Concept | Pattern Intelligence | Scalp research harness |
| :--- | :--- | :--- |
| labels a bar by | its **open** time | its **close** time |
| `dataThrough` | `detectedCandle.openTime` | `decisionAt - 1ms`, where `decisionAt` is the close |
| `knownAt` | `max(detectedAt, dataVintageAt)` | not modelled |
| `earliestExecutionAt` | first bar opening strictly after `knownAt` | **not modelled at all** |

For the 1-minute bar spanning 15:20:00–15:21:00, Pattern Intelligence records `dataThrough` as
`15:20:00.000` and the harness records `15:20:59.999`. Both are correct about the same bar. Neither is
convertible to the other without knowing which convention produced it, and the field name carries no
hint.

The translation exists in exactly one place today — the harness runner passes
`context.candle.openTime` when reading observations, which is correct — and is documented nowhere. It
is one edit away from a silent off-by-one-bar join, and the covariate join already reconciles at 93%
rather than 100%.

**So `dataThrough` alone is not a point-in-time fact.** A shared type must carry the convention
alongside the instant, which is what `PitInstants.dataThroughConvention` does. The conversion is total
and its own inverse, so a cross-module join becomes exact rather than approximately right.

`eventAt` and `referenceAt` did not exist in TypeScript at all before this. `referenceAt` is kept
distinct from `earliestExecutionAt` even though Pattern Intelligence sets them equal today: a horizon
of H bars spans the closed bars `[0, H-1]` from Bar 0, and conflating "when we could act" with "what
we measure from" is how that becomes an invisible off-by-one.

> [!IMPORTANT]
> **The primitive is deliberately not yet adopted by its callers.** `dataThrough` is field 6 of the 8
> that make a `proposalKey`, and 9,218 terminal settlements depend on those keys. A primitive that
> "tidied" either derivation would re-identify research history. Adoption is a separate change with
> its own evidence — the same discipline D1 followed.

---

## Gap 11: The Calendar Was Wrong on Six of Eight Non-Regular Sessions (found while implementing B4)

`NseMarketSession` decides tradability from the weekday plus a holiday set, and the non-regular
session catalogue recorded only a *date* and a reason — never a window. Checked against stored 1m
bars:

| Date | Day | Reason | Observed IST window | What the calendar said |
| :--- | :--- | :--- | :--- | :--- |
| 2023-11-12 | Sun | Muhurat evening | 18:15–19:15 | CLOSED (weekend) |
| 2024-01-20 | Sat | Saturday live | 09:15–15:30 | CLOSED (weekend) |
| 2024-03-02 | Sat | Saturday half day | 09:15–12:30 | CLOSED (weekend) |
| 2024-05-18 | Sat | Saturday half day | 09:15–12:30 | CLOSED (weekend) |
| 2024-11-01 | Fri | Muhurat evening | 18:00–19:00 | **REGULAR 09:15–15:30** |
| 2025-02-01 | Sat | Budget session | 09:15–15:30 | CLOSED (weekend) |
| 2025-10-21 | Tue | Muhurat afternoon | 13:45–14:45 | **REGULAR 09:15–15:30** |
| 2026-02-01 | Sun | Budget session | 09:15–15:30 | CLOSED (weekend) |

Two opposite failure modes. Four live sessions carrying 105–750 bars per instrument are reported
closed. Two ordinary weekdays that had **no regular trading at all** are reported as full
09:15–15:30 days — the more dangerous case, because anything asking "is the market open" got a
confident wrong answer for six and a half hours.

**None of the eight appears in `nse_holidays`,** so no amount of holiday-list maintenance would have
fixed either case.

### The rule

Precedence is structural, not a longer list:

```
1. a declared non-regular session wins   <- over the holiday check AND the weekday check
2. a holiday is closed
3. a weekend is closed
4. otherwise regular, with the segment's own bell
```

The exchange announcing a sitting settles whether it traded. Resolution is exchange-agnostic — it
takes windows as input and never names NSE, 09:15 or Muhurat — so the platform layer does not acquire
a dependency on one exchange's timetable. The dated facts stay in `market-data`.

### Window provenance is per entry, and not uniform

`2025-10-21` carries **61 bars per instrument where its announced 13:45–14:45 window allows 60**, the
extra one opening at 14:45. The *announced* close is recorded rather than the observed last bar, and
`isWithinSession` is half-open, so that bar stays detectable as an anomaly instead of being
legitimised by the calendar it contradicts. The three Muhurat windows match their circulars exactly;
the weekend sittings are marked `OBSERVED_FROM_TAPE` because the circulars on file announce the
sitting without a timetable the catalogue can cite.

### Also consolidated

`09:16` / `15:30` existed as bare integers in two research CLIs under two different names
(`REGULAR_SESSION_FIRST_CLOSE = 556`, `REGULAR_FIRST_CLOSE = 556`) and as SQL literals in the
acceptance repository — one fact written four times under three names.

> [!IMPORTANT]
> **Not adopted by `NseMarketSession` yet.** Its `getSession()` feeds `sessionCloseAt` into the
> research harness, and migration 075 is `scalp-research-session-close-boundary` — settlement depends
> on that instant. Adoption is a measured migration with its own evidence, not a drive-by. Until then
> the contract is available and the live defect remains live.

---

## Gap 12: The Audit Record's Own Field List Broke Its "Same Codes" Rule (found while implementing B6)

The Scalp Engine V2 specification states plainly: *"Production must use the **same taxonomy codes**,
not new ones."* Its `DecisionAuditRecord` sketch then listed a parallel set.

| The harness actually emits | The sketch listed |
| :--- | :--- |
| `TAPE_FROZEN` | *absent* — the sketch predates the frozen-tape gate |
| `FEATURE_WARMUP:ATR,EMA,EMA,RSI,SUPERTREND,VWAP` | `DEFERRED_FEATURE_WARMUP` |
| `FEATURE_LAYER_NOT_COMPUTED` | `DEFERRED_FEATURE_NOT_COMPUTED` |

Two renames and an omission. The second rename is the damaging one: the emitted code names **which**
inputs were missing, and a flat `DEFERRED_FEATURE_WARMUP` discards that — precisely the loss that made
the harness abandon its ATR-only eligibility check, when a coarse flag hid which feature was absent.

### The rule, enforced rather than stated

`parseDeferralReason` refuses any family not declared in `DEFERRAL_FAMILIES`, so a new code cannot
appear by accident:

```
family   = platform vocabulary  ("a declared input was not ready")
payload  = domain fact          (which indicators, verbatim, colons and all)
```

Same division that keeps `AccountRiskSnapshot` generic over its evidence type: the shared layer
enforces the shape while staying ignorant of indicator names.

`GRID_MISALIGNED` has no harness counterpart, and that asymmetry is correct rather than an oversight.
The harness calls `assertOnGridDecision`, which **throws** — an off-grid research capture is a bug in
the capture. Production cannot throw at a scheduler tick, so it needs a reportable state for the same
condition.

### "No silent NO_ACTION" is now falsifiable

The specification's requirement is that *every tick must be classifiable from this record*. That is a
claim about whether the fields are **sufficient**, and a field list cannot establish it. `classifyTick`
makes classification a total function, so any combination it cannot resolve is a schema hole that
surfaces at the boundary rather than as an unexplained quiet tick months later.

It throws rather than picking a story when a record contradicts itself: deferred-yet-`EVALUATED`,
candidates alongside `NO_CANDIDATE` admission, a `candidateCount` that disagrees with `candidateIds`,
and an approved candidate carrying a null risk result — which would hide a bypassed gate (I17).

### Thresholds are mostly null, deliberately

A guessed threshold produces the failure that makes monitoring worthless: an alert that fires often
enough to be ignored, after which a real one is invisible too. `NOT_EVALUATED` is a third verdict and
is never folded into `OK`, because "no bar set yet" and "within bounds" are different facts. An
undeclared metric **throws** rather than reporting healthy — a green light with nothing behind it is
worse than no dashboard.

Two thresholds carry values, both derived rather than chosen:

| Metric | Value | Why it is not a judgement call |
| :--- | :--- | :--- |
| `execution.fill_rate` | `0` during market hours | Zero fills means the pipeline is down, whatever the strategy |
| `tape_liveness.frozen_decisions_per_session` | `13` | The measured floor from the index close freeze; materially more means an intraday stall |

`STRUCTURAL_SILENCE_MS` in `collector-health.ts` is the counter-example that justifies the rule: a
hard-coded 300 s, correctly so, because it is derived from the streamer's own reconnect backoff cap
rather than picked.

---

## Gap 13: A Terminal Research Verdict Reached Nothing (found while implementing the Terminal Strategy Registry)

> [!CAUTION]
> **This was a live governance hole, not a documentation tidy-up.** The research harness had recorded
> two strategies as TERMINAL / NEVER_ELIGIBLE — measured, permanent verdicts — while **both of their
> operational twins were trading**, and nothing connected the two records.

Found 2026-09-02 while building §2's registry. The plan's §2 table lists four research strategies;
`research_scalp.strategy_definitions` holds **seven**. And two of the four TERMINAL entries had live
production twins:

| research key | status | operational twin | state when found |
| :--- | :--- | :--- | :--- |
| `index-v3-research` | TERMINAL — `NO_VIABLE_HORIZON` | `momentum-scalp-index` | trading, **−₹12,030 over 155 trades** on its enabled timeframe |
| `pattern-v4-research` | TERMINAL — degrades the base strategy | `momentum-scalp-pattern-v2` | trading, unrestricted |

The index twin carried a registry comment justifying it as *"roughly break-even −₹674 over 76
trades"* — a figure that was stale and understated the loss by a factor of eighteen.

**The mapping is counterintuitive and must be derived from implementation, never from names.**
`pattern-v4-research` wraps `MomentumScalpPatternStrategyV2`, so its twin is the operational **v2**
key despite the research key reading as generation 1. Name similarity would have mapped it wrongly.

### Three further statuses the data forced

`SUPERSEDED` had to be added as a third research status. `index-v2-research`, `momentum-v4-research`
and `pattern-v3-research` are persisted definitions on the retired `scalp-raw-context-v1` feature
schema with **zero captured proposals**. Recording them as TERMINAL would assert a research finding
that was never made — nothing was concluded about them, they were migrated away from. The reason
strings are read by people deciding whether to retry an idea, so the distinction is load-bearing:
`SUPERSEDED` means *not eligible, not revivable under this key, and not evidence against the idea*.

### The link is a test, and cannot be an import

`scalp-research-isolation.test.ts` forbids execution code from importing research internals, and that
severance is the harness's central guarantee. Its scans exclude `*.test.ts`, so a test is the one
place allowed to hold both registries. The link is a **declared key**
(`RegisteredResearchStrategy.operationalStrategyKey`) verified there — not a runtime dependency.

### It requires acknowledgement, not automatic disablement

A research TERMINAL judges a line of inquiry under the harness's canonical geometry. Whether the live
strategy keeps trading is a separate decision with its own evidence, and letting a research
conclusion silently close a production strategy would be the same failure pointing the other way.

What is forbidden is the verdict going **unnoticed**. A registered twin must name the research key,
repeat the closure reason **verbatim**, and state its disposition — required whether the strategy is
enabled or disabled, so that turning one off cannot delete the reasoning that justified it. Silence
fails the build.

Implemented `06880f9`. Guarded both directions: a stale `operationalStrategyKey` fails (it would make
the check inert), and an acknowledgement citing a non-TERMINAL verdict fails too.

---

## Gap 14: The Outcome Engine Could Not Answer Its Own Question (found while adopting Brain P11)

Two defects in the three-layer split, both found by running it over real data rather than by reading
it. Neither is a flaw in the architecture; both are places where the *measurement* could not express
what the architecture promised.

### 14a — A missing verdict: `EXITED_UNRESOLVED`

`attributeShortfall` had three verdicts, each naming a layer that failed, and no way to say **the
position was closed while its thesis was still live**. That case returned null, which reads as
"cannot tell" when the layers in fact agree on something specific.

It was the dominant real case. The first trades ever to carry an observed underlying exit were all
theses whose underlying stopped **short of the thesis stop** — 33%, 40%, 82%, 86% of the way — while
the option position closed first, by its own stop or the 20-minute stall timer.

Deliberately **not** a layer name, because no layer failed, and deliberately neutral about whether
the exit was wrong: an early stop may be correct risk management on a cheap option, or a stop too
tight for the geometry it expresses. It records that the position never got the chance to be right or
wrong — which points at holding period and stop placement rather than at the thesis, strike or fill.
`EXECUTION` is checked first, so a fill that erased a real gain is never absorbed by it (`d0f549d`).

### 14b — `INSTRUMENT` was unreachable, and that was instrumentation, not absence

`INSTRUMENT` — *"the thesis was right and the expression was wrong"* — requires `TARGET_REACHED`.
Across 22 trades with an observed underlying exit, **not one finished at its thesis target**, so the
verdict could never fire. Two mechanisms:

1. The option's own target sits much nearer than the thesis target — it fired at **18–53%** of the
   distance — so the position closes before the underlying arrives.
2. Resolution read only the **exit instant**. A target touched mid-hold and given back was invisible.

(2) was fixable and the data was simply unread: a paper trade's `instrument_id` points at the
**index**, so its own 1m candles cover the whole hold. `resolveUnderlyingPath` (`24a8a51`) walks them
and reports which barrier was touched first.

Live effect on the same 362 trades: **`UNDERLYING` 3 → 6, `EXITED_UNRESOLVED` 9 → 6.** Three trades
moved because the path saw a stop touched mid-hold the endpoint could not.

`INSTRUMENT` remains 0 — and is now **honest absence**. Two trades did touch target; one was
profitable, and the other realised −₹7 on a theoretical **+₹95** with ₹102 of fees, so `EXECUTION`
takes precedence correctly: a positive `theoreticalPnl` proves the instrument captured the move.

`resolutionBasis` (`ENDPOINT` / `PATH_TOUCH`) is recorded on the layer, because the two are not
equally strong claims. A path-derived target may be a 1m wick nobody could have exited on; an
endpoint `UNRESOLVED` means "not resolved at the end", never "never reached a barrier".

---

## Gap 15: The V1 Retirement Track (found while building the differential evidence)

P13 is named at line 238 as *the* gate for V1 retirement, and the plan says nothing about how the
evidence it grades gets produced. Building that surfaced four defects, each of which would have made
the gate report a pass or a coverage figure it had not earned.

### The track as built

| Piece | State | Notes |
| :--- | :--- | :--- |
| §6 adapter ladder (Pattern, MarketContext, Thesis, Execution/Outcome) | Complete | `autonomous-v2/application/` |
| Thesis producer slot | Complete | `structuralGateThesisProducer` — can never return `APPROVED`, asserted as a property |
| Shadow decision path | Live | Holds no execution port; `SHADOW_DECISION` on `*/5 9-15 * * 1-5` |
| Ported V1 producer | Live, `DIFFERENTIAL_ONLY` | `strategy-engine/application/v22-thesis-bridge.ts` |
| P13 gate + stored observations | Live | `differential_observations`, migrations 092–094 |
| Divergence classification | **Not started** | Needs in-window data; every divergence starts `UNKNOWN` and blocks |
| P19 paper authority | Not started | Gated on the above |

### Why the ported producer exists, and why it may never trade

P13 asks whether V2.2 can *substitute* for V1. A V2.2 carrying a different entry rule cannot answer
that: every bar differs, every difference is expected, and the gate measures two strategies instead of
one platform. So V1's rule is ported unchanged and a divergence means a plumbing defect.

It carries `authority: "DIFFERENTIAL_ONLY"` and `assertMayHoldAuthority` throws on it, because §6
licenses a legacy thesis for "differential analysis only, not live decisions" and prose cannot enforce
that once P19 grants authority to *some* producer. It also refuses to *select* between candidates
(`AMBIGUOUS_PROPOSALS`): ranking by confidence is `scoreDirectionalSetup` rebuilt, taking the first is
`patterns[0]`, and both are quarantined by name.

V2.2's measured gates still run first, so on a frozen-tape bar V1 proposes and the ported producer
refuses. That divergence is the finding, not a fault — it classifies as
`EXPECTED_ARCHITECTURAL_CHANGE`.

### Four defects, each found by running it rather than by the suite

1. **Comparing the reason, not the action.** `NO_ACTION NO_PROPOSAL` vs `REJECTED
   OUTSIDE_EXECUTABLE_WINDOW` counted as a divergence though neither system traded. Under whole-string
   equality every bar would diverge for as long as V2.2 has no entry rule — all `UNKNOWN`, all
   blockers, the exact "hundreds of expected divergences is noise" failure the thesis comparison
   already refuses for composite scores. Fixed by splitting action from reason (migration 093).
2. **The gate passed on evidence containing no trades.** `promotable` was `observations.length > 0 &&
   no blockers`, so two agreements on "nobody traded" gave `promotable: true`. A comparison is now
   *decisive* only when at least one system traded, and zero decisive comparisons is a stated blocker.
   A coverage floor, not a sample-size test.
3. **Two producers competed for one row.** The unique key omitted the producer, so native and ported
   collided and the second was dropped by `ON CONFLICT DO NOTHING` — the ported producer could never
   have contributed a row while the scheduler ran native first (migration 094).
4. **The pass covered 1m only.** Measured over 21 days by the bar each proposal came from: **5m — 948
   proposals** (`momentum-scalp-index`, `momentum-scalp-pattern`, `-pattern-v2`), **1m — 179**
   (`momentum-scalp`). That is 85% of live decisions outside the comparison, including
   `momentum-scalp-index`, which is 5m-only, is the largest decision source and the largest loser at
   −₹32,911 over 288 trades. Widening it exposed two more silent failures: the comparison key had no
   timeframe (a 1m and a 5m bar closing at 09:25 collided, every five minutes), and the staleness
   ceiling was a flat three minutes, which would have refused most 5m bars as stale. The tape-liveness
   walk also stepped predecessors by 60 s regardless of timeframe, which finds no predecessor on a 5m
   series and reads a frozen tape as `LIVE` — the D3 gate silently disarmed on the timeframe carrying
   most of V1's decisions.

### Intraday is not covered, and that is a measurement not an omission

`trend-breakout` owns 15m/30m/60m/1d and last proposed on **2026-08-24** — 7 proposals in 21 days,
none in the last 7. Adding those timeframes would add bars and no decisions, inflating `comparisons`
with rows that cannot be decisive; P13's coverage floor would refuse them anyway. So V1's intraday
plane is dormant rather than retired, and retiring it would be vacuous on current evidence.
`--timeframes` covers it without a code change when that strategy proposes again.

### What the track is waiting on

Not engineering. Every production run so far refuses at `OUTSIDE_EXECUTABLE_WINDOW`, so **the approval
path has never executed against production** — it is proved by unit tests only. The first real
exercise is a session bar between 09:20 and 15:30.

---

## Gap 16: The Watchdog Shared Its Subject's Failure Mode (found while investigating COLLECTOR_HEALTH)

`COLLECTOR_HEALTH` reporting DEGRADED turned out to have one root cause with two symptoms, and the
second had been silently destroying trading days.

### The cause: Windows Modern Standby

The host suspends the Docker VM. Correlation is exact — the 2026-09-02 receipt gap in
`option_premium_ticks` ran **11:27:42–11:43:05 IST**, and the Windows power log records event 506
(entering Modern Standby) at **11:27:42** and 507 (exiting) at **11:42:59**.

**Symptom 1 — mid-session quote gaps.** Real data loss, correctly detected. Not new: 08-25 (874 s),
08-26 (742 s), 09-01 (508 s), 09-02 (922 s). This is what `RECEIPT_SILENCE_<n>S` reports.

**Symptom 2 — the scheduler's cron timers stop firing and never recover.** After an overnight standby
the process stays alive but only its frequent, hour-unrestricted cron fires again:

| day | claims | job types |
| :--- | ---: | ---: |
| 08-27 (from 11:10) | 1,440 | 22 |
| **08-28** | **187** | **1** (RSS only) |
| 08-31 | 640 | 17 |
| 09-01 | 1,999 | 21 |

`claimed_by` was the **same process across all three days** — no restart, no crash, no FAILED row.
08-28 cost a full session with zero `option_premium_ticks`, zero `FYERS_AUTH_HEALTH_CHECK` and zero
`COLLECTOR_HEALTH` runs. Index candles were complete and live-written throughout, because they come
from a *different container* — which is what hid it. Recovery only ever came from recreating the
container, so a day of deploys masks this entirely.

### Why the existing liveness check could not fire

`findOverdueScheduledJobs` shipped after the previous stall (`1a7fdf7`) and would have detected this
one. But it was registered on `*/5 9-15 * * 1-5` **inside the same process**, so it died of the exact
condition it existed to report — and its only output was a log line, which is gone once the container
is recreated. *A watchdog that shares its subject's failure mode and writes only to a log is not a
watchdog.*

### The fix, and the three things that make it survive

`87a8edc`. A plain `setInterval` rather than a cron; every decision from the wall clock, so a timer
firing late after a suspend still concludes correctly; and an **exit** (code 75, distinct from 0 and 1)
rather than a message, because `restart: unless-stopped` re-arming the timers is the only action that
can help — the process cannot repair its own schedules.

It measures **firing, not completing**. A job that fires and fails writes a FAILED row and is a
different problem. So the hook wraps cron *registration*, not `schedule()`: several crons legitimately
decline to run their job, and a `schedule()`-level hook would read that as a dead timer. The timestamp
is stamped *before* the handler, so a throwing handler still counts as a fire — otherwise a
persistently failing job would restart the container in a loop.

False positives were the main design risk. Silence is measured from the latest of **last fire, process
start, and window open**; the third is the trap, since a container started at 08:00 has been "silent"
for 65 minutes by 09:05 and measuring from process start alone would restart every container five
minutes into every session.

All 27 registrations now route through `cronSchedule`, which also centralises `timezone: IST`. A source
guard asserts `cron.schedule(` appears exactly once — mutation-tested — and the scheduler throws at
startup if the canary expression is not registered, rather than watching nothing.

### Still open

The **host power settings**. The watchdog restores the scheduler; it cannot recover quotes that were
never received. Stopping Modern Standby during market hours is the only fix for the data loss, and it
is not a code change.

---

## Open Research Observations (not architecture, and deliberately not acted on)

Recorded here so they accumulate. None of these is a task.

### Exits are firing inside one bar's noise

Measured 2026-09-02 over 22 trades carrying an observed underlying exit:

| | median adverse move at exit | median 5m bar range |
| :--- | ---: | ---: |
| NIFTY50 | 15.8 | 16.1 |
| BANKNIFTY | 56.3 | 58.2 |

The adverse move that triggers an exit is **within a single 5m bar's range** on both indices, and the
thesis stop sits meaningfully further out (23.2 and 69.2). The same reading from the other side:
`EXITED_UNRESOLVED` on 6 of the layered trades, and 0 of 22 ever reached a thesis target.

> [!WARNING]
> **Do not turn this into a tuning lever from one session.** The obvious inference — widen the stop —
> is exactly what the sweeps already tested: `NO_VIABLE_STOP_MULTIPLE` and `NO_VIABLE_HORIZON`. This
> is better read as *corroborating why those came back empty* than as a new lever. The correct action
> is: record → accumulate across sessions → re-evaluate. Every close now records the adverse move, so
> this is cheap to test properly later.

Session context matters for how much weight this carries: BANKNIFTY finished 2026-09-02's morning
**0.3 points from its open** after a 398-point round trip, so the sample is drawn from chop.

### Side asymmetry on both live scalps, and what was done about it

| strategy | side | trades | win % | net |
| :--- | :--- | ---: | ---: | ---: |
| Momentum Scalp (Index) | SHORT | 94 | 47.9% | +₹2,899 |
| Momentum Scalp (Index) | **LONG** | 62 | 35.5% | **−₹13,414** — disabled `7d18e48` |
| Momentum Scalp (Pattern Confluence) | SHORT | 32 | 50.0% | +₹424 |
| Momentum Scalp (Pattern Confluence) | **LONG** | 36 | 36.1% | **−₹8,531** — disabled `bf7fc9e` |

Declared **per strategy** on the registration, not through the generator's global `allowedSides`,
which would have silenced the side across every strategy in the run. Filtering happens at *idea
generation*, which is only defensible because the research harness evaluates its frozen twins ungated
and captures every bar — so the suppressed population stays measurable. That claim is enforced: an
isolation test fails if any research file reads `executableSides`.

The near-identical split across two strategies is recorded as **suggestive, not confirmatory** — both
are built on the same momentum architecture, so it is plausibly one flaw observed twice. Neither
decision rests on it.

No edge is claimed for either short side. Pattern Confluence's +₹424 over 32 trades is barely
distinguishable from zero and is the first review candidate.

### Resolved decision: `momentum-scalp-pattern-v2` (2026-09-02)

Disabled both sides (`7f6ef16`) on asymmetric evidence: a TERMINAL verdict measured over 13.7k–18.6k
trades per cell against **3 closed trades totalling +₹1,335**. Three trades cannot overturn that
prior, and leaving it enabled is how a small positive run quietly becomes a positive result.

Disabled operationally, preserved scientifically — registered rather than deleted, so its lineage and
reasoning survive and the research twin keeps measuring ungated. **Not marked TERMINAL**: the
generation-2 pattern question is unanswered, not closed, so `pattern-v4-research-v2` stays
`RESEARCH / NOT_YET_ELIGIBLE`.

---

## Readiness Gates (was: Pre-Coding Checklist)

> [!CAUTION]
> **PLATFORM GATE D2.** The previous single 12-item checklist contained a circular dependency and
> could never have been completed. Item 8 required adding fields to `StrategyPromotionRecord`, but
> that type does not exist and is created in **Scalp Phase 2** — which the checklist itself blocked.
> Items 1–5 had a milder version of the same problem: they *are* Platform P0 implementation, listed
> as things to finish before coding starts.
>
> The fix is to separate a **design gate** (artifacts that must exist before domain code) from a
> **Platform P0 exit gate** (implementation that must be complete and tested), and to move item 8
> into the phase that owns it.

### Gate A — Pre-Domain Design Gate

Design artifacts only. No implementation. Blocks Brain P1+ and Scalp Phase 1+.

| # | Item | Verified by | Status |
| :--- | :--- | :--- | :--- |
| A1 | Platform contracts defined (PIT, Snapshot, Calendar, Risk primitives, Identity) | Platform | **DONE** — realised by Gate B B1–B5 under `modules/platform/{pit,snapshot,calendar,risk,identity}`, 89 tests plus a layering guard. |
| A2 | `PromotionPolicy V1` defined + `PromotionReview` artifact type | Governance | **DONE (design)** — Gap 5: the `PromotionPolicy` interface and the `PROMOTION_POLICY_V1` transition table. Deliberately not in code: this is a design gate, and the types land with the promotion system. |
| A3 | Observability contracts: `DecisionAuditRecord` schema + `ObservabilityPolicy` type | Engineering | **DONE** `6d7b060` — `platform/observability/decision-audit-record.ts` and `observability-policy.ts`. See Gap 12. |
| A4 | Brain/Scalp dependency graph approved — no cross-programme edge except Platform P0 | Engineering | **DONE** — Gap 3 plus **D2 CLOSED** (no circular dependency). Enforced, not just agreed: `platform-layering.test.ts` and `autonomous-v2-quarantine.test.ts` walk the real import graph. |
| A5 | Authority boundaries defined: paper-authority gates for Brain (P19) and Scalp (Phase 6) documented and explicitly distinct from "simulatable" milestones | Engineering | **DONE, and now machine-checked** — `ThesisAuthority` (`NATIVE` / `DIFFERENTIAL_ONLY`) with `assertMayHoldAuthority`, so a legacy-derived thesis cannot reach an execution path. See Gap 15. |
| A6 | Momentum v5 review cadence formalized as `RESEARCH_REVIEW_POLICY_V1` | Research | **DONE (design)** — Gap 5: `reviewIntervalSessions = 5`, `minimumForCandidacy = RESEARCH_USABLE`. Owned by research governance; strategy logic never references session count. |
| A7 | Evidence thresholds referenced by policy, not copied as literals (see Gap 6) | Research | **CLOSED** `4e48695` — `EVIDENCE_POLICY_V1`. See the Gap 6 correction: the duplication this gate was written against did not exist; the real gap was provenance. |

### Gate B — Platform P0 Exit Gate

Implementation complete **and** tested. Blocks any domain phase that consumes the component.

| # | Item | Verified by | Status |
| :--- | :--- | :--- | :--- |
| B1 | PIT primitives implemented + immutability tests | Platform | **DONE** `5398174` — extraction, not greenfield; see Gap 10. 17 unit tests + 400 stored observations reproduced, 0 mismatches |
| B2 | Snapshot Registry implemented + **content-addressed auto-heal test** (see Gap 7) | Platform | **DONE (contract + reference impl)** `c730968` — copy-on-seal with hash dedup; reusable invariant suite. Production store remains Brain P2. A re-query registry passes 9 of 10 and fails only the heal test. |
| B3 | Identity **relocated verbatim** + golden digest pins (**D1**) | Platform | **DONE** `e3e5768` → `e8ce167` → `73e75bb` — R100 rename, 8 pins, 1,500 live keys reproduced |
| B4 | Calendar/session implemented + special-session tests (Muhurat etc.) | Platform | **DONE** `345a186` — found the calendar wrong on 6 of 8 non-regular sessions; see Gap 11. 14 tests + every stored bar on all 8 sessions verified inside its declared window |
| B5 | Risk primitives implemented (contracts only, no domain policy) + concurrency/capacity tests | Platform | **DONE** `47d566f` — resolved a duplicated snapshot shape; `decideCapacity` asserted behaviour-identical to the live implementation. Concurrency isolation stays proven by `verify-cap-concurrency.ts` (two connections, live DB), which unit tests cannot show. Adds a layering guard. |
| B6 | Observability infrastructure contracts implemented | Engineering | **DONE** `6d7b060` — reuses the harness taxonomy rather than the parallel set the spec listed; `classifyTick` makes "no silent NO_ACTION" falsifiable. See Gap 12. |
| B7 | Invariant tests exist for every shared platform component before any domain implementation begins | Engineering | **DONE** — 89 platform tests across 8 files, plus a layering guard. Every component was built test-first or verified against live data. |

### Moved out of the checklist

| Was | Now owned by |
| :--- | :--- |
| Item 8 — DATA_INSPECTED holdout fields on `StrategyPromotionRecord` | **Scalp Phase 2** definition of done |

### Blocking gates summary

No downstream production implementation may begin while any of these is open:

| Gate | Subject | Status |
| :--- | :--- | :--- |
| **D1** | Canonical identity semantics — relocate and pin, never unify | **CLOSED** (`e3e5768`, `e8ce167`, `73e75bb`) |
| **D2** | Readiness graph has no circular dependency | **CLOSED** by this revision |
| **D3** | Frozen-market / value-staleness condition covered | **CLOSED, fully** — both code surfaces (`5a3d596`, `946ba5c`) and the per-instrument declared threshold (`919e626`). No sub-items remain. First live catch on 2026-09-01: **52 control points refused `TAPE_FROZEN`, every one inside the single 15:30 IST closing minute**, which is the defect the gate was built for. |
| **D4** | Matched-control population homogeneity across policy versions | **CLOSED** `88f4869` — homogeneity, not current-version filtering. Measured free: 0 of 1,822 stored matched sets mixed, 0 of 468 unmatched opportunities refused, all 468 keep a pool of ≥5. |
