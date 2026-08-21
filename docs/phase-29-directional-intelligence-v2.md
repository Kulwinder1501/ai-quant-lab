# Phase 29 — Directional Intelligence V2 (Label Study)

**STATUS: PROTOCOL. NOTHING BUILT.**

A label study, not a strategy. Its question is narrow and prior: **which formulation of "direction" is
learnable at all**, before a single model is tuned. The best possible outcome of D0/D1 is "target X
is more learnable than target Y" — which is genuinely valuable and is *not* an edge. §2.1 is what
converts a learnable label into a tradable one, and on this project's record that conversion is
exactly where directional work has died every time.

Adapted from a frozen blueprint (D0.2). The experimental design is kept nearly intact; four required
additions and one structural change are recorded in §2 and §3, each traceable to a specific failure
in this repository rather than to general good practice.

---

## 0. Why this phase exists, and why it is not more timeframe hunting

The directional track has failed twice, in two different ways, and the second failure is the one that
sets this phase's target.

**The ML path never reached production.** Thirty-plus directional model versions sit in
`model_versions` (`market-direction-*`, `directional-lightgbm/xgboost-*`), and `model_predictions`
holds **zero rows**. No code writes to that table; `INTRADAY_MODEL_PREDICTIONS` ends in
`ml:predict:volatility-shadow`. The models were trained, evaluated, found wanting, and the inference
path was never built. One stale `PRODUCTION` marker
(`market-direction-lightgbm--BANKNIFTY--60m--h5--neutral-20bps--ml-feature-v7` v2) implies a live
directional model that produces nothing; it should be retired as housekeeping, separately from this
phase.

**The rule-based path failed on cost, not on signal, and that distinction is this phase's whole
premise.** The A→B gate measured `momentum-scalp-index` over 150 sessions and 12,134 trades:

| | value |
|---|---|
| gross expectancy | **+0.0301 R/day (positive)** |
| round-trip cost | 0.3764 R/trade |
| net @ 2bp, NIFTY50 | −0.3887, CI [−0.4731, −0.3044] |
| net @ 2bp, BANKNIFTY | −0.3092, CI [−0.3790, −0.2393] |

The directional signal is **real and roughly 13× too small to pay friction**. Both levers that reduce
cost without touching the signal were then swept to exhaustion: `NO_VIABLE_STOP_MULTIPLE` (cost falls
as 1/width, gross edge ~13× short) and `NO_VIABLE_HORIZON` (lengthening `expiryCandles` 3→75 drove
the resolved share from 0.68 to 0.9999 and the resolved hit rate to 41.1%, a hair over the 40%
break-even, still netting −0.33 R/day with the full CI below zero on both indices). Bar size was
swept last and returned `NO_VIABLE_BAR_SIZE` (2026-08-21).

So the remaining lever is **a bigger move per trade** — and that is a property of the *target*, not of
the model or the geometry. Hence a label study.

**Why the source plan is aimed correctly.** Several of its label families attack move magnitude
directly rather than trying to predict sign better:

- **D0-E (Move-then-Side)** is the strongest idea in the blueprint. When the failure mode is
  "predictions of moves too small to trade", factorising "will it move meaningfully" from "which way"
  is the right decomposition. Its invariant is also specified correctly — Stage 2 trains only on
  `MOVE=1`, validation scores all rows and reconstructs `pUp = pMove × pUpGivenMove` — which is the
  guard against the selection bias that decomposition invites.
- **D0-A**'s threshold in vol units (`futureReturnVolUnits >= k`) is a magnitude filter by
  construction.
- **D0-F**'s time-to-event asks when a *meaningful* move arrives, which bears directly on holding cost.

**Three methodological fixes that map onto named past failures**, kept from the blueprint unchanged:

- Spearman IC, prediction-decile monotonicity and residual IC instead of macro-F1. Macro-F1 alone is
  what made the triple-barrier work look alive — it rewards class-spreading, and comparing it against
  a trivial baseline on accuracy is what killed the directional target in one run.
- `decisionAt` vs `dataThrough`, purging *and* embargo, fold-local scalers, purged-OOF-only metrics.
  This is the leakage class handled properly rather than trusted.
- **Residual IC against a TRAIN-fitted time-of-day prior.** The best control in the blueprint. NSE
  intraday is strongly U-shaped, so a model can post a respectable IC having learned only "the open
  is volatile". Incremental skill over that prior is the honest question.

---

## 1. Kept from the blueprint without change

The decision grid and session invariants (§1), the frozen robust absolute-return EWMA vol estimator
with its explicit `shockMagnitude`/`shockFlag` diagnostic (§2), the independent per-horizon
`ForwardPath` (§3), the six label families (§4), target-specific concurrency and the purging/embargo
distinction (§5), the label-quality report (§6), and the D1 baseline learners and CV safeguards (§7).

Two details worth calling out as correct and easily got wrong: **no intraday rolling window crosses
an overnight boundary**, and **no label may resolve past the session close** (`labelEndAt >
session.closeAt → INVALID`). An overnight gap carried into a trailing range inflates every threshold
that reads it, and a label resolving after the close is unreachable by any trade — both are the same
class of bug as the SMC look-ahead defect that needed migration `048` to clean up after the fact.

---

## 2. Four required additions

Each corresponds to a specific way this repository has produced a false positive.

### 2.1 A cost gate, declared now, before D0 runs

The blueprint states "Information Label Only: No execution costs baked into this layer." That is
defensible for a label study and it is also **exactly how this project has burned itself three times
running** — the A→B gate, the stop sweep and the horizon sweep all looked acceptable until costs were
applied, and all three then returned terminal negatives.

So the D2 gate is written here, before any D0 result exists and therefore before it can be tuned to
fit one:

- Costs come from `brokerage-calculator.ts` in **premium space** (the live options path), not from
  the flat-bps `round-trip-cost.ts` used for the ETF backtest.
- A label family passes D2 only with **non-negative net expectancy on both indices independently**.
- Day-level CI for the expectancy delta must exclude zero, matching the selection rule already used
  by `expectancy-statistics.ts`.

A label family that wins D0 and D1 but fails D2 is a **negative result for the whole family**, not an
invitation to re-tune `k`.

### 2.2 Cross-instrument replication as a pre-registered condition

The most reliable killer in this codebase. HTF confluence was monotone on two ETFs and then made 14
of 20 equities worse. On 2026-08-21 a 3m SHORT rule cleared break-even and beat its baseline on
NIFTY50 while sitting *below* baseline on BANKNIFTY — same rule, same sample, opposite verdict.

**A result on one instrument is not a result.** Every D0/D1/D2 claim must hold on both members of the
relevant pair independently, and a split verdict is recorded as drift rather than pooled away.

### 2.3 Multiplicity control — the biggest hole in the blueprint

Six label families × three horizons × several `k` values is **50+ cells**, and the blueprint specifies
no correction. On 2026-08-21 an eight-cell timeframe sweep in this project produced one apparent
winner at a sub-1pp margin, and that winner was disqualified *by this project's own standard* as what
the null hypothesis does when you look eight times. Fifty cells will produce several.

- Holm–Bonferroni across the pre-declared family, via the existing `applyHolm`.
- Because the cell count is large, also report **Deflated Sharpe / PBO** at the D2 stage, where a
  strategy-level statistic exists to deflate. This is the first place in this project where that
  machinery is actually warranted — it was correctly deferred in Phase 28 for lack of variants to
  control for.
- The family must be **frozen in writing before D0 runs**. Adding a `k` after seeing results makes
  every prior correction invalid.

### 2.4 Placebos and the negative-lag probe

Every safeguard in the blueprint's §7 is CV hygiene — purging, embargo, fold-local preprocessing.
Those prevent the leakage you already know about. Placebos catch the leakage you do not.

Route D1's purged OOF predictions through `runFalsificationHarness` (Phase 28, already built and
tested): sign-flip, block permutation, circular shift, wrong-day-matched-time, plus the negative-lag
probe. The wrong-day placebo is a stronger version of the blueprint's own time-of-day concern — it
destroys day alignment while preserving the intraday profile, so a signal that is really
seasonality shows up as a placebo that scores as well as the real thing.

---

## 3. The structural change: the deep 1m history is on the wrong instruments

Measured 2026-08-21:

| series | sessions | from | notes |
|---|---|---|---|
| NIFTYBEES 1m | **899** | 2023-01-02 | 100% non-zero volume, 23 indicator definitions, 4.12M snapshots |
| BANKBEES 1m | **897** | 2023-01-02 | 99.7% non-zero volume, **17** definitions, 4.12M snapshots |
| NIFTY50 1m | **155** | 2026-01-01 | — |
| BANKNIFTY 1m | **153** | 2026-01-01 | — |

Two consequences, and they reproduce the split that forced the A→B gate's existence:

1. **D0/D1 must run on NIFTYBEES and BANKBEES.** 899 sessions is a real sample for a 50-cell label
   study; 153 is not.
2. **The index 1m block is already consumed three times** — A→B gate, stop sweep, horizon sweep. It
   is in-sample by construction, and any D0 result claimed on it is not out-of-sample. Treat it as a
   replication target under §2.2, never as a clean test.

A genuinely untouched index verdict therefore requires **forward accumulation** from the date this
protocol is frozen. State that plainly rather than spending the block and discovering it later.

**Data-readiness gate before D0 begins**, per the standing pattern: audit the 1m series for missing
sessions, duplicate timestamps, out-of-session bars and session misalignment; holidays and known
short sessions are acceptable, unexplained intra-session gaps are a FAIL that aborts the run. Note
the coverage asymmetry above — BANKBEES carries 17 indicator definitions against NIFTYBEES' 23. Any
feature set for D1 must be the **intersection**, or the two arms are not comparable and a "BANKBEES
does not replicate" verdict would be a coverage artefact rather than a finding. A NIFTYBEES 5m series
once sat at 47.1% indicator coverage and silently produced zero signals for a strategy that later
fired 72,140 times on the same bars.

---

## 4. Stages and gates

**D0 — dataset and label study.** Build the decision grid, the vol estimator, the forward paths and
all six label families on the ETF pair. Produce the §6 label-quality report: class balance by year,
time-of-day and vol regime; label-transition and cross-horizon-transition matrices; and the
**overlap-adjusted sample count with average uniqueness**, which is the number that matters — a 5m
grid over 899 sessions is ~67k raw decisions but far fewer independent ones at a 60m horizon.
*Gate:* a family whose overlap-adjusted count is too small to support D1, or whose class balance is
unstable across years, is dropped here and not carried forward.

**D1 — learnability baselines.** Frozen minimal feature set (the coverage intersection), the
blueprint's baseline learners, purged OOF only, Holm across the frozen family, day-block bootstrap
CIs, residual IC against the time-of-day prior, decile monotonicity — then the §2.4 placebo pass.
*Gate:* survives every placebo, beats the time-of-day prior on residual IC, and holds on both ETFs.

**D2 — cost gate (§2.1).** The surviving families only, on both indices independently, costed in
premium space, with DSR/PBO reported.
*Gate:* non-negative net expectancy on both, day-level CI excluding zero.

**D3 — forward out-of-sample.** Freeze everything and evaluate forward on untouched index data. There
is no untouched historical index block left, so this is the only honest OOS available.

---

## 5. Pre-registered kill conditions

- **D0:** no label family has a usable overlap-adjusted sample → `NO_LEARNABLE_LABEL_GEOMETRY`, stop.
- **D1:** any placebo matches the real IC, or the negative-lag probe breaches its threshold →
  `HARNESS_OR_PIPELINE_FAULT`. Fix it; do not report the IC.
- **D1:** no family beats the time-of-day prior on residual IC after Holm →
  `DIRECTION_NOT_LEARNABLE_BEYOND_SEASONALITY`, stop. This is the most likely outcome.
- **D2:** negative net expectancy on either index → `DIRECTION_DOES_NOT_CLEAR_COSTS`, stop. Do not
  re-tune `k` to force it. This is the condition that has ended every previous directional attempt,
  and repeating it under a new label is still a stop.
- **Any stage:** a result on one instrument and not the other is drift. Record and stop.
- **Any stage:** if the surviving family's implied trade frequency is so low that the overlap-adjusted
  sample cannot reach significance within a season, record `UNTESTABLE_IN_REASONABLE_TIME` rather
  than running it live to find out.
- **Never:** add a label family, horizon or `k` after seeing results. Doing so invalidates every
  multiplicity correction already applied.

---

## 6. What already exists and should be reused

From Phase 28, built and tested 2026-08-21:

- `research/domain/information-coefficient.ts` — Spearman IC, averaged ranks, seeded bootstrap.
  **Needs one extension:** it currently resamples *pairs*; §7 of the blueprint correctly wants
  **day-block** resampling. Small change to a tested function.
- `research/domain/lookahead-guard.ts` — enforces the `decisionAt` / `dataThrough` contract at
  runtime, and refuses an unverifiable timestamp rather than passing it.
- `research/domain/placebos.ts` and `falsification-harness.ts` — §2.4 in full.
- `backtesting/domain/expectancy-statistics.ts` — day-level paired deltas and `applyHolm` for §2.3.
- `paper-trading/domain/brokerage-calculator.ts` — itemized premium-space costs for §2.1. Note it is
  a single flat rate table with **no effective-date concept**, so re-costing history under the rate
  then in force is not currently possible.

## 7. Deferred and open

- **D0-F (survival / competing risks) is deferred to a second pass.** It is the largest build for the
  least certain payoff, and D0-A/B/E already cover the magnitude question that motivates the phase.
  If those three all fail, D0-F is unlikely to rescue the family.
- **Does the ETF→index handoff transfer at all?** The A→B gate answered "no" for one specific
  architecture. It is an open question whether it fails for *every* architecture or only for
  momentum-scalp, and D2 is the first thing that will say.
- **Relationship to Phase 28.** OFI is also a directional signal, aimed at the same "signal too small
  for friction" problem from the data side rather than the label side. They are independent attempts
  at one lever; whichever reports first should not be allowed to justify relaxing the other's gates.
