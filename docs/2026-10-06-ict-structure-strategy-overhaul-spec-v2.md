# Frozen Specification: ICT Strategy Overhaul (v2)

> **Status:** Draft v2, pending reviewer sign-off on the 5 items marked `[OPEN — needs reviewer call]` below.
> **Supersedes:** the v1 draft pasted into this session on 2026-10-06.
> **What changed from v1:** every claim in v1 was independently re-verified against the live codebase
> (not re-derived from v1's own wording). All of it checked out — file:line references for every
> verification are inline below. Five gaps were found that v1 didn't address; each is resolved here
> with a concrete recommendation, flagged `[OPEN]` where it's a judgment call rather than a fact.

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

**`[OPEN — needs reviewer call]`** Recommendation: keep the floor, carried into the per-instrument
profile as `minimumRiskReward` rather than a hardcoded constant (since Gold and the indices may
reasonably want different floors once there's real settled data for each). Defaulted to the existing
`1.2` for both instrument classes until evidence says otherwise. Added to the geometry above as the
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

**Action item**: add `atr14: number | null` to `IctStateCompositeSnapshot`, sourced from the tracker
instance the composite engine already owns. Small, mechanical, not a design question — listed here so
it's a planned step rather than a mid-implementation surprise.

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

### [NEW in v2] Item 3 — should this uniqueness be permanent, or scoped to "while still active"?

v1's index has no status qualifier: once a `setupId` is ever persisted, it can never be proposed again
— even after that idea expires unresolved or stops out, and the *same* structural level later gets a
legitimate second test. That may or may not be the intended behavior.

**`[OPEN — needs reviewer call]`** Recommendation: scope the partial index to `status = 'PROPOSED'`.
Postgres re-evaluates a partial index's predicate per-row as the row's indexed column changes, so a row
moving from `PROPOSED` to `EXPIRED`/`REJECTED`/`ACCEPTED` is removed from the index automatically — a
genuinely new attempt at the same structural level is then free to insert once the first one has
resolved one way or another, while simultaneous duplicates (the actual bug) are still blocked exactly
as v1 intended.

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

### [NEW in v2] Item 4 — relationship to the already-shipped application-level dedup guard

Independently of this plan, an application-level duplicate guard already shipped this session
(`TradeIdeaRepository.findActiveDuplicate`, fuzzy 0.1%-relative target-price match against
already-`PROPOSED`, not-yet-expired ideas — PR
[fix/gold-ict-idea-dedup](https://github.com/Kulwinder1501/ai-quant-lab/pull/new/fix/gold-ict-idea-dedup)).
The DB-level unique index here is strictly more correct (atomic, exact match on the real structural
event identity, race-proof under true concurrency vs. the app-level check-then-insert).

**Recommendation (not open — this one's just a call I'm making)**: keep both. The app-level check stays
useful as a cheap pre-filter that avoids even attempting an insert the DB is going to reject, and
neither correctness nor performance is harmed by the overlap. No action needed beyond landing this
spec's index.

### [NEW in v2] Item 5 — existing duplicate/stale rows are not addressed

Not a flaw in the design, just unaddressed: as of 2026-10-06 the DB already has real duplicate rows (16
`trade_ideas` sharing one target/stop over 4 hours) and ~97 ideas that timed out unresolved under the
pre-fix expiry bug. The new unique index applies only to future inserts; it does nothing to this
existing data.

**`[OPEN — needs reviewer call]`**: leave the historical rows as-is (they're inert — `PROPOSED` but past
`expires_at`, never read again by anything), or run a one-time cleanup marking them `EXPIRED`. Either
is fine; just worth a deliberate choice rather than silence.

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
- **[NEW] Re-entry after resolution:** an idea that reaches `EXPIRED`/`REJECTED`/`ACCEPTED` for a given
  `setupId`, followed by a fresh confirmation producing the *same* `setupId`, → a new `PROPOSED` row is
  permitted (confirms the `status = 'PROPOSED'` scoping in item 3 behaves as intended, not as a
  permanent block).
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

## Summary of open items for the reviewer

| # | Item | v1 status | v2 recommendation |
|---|---|---|---|
| 1 | Minimum risk-reward floor | Missing | Keep it, per-profile, default 1.2 |
| 2 | ATR not exposed on snapshot | Unlisted prerequisite | Add `atr14` to `IctStateCompositeSnapshot` |
| 3 | Setup uniqueness scope | Permanent (unstated) | Scope to `status = 'PROPOSED'` |
| 4 | Overlap with shipped app-level dedup | Not mentioned | Keep both, no conflict |
| 5 | Existing duplicate/stale rows | Not mentioned | Reviewer's call: leave or one-time cleanup |

Items 1 and 3 are genuine judgment calls, not facts to verify — flagged for the reviewer rather than
decided unilaterally here.
