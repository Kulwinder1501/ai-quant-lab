# Frozen Specification: ICT Strategy Overhaul (v2, final — FROZEN)

> **Status:** **FROZEN.** All 5 open items reviewed and approved by the reviewer. Ready for
> implementation.
> **Supersedes:** v1 (pasted into this session 2026-10-06).
> **Revision history:** first pass below independently re-verified every v1 claim against the live
> codebase and surfaced 5 gaps (2 flagged as open judgment calls). The reviewer then approved items 1-4
> as written; item 5's recommendation (cleanup) was approved too, but its *mechanism* was independently
> re-checked against the live DB and corrected (see item 5) — the risk as originally stated doesn't
> hold, but the real justification is both valid and larger in scope than first written. One
> verification-test wording improvement from the reviewer adopted as proposed.

---

## 0. Why this revision exists

v1 is unusually well-grounded for a planning document — every structural claim in it (the missing
`structureSequenceId` column, `StructureEvent`'s real fields, the single shared strategy version) was
checked line-by-line against the live repository and found accurate. That is not the common case for
documents reviewed this session; most prior ones mixed real numbers with fabricated or inverted
interpretation. This revision keeps v1's architecture intact and adds the five things independent
verification surfaced as missing, so the frozen spec is complete before execution starts rather than
discovered mid-implementation.

---

## 1. Single Strategy, Rich Configuration Profile

Unchanged from v1. Confirmed independently (not from v1's own claim): Gold (`XAU_USD`) and the Indian
indices currently share **one single `strategy_versions` row** — same `ict-structure-v1` key, same
version (`2`), same immutable configuration object (verified live against the DB: `AutoBot-IctNifty15m`
and `AutoBot-IctBankNifty5m` evaluate the identical code/config against NIFTY50/BANKNIFTY, currently
always `RULES_NOT_MET`, while Gold has produced 108 ideas off the same row). The profile format below is
the correct fix for that: one engine, per-instrument calibration via profile, not a forked
implementation.

```typescript
interface IctStructureStrategyProfile {
  instrumentClass: string;
  timezone: string; // IANA timezone (e.g. 'Asia/Kolkata', 'America/New_York')
  allowedSessions: TradingSession[]; // real type, already exists: platform/calendar/trading-session.ts:66

  atrPeriod: number;
  atrStopMultiple: number;
  structuralBufferAtr: number;

  maxTargetR: number;
  maxRiskDistanceAtr: number;

  /** [NEW in v2 — item 1 below] */
  minimumRiskReward: number;
}
```

---

## 2. Robust Trade Geometry & Hard Gates

Unchanged from v1; math re-checked and is sound. `Math.min`/`Math.max` correctly pick the *wider* (more
protective) of the ATR-based and structural stops in each direction — not a bug, a deliberate
"never place the stop tighter than either method alone would" rule.

**LONG Geometry:**
```typescript
const atrStop = entryPrice - atr * profile.atrStopMultiple;
const structuralStop = sweptLow - atr * profile.structuralBufferAtr;
const stopLoss = Math.min(atrStop, structuralStop);
const riskDistance = entryPrice - stopLoss;

// Veto checks
if (riskDistance <= 0 || (riskDistance / atr) > profile.maxRiskDistanceAtr) return [];
if (structuralTarget <= entryPrice) return [];

const maxTarget = entryPrice + profile.maxTargetR * riskDistance;
const takeProfit = Math.min(structuralTarget, maxTarget);

// [NEW in v2 — item 1 below]
const riskReward = (takeProfit - entryPrice) / riskDistance;
if (riskReward < profile.minimumRiskReward) return [];
```

**SHORT Geometry:**
```typescript
const atrStop = entryPrice + atr * profile.atrStopMultiple;
const structuralStop = sweptHigh + atr * profile.structuralBufferAtr;
const stopLoss = Math.max(atrStop, structuralStop);
const riskDistance = stopLoss - entryPrice;

// Veto checks
if (riskDistance <= 0 || (riskDistance / atr) > profile.maxRiskDistanceAtr) return [];
if (structuralTarget >= entryPrice) return [];

const maxTarget = entryPrice - profile.maxTargetR * riskDistance;
const takeProfit = Math.max(structuralTarget, maxTarget);

// [NEW in v2 — item 1 below]
const riskReward = (entryPrice - takeProfit) / riskDistance;
if (riskReward < profile.minimumRiskReward) return [];
```

**Sanity Checks (Default Deny):**
- Reject if ATR is NaN, Infinity, or `<= 0`.
- Reject if missing structural levels or opposing liquidity.

### [NEW in v2] Item 1 — the minimum risk-reward floor was silently dropped in v1

v1's geometry only caps the *maximum* target distance (`maxTargetR`). The strategy's current live
code has a *minimum* gate too — `minimumRiskReward: 1.2`, enforced at
[ict-structure-strategy.ts:555,636](apps/api/src/modules/strategy-engine/domain/ict-structure-strategy.ts:555)
— and v1's 13-step evaluation order has no step for it. Without a floor, a structurally-valid but
barely-profitable setup (say 1.05R) would pass where today it's vetoed.

**`[APPROVED]`** Keep the floor, carried into the per-instrument profile as `minimumRiskReward` rather
than a hardcoded constant (since Gold and the indices may reasonably want different floors once there's
real settled data for each). Defaulted to `1.2` for both instrument classes until evidence says
otherwise — reviewer's framing: this isn't a new trading idea being introduced, it's preserving an
existing live constraint v1 would otherwise have silently dropped. Added to the geometry above as the
last step before the final sanity checks.

---

## 3. Persistent Idempotency & Live Schema Alignment

### Live Schema & Code Inspection Summary — independently re-verified, all accurate

- **`ict_state_snapshots` & `ict_structural_features`**: confirmed directly —
  [105-ict-state-snapshots.ts](apps/api/src/infrastructure/database/migrations/105-ict-state-snapshots.ts)
  and
  [108-ict-structural-features.ts](apps/api/src/infrastructure/database/migrations/108-ict-structural-features.ts)
  — neither table has a `structureSequenceId` column.
- **Canonical Setup Identity Mapping**: confirmed `StructureEvent` really does carry everything this
  needs —
  [structure.ts:7-16](apps/api/src/modules/technical-analysis/domain/ict/structure.ts:7):
  `type` ("BOS"|"CHOCH"|"IDM_CONFIRMED"|"SWEEP"), `level`, `candleTime`, `availableAt`, and
  `brokenPivot: ConfirmedPivot`, which itself carries `.time`
  ([causal-pivot.ts:13-21](apps/api/src/modules/technical-analysis/domain/ict/causal-pivot.ts:13)).
  `IctStructureSnapshot.lastEvent` holds this object stably until a new structure event supersedes it,
  which is exactly the property needed for the same still-valid setup to hash to the same `setupId`
  across many bars of re-evaluation.
- **PIT `sweptLow` / `sweptHigh` Enforcement**: confirmed, `StructureEvent.availableAt` exists and must
  gate every read of it.
- **Single Strategy Registration for Gold & India**: confirmed independently (see §1).

### [NEW in v2] Item 2 — ATR is not actually exposed to the strategy yet

A real, correctly-engineered incremental Wilder ATR(14) tracker exists
(`IctAtrTracker`,
[atr-tracker.ts](apps/api/src/modules/technical-analysis/domain/ict/atr-tracker.ts), O(1) per bar,
matches Wilder's seeding convention exactly) and is already wired into
[composite-engine.ts:58,124](apps/api/src/modules/technical-analysis/domain/ict/composite-engine.ts:58) —
but only to feed `computeDrawOnLiquidity`. `atr14` is **not** currently a field on
`IctStateCompositeSnapshot`, and `ict-structure-strategy.ts` imports nothing from `atr-tracker.ts` at
all. This confirms v1's framing is accurate (today's `rawStop * 0.9995` is genuinely a bare
fixed-0.05%-percentage buffer, not ATR-based) — but it means §2's geometry needs one small, real,
unlisted prerequisite:

**`[APPROVED]`** Action item: add `atr14: number | null` to `IctStateCompositeSnapshot`, sourced from the
tracker instance the composite engine already owns. Reviewer's addition, correct and binding: the
strategy must **not** instantiate its own `IctAtrTracker` — consuming the engine's own instance only
avoids live/replay divergence and duplicate state computation. Small, mechanical, not a design
question — listed here so it's a planned step rather than a mid-implementation surprise.

### Deterministic Setup Hash Definition

Unchanged from v1; fields confirmed to exist under the names mapped above (`eventType`→`.type`,
`confirmationCandleTime`→`.candleTime`, `brokenPivotTime`→`.brokenPivot.time`).

```typescript
const setupId = hash({
  strategyId,
  instrument,
  timeframe,
  confirmationCandleTime,
  brokenPivotTime,
  eventType,
  level,
  direction,
});
```

### Database Uniqueness Expression Index & Semantics

### Item 3 — should this uniqueness be permanent, or scoped to "while still active"?

v1's index has no status qualifier: once a `setupId` is ever persisted, it can never be proposed again
— even after that idea expires unresolved or stops out, and the *same* structural level later gets a
legitimate second test. That may or may not be the intended behavior.

**`[APPROVED]`** Scope the partial index to `status = 'PROPOSED'`. The intended invariant, as stated by
the reviewer: *same setup + currently active proposal → cannot have two; same setup + previous proposal
resolved → may be proposed again.* Postgres re-evaluates a partial index's predicate per-row as the
row's indexed column changes, so a row moving from `PROPOSED` to `EXPIRED`/`REJECTED`/`ACCEPTED` is
removed from the index automatically — a genuinely new attempt at the same structural level is then
free to insert once the first one has resolved one way or another, while simultaneous duplicates (the
actual bug) are still blocked exactly as v1 intended.

```sql
CREATE UNIQUE INDEX trade_ideas_strategy_setup_id_idx
  ON trade_ideas (strategy_version_id, (evidence->>'setupId'))
  WHERE evidence->>'setupId' IS NOT NULL AND status = 'PROPOSED';
```
The partial `WHERE` clause ensures rows without a `setupId` (e.g. older trades from other strategies)
are unaffected, and (new in v2) that a resolved idea never blocks a later, genuinely new one.

**Database Invariant (updated for the `status = 'PROPOSED'` scoping):**
- **No valid setup / gate failure**: 0 persisted authorizations
- **Valid setup, first attempt**: $\le 1$ persisted `PROPOSED` authorization per `(strategy_version_id, setupId)`
- **Concurrent duplicate attempts (same setup, still `PROPOSED`)**: exactly 1 successful database insertion
- **Same setup, after the first attempt resolves**: a new attempt is permitted (this is the v2 change)

### Item 4 — relationship to the already-shipped application-level dedup guard

Independently of this plan, an application-level duplicate guard already shipped this session
(`TradeIdeaRepository.findActiveDuplicate`, fuzzy 0.1%-relative target-price match against
already-`PROPOSED`, not-yet-expired ideas — PR
[fix/gold-ict-idea-dedup](https://github.com/Kulwinder1501/ai-quant-lab/pull/new/fix/gold-ict-idea-dedup),
merged as PR #30). The DB-level unique index here is strictly more correct (atomic, exact match on the
real structural event identity, race-proof under true concurrency vs. the app-level check-then-insert).

**`[APPROVED]`** Keep both, layered: application dedup (fast rejection of the obvious case) →
PostgreSQL unique index (the actual, authoritative concurrency boundary). No conflict, no action needed
beyond landing this spec's index.

### Item 5 — existing stale rows: cleanup approved, mechanism corrected

**`[APPROVED, mechanism corrected]`** The reviewer's proposed cleanup (mark stale `PROPOSED` rows
`EXPIRED` before relying on the new invariant) is the right call — but the specific risk cited
("an old row containing a setupId can block index creation, or continue blocking a future proposal")
does not hold, and the true scope is larger than ICT alone. Both checked directly against the live DB:

- **`SELECT count(*) FROM trade_ideas WHERE evidence ? 'setupId'` → 0.** No existing row can carry a
  `setupId` — that field doesn't exist in the code that wrote them. The partial index's own
  `WHERE evidence->>'setupId' IS NOT NULL` clause means every pre-existing row is invisible to it
  regardless of status; `CREATE UNIQUE INDEX` was never at risk, and no old row can collide with a new
  one via `setupId`.
- **The real reason to do the cleanup**: stale `PROPOSED` rows are invisible to the *new index*, but not
  to anything else that queries `status = 'PROPOSED'` expecting "currently live" — including the shadow
  ledger frontend built this session. Queried live: **1,601 stale `PROPOSED` rows system-wide**, not the
  108 ICT-only rows this document originally scoped to:

  | Strategy | Stale `PROPOSED` rows |
  |---|---|
  | Momentum Scalp (Index) | 679 |
  | Momentum Scalp | 310 |
  | Momentum Scalp (Gold) | 247 |
  | Momentum Scalp v2 (Pattern Confluence) | 129 |
  | ICT Structural Alignment (V1) | 108 |
  | Momentum Scalp (Pattern Confluence) | 106 |
  | AI Autonomous Agent | 22 |

**Approved action**: a one-time, system-wide batch update, using the exact condition this codebase
already uses everywhere else a trade idea gets marked expired (not a newly-invented rule):
```sql
UPDATE trade_ideas
SET status = 'EXPIRED'
WHERE status = 'PROPOSED' AND expires_at IS NOT NULL AND expires_at < now();
```
(Matches [prepare-option-entry.ts:275,371](apps/api/src/modules/paper-trading/application/prepare-option-entry.ts:275)
and [postgres-paper-trade-repository.ts:489](apps/api/src/infrastructure/database/repositories/postgres-paper-trade-repository.ts:489).)
Run this before the index migration ships, system-wide rather than ICT-scoped, since the motivating bug
(phantom "live" rows in anything reading `status = 'PROPOSED'`) applies equally to every strategy.

---

## 4. Final Evaluation Order (updated)

1. PIT / availability validation
2. Killzone gate
3. Structure confirmation
4. Build deterministic setupId
5. Entry validation
6. ATR validation
7. Structural stop
8. Volatility buffer
9. Risk-distance veto
10. Opposing-liquidity validation
11. 3R maximum-target cap
12. **[NEW in v2] Minimum risk-reward floor** (item 1)
13. Directional / numeric sanity checks
14. Atomic idempotent authorization (database persistence, `status = 'PROPOSED'`-scoped unique index)

---

## Verification Plan

### Automated Behavioral Tests

Unchanged from v1, plus one addition:

- **Idempotency:** 10 concurrent evaluations of same setup → exactly 1 persisted authorization.
- **Restart Safety:** Bot restart after first authorization → 0 additional authorizations.
- **Time Invariance:** Same confirmation with different evaluation times → identical `setupId`.
- **Directional Safety:** LONG stops must be `< entry`, SHORT stops `> entry`.
- **Numeric Safety:** Missing ATR, NaN ATR, `<=0` ATR, or invalid targets → NO TRADE.
- **[NEW, reviewer-corrected] Re-entry after EXPIRED (the exact regression case the old lifecycle bug
  lived in):**
  1. insert `PROPOSED` for `setupId` X
  2. mark that row `EXPIRED`
  3. insert a new proposal for the same `setupId` X
  4. → succeeds, and exactly one *current* `PROPOSED` row exists for `(strategy_version_id, X)`.
  `EXPIRED` is the case to assert on specifically, not `REJECTED`/`ACCEPTED` generically — it's the
  state every one of the 1,601 stale rows above is being moved into, so it's the one this test must
  prove doesn't block re-entry.
- **[NEW] Minimum R:R floor:** a setup whose capped `takeProfit` yields `riskReward < minimumRiskReward`
  → NO TRADE (confirms item 1's floor is actually wired in, not just documented).

### Historical Replay Validation

Unchanged from v1 — this is the right discipline and matches how every other finding this session was
validated: *"Success is defined primarily by architectural correctness (0 duplicates, 0 killzone
violations). Economic performance (net P&L) will be logged separately to falsify or validate the
hypothesis."* Do not let a good-looking replay P&L substitute for this — on this exact strategy, the
only real settled evidence gathered so far (97 of 101 live ideas timing out unresolved under the
pre-fix geometry) showed the gap between "the code runs" and "the strategy has edge" is large.

---

## Final decisions (all approved — spec is frozen)

| # | Item | v1 status | Decision |
|---|---|---|---|
| 1 | Minimum risk-reward floor | Missing | **APPROVED** — keep, per-profile, default 1.2 |
| 2 | ATR not exposed on snapshot | Unlisted prerequisite | **APPROVED** — add `atr14` to `IctStateCompositeSnapshot`; strategy must consume the engine's own tracker instance, never its own |
| 3 | Setup uniqueness scope | Permanent (unstated) | **APPROVED** — scope to `status = 'PROPOSED'` |
| 4 | Overlap with shipped app-level dedup | Not mentioned | **APPROVED** — keep both, layered (app pre-filter → DB authoritative boundary) |
| 5 | Existing duplicate/stale rows | Not mentioned | **APPROVED, mechanism corrected** — one-time system-wide cleanup (1,601 rows, not 108), `expires_at < now()` → `EXPIRED`, using the codebase's existing rule; not required for index safety (verified 0 existing rows carry `setupId`), but required so `status = 'PROPOSED'` stays truthful everywhere it's read, including the new shadow ledger |

This document is frozen. Implementation can proceed directly against it.
