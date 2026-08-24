# Phase 29 — Directional Intelligence V2 (Label Study)

**STATUS: D0/D1 BUILT AND AUDITED (FROZEN). D2 COLLECTION ACTIVE; D2 CONFIRMATORY INTERPRETATION
PENDING — SEE §8. D3 NOT STARTED.**

**Session accounting as at 2026-08-24 — observed is not qualified:**

| | count |
|---|---|
| calendar sessions observed | 9 |
| completed (today still in progress) | 8 |
| **coverage-qualified under §8.3** | **0 of 8** |
| target | 60 qualified |

The earlier "8/60" reading counted *observed* sessions. It is superseded: §8.3 defines qualification,
and on the completed sessions to date **no session qualifies**. Collection continues, and the failed
sessions are preserved; the count that governs the evidence minimum is the qualified one.

The D0 dataset/label generator, strict candle audit, target-specific overlap accounting and D1
purged-OOF baselines live under `apps/api/src/modules/research/directional-v2`. This remains a
research path: it is deliberately not connected to live strategy generation, model promotion or
paper trading. D2 has an immutable premium-space runner but has not reached its evidence minimum;
D3 forward OOS remains mandatory before any such wiring.

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

Even one threshold produces multiple label/model families across three horizons, and any later
threshold grid expands that family rapidly. The first D0/D1 pass is frozen at `k = 0.5`
(`tripleBarrierMultiplier = 1.0`); changing or expanding that grid requires a protocol revision
before inspecting results. On 2026-08-21 an eight-cell timeframe sweep in this project produced one
apparent winner at a sub-1pp margin, and that winner was disqualified *by this project's own standard*
as what the null hypothesis does when you look eight times.

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

Measured and strictly audited 2026-08-22 after the settled FYERS refill:

| series | sessions | from | notes |
|---|---|---|---|
| NIFTYBEES 1m | **902 stored / 893 study-eligible** | 2023-01-02 | 336,766 bars; 100% non-zero volume; 14 indicator definitions |
| BANKBEES 1m | **902 stored / 890 study-eligible** | 2023-01-02 | 336,763 bars; 99.7% non-zero volume; 14 indicator definitions |
| NIFTY50 1m | **158** | 2026-01-01 | 59,250 bars after D2 input refill |
| BANKNIFTY 1m | **158** | 2026-01-01 | 59,250 bars after D2 input refill |

Two consequences, and they reproduce the split that forced the A→B gate's existence:

1. **D0/D1 must run on NIFTYBEES and BANKBEES.** Roughly 890 eligible sessions is a real sample for
   a 50-cell label study; 158 is not.
2. **The index 1m block is already consumed three times** — A→B gate, stop sweep, horizon sweep. It
   is in-sample by construction, and any D0 result claimed on it is not out-of-sample. Treat it as a
   replication target under §2.2, never as a clean test.

A genuinely untouched index verdict therefore requires **forward accumulation** from the date this
protocol is frozen. State that plainly rather than spending the block and discovering it later.

**Data-readiness gate before D0 begins**, per the standing pattern: audit the 1m series for missing
sessions, duplicate timestamps, out-of-session bars and session misalignment; holidays and known
short sessions are acceptable, unexplained intra-session gaps are a FAIL that aborts the run. Both
ETF arms currently carry the same 14 audited indicator definitions. Any indicator-based feature set
for D1 must still use the **intersection**, or the two arms are not comparable and a "BANKBEES does
not replicate" verdict would be a coverage artefact rather than a finding. A NIFTYBEES 5m series
once sat at 47.1% indicator coverage and silently produced zero signals for a strategy that later
fired 72,140 times on the same bars.

Special sessions are not silently treated as regular days. A versioned, circular-referenced
allowlist retains them in the candle store but excludes them from this regular-session study and
reports the excluded session and candle counts. Migration `072-historical-nse-holidays` seeds the
2023-2025 cash-market holiday calendar, and migration `073-january-2026-election-holiday` records the
15 January 2026 Maharashtra election closure, so exchange closures are not reported as missing data.
Five sessions containing irreparable invalid FYERS minutes are excluded in full; two isolated 15:30
closing prints are excluded exactly. No synthetic candles are introduced.

The frozen D1 implementation satisfies that constraint by deriving its seven minimal features only
from audited OHLCV fields present on both arms; it does not consume `indicator_snapshots` at all.
Stored indicator-definition counts remain an audit diagnostic, not a D1 input.

---

## 4. Stages and gates

**D0 — dataset and label study.** Build the decision grid, the vol estimator, the forward paths and
all six label families on the ETF pair. Produce the §6 label-quality report: class balance by year,
time-of-day and vol regime; label-transition and cross-horizon-transition matrices; and the
**overlap-adjusted sample count with average uniqueness**, which is the number that matters — a 5m
grid over roughly 890 sessions is ~66k raw decisions but far fewer independent ones at a 60m horizon.
*Gate:* a family whose overlap-adjusted count is too small to support D1, or whose class balance is
unstable across years, is dropped here and not carried forward.

**D1 — learnability baselines.** Frozen minimal feature set (the coverage intersection), the
blueprint's baseline learners, purged OOF only, Holm across the frozen family, day-block bootstrap
CIs, residual IC against the time-of-day prior, decile monotonicity — then the §2.4 placebo pass.
*Gate:* survives every placebo, beats the time-of-day prior on residual IC, and holds on both ETFs.

**Frozen D0/D1 result (2026-08-22).** Manifest
`4862abb38ba241dc0a81a2cbb9fc993eefd20b4330fb3e8a909c058a57745a79` produced one cross-instrument
replication: `D0-D Quantile Median` at 30 minutes. Purged-OOF Spearman IC was 0.0441 on NIFTYBEES
(residual IC 0.0441) and 0.0437 on BANKBEES (residual IC 0.0361); both Holm-adjusted p-values were
0.0479 and the hard leakage/placebo checks passed. The negative-lag statistic is diagnostic for this
D1 feature set because its causal price/return features deliberately overlap past resolved returns;
feature-as-of, purging, OOF-only scoring and the remaining placebos remain hard gates. This is a D2
candidate, not evidence that the signal clears execution costs or is ready for live trading.

**D2 — cost gate (§2.1).** The surviving families only, on both indices independently, costed in
premium space, with DSR/PBO reported.
*Gate:* non-negative net expectancy on both, day-level CI excluding zero.

**Frozen D2 implementation and first run (2026-08-22).** Manifest
`36960366c89a02adc06c03656d76ccd489d02ac1e42e8e6915fd8f1dff10d964` fits the selected 30-minute
median-quantile architecture separately on each index using history strictly before the first stored
premium session. Its lower/upper signal tails are fixed from the pre-evaluation training-score
distribution. It buys the nearest-expiry ATM call/put at the first observed ask after `decisionAt`,
sells the identical provider contract at the first observed bid after 30 minutes, permits at most
60 seconds of quote lag, and prevents overlapping positions. The primary scenario adds one adverse
₹0.05 tick to each leg beyond the observed spread and charges the itemized options fee calculator.
Zero- and two-extra-tick scenarios are diagnostics, not selection alternatives.

The first run has only **8** dense premium sessions, below the frozen 60-session minimum. NIFTY50
resolved 40 trades with provisional primary net P&L of **−₹6,618.79** and mean daily premium return
of **−5.2631%** (normal-approximation CI [−9.0549%, −1.4712%]). BANKNIFTY resolved 31 trades with
provisional net P&L of **−₹8,405.79** and mean daily premium return of **−3.2927%** (CI [−6.7306%,
0.1453%]). The formal cross-instrument verdict is therefore `INSUFFICIENT_DATA`, not PASS or FAIL.
No threshold or execution parameter may be retuned while the premium series accumulates. DSR is
reported diagnostically; PBO is explicitly unavailable because Holm advanced only one fully costed
candidate and CSCV requires at least two strategy return series.

### 4.1 D2 accumulation plan and data-source rule

The D2 evidence requirement is **60 distinct NSE premium sessions**, not 60 calendar days and not a
target number of option ticks. As of the close on 2026-08-21, 8 qualifying sessions exist, so **52
additional trading sessions** must be collected. At a normal five-session week this is approximately
10–12 calendar weeks, but exchange holidays and any failed collection day can extend it. This is an
evidence count, not a promised completion date.

The default path is prospective collection on each upcoming NSE session. The existing FYERS
collectors record the index candles, option-chain contract identity and dense ATM bid/ask ticks. A
day counts only when both index features and executable premium quotes pass audit; a market day with
missing or irreparable premium coverage is reported and does not count. While accumulation runs:

1. Keep manifest `36960366c89a02adc06c03656d76ccd489d02ac1e42e8e6915fd8f1dff10d964`, the
   model, tail thresholds, 30-minute holding period, quote-lag rule, costs and lot policy unchanged.
2. Monitor `OPTION_PREMIUM_TICKS` and option-chain collection every trading day. Repair index candles
   from FYERS when possible; never fabricate or interpolate an option quote.
3. Do not treat intermediate P&L, confidence intervals or DSR as a selection result. They are
   provisional diagnostics until both the 60-session and 30-resolved-trade minimums are met.
4. At 60 valid sessions, rerun `npm run research:directional:d2` once under the frozen manifest. PASS
   requires both indices independently to have non-negative primary net expectancy and a day-level
   95% CI whose lower bound is above zero. Otherwise record the pre-registered terminal failure.
5. Start D3 evaluation only after that cross-instrument D2 PASS. No live or paper-trade promotion is
   permitted while D2 is `INSUFFICIENT_DATA`.

There is no source from which *future* sessions can be downloaded in advance. Waiting can be shortened
only by acquiring sufficiently granular historical F&O order-book data. The acceptable paid route is
[NSE Data & Analytics historical F&O order data](https://www.nseindia.com/static/market-data/eod-historical-data-subscription)
or an auditable NSE-authorized equivalent capable of reconstructing point-in-time best bid/ask for the
exact strike and expiry. EOD bhavcopy, OHLC candles and trade prints alone are insufficient because
they cannot reproduce the executable spread or verify contract continuity. Introducing a historical
order-book provider requires a new source-specific importer, provenance audit and manifest revision;
it must not be silently mixed into the FYERS series.

**D3 — forward out-of-sample.** Freeze everything and evaluate forward on untouched index data. There
is no untouched historical index block left, so this is the only honest OOS available.

---

## 5. Pre-registered kill conditions

- **D0:** no label family has a usable overlap-adjusted sample → `NO_LEARNABLE_LABEL_GEOMETRY`, stop.
- **D1:** any hard placebo matches the real IC → `HARNESS_OR_PIPELINE_FAULT`. Fix it; do not report
  the IC. The negative-lag probe is reported diagnostically for causal price-derived features and is
  hard only for feature sets whose construction should make past resolved returns independent.
- **D1:** no family beats the time-of-day prior on residual IC after Holm →
  `DIRECTION_NOT_LEARNABLE_BEYOND_SEASONALITY`, stop. This is the most likely outcome.
- **D2 evidence minimum:** fewer than 60 valid premium sessions or 30 resolved trades on either index
  → `INSUFFICIENT_DATA`. Continue frozen forward collection; do not infer PASS or FAIL from the partial
  sample.
- **D2 after the evidence minimum:** negative net expectancy on either index, or a day-level 95% CI
  whose lower bound does not exceed zero → `DIRECTION_DOES_NOT_CLEAR_COSTS`, stop. Do not re-tune `k`
  or execution thresholds to force it. This is the condition that has ended every previous
  directional attempt, and repeating it under a new label is still a stop.
- **Any stage:** a result on one instrument and not the other is drift. Record and stop.
- **Any stage:** if the surviving family's implied trade frequency is so low that the overlap-adjusted
  sample cannot reach significance within a season, record `UNTESTABLE_IN_REASONABLE_TIME` rather
  than running it live to find out.
- **Never:** add a label family, horizon or `k` after seeing results. Doing so invalidates every
  multiplicity correction already applied.

**§5 is unchanged and remains binding.** §8 adds branches it did not anticipate; it does not relax
any condition above.

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

---

## 8. Pre-registrations of 2026-08-24

Everything in this section was written **before** the 60-session verdict and must be read as
constraining it. Nothing here retunes a threshold, refits a model, or alters an execution rule —
each item either narrows what a verdict may claim, or names an outcome §5 did not have a branch for.
Three of them exist because an outcome-blind audit
(`apps/api/src/interfaces/cli/audit-d2-opportunity-coverage.ts`) measured something about the running
experiment that was not known when the protocol was frozen.

### 8.1 Directional scope: `DOWN_ONLY`

The frozen candidate emits no UP signals at all. Over the eight completed premium sessions, both
indices, 528 scored decisions each:

| | NIFTY50 | BANKNIFTY |
|---|---|---|
| UP threshold (training P90) | 0.486 | 0.723 |
| **highest evaluation score** | **0.329** | **0.676** |
| DOWN threshold (training P10) | −0.809 | −0.463 |
| evaluation median | −0.709 | −0.348 |
| tail candidates DOWN / UP | 174 / **0** | 174 / **0** |

The UP threshold is *mechanically unreachable*: no score in the evaluation window comes near it.
Lower-tail occupancy is 174/528 ≈ **33%** against a nominal 10%, so the whole evaluation score
distribution has shifted down relative to training.

This is not an implementation fault. Thresholds are the training-score percentiles applied
prospectively, which is the correct no-lookahead construction; a distribution shift is exactly what
prospective testing is *for*. **Do not** lower the UP threshold, recentre scores, use evaluation
percentiles, change the tail fraction, or retrain. Any of those would destroy D2.

What changes is the claim. Pre-registered as:

```
directionalScope: "BIDIRECTIONAL" | "UP_ONLY" | "DOWN_ONLY" | "NO_ACTIVE_TAIL"
current value:    DOWN_ONLY
```

- **PASS** supports the economic viability of *the frozen lower-tail downside candidate under this
  prospective regime*. It does **not** establish bidirectional directional skill.
- **FAIL** rejects that same frozen downside candidate and its economic mapping. It does **not**
  establish that directional trading is impossible.

`directionalScope` is a scope diagnostic and carries **no** PASS/FAIL authority. Recording it now is
what stops the one-sidedness being used after the fact to rescue or to kill the result.

Stated plainly, because it narrows the phase's own premise: D2 is no longer testing "does our
surviving directional predictor survive real option costs". It is testing "does the frozen
lower-tail output of the surviving quantile model, under a materially shifted score distribution,
produce positive ATM put economics under the frozen execution policy". That is still a legitimate
question. It is much narrower, and it must not be described as symmetric directional validation at
session 60.

### 8.2 The verdict tree gains a fourth branch

§5 implies PASS / FAIL with drift handled separately. That is insufficient: the coverage audit has
demonstrated that a methodologically sound experiment can end with no directional verdict at all,
simply because prospective capture was inadequate. That is a failure to obtain a valid test — not
evidence about the hypothesis — and conflating the two would be a serious error.

```
                          D2 @ 60 qualified sessions
                                     │
        ┌───────────────┬────────────┴────────────┬───────────────────┐
        │               │                         │                   │
   BOTH PASS       ONE PASSES               NEITHER PASSES     CANNOT REACH 60
        │               │                         │                   │
        ▼               ▼                         ▼                   ▼
CROSS_INSTRUMENT_PASS CROSS_INSTRUMENT_DRIFT       FAIL        INSUFFICIENT_VALID_DATA
        │               │                         │                   │
        ▼               ▼                         ▼                   ▼
   may progress    record + stop            record + stop      record + stop
```

```ts
if (niftyPass && bankNiftyPass) verdict = "CROSS_INSTRUMENT_PASS";
else if (niftyPass !== bankNiftyPass) verdict = "CROSS_INSTRUMENT_DRIFT";
else verdict = "FAIL";
```

`CROSS_INSTRUMENT_DRIFT` **never** means "trade the instrument that worked". It means record, stop,
and require a new hypothesis. No post-hoc single-instrument rescue — this is §2.2 and the existing
§5 drift rule, made explicit as a branch so it cannot become a judgement call after the numbers are
visible.

`INSUFFICIENT_VALID_DATA` is recorded when qualified sessions cannot reach 60 under §8.3. It carries
no directional information whatsoever.

### 8.3 Session qualification: full coverage of the frozen opportunity set

§4.1 already requires that "a day counts only when both index features and executable premium quotes
pass audit". That clause was never implemented. This is its implementation, and deliberately
introduces **no new free parameter** — no minimum tick count, no 90%/95% ratio, no "material gap"
threshold. Every element is derived from rules already frozen.

A session qualifies **iff every opportunity in the frozen D2 opportunity set for that session has
both an entry ask and its exit bid observable under the existing `D2_MAX_QUOTE_LAG_MS` rule.**

100% is appropriate here precisely because it was *not* appropriate over an arbitrary session grid.
An uncovered point at 11:25 when the strategy could not have acted at 11:25 measures nothing; an
uncovered *opportunity* is an unobserved outcome for something the experiment did select, and
admitting the session anyway creates missing-outcome selection.

Two measurements were tried and rejected on the way, recorded so they are not revisited:

- **Raw tick density fails as a discriminator.** The pre-2026-08-17 collector produced ~6× fewer
  ticks per session, yet its opportunity coverage is not systematically worse — the best NIFTY50
  session (2026-08-12, legacy) beats several streamer sessions. Density buys resolution *between*
  decision points, which the 60-second rule never asks about.
- **A minimum-tick threshold was rejected outright** as a free parameter invented after seeing nine
  sessions of data.

The audit must be generated in this physical order, so premium availability cannot influence
selection: index data → frozen model → tail candidates → opportunity set → hash → **only then**
premium quotes.

Ordering statuses:

```
coverageStatus: "PASS" | "FAIL" | "NOT_TESTABLE_NO_OPPORTUNITIES" | "INCOMPLETE"
```

A session with zero opportunities is `NOT_TESTABLE_NO_OPPORTUNITIES`, never a silent PASS — there was
nothing to test. A session is `INCOMPLETE` until its last required exit observation window has
elapsed; incomplete sessions never enter historical quality statistics.

Coverage-failed sessions are **preserved, immutable and reported**. They are excluded from the
confirmatory count, not deleted.

### 8.4 The no-overlap rule is conformant as written — do not "fix" it

`evaluateD2PremiumCostGate` advances its block only when an entry quote is found, so a candidate with
no quote suppresses nothing and premium availability partly determines the later opportunity set.

This was investigated as a suspected defect and **it is not one**. Three independent statements of the
frozen protocol say *position*, never *opportunity* or *signal*: §4 above ("prevents overlapping
positions"), the frozen D2 manifest (`concurrency: "one-open-position-per-underlying"`), and the skip
counter (`overlappingPosition`). A position exists only once an entry fill exists. Production
implements the written rule faithfully.

Changing it would be a different experiment, not a bug fix. A premium-blind resolver — one where a
tail candidate commits its full planned hold the moment it is accepted, regardless of quote
availability — is the better research semantic and is pre-registered here as a **D2R / D2.1**
candidate for a future protocol. It must not replace current D2 semantics.

Measured divergence over the eight completed sessions, both indices:

| resolver | opportunities | uncovered |
|---|---|---|
| `FROZEN_POSITION` (running experiment) | 134 | 59 (44%) |
| `PREMIUM_BLIND` (D2R candidate) | 104 | 34 (33%) |

Missing quotes admit ~29% more opportunities than a clean design would.

### 8.5 D2's confirmatory status is downgraded, and collection continues

Because of §8.4, the realised return sequence is partly determined by data availability. Until that
is reconciled in a successor protocol:

```
D2 data collection:            ACTIVE — continue, unchanged
D2 confirmatory interpretation: PENDING RESOLUTION OF OPPORTUNITY-SET SEMANTICS
```

This is a downgrade of evidentiary status, **not** a stop, and **not** a licence to change anything.
Collector data is irreversible and today's quotes cannot be recreated, so collection continues under
the frozen manifest regardless.

### 8.6 Execution-time semantics are receipt-time, and stay that way

`observed_at` is stamped by the collector (`observedAt: this.now()`), not by the exchange. Comparing
it against `created_at` for post-close rows gives a 2.6–3.9 s mean lag, so those rows were captured
in near real time — they are not backfill carrying a true exchange timestamp. The socket adapter
narrows every payload to five fields before anything downstream sees it, so no exchange clock is
persisted at all.

The frozen rule "first observed ask within 60 s" therefore measures **collector receipt time**.

```
D2 execution-time basis: COLLECTOR_RECEIPT_TIME_V1   ← frozen, do not change mid-experiment
successor protocol:      EXCHANGE_EVENT_TIME_V2
```

For the nine sessions already collected, `exchangeFeedAt = UNKNOWN` and `timeBasis =
COLLECTOR_RECEIPT`. It must **not** be reconstructed from `observed_at`, `created_at`, or an assumed
latency; a guessed exchange timestamp is worse than an explicitly missing one. If a D2 PASS ever
arrives, this limitation is among the first things a replication must challenge before any production
authority is granted.

### 8.7 Known capture defects, and what they are not

Two causes account for essentially all coverage failure. Both are recorded so the eventual verdict
cannot be misread as evidence about direction.

**Daily mid-session downtime.** Every session from 2026-08-12 to 2026-08-24 carries a 16–62 minute
quote gap beginning between 10:59 and 11:49 IST, caused by the server being shut down at that time.
Uncovered rate is **55%** inside 10:00–12:59 IST against **21%** elsewhere; 47 of 59 failures fall in
the 11:00 and 12:00 hours alone. The chain job stalls with it, and because
`selectAtmPremiumContracts` has a 40-minute staleness guard, an outage longer than that previously
cost additional silence after the machine returned. Reaching 60 qualified sessions requires uptime
across the full 09:15–15:40 IST derivatives session.

**ATM band drift unpinning held contracts.** The premium streamer subscribes to a *moving* ATM band;
a 30-minute hold needs a *fixed* contract. `PostgresOpenPositionContractRepository` pins contracts for
open *paper trades*, and a research opportunity is not a paper trade, so nothing pinned it. On
NIFTY50 2026-08-18 an opportunity entered at 14:45 needed an exit bid at 15:15; strikes 24200/24250
were quoted until **15:12:36** and then dropped. Band churn is heavy — 4 to 28 contracts stop being
quoted before 15:00 each session against ~6 subscribed at a time. Fixed by a contract-retention
window on the streamer (collector regime 4); unlike the downtime, this recurs regardless of uptime.

Neither defect is evidence about the alpha hypothesis. If they prevent 60 qualified sessions, the
outcome is `INSUFFICIENT_VALID_DATA` under §8.2.

### 8.8 Collector regimes

Capture provenance is a property of the data, and the boundaries are set by implementation changes,
never by performance:

| regime | window | notes |
|---|---|---|
| 1 — legacy poller | 2026-08-12 → 2026-08-14 | HTTP polling, ~33 s cadence; truncated the F&O session at the 15:30 cash close |
| 2 — streamer-v1 | 2026-08-17 → | socket streaming, `observed_at` only |
| 3 — streamer + source timestamps | not yet started | pending the socket-payload inspection in §8.9 |
| 4 — contract retention | not yet deployed | holds a contract past band exit for one holding period |

At the final report, all qualified sessions are the primary frozen verdict; a regime split is a
**pre-declared diagnostic only**. It must never rescue a result: "overall FAIL, post-streamer PASS"
is recorded as `FAIL` plus evidence of collector-regime sensitivity requiring a new pre-registered
study — the same governance as `CROSS_INSTRUMENT_DRIFT`.

### 8.9 Score-distribution audit, and open items

`ScoreDistributionAudit` — training and evaluation percentiles, tail occupancy, location and scale
shift, PSI — is to be recorded as diagnostic evidence for the eventual replication design. It has
**no decision authority** over D2 and the shift it measures must not be corrected mid-experiment.

Still open at the time of writing, in priority order: FYERS socket key-name inspection on both
`fyersDataSocket` and `fyersTbtSocket` (looking for `exch_feed_time`, `last_traded_time` and sequence
identifiers, key names only); collector-provenance capture; the trial registry with
`RunProvenance`; the future-injection sentinel; and calendar hardening made segment-aware, since NSE
equity derivatives close at 15:40 while the cash session closes at 15:30 — a distinction the legacy
collector conflated.

### 8.10 Status of §8.9's open items, as of 2026-08-24

- **Socket key-name inspection — done.** `exch_feed_time` and `last_traded_time` are present on every
  `fyersDataSocket` message and were being discarded at `parseTick`. Migration 078 stores them with a
  `collector_regime`, nullable and never backfilled. D2's execution basis stays
  `COLLECTOR_RECEIPT_TIME_V1`; these columns are provenance for a successor protocol.
- **Verdict tree — implemented.** `d2-cross-instrument-verdict.ts`, with §8.3 qualification counted
  per session by `D2SessionCoverage` on the cost gate. This corrected a live defect: the previous
  rule returned `FAIL` when one index passed and one failed, which is the `CROSS_INSTRUMENT_DRIFT`
  case, and it had no branch for `INSUFFICIENT_VALID_DATA` at all. Overlap declines are deliberately
  not coverage failures — the no-overlap rule declines those signals as policy, so counting them
  would fail sessions for obeying the protocol.
- **Future-injection sentinel — implemented.** `future-injection-sentinel.ts` corrupts every bar
  after a cut and asserts that pre-cut samples are feature-identical. It compares an explicit feature
  allowlist, never labels, since labels are *defined* by future bars and a whole-sample comparison
  would fire on every row. The generator is injectable so the sentinel is proven to fail on three
  distinct leak shapes; against the frozen generator it reports **no leakage**.
- **Calendar hardening — implemented.** `NseSegment` splits the 15:30 cash close from the 15:40
  equity-derivatives close, effective 2026-08-03, defaulting to `CASH` so no existing caller silently
  gains ten minutes. Historical sessions are not widened retroactively. **The 15:40 date is the
  planner's, not independently verified against an NSE circular here** — correct the constant in
  `nse-market-session.ts` rather than at a call site.
- **`RunProvenance` — implemented.** The D2 artifact now records the commit and whether the tree was
  dirty, closing the gap that a manifest hashes declared policy only, so an identical hash never
  established that the implementation was unchanged.
- **Trial registry — `QUEUED / NOT BLOCKING`.** Not deleted from the architecture. Its value is not
  only PBO: it records research lineage and failures, which survives the fact that PBO/CSCV cannot
  run yet (it needs at least two fully costed return series and Holm advanced one). It is deferred
  because it does not compete well against the live data-integrity work, not because it is unwanted.
  Note that its most concrete consumer, `D2_MULTIPLICITY_TRIALS = 24`, is frozen and must not move
  mid-experiment — a registry may report a differing count as a diagnostic for the replication
  design, never as a correction to the running gate.
- **`CollectorSessionProvenance` — not built as a second authoritative table.** Migration 078 stamps
  `collector_regime` per tick immutably, so session provenance is derivable deterministically from
  raw ticks; a second table would be duplicate authoritative state that can disagree with it. If a
  session-level view is wanted it should be a **read-only derived view or materialised report** over
  those ticks.

### 8.11 `LIVE_BACKFILL_FEATURE_PARITY_V1`

An acceptance test for the coverage gate, deliberately not a backtest. It replays a completed session
against the same code that captured it live — same strategy versions, `featureSchemaVersion`,
algorithm versions, `controlPolicyVersion` and source candles — and asks one question:

> For every sample live capture marked eligible, did it consume the state an after-the-fact
> reconstruction sees?

Three properties are structural rather than matters of care. It **writes nothing** — no write port,
no `save*`, no settlement table — because a diagnostic that mutates the cohort it is diagnosing
destroys the evidence. It **stops before outcomes**: no label, forward path, settlement or P&L is
read, since "live P&L vs backfill P&L" would be a backtest of a session we already have. And it
**fails on zero comparable samples**, because a vacuous pass on an acceptance test gets mistaken for
evidence.

Coverage **ordering** is checked, not merely coverage existence: `coverageSatisfiedAt` (the `MAX` of
first-cover `computed_at` across every required layer and sibling) must precede `sampleCapturedAt`,
and `coverageLagMs` is retained per sample. A coverage row stamped after its own sample reads as
compliance while being exactly the race the gate removes. No timestamp is fabricated for old rows;
migration 079's `ON CONFLICT DO NOTHING` already makes `computed_at` a first-cover time.

**Known limitation, stated rather than hidden.** `raw_context` exists only on proposals, so a bar
that produced no proposal stores no feature vector. Feature-vector parity is therefore checkable only
where **both** sides proposed; eligibility, eligibility reason, coverage ordering and proposal
presence are checkable on every eligible bar, and proposal presence is what catches a silent
under-read on a non-firing bar. Both counts are reported so a reader never assumes the stronger
coverage. Comparing the vectors anyway inflates one fact into nine — measured on 2026-08-24 it
produced 1,146 phantom indicator mismatches against 250 genuine ones.

Run against 2026-08-24 as a negative control, it correctly reports `NO_PARITY`: 750/750 samples fail
coverage ordering (median lag −20 min, since coverage was stamped after the fact) and 470 strategy-bar
combinations proposed in reconstruction but not live. That is the defect, reproduced independently of
the original diagnosis.
