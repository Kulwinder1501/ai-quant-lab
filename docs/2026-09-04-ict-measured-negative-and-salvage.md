# ICT (`ict-state-v1` / `ict-structure-v1`): measured negative, disposition and salvage

Measured 2026-09-04. This document closes out the SMC/ICT upgrade as a **trading**
strategy and records the parts worth reusing. It is written to stand alone: a
reader six months from now should be able to re-derive or overturn the verdict
without this conversation.

## 1. Verdict: no tradeable edge on BANKNIFTY

Walk-forward replay of `ict-structure-v1`, index thesis (points, not option
premium), via `run-backtest.ts --strategy ict-structure-v1`. Costs modelled as
slippage bps per side; no per-order fee (index execution proxy — option fees and
theta were never measured, see §1.2).

| fold | ctx | signals | trades | win% | net (frictionless) | exp/trade | net @2bps | exp @2bps | PF @2bps |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 5m 2026Q1 | 4500 | 14 | 11 | 18 | −771 | −70 | −1035 | −94 | 0.12 |
| 5m 2026Q2 | 4500 | 35 | 15 | 27 | +710 | +47 | +382 | +25 | 1.28 |
| 5m 2026Q3 | 3600 | 12 | 7 | 14 | −463 | −66 | −598 | −100 | 0.15 |
| 15m 2023H1 | 3050 | 56 | 23 | 13 | −1548 | −67 | −1932 | −84 | 0.23 |
| 15m 2023H2 | 3078 | 70 | 19 | 26 | +326 | +17 | −16 | −1 | 0.98 |
| 15m 2024H1 | 3039 | 22 | 10 | 10 | −1019 | −102 | −1214 | −121 | 0.08 |
| 15m 2024H2 | 3129 | 54 | 16 | 6 | −399 | −25 | −706 | −47 | 0.37 |
| 15m 2025H1 | 3075 | 51 | 24 | 25 | +149 | +6 | −340 | −14 | 0.74 |
| 15m 2025H2 | 3130 | 73 | 26 | 8 | −957 | −37 | −1543 | −59 | 0.27 |
| 15m 2026 | 4200 | 36 | 17 | 24 | −3422 | −201 | −3783 | −236 | 0.21 |

Aggregates:

* **5m** — 33 trades. Net −524 frictionless / −1,251 @2bps. 1/3 folds positive.
* **15m** — 135 trades (well powered). Net **−6,869 frictionless** / −9,536 @2bps.
  2/7 folds positive frictionless, **0/7 @2bps**.

Pre-registered gate (set before the grid ran): ≥30 trades per cell to be
interpretable; net-positive expectancy after costs; positive on **both**
timeframes; positive in a **majority of folds**; point estimate above ~2×SE.
**Failed on every criterion.**

### 1.1 Why this is not a cost problem

It loses **frictionless** on both timeframes. Costs deepen the hole but do not
create it, so no execution improvement rescues it. The single positive cell
(5m 2026Q2, +25/trade) does not replicate — the adjacent quarters are −94 and
−100. Treat it as window fit, not edge.

### 1.2 Why the option-premium arm was never measured

The plan's `AutoBot-ICT` arm would measure executable option P&L. It was not run:
option execution only adds fees, slippage and theta on top of a losing index
signal, so it cannot turn this positive. Do not pool index-space results with
option-premium results if that arm is ever built.

### 1.3 Caveats, stated honestly

* **No warmup runway.** Each fold starts cold, so the first one or two sessions
  produce no signals (every pillar is `UNKNOWN` until warm). This *understates
  signal count* slightly; it does not create the losses, which are pervasive
  across all ten folds.
* **Folds, not full windows.** Forced by the engine defect in §4, not by choice.
  Within-fold results are correct because pivot/zone state is bounded by the fold.
* **Engine bugs cannot be fully excluded**, but a bug producing consistent losses
  across ten independent folds and two timeframes would be remarkable — and two
  real correctness bugs were *fixed* before measuring (see §2), which made the
  engine more correct and it still lost.
* **Geometry vs signal is the one open alternative.** Win rates are 6–27% with a
  far-ERL target and a `minimumRiskReward: 1.5` filter. A low-hit-rate/high-R
  design only works if R materialises. See §5.

## 2. Commits that produced this result

Both are correctness work that stands on its own merit and were prerequisites to
trusting any measurement:

* `30d9a82` — separated **coverage from value** (invariant `UNKNOWN != NEUTRAL`):
  a `NEUTRAL` structure/bias value was being reported as `UNKNOWN` coverage, zone
  coverage was hardcoded `COMPLETE`, and an `"UNKNOWN"` HTF string reported
  `COMPLETE`. Made the four-pillar gate fail closed on all six pillars and
  enforce HTF/local direction alignment. Added the per-pillar negative matrix,
  prefix-invariance and `zoneId` stability tests.
* `acbfdf4` — **wired the engine into replay**. Before this, `context.ictSnapshot`
  was never populated, `IctCompositeEngine` was never instantiated, and the
  strategy returned `[]` on every path — it was dead code. Added
  `replay-builder.ts`, which owns the engine state (never the strategy) and
  attaches an immutable snapshot per bar, including a session-anchored HTF pillar.

## 3. Current disposition

* **Code: kept, inert.** `ict-state-v1` is a separate versioned engine;
  `smc-v2` was never touched. `ict-structure-v1` only computes when its strategy
  key is explicitly passed, and it is exempt from the legacy SMC confluence
  wrapper. Zero blast radius on incumbents.
* **DB: deactivated.** Running the backtest called `ensure(registration)`, which
  left `ict-structure-v1` v1 `is_active = TRUE`. Set to `FALSE` on 2026-09-04;
  verified no other strategy's flags changed. Note `ensure()` will re-activate it
  if the strategy is backtested again — re-deactivate afterwards.
* **Live path deliberately NOT built.** Migration `105-ict-state-snapshots` exists
  but **is not applied**, and 6B (compute+persist), 6C (live context load),
  6D (readiness) and 6E (parity) were never implemented. Do not build them for
  this strategy.
* **Pending (optional):** mark the registry entry
  `operationalDisposition: { status: "TERMINAL_UNOWNED", ... }` with this
  evidence, matching the `trend-breakout` precedent in `strategy-registry.ts`.
  Deferred because `strategy-registry.test.ts` pins entries and the sweep in §5
  may yet change the verdict.

## 4. Known engine defect — fix before any full-history or long-running use

The engine grows state without bound:

* `IctStructureTracker.confirmedPivots` is never pruned.
* `liquidity.ts` runs an **O(n²)** equal-high/equal-low pair scan over *all*
  confirmed pivots **every bar**, pushing a pool object per matching pair, so
  `erlPools` per snapshot grows with history.

Consequence: a full-window replay (>~12k bars) **OOMs at a 4 GB heap**. Bounded
folds are fine. A continuously-running live compute job is the worst case for
this and would degrade then crash — another reason the live path was not built.
Also note `liquidity.ts` hardcodes the equal-pool tolerance at `5` bps and
`zones.ts` hardcodes IDM adjacency at `0.005` instead of reading
`IctEngineConfig` — a Phase 0 freeze gap.

## 5. If ever revived: run the exit-geometry sweep first, not a live test

Do **not** "go live to see how it does". A live/paper run is a weaker version of
the test already done: 15m produced 135 trades over 3.7 years of history, so live
paper would need ~3.7 years to match a sample already in hand — and the signal
loses frictionless, so real fills cannot help.

The one test that could overturn the verdict is cheap and runs in replay: hold the
ICT entries fixed and **vary the exit geometry** (fixed 1R/2R, partial at
equilibrium, session-close time stop, trail from CE). `exit-geometry-program-gate-0`
already records that **1.5R was never independently tested**, which is exactly the
filter this strategy uses. Promote only if some geometry flips it positive *and*
replicates across folds and both timeframes.

## 6. Salvage backlog — useful independent of the failed thesis

### S1 (highest value) — `session-levels.ts` → Pattern Intelligence

`DetectPatternIntelligence` accepts `referenceLevels?: { pdh, pdl, pdc }`, but the
CLI calls `.execute({ candles, source })` and **no caller anywhere passes levels**.
So `PDH_SWEEP`, `PDL_SWEEP` and `GAP_STRUCTURE` are computed-but-unreachable: those
detectors can never fire. This is a live blind spot unrelated to ICT.

`session-levels.ts` is the missing piece — a causal per-IST-session PDH/PDL/PDC/PDO
resolver, plus `buildSessionReferenceLevelsMap()` which is **date-keyed** so one
day's levels cannot be applied across a multi-day window (the contamination trap
the plan called out).

Not free: PI enforces an Implementation Gate (`assertDefinitionRegistrable`
requires a `pattern-intelligence.<slug>` id, non-empty `parameters` and
`invalidationConditions`, and `pattern-definition-registry.test.ts` pins every
`definitionHash`), so definitions must be frozen before detectors change. Treat as
a small standalone project, not a patch.

### S2 — `causal-pivot.ts` as a shared exported primitive

Migration `048-purge-look-ahead-smc-snapshots` purged `EQUILIBRIUM_ZONE` rows
precisely because it published on the same bar whose swing had just been confirmed,
and confirming a swing reads the following `pivotLength` bars. The correct rule
lives in `technical-indicator-engine.ts` as a **file-private, unexported**
`swingConfirmedAt`, so nothing else can reuse it. `causal-pivot.ts` is that rule,
exported and tested, returning an explicit `confirmedAtIndex`. Small file that
prevents a bug class already paid for once.

### S3 — corrected session-anchored HTF bucketing (in `replay-builder.ts`)

`higher-timeframe-resolver.ts` groups buckets by **UTC date** and counts bars from
whichever bar appears first, and publishes a bucket only to the *next* base bar.
The replay-builder version anchors buckets to the IST trading session, **discards
incomplete session-end buckets** rather than emitting short synthetic bars, and
makes a same-close bucket visible (`closeTime <= decisionAt`). Nothing populates
`higherTimeframes` today; this is the correct logic for when something does.

### Marginal

* `zones.ts` — FVG/OB lifecycle with stable deterministic ids, fill fraction, CE,
  inversion, invalidation. `smc-confluence.ts` documents that zone lifecycle is
  "not modelled" and smc-v2's `fvg()` sets `active: true` as a stub, so this is a
  capability smc-v2 lacks. Plausible as *features*; unproven as signal.
* `bias.ts` technique — deriving OHLC vs OLHC **path order** from intraday bars,
  because a stored daily OHLC row cannot reveal which of the high/low came first.

### Do not recycle

The four-pillar conjunctive gate, POI ranking, the entry/stop/target geometry and
`ict-structure-strategy.ts` — that is the measured-dead part. Also do not lift
`liquidity.ts`'s equal-pool scan as written (see §4).

## 7. Reproducing the measurement

```bash
# From apps/api, with DATABASE_URL pointing at the v2 database (port 5433).
# Bounded folds only — a full window OOMs, see section 4.
npx tsx src/interfaces/cli/run-backtest.ts \
  --instrument BANKNIFTY --timeframe 15m \
  --from 2026-01-01 --to 2026-09-04 \
  --strategy ict-structure-v1 --slippage-bps 2
```

`ensure()` re-activates the strategy version, so set `is_active = FALSE` again
afterwards (see §3). Raw grid output from the original run:
`logs/ict-measure.jsonl` (gitignored).

## 8. Priority note

This salvage backlog is tidy-up, not opportunity. The higher-value open problem is
the **volatility execution vehicle**: volatility expansion has repeatedly shown
real skill across walk-forward folds, but the cost-aware straddle gate refuses it
(the equity path is dead at a tradable monthly tenor, and the index path refuses
because predicted move size loses to breakeven). That is an execution problem
sitting on top of proven skill, which is worth more than any item in §6.
