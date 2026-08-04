# Phase 25: Data readiness, CatBoost, TCN, and leakage-safe stacking

Status: **master plan with Stage 0 market-context remediation implemented on
2026-08-02**. No advanced model is implemented or promoted by this phase.

## Stage 0 implementation record (2026-08-02)

The five immediate market-context gaps have been closed as follows:

| Gap | Implemented state |
|---|---|
| FII/DII daily collection | Direct NSE current-session collection remains primary; 18:30 IST collection now has 19:15 and 20:15 retries |
| FII/DII historical depth | 70 real-fetch sessions from 2026-03-30 through 2026-07-31 are stored; seeded archive rows are rejected and existing direct-NSE rows are preserved and cross-checked |
| India VIX | Registered in the active v2 database; 632 daily bars from 2024-01-02 plus recent 1m/5m/15m bars and SMA20 snapshots are populated |
| GIFT Nifty | Provider configuration is wired through API and scheduler containers, but remains explicitly `PROVIDER_NOT_CONFIGURED`; NIFTY spot is never substituted for an offshore future |
| Dashboard and freshness | The v2 dashboard displays a 60-session FII/DII + India VIX + GIFT-gap chart with independent missing/stale states and no forward filling |

Operational schedules now include:

- `INDIA_VIX_INTRADAY`: every five minutes during 09:00-15:59 IST on weekdays,
  collecting exact 1m, 5m, and 15m VIX timeframes and recalculating indicators.
- `INDIA_VIX_EOD`: 16:30 IST with 17:15 and 18:15 retries.
- `INSTITUTIONAL_FLOWS`: 18:30 IST with 19:15 and 20:15 retries.

Point-in-time integrity remains unchanged: a session-D FII/DII print is published
at/after 18:30 IST and is therefore unavailable to session-D candles; VIX features
use the same timeframe and require both the VIX candle and its SMA snapshot to exist
before the evidence cutoff. Paper-option IV now rejects VIX closes older than seven
calendar days.

The historical FII/DII bridge is deliberately narrow. NSE exposes the current
provisional cash print, not a range endpoint. The backfill reads a public archive of
daily NSE fetches, accepts only rows marked `fetch-pipeline` or `live-fetch`, verifies
buy-minus-sell arithmetic, rejects `historical-seed`, refuses conflicting duplicates,
and fails if an overlapping row disagrees with a preserved first-party row. It is not
a replacement for the daily direct NSE collector.

Verification recorded on the active v2 stack:

- migration `028-market-context-integrity` applied;
- 70 FII/DII rows (68 archive, 2 direct NSE), idempotent re-run preserved all 70;
- VIX bars: 632 daily, 1,871 one-minute, 375 five-minute, 125 fifteen-minute;
- VIX SMA20 snapshots: 613 daily, 1,852 one-minute, 356 five-minute, 106 fifteen-minute;
- GIFT Nifty rows: 0, correctly reported as provider-not-configured;
- API tests: 317 passed; API and web production builds passed; web lint passed;
- deployed API returned 60 flow sessions and 60 VIX sessions; dashboard returned HTTP 200.

## Stage 0 addendum: database consolidation (2026-08-03)

The Stage-0 record above is accurate but was written against a database that did not
hold the research window. Re-baselining on 2026-08-03 found the project running two
Postgres instances with disjoint contents:

| | v1 — `ai-quant-lab-db`, port 5432 | v2 — `ai-quant-lab-db-v2`, port 5433 |
|---|---|---|
| NIFTY50 `1d` | 883 bars from 2023-01-03 | 99 bars from 2026-03-10 |
| Twenty research equities | 20 symbols, 17,720 bars | 20 symbols, **0 bars** |
| India VIX | 629 daily, stale, unscheduled | 632 daily + intraday, scheduled |
| FII/DII | 1 row | 70 rows with provenance |
| Migration `028-market-context-integrity` | not applied | applied |
| `model_versions` | 66 | 2 |
| Host `.env` `DATABASE_URL` | pointed here | — |

Every Phase 24 measurement came from v1; every Stage-0 remediation landed on v2. Host-run
CLI and ML commands hit v1, meaning any training run would have used the single-row FII/DII
table and unscheduled VIX that Stage 0 exists to fix. **Neither database could satisfy the
Stage 0 exit criterion on its own.**

**Decision: v2 is the system of record.** It carries the newer schema, the applied
migration, the running collectors, and the dashboard. v1's history is Yahoo-sourced and
therefore re-fetchable, so it was re-collected into v2 rather than copied — this keeps a
single provider lineage per series and satisfies invariant 4 (provider consistency)
instead of importing rows of uncertain origin.

Actions taken on 2026-08-03, all additive and idempotent (`--skip-existing`):

| Action | Result |
|---|---|
| NIFTY50 `1d`, Yahoo, 2023-01-01 → 2026-08-03 | 785 persisted, 98 skipped → **883 bars from 2023-01-03** |
| BANKNIFTY `1d`, same range | 784 persisted, 98 skipped → **882 bars** |
| INDIAVIX `1d`, same range | 246 persisted, 632 skipped → **878 bars from 2023-01-03**, closing the pre-2024 gap Phase 24 §5 flagged |
| Twenty research equities `1d`, same range | 887 bars each, **17,740 total, 99.4% with real traded volume** |
| `analysis:calculate-indicators` over all 23 instruments on `1d` | Full `ta-v1` coverage: ATR, BOLLINGER_BANDS, EMA, MACD, RSI, SMA, SUPERTREND across all 23; VWAP across 22 (INDIAVIX has no volume, correctly absent) |
| Host `.env` `DATABASE_URL` repointed to port 5433 | **Corrected 2026-08-03 — this was only half done.** See the correction below |

v1 was **not** deleted. It remains running and readable as an audit trail for the 66
historical `model_versions` rows, which were not migrated because they were trained on a
feature space that the planned `ml-feature-v6` bump retires anyway.

Residual gaps after this consolidation:

- FII/DII still covers 70 sessions (2026-03-30 → 07-31), not a multi-year window. The two
  flow features are thin rather than dead; their trailing normalisation window is short.
- Intraday remains Yahoo-sourced, 100% zero-volume on both indices. Unchanged by this work
  and addressed only by Workstream D.
- GIFT Nifty remains `PROVIDER_NOT_CONFIGURED` with zero rows.
- ~~The Workstream A audit script does not exist yet.~~ **Resolved later the same day** —
  see "Workstream A record" below. The audit exists, is persisted and hashed, gates
  training fail-closed, and Stage 0 is complete.

### Correction: the repoint was incomplete (2026-08-03)

The consolidation above claimed the host `DATABASE_URL` was repointed and that "neither
compose stack reads this value, so only host CLI/ML runs are affected." Both halves were
wrong, and the error surfaced only when the operator ran a CLI command directly and got
`relation "provider_credentials" does not exist`.

Only the repository-root `.env` had been changed. Four env files exist, and three still
pointed at v1:

| File | Was | Now |
|---|---|---|
| `.env` | 5433 | 5433 |
| `apps/api/.env` | **5432** | 5433 |
| `apps/ml/.env` | **5432** | 5433 |
| `apps/web/.env` | **5432** | 5433 |

`apps/ml/.env` is the consequential one: model training reads it, so any training run
would have used v1 — 99 daily bars instead of 883, zero equity bars, one FII/DII row.
The exact split-brain the consolidation claimed to resolve was still live for the ML
path.

Two things hid it. Verification used `export DATABASE_URL=...` before each command, and
`dotenv` does not override an already-set variable, so every check passed against v2
while the files still said v1. And npm workspace scripts set the working directory to
the workspace root, so `apps/api/.env` — not the repository-root file — is what a CLI
run actually loads.

Backups are written beside each file as `.env.bak-pre-v2-repoint`, and `.env.bak*` is
now in `.gitignore`; the first such backup had been left committable while holding live
credentials.

### Workstream D1 decision (2026-08-03), revised the same day

The initial D1 choice was NIFTY/BANKNIFTY futures. Measurement against the live Fyers
endpoint forced a revision, because **futures cannot supply history**:

| Probe | Result |
|---|---|
| `NSE:NIFTY26AUGFUT` (live) | 375 bars, 100% volume |
| `NSE:BANKNIFTY26AUGFUT` (live) | 375 bars, 100% volume |
| `NSE:NIFTY26JULFUT` (expired ~1 month) | `-300 Invalid symbol provided` |
| `NSE:NIFTY26JUNFUT`, `26MARFUT`, `25DECFUT`, `25JUNFUT` | all `-300 Invalid symbol` |

Fyers' history endpoint serves only currently listed contracts. Note also that futures
use `BANKNIFTY` while the index is `NIFTYBANK` — `NSE:NIFTYBANK26AUGFUT` is invalid.

`cont_flag=1` appears to supply the missing history, and must not be used:

| Window | `cont_flag=0` | `cont_flag=1` |
|---|---|---|
| Jan 2026 (contract not yet trading) | no data | 375 bars |
| Jul 2026 (contract live) | firstClose 24305 | firstClose 24208 |

So it invents bars for periods a contract never traded and back-adjusts the ones it did,
by an undocumented method. A back-adjusted price at time T embeds roll factors fixed
after T — look-ahead by construction — and rewriting stored bars is impossible anyway
because completed candles are immutable. The adapter now pins `cont_flag=0` with a test.
Verified to make no difference for index symbols, so index bars already collected are
unaffected.

**Revised decision: a liquid ETF proxy is the intraday instrument, with futures reserved
for a record-forward series.** `NIFTYBEES` is measured at 100% non-zero volume on 1m and
5m back to 2023-01 and is genuinely tradable, which the spot index is not. Registered by
migration `031-etf-index-proxies` alongside the much thinner `BANKBEES` (median 5m volume
~2.4k units, an order of magnitude below NIFTYBEES — a candidate, not an equal). Both are
`is_active = FALSE`.

The spot index is rejected as a training series for volume-dependent features regardless
of its depth: `NSE:NIFTY50-INDEX` 5m reports 0% non-zero volume through 2025 and 100%
from 2026, so any volume feature over a multi-year span is a calendar proxy rather than a
participation measure.

Futures remain correct for forward recording, and every session not recorded is
permanently unavailable — Fyers will not sell it back later. That argues for standing up
contract discovery and a scheduled collector sooner rather than later, but it is a
separate build from this backfill and needs a documented point-in-time rollover policy
first.

### Intraday backfill result (2026-08-03)

`NIFTYBEES`, Fyers, native intervals, no resampling:

| Timeframe | Bars | Sessions | Range | Non-zero volume |
|---|---|---|---|---|
| `1m` | **331,141** | 887 | 2023-01-02 → 2026-07-31 | 100% |
| `5m` | **66,229** | 887 | 2023-01-02 → 2026-07-31 | 100% |

Against the Workstream D gates: the **1m gate is met** — ≥200,000 clean bars, ≥250
distinct sessions, genuine volume, native interval. The 5m gate (≥100,000) is not; Fyers
serves 1m back to 2017-08, so extending the window would close it, at the cost of
including 2019-era liquidity where NIFTYBEES 1m shows only 68% non-zero volume.

Meeting a bar-count gate is necessary and not sufficient. Overlapping windows do not
create independent observations, and no research gate has been evaluated.

Two operational findings from the same work:

- Fyers answers `429 request limit reached` after roughly a dozen rapid requests. The
  adapter now honours `Retry-After`, falls back to exponential backoff capped at 30s, and
  fails loudly once the retry budget is spent. Without this a multi-year 1m campaign dies
  partway and leaves a gap indistinguishable from missing market data.
- One bar in 25,159 was corrupt upstream: the `NIFTYBEES` 5m bar opening 2023-09-21
  09:15 IST reported `open` 213 against its own `low` of 218.33. The importer correctly
  aborted the whole batch. `ImportHistoricalMarketData` gained an opt-in `skipInvalid`
  that counts and reports rejected candles with samples instead of aborting; the strict
  abort remains the default, since for a CSV fixture an invalid row means the file is
  wrong. Exactly one candle was rejected across both timeframes.

The intraday provider is **Fyers**, per `phase-23-fyers-market-data.md`; the operator
opened an account on 2026-08-03, which settles that document's "check Kite first"
question. Phase 23's reserved migration IDs collided with the applied
`028-market-context-integrity` and were renumbered: `029-provider-credentials` is
applied, and the purge is `030-purge-yahoo-scalp-candles`, deliberately **not**
registered in `migrations/index.ts` — it deletes the Yahoo scalp series and must not run
until Fyers has replaced it. The ETF registration that followed took `031`.

This plan consolidates:

- the data-first conclusions in `phase-24-model-capacity-discipline.md`;
- the proposed CatBoost, PyTorch TCN, and stacking architecture supplied for review;
- the existing project contracts for point-in-time data, immutable feature schemas,
  explainable inference, settled predictions, and champion/challenger promotion; and
- the current empirical result that model capacity is not the main constraint.

It is intentionally fail-closed. Passing a technical test such as "the loss converges"
does not make a model eligible for production. Every stage below has a data gate, a
research gate, and an operational gate.

## Executive decision

The proposed direction is useful, but its implementation order must change.

| Proposal | Decision | Reason |
|---|---|---|
| CatBoost for daily models | **Adopt first, as a challenger** | Low integration cost and a valid additional GBDT inductive bias; it must still beat existing trees out of sample and live |
| TCN for 1m/5m scalping | **Approve conditionally, defer implementation** | The sequence architecture is appropriate, but current intraday history, volume, indicator coverage, and microstructure inputs are insufficient |
| Logistic stacking over tree probabilities | **Approve conditionally, after base-model evidence** | Can reduce model-specific variance, but only with nested out-of-fold predictions and genuinely diverse base errors |
| Add PyTorch now | **Reject for this stage** | A dependency is not progress while the TCN data gates fail; keep the normal ML image small until a sequence experiment is authorized |
| TabNet | **Defer** | Current swing sample size and all-numeric tabular schema favor GBDTs |
| TFT | **Defer** | Requires a large multi-instrument, multi-horizon dataset and point-in-time observed/known-future covariates that do not yet exist |
| PPO / deep RL | **Out of scope** | Requires historical L2/tick data and a validated execution simulator, neither of which exists |

The immediate objective is therefore:

> Build enough reliable, point-in-time, economically meaningful data to determine
> whether CatBoost, a compact TCN, and a conservative stack add incremental value over
> LightGBM/XGBoost after costs.

The architecture order is:

```text
data correctness and coverage
        |
        v
target and baseline validation
        |
        v
feature discipline + CatBoost challenger
        |
        v
intraday sequence-readiness gate
        |
        v
compact TCN research candidate
        |
        v
out-of-fold stacking, only if base errors are diverse
        |
        v
settled shadow predictions and rare evidence-backed promotion
```

## Why this phase matters to the project

The project already has the difficult governance machinery:

- Logistic, XGBoost, and LightGBM trainers.
- Immutable swing and scalp feature schemas.
- Scale-free feature construction.
- Fixed-horizon, triple-barrier, and volatility-expansion targets.
- Purged chronological and walk-forward validation.
- Combinatorial Purged Cross-Validation (CPCV) with embargo.
- Label-shuffle, feature-lag, and era-holdout audits.
- Checksummed artifacts and model-specific explanations.
- Settled live directional outcomes.
- A champion/challenger pool where only the PRIMARY drives downstream consumers.
- A scanner that reads stored predictions without triggering inference or execution.

The weak link is the information entering that machinery:

- daily index history still has a low effective sample size;
- current swing models have too many mostly sparse features for the available rows;
- intraday spot-index bars have no genuine traded volume;
- point-in-time option-chain history is absent;
- constituent breadth and cross-index features are not yet in the ML schema;
- the 1m feature set lacks complete production-version indicator coverage; and
- no Level-2 order book or tick history exists.

A larger architecture cannot recover information that was never observed. It can only
fit a more complicated function of the same incomplete evidence.

## Scope

### In scope

1. A repeatable data-readiness audit and monitoring scorecard.
2. India VIX, FII/DII, equity-universe, and intraday-source reliability.
3. Feature reduction and point-in-time breadth features under a new swing schema.
4. CatBoost as a normal registry-backed model family.
5. A formal sequence data contract and TCN readiness gate.
6. A compact TCN research design after the data gate passes.
7. Leakage-safe out-of-fold stacking after base learners qualify.
8. Validation, explainability, artifact, deployment, and rollback rules.

### Explicitly out of scope

- Live broker order routing.
- PPO or another reinforcement-learning execution agent.
- Installing PyTorch before a TCN experiment is authorized.
- TFT, LSTM, or TabNet implementation.
- Treating a research score as an order instruction.
- Relaxing the existing point-in-time, artifact, explanation, or promotion gates.
- Activating the twenty research equities in the scanner or strategy engine.

## Corrections to the supplied implementation proposal

The attached proposal identifies the correct integration seams, but the following
corrections are required.

### CatBoost

1. The current ML schema is numeric. There is no general one-hot encoding stage to bypass.
   CatBoost's native categorical advantage is therefore limited unless future schemas add
   instrument, sector, session segment, or expiry-regime categories.
2. The first CatBoost version should use the same numeric feature contract as LightGBM and
   XGBoost. Native categorical features should be a separate schema experiment, not an
   invisible preprocessing difference.
3. CatBoost needs a dedicated SHAP adapter. Its SHAP interface is not the same call used by
   XGBoost or LightGBM. Registration in `CONTRIBUTION_METHOD_BY_ALGORITHM` is mandatory
   before inference or competition enrollment.
4. Ordered boosting does not replace chronological splitting, purge, embargo, or the
   leakage audit.
5. CatBoost is expected to be a marginal challenger, not a solution to missing data.

### TCN

1. A small TCN does not inherently require a GPU. CPU and GPU wall time must be benchmarked
   on the authorized dataset before making CUDA an operational requirement.
2. A TCN dataset cannot be created by blindly reshaping a global 2D matrix. Windows must be
   constructed per instrument, timeframe, provider lineage, and trading session.
3. A sequence must reject gaps, duplicated timestamps, incomplete candles, mixed bar
   durations, and provider changes inside a window.
4. Every example needs `sequence_start_at`, `observed_at`, and `label_available_at`. Purging
   must consider the complete information interval, not only the source candle and label.
5. Training normalization, early stopping, and any sequence-length selection belong inside
   the training fold. Fitting them globally leaks validation information.
6. PyTorch model state should eventually use a versioned state-dictionary artifact with
   explicit architecture metadata. Pickling an arbitrary live module is not an adequate
   long-term artifact contract.

### Stacking

1. A generic `StackingClassifier` is insufficient for this project because ordinary
   cross-validation can mix time and leak future regimes.
2. Base probabilities used to train the meta-learner must be generated strictly out of
   fold under the same purged chronological splits.
3. Hyperparameter tuning and early stopping for every base model must occur inside an inner
   temporal split. The outer prediction remains untouched.
4. The meta-learner starts as regularized logistic regression. A neural meta-model is not
   justified.
5. Stacking is authorized only when base models show useful but meaningfully different
   errors. Combining three highly correlated GBDTs may add no value.
6. The stack must have its own algorithm ID, artifact metadata, explanation contract, and
   settled competition record. It cannot borrow one base learner's identity.

## Non-negotiable invariants

1. **Point-in-time only.** Every feature must carry a source observation/publication time
   no later than the prediction cutoff.
2. **Completed evidence only.** Incomplete candles and current option snapshots cannot be
   inserted into historical training as though they were settled.
3. **Immutable schemas.** Any added, removed, reordered, or redefined feature creates a new
   schema version.
4. **Provider consistency.** A training/inference series cannot silently switch data
   meaning or provider lineage.
5. **Label alphabets remain disjoint.** Directional and volatility labels keep separate
   storage and consumers.
6. **No explanation, no production.** A new family without a registered honest explainer
   may train as a local experiment but may not shadow-predict or be promoted.
7. **CPCV is diagnostic.** It measures score stability; it does not replace the most-recent
   chronological deployment gate.
8. **Costs matter.** A classification improvement that does not improve calibrated,
   net-of-cost trading utility is not an improvement.
9. **Shadow before primary.** Every new family must build settled live evidence before it
   can affect scanner context, strategies, risk, or paper activity.
10. **No fabricated fallback.** Missing data remains missing or makes a gate fail. It is
    never replaced with synthetic market evidence for convenience.

## Workstream A: Data-readiness audit and monitoring

Before adding a model family, create one reproducible report for each
instrument/timeframe/source. The report is the phase's control panel and is evaluated at
every later gate.

### Required data-health fields

| Category | Measurements |
|---|---|
| Identity | Instrument, instrument type, exchange, timeframe, provider, first/last bar |
| Coverage | Expected bars, stored bars, complete bars, missing-bar count, longest gap, session count |
| Integrity | Duplicates, non-monotonic timestamps, invalid OHLC, negative volume, source changes |
| Freshness | Last completed close, ingestion time, age in expected bars/sessions |
| Volume | Zero-volume percentage, non-zero sessions, median volume, suspicious discontinuities |
| Derived evidence | Per-indicator/pattern/version coverage and latest calculation time |
| Cross-series | India VIX coverage, breadth-universe coverage, cross-index alignment |
| Institutional | Available FII/DII sessions, publication-time coverage, staleness |
| Labels | Usable examples, class counts, neutral share, label-availability distribution |
| Sequences | Candidate windows, rejected gaps, rejected cross-session windows, usable window count |

### Monitoring states

- `READY`: all hard requirements pass.
- `DEGRADED`: inference may continue with explicit missing evidence, but training is blocked.
- `STALE`: the source is older than its allowed cadence; training and new predictions stop.
- `INVALID`: integrity/provenance failure; the affected series is quarantined.

### Initial monitoring targets

These are engineering gates, not claims of statistical sufficiency:

- No duplicate completed candle for an instrument/timeframe/open time.
- No provisional candle in a training dataset.
- No unreported provider change inside a model dataset.
- At least 99% expected-bar completeness for an authorized contiguous research window,
  excluding recorded exchange holidays and halts.
- At least 95% required indicator coverage before a feature schema may train.
- India VIX and institutional data report explicit availability and age; missing is never
  transformed into a neutral value.
- Intraday volume-dependent schemas require genuine non-zero traded volume on the chosen
  tradable proxy or futures instrument.

### Deliverable and acceptance

The audit must be runnable without training a model and must emit machine-readable output
that can be stored with a research run. A model run records the audit identifier/hash it
used. A failed hard gate stops before fitting begins.

## Workstream B: Repair and broaden swing data

### B1. India VIX

- Register and document the authoritative local `INDIAVIX` series if not already present.
- Backfill the full swing research window.
- Schedule collection and monitor freshness.
- Keep the existing point-in-time join: the VIX bar used by an observation must have
  closed no later than that observation.
- Treat India VIX as a broad Nifty volatility regime. It is not a substitute for Bank
  Nifty option-implied volatility.

### B2. FII/DII

- Backfill enough published daily sessions to populate the trailing normalization window.
- Preserve `published_at`; a same-session flow printed after the close is not available to
  a bar that closed before publication.
- Monitor missing, unparseable, stale, and revised records separately from genuine zero.
- Evaluate incremental value rather than assuming an economically appealing feature is
  predictive.

### B3. Equity research universe

- Confirm all registered research equities have consistent daily history and genuine
  volume.
- Keep them inactive for scanner/strategy purposes until separately authorized.
- Confirm the ML repository can read the intended inactive research instruments without
  changing active-market behavior.
- Record corporate-action and provider semantics explicitly.

### B4. Point-in-time breadth features

First candidates:

- advance/decline balance;
- median and weighted constituent return;
- percentage above trailing SMA/EMA;
- cross-sectional return dispersion;
- banking-versus-IT relative strength;
- median constituent volume ratio; and
- Nifty-versus-Bank-Nifty relative return and rolling beta.

The current twenty-name universe is a breadth proxy, not a point-in-time Nifty 50
constituent decomposition. Do not label it as official breadth or apply guessed weights.
Official constituent/weight history becomes a separate authorized dataset.

### B5. Feature-capacity discipline

- Measure aggregate-versus-drop alternatives for sparse pattern and price-action blocks.
- Select features only inside the training folds.
- Prefer economically stable aggregates over dozens of mostly zero confidence columns.
- Combine breadth additions and feature reduction into one swing schema bump so the model
  pool resets once.
- Preserve the old schema and models for audit, but do not compare incompatible feature
  spaces as if their holdout scores came from the same experiment.

### Swing readiness gate

CatBoost research can begin on the current numeric schema, but a new swing schema is not
eligible for production competition until:

- the data audit passes;
- every validation fold contains at least the project's minimum validation rows;
- the full schema has acceptable non-missing coverage;
- the feature count is defensible relative to usable rows;
- the label distribution is reported per fold and era; and
- the trivial majority-class baseline is recorded on the exact same rows.

## Workstream C: CatBoost challenger

### Objective

Determine whether CatBoost adds repeatable, incremental out-of-sample value over
LightGBM/XGBoost on the same features, labels, folds, and cutoffs.

### First version boundaries

- Numeric features only.
- Same immutable feature schema as the competing tree models.
- Same label encoding and probability contract.
- Same imputation policy unless a separately versioned experiment proves an
  algorithm-native missing-value policy is preferable.
- Deterministic seed and recorded CatBoost version.
- Conservative depth, learning rate, regularization, and early stopping.
- Dedicated CatBoost SHAP implementation and additivity tests.

### Required integration surfaces for a later implementation

- dependency constraints;
- algorithm constant and CLI choice;
- trainer registry and hyperparameter applicability;
- artifact metadata and checksum validation;
- probability prediction and canonical labels;
- CatBoost-specific SHAP adapter;
- explanation method registration;
- model-performance parsing/display;
- competition eligibility; and
- candidate pruning/reference safety.

### CatBoost research acceptance

CatBoost is retained only when it:

1. beats the trivial predictor on the same unseen rows;
2. passes label-shuffle, era-holdout, and applicable feature-lag checks;
3. has a non-suspicious training-to-validation gap;
4. performs consistently across walk-forward folds rather than one lucky period;
5. shows a practically meaningful advantage or useful error diversity versus current
   GBDTs; and
6. produces calibrated probabilities and valid local SHAP explanations.

Training successfully or beating a tree by less than fold variability is not acceptance.

### CatBoost stop conditions

- It loses to the trivial baseline.
- Its apparent edge disappears under feature/label shuffle controls.
- Improvement is smaller than validation spread and it adds no error diversity.
- Inference cannot reconstruct SHAP additivity reliably.
- Operational cost is disproportionate to measured incremental value.

## Workstream D: Intraday data program

TCN work is blocked until this workstream passes.

### D1. Choose the traded information source

Spot indices have no traded volume or order book. Choose and document one of:

- Nifty/Bank Nifty futures, with a point-in-time rollover/continuous-contract policy;
- a liquid ETF proxy, with acknowledged tracking error; or
- a constituent panel whose aggregate activity is used as context for the spot index.

Do not combine them invisibly. The chosen instrument semantics become part of the feature
schema and model key.

### D2. Historical intraday bars

- Use native intervals or honest resampling from a finer real interval.
- Never relabel 1m bars as 3m or 5m.
- Use one consistent provider per instrument/timeframe lineage unless a measured and
  documented cutover is explicitly versioned.
- Backfill enough regimes: calm, high-volatility, expiry, event, trending, and mean-reverting
  periods.
- Recompute all required production-version indicators over the complete backfill.

### D3. Point-in-time option-chain snapshots

If authorized data is acquired, store raw observations before deriving features:

- underlying, expiry, strike, option type;
- bid, ask, last price, volume, OI, change in OI, and IV when supplied;
- provider timestamp, exchange timestamp, and receipt timestamp;
- contract metadata and expiry/roll state; and
- completeness/strike-coverage indicators.

Derived candidates include OI PCR, change-in-OI PCR, volume PCR, ATM IV, skew, term
structure, concentration around spot, and expiry-normalized distances. Max Pain is an
experimental contextual feature, not a trusted target or standalone signal.

Historical snapshots must be legally and operationally authorized. Scraping the current
web page and pretending those values existed in the past is prohibited.

### D4. Intraday covariates

- cyclical minute-of-session and day-of-week;
- minutes from open/to close;
- opening-range state;
- time to expiry using confirmed contract metadata;
- prior-session FII/DII only when it was already published;
- current point-in-time VIX/IV context;
- futures basis and change in basis;
- constituent breadth/dispersion; and
- Nifty/Bank-Nifty relative strength.

### Intraday readiness gates

The following are provisional minimum engineering gates and must be re-estimated from the
actual dataset before authorizing training:

| Candidate | Minimum gate to open research |
|---|---|
| 15m TCN | At least 50,000 clean bars or equivalent panel sequences, broad regime coverage, genuine volume on the chosen traded instrument, and complete required indicators |
| 5m TCN | At least 100,000 clean bars or equivalent panel sequences with the same integrity requirements |
| 1m TCN | At least 200,000 clean bars or equivalent panel sequences, at least 250 distinct trading sessions, genuine volume, and no fabricated/resampled intervals |
| TFT | TCN gates plus a large multi-instrument panel, multiple explicit horizons, and at least one year of reliable point-in-time exogenous snapshots |
| PPO | Separate future phase: recorded L2/ticks, order/fill history, and a simulator whose fill/cost behavior is independently validated |

Bar counts are necessary, not sufficient. Highly overlapping windows do not create the
same number of independent observations.

## Workstream E: Sequence data contract

This contract is designed before the TCN implementation so that the validation design is
not retrofitted after training.

### Sequence example

Each example records:

- instrument and instrument semantics;
- timeframe and expected interval;
- provider lineage;
- sequence length;
- `sequence_start_at`;
- ordered source candle IDs/timestamps;
- `observed_at` for the prediction point;
- `label_available_at`;
- feature schema/version;
- missingness mask when applicable;
- session-boundary policy; and
- target scheme/horizon.

### Window construction rules

- Build per instrument and timeframe, never across symbols.
- Default to no overnight crossing for scalping sequences; test cross-session context as a
  separate contract.
- Reject a window with missing or duplicated expected bars unless an explicit missing-bar
  representation is part of the versioned schema.
- Use only completed candles available by the cutoff.
- Do not forward-fill volume, OI, IV, or prices through missing market observations.
- Create labels only after the full future label interval is available.

### Sequence CV rules

- Group synchronized timestamps across Nifty, Bank Nifty, futures, options, and
  constituents into the same outer fold.
- Purge any training example whose full information interval
  `[sequence_start_at, label_available_at]` overlaps a validation interval.
- Apply embargo after validation blocks.
- Fit scalers, class weights, sequence-length choices, and early stopping inside each
  training fold.
- Permit a validation sequence to use earlier historical context exactly as live inference
  would, but never permit its label or later normalization statistics into training.
- Keep a final recent chronological holdout for deployment simulation.
- Keep CPCV as a stability distribution, not a promotion score.

## Workstream F: Compact TCN research candidate

### First authorized target

Prefer one of these, in order:

1. volatility expansion/regime over a short future horizon;
2. setup-quality or trade-filter probability after explicit cost labelling; or
3. directional classification only if the refreshed tabular baseline first demonstrates
   a directional edge over trivial.

This order follows the project's existing evidence: volatility/regime information has
been more credible than unconditional direction.

### First model constraints

- Small causal TCN with residual blocks and dilated 1D convolutions.
- Fixed, short lookback selected inside CV, not chosen from the final holdout.
- No attention layer in version 1.
- Parameter count reported and bounded relative to usable sequences.
- Dropout/weight decay, early stopping, gradient clipping, and deterministic seeds.
- Probability calibration evaluated on a separate chronological slice.
- CPU benchmark first; GPU remains optional unless measured wall time requires it.

### Packaging decision

Do not add PyTorch to the default ML image until this workstream is authorized. Prefer a
separate optional deep-learning dependency group or image/profile so existing tree
training remains lightweight and reproducible.

### TCN explanation

Register a new explanation method rather than calling attention or convolution weights
"feature importance." Initial candidates are temporal occlusion and Integrated Gradients.
The stored explanation must identify both feature and lag/time region and must pass sanity
checks against randomized model weights/labels.

### TCN acceptance

The TCN advances only if it:

- beats the strongest tabular lag-feature baseline on the same outer folds;
- beats the trivial baseline;
- improves a trading-relevant metric after estimated costs;
- survives label shuffle and era holdout;
- remains useful across multiple regimes and recent folds;
- has calibrated probabilities;
- meets inference-time and memory budgets; and
- provides a stable, honest explanation artifact.

If a tree supplied with lag/rolling features matches it, retain the tree.

## Workstream G: Leakage-safe stacking

### Authorization gate

Do not implement stacking until at least two base families:

- independently pass their research gates;
- provide calibrated probabilities on common outer-fold rows; and
- show sufficiently different residual/error patterns.

Prediction disagreement alone is not enough; measure error correlation by class, regime,
timeframe, and confidence bucket.

### Training design

For each outer temporal fold:

1. Fit/tune every base model only on the outer training portion, using inner purged splits.
2. Predict probabilities on the outer validation portion.
3. Store the OOF probabilities with model artifact ID, feature schema, cutoff, and fold ID.
4. Concatenate only common, valid OOF rows.
5. Train a regularized multinomial logistic meta-learner on earlier OOF folds.
6. Evaluate the meta-learner on a later untouched fold.
7. Refit base models and meta-model only after design choices are frozen.

Initial meta-features:

- canonical class probabilities from each base learner;
- entropy/uncertainty per learner;
- model disagreement;
- point-in-time volatility regime; and
- missing-evidence indicators.

Do not feed the full raw feature vector into the first meta-learner; doing so turns the
stack into another high-capacity base model and obscures whether ensembling helped.

### Stack artifact and explanation

The stack artifact records:

- every base artifact checksum;
- OOF fold assignments;
- base probability class order;
- calibration transforms;
- meta coefficients/intercept;
- training and evaluation cutoffs; and
- the complete feature/label contract.

Explain a stack in two layers:

1. meta-level contribution of each base probability/regime input; and
2. links to each base model's own explanation for the same observation.

Never present the meta coefficient as if it were an original market-feature effect.

### Stacking acceptance

- Must beat the best base learner, not the average base learner.
- Improvement must exceed fold variability or pass a predeclared paired block-bootstrap
  confidence rule.
- Must not reduce accuracy below the trivial baseline while improving macro-F1.
- Must improve calibration or net-of-cost utility, not merely class spread.
- Must build settled shadow evidence before promotion.

If it adds no stable incremental value, weighted averaging or the best single model wins.

## Validation and evaluation protocol

Every research report includes:

### Predictive measurements

- accuracy, balanced accuracy, macro-F1;
- trivial majority-class accuracy on identical rows;
- directional hit rate and coverage for directional targets;
- log loss, Brier score, and calibration by confidence bucket;
- confusion matrix and class distribution;
- training-to-validation gap;
- fold mean, minimum, maximum, spread, and latest-fold score; and
- label-shuffle, feature-lag, and era-holdout results.

### Trading measurements

- net expectancy after brokerage, fees, taxes, and modeled slippage;
- turnover and trade coverage;
- profit factor and maximum drawdown;
- average adverse/favorable excursion when available;
- performance by volatility, trend, time-of-day, and expiry regime; and
- sensitivity to higher slippage/cost assumptions.

### Comparison rules

- Same rows, target, horizon, cutoff, schema, and costs for every compared model.
- Compare against trivial, logistic, LightGBM, and XGBoost baselines.
- Never compare a CPCV mean directly with a chronological gate score.
- Never rank models whose validation samples or label schemes differ.
- A difference smaller than fold variability is reported as indistinguishable.
- Hyperparameter search budget is equal or explicitly reported per family.

## Production and competition policy

1. New models begin as local research candidates.
2. Passing holdout checks permits competition enrollment, not production authority.
3. Competition members shadow-predict with exact point-in-time evidence.
4. Predictions settle under the same label definition used in training.
5. The challenger must beat trivial and the PRIMARY under existing minimum-sample,
   head-to-head, and promotion-margin rules.
6. Only PRIMARY directional predictions may drive downstream directional consumers.
7. Volatility/regime outputs remain in their non-directional path and may inform risk only.
8. A silent/stale model is demoted or quarantined according to existing operational rules.
9. Schema or artifact incompatibility fails closed.

## Operational monitoring after deployment

### Daily

- source freshness and missing bars;
- prediction count and inference failures;
- feature missingness drift;
- option/futures/constituent coverage when used;
- model latency and artifact-load errors; and
- newly settled outcomes.

### Weekly

- rolling accuracy, macro-F1, trivial accuracy, coverage, calibration;
- confidence versus realized correctness;
- performance by regime and instrument;
- base-model error correlations and stack contribution stability;
- feature attribution drift; and
- data-provider/provenance changes.

### Monthly or after a material market event

- full walk-forward retraining report;
- CPCV robustness distribution;
- leakage audit rerun;
- cost/slippage stress test;
- stale feature and dead-column audit;
- artifact/dependency reproducibility check; and
- decision to retain, retrain, quarantine, or retire.

### Alert conditions

- missing/stale required data;
- unexplained provider or contract change;
- calibration deterioration beyond a predeclared band;
- model accuracy at or below trivial over the minimum settled sample;
- attribution concentrated in a missingness/provenance proxy;
- sudden inference-latency or error-rate increase; or
- divergence between training and serving feature construction.

## Phased implementation order

Each stage ends with a written go/no-go decision. A later stage cannot begin merely
because the previous code merged.

### Stage 0: Re-baseline current state

- Re-run database counts, feature coverage, source/provenance, and model metrics.
- Treat time-stamped counts in earlier documents as historical, not current truth.
- Freeze a data-audit snapshot and current model baselines.

**Exit:** reproducible baseline report with no unexplained fabricated or stale evidence.

### Stage 1: Data health and swing breadth

- India VIX backfill/schedule/freshness.
- FII/DII backfill and publication-time validation.
- Twenty-equity history/volume/indicator coverage.
- Data-readiness report and fail-closed training gate.

**Exit:** swing data gate passes and missing evidence is visible rather than silently
neutralized.


## Stage 2 record: validation activation (2026-08-03)

Status: **validation activation done and measured.** (The feature-capacity half — the
`ml-feature-v6` bump — was completed later the same day; see its own record below.)

### What was wrong

`train.py:267` defaults `--folds` to 1, and a search of `apps/api/src`, `scripts`, and
every `package.json` confirmed **nothing passed it**. `--cpcv-groups` was likewise never
passed, so the Combinatorial Purged CV implemented in `validation.py` had never once
run. Every promotion decision in the project's history rested on a single trailing
block.

Separately, and larger: the EOD pipeline trained on `--timeframe 15m --from 2024-01-01`.
15m is Yahoo-owned and Yahoo serves roughly 60 days at that interval. The request did not
fail — it silently returned about six weeks. That is why these models trained on ~780
rows, and it was never the algorithm.

### Measurements, NIFTY50, LightGBM, identical features and folds

| | 15m direction (status quo) | 1d direction | 1d volatility-expansion |
|---|---|---|---|
| Labelled rows | 782 | 877 | 873 |
| Window covered | ~6 weeks | 3.5 years | 3.5 years |
| Training macro-F1 | 0.9341 | — | — |
| Holdout macro-F1 | 0.2928 | 0.1922 | **0.3897** |
| Holdout accuracy | 0.3418 | 0.2586 | **0.4023** |
| Fold macro-F1 | single block | [0.201, 0.253, 0.192] | [0.296, 0.390] |
| CPCV macro-F1 vs trivial | not run | 0.3100 vs 0.2062, **won 100%** | 0.3982 vs 0.1595, **won 100%** |
| CPCV accuracy vs trivial | not run | 0.3806 vs 0.4492, **won 7%** | 0.4043 vs 0.3148, **won 100%** |

Three conclusions, all measured rather than argued:

1. **The directional target does not work, and CPCV is what proves it.** It beats the
   trivial predictor on macro-F1 on every split while *losing* on accuracy on 93% of
   them. That is the signature of a model spreading predictions across classes, which
   macro-F1 rewards and accuracy exposes. A single-metric gate cannot see it. The 15m
   model's 0.9341 training against 0.2928 holdout — below the 0.333 three-class random
   baseline — is the same story with the folds turned off.
2. **Volatility expansion works on the same rows.** It wins macro-F1 *and* accuracy on
   100% of splits. This reproduces the earlier volatility-expansion result under proper
   walk-forward and CPCV, on the current database.
3. **Fold count is bounded by rows, and the bound is already binding.** 3 folds on 877
   rows leaves 58 validation rows against the gate's own 60-row floor, and the run is
   correctly refused as `INSUFFICIENT_VALIDATION_EVIDENCE`. 2 folds leaves 87 and
   passes. More folds requires more rows, not a lower floor.

### Changes made

- `WALK_FORWARD_FOLDS = 2` and `CPCV_GROUPS = 6` are now passed on every training run in
  the EOD pipeline. CPCV remains report-only and out of the gate, for the reason
  `train.py` already documents.
- The 15m run's window is now `sixtyDaysAgo` rather than a 2.5-year request the provider
  silently truncates. Its ceiling is stated, not implied.
- A `1d` directional run was added — the only timeframe whose depth lets folds span more
  than one regime.
- A `1d` volatility-expansion run was added, on its own label alphabet. It cannot reach a
  directional consumer: `postgres-model-competition-repository.ts` and
  `postgres-model-prediction-settlement-repository.ts` both filter on
  `validationProtocol.labelScheme`, so the separation is structural, not conventional.

### Not done, and what it needs

The `ml-feature-v6` bump — cutting 113 features to roughly 30 and adding point-in-time
breadth features — is **not** implemented. Two findings shape it:

- Phase 24's open question 4 is answered: **multi-instrument training is not supported.**
  `train.py:175` takes a single required `--instrument`. Its guess that the 1,933-row
  runs implied pooled training was wrong. Pooling the 20 research equities is worth
  17,740 rows against the current 877 — a 20x increase and by far the cheapest route to
  a fold count above 2 — but it needs a real change to the loader and an explicit
  assumption of shared cross-sectional dynamics.
- Open question 3 is answered: **the ML evidence query does reach inactive instruments.**
  `postgres_repository.py` applies no `is_active` filter on any of its four instrument
  joins, so the research equities are readable today.

**Stage 2 exit was not met at this point.** Validation activation was complete and had
already changed a conclusion; the capacity half remained. (Resolved later the same day —
see the `ml-feature-v6` record below.)


## Stage 2 record: multi-instrument pooling (2026-08-03)

The cheapest route past the fold ceiling, and the first configuration in the project's
history to clear the promotion gate's initial baseline.

### Why row concatenation alone would have been wrong

`walk_forward_splits` and `chronological_purged_split` do row-index arithmetic on a
sorted list, with the purge expressed as `train_end = validation_start - horizon_bars`.
For one instrument a row is a bar, so that is correct. Pooled across twenty instruments
it fails twice:

- the train/validation boundary lands *inside* a session, putting some instruments' bars
  for a timestamp in training and their siblings in validation — contemporaneous
  cross-sectional leakage, and invisible in the resulting scores; and
- a five-bar purge becomes five rows, roughly a quarter of one session, so training
  labels overlap the validation block almost entirely while the code still reads
  correctly.

`pooled_walk_forward_splits` cuts folds on distinct `observed_at` values and purges on
real timestamps — dropping a training example when its `label_available_at` reaches into
the validation block — which is the defence `combinatorial_purged_splits` already
applied and the walk-forward path never did. Seven tests cover the grouping, the
timestamp purge scaling with the label horizon, sibling integrity, and the two refusal
paths. CPCV needed no change: its block bounds are row-based but its purge was always
timestamp-based, so pooled leakage was already caught.

### Result: pooling helps volatility and does nothing for direction

Identical features, folds, window and cutoff. LightGBM, `1d`, 2023-01-01 onward.

| | Single instrument | Pooled (20 equities) |
|---|---|---|
| Labelled rows | 873–877 | **17,540** |
| Validation rows per fold | 87 | **700** |
| Folds the 60-row floor permits | 2 | **5** |
| Volatility mean macro-F1 | 0.3427 | **0.4404** (spread 0.1383) |
| Volatility CPCV macro-F1 vs trivial | +0.2386, won 100% | **+0.2874**, won 100% |
| Volatility CPCV accuracy vs trivial | +0.0896, won 100% | **+0.1416**, won 100% |
| Direction CPCV macro-F1 vs trivial | +0.1038, won 100% | +0.1042, won 100% |
| Direction CPCV accuracy vs trivial | −0.0686, won 7% | −0.0129, won 27% |
| Volatility gate decision | THRESHOLD_NOT_MET | **INITIAL_BASELINE_THRESHOLD_MET** |

**Twenty times the data moved the directional CPCV macro-F1 edge by 0.0004, and its
accuracy still lost to trivial.** That is the controlled evidence that direction's
failure is the target rather than the sample size — the objection that "it would work
with more data" is now measured and answered. Volatility improved on both metrics with
the same increase.

Two honest caveats on the passing model:

- Fold spread is 0.1383, from 0.3766 to 0.5149, and the gate scores the *final* fold —
  which happens to be the best of the five. The mean, 0.4404, is the more
  representative number, and it also clears the 0.40 volatility floor.
- Highly overlapping windows do not create twenty times the independent information.
  Twenty instruments in one market share most of their systematic variance, so the
  effective sample is far below 17,540. The gate's minimum-row rules are satisfied;
  statistical sufficiency is not thereby proven.

### Contract notes

- Pooled models carry method `POOLED_PURGED_CHRONOLOGICAL_V1`, and the roster,
  per-instrument row counts, and distinct observation-time count are recorded in
  `validationProtocol`. A pooled score averages over a different distribution than a
  single-instrument score and must not be ranked against one.
- The model key encodes the pool as `pool20-<8-hex-digest>` of the sorted roster, so a
  pooled model cannot inherit NIFTY50's promotion lineage. The digest keeps the key and
  artifact path usable where twenty spelled-out symbols would not.
- Each instrument is loaded and labelled against its own history; pooling happens only
  after labelling. A forward return or trailing window computed across a concatenated
  frame would be meaningless.
- The pooled volatility run is now in the EOD pipeline. No pooled *directional* run is
  scheduled, on the evidence above.
- The research equities remain `is_active = FALSE`. Pooling them for research does not
  activate them for the scanner or strategy engine.

### Still outstanding for Stage 2 exit

The feature cut — 113 features to roughly 30 — is not done. Note that the capacity
argument has weakened considerably: at 17,540 rows the ratio is 155 rows per feature,
not 5.5. The cut is now a variance-reduction and interpretability exercise rather than a
rescue, and it should be measured under these folds rather than assumed to help.


## Stage 2 record: feature capacity cut and breadth (`ml-feature-v6`, 2026-08-03)

Status: **done and measured. Stage 2 exit criteria are met.**

### What changed

The swing feature schema was cut from 113 columns (`ml-feature-v5`) to 36
(`ml-feature-v6`), and seven point-in-time market-breadth columns were added from the
twenty-equity research panel plus the two indices. The changes, and the reasoning:

- The 42 pattern one-hots and 30 price-action confidence one-hots collapse into four
  aggregate scores: `pattern.bullish_confidence`, `pattern.bearish_confidence`, and the
  price-action pair. On daily NIFTY50 those blocks are zero on the vast majority of
  rows; 72 near-constant columns are variance for the imputer and noise for fold
  estimates while carrying at most "some bullish/bearish detection fired, this
  strongly". The two SUPPORT/RESISTANCE `level_distance_bps` columns survive as the
  block's only dense structural content (sparse on 1d — 29 SUPPORT and 26 RESISTANCE
  events exist with levels — but continuous and unambiguous when present).
- Exact linear combinations are gone: Bollinger middle/upper/lower (middle *is* SMA20,
  bands are middle ± 2σ, and the σ ratio stays), and the SuperTrend band levels (its
  line and trend flags stay).
- VWAP is gone from the swing schema: one bar per session makes a session-reset VWAP
  the bar's typical price restated, and index "volume" is synthetic anyway.
- `candle.gap_fill_bps` and `candle.is_gap_defended` are gone for their documented
  dual-meaning and near-constant-gate pathologies.
- Seven breadth columns arrive: advance/decline ratio, cross-sectional median return
  and dispersion, share above SMA20, median volume ratio, the bank-vs-IT
  relative-strength spread, and the NIFTY50-vs-BANKNIFTY daily return gap. All are
  computed by pure functions in `apps/ml/ai_quant_lab_ml/breadth.py` from *settled
  daily bars only*, attached to a bar as the latest panel session at or before its
  close within a five-weekday staleness budget — the same point-in-time attach rule as
  the VIX regime and FII/DII columns. A session below ten measurable participants
  publishes NaN, not a quiet-looking zero.

### The versioning contract changed shape

Unlike every earlier bump, v5 artifacts remain loadable. Inference now validates an
artifact against the schema version recorded in *its own metadata*
(`ProductionInferenceContract.schema_version`), and `predict.py` builds feature vectors
for that version, never the current default. Consequences:

- The v5 volatility shadow families keep scoring and accruing settled history next to
  fresh v6 lineages; the volatility competition ranks settled outcomes and is therefore
  comparable across schemas.
- The *directional* competition resets to v6 only
  (`CURRENT_FEATURE_SCHEMA_VERSION = "ml-feature-v6"` in `competition-eligibility.ts`),
  per this phase's rule that a capacity change resets that pool exactly once.
- An artifact declaring a version outside `KNOWN_FEATURE_SCHEMA_VERSIONS` is rejected
  at load time, fail-closed.
- `train.py --feature-schema ml-feature-v5` exists as a research-only override so
  capacity experiments run both schemas on identical rows and folds. Scalp timeframes
  are excluded; their schema is versioned separately.

### Measured, not assumed

Both schemas were trained on identical windows (2023-01-01 to 2026-08-02, cutoff
2026-08-03T14:00Z), identical fold counts, and the same audited data.

| Run | v5 | v6 |
| --- | --- | --- |
| Pooled 1d volatility LightGBM, 5-fold walk-forward mean macro-F1 | 0.4337 | 0.4222 |
| Pooled 1d volatility LightGBM, CPCV (15 splits) macro-F1 | 0.4426 (σ 0.0173) | 0.4352 (σ 0.0170) |
| NIFTY50 1d volatility logistic, 2-fold mean macro-F1 | 0.3156 | **0.3636** (won both folds) |
| NIFTY50 1d directional logistic, 2-fold mean macro-F1 | 0.2432 | **0.3235** |

Reading: on the data-rich pooled task the two schemas are statistically
indistinguishable — the CPCV gap is under half a split standard deviation — which means
the 77 removed columns were carrying essentially no signal that LightGBM could use. On
the scarce single-instrument tasks, exactly where the capacity argument applies, v6 wins
outright. Both CPCV runs beat trivial on 15/15 splits under either schema. Parsimony
wins the tie: **v6 is the default swing schema going forward.** The pooled EOD lineage
will re-baseline under v6 while its v5 predecessors keep settling in shadow, so the
scoreboard — not this offline table — makes the final call, per invariant 9.

Breadth population was verified in the artifact itself: in a 256-row v6 reference set,
all four aggregate scores populate on every row and the breadth columns populate on
249–255 rows (the shortfall is the SMA20/volume warmup and one unmeasurable session),
with the SUPPORT/RESISTANCE distances NaN throughout that particular sample — expected
given 29/26 events across the whole series.


## Stage 3 record: CatBoost challenger family (2026-08-03)

Status: **family integrated and measured. Not enrolled in the EOD training loop.**

### What was built

CatBoost is a normal registry-backed model family on the same numeric `ml-feature-v6`
contract as LightGBM/XGBoost — not a silent preprocessing fork:

- Identifier `catboost-gradient-boosting-v1`, CLI choice `catboost`, npm script
  `ml:train:catboost`, dependency pin `catboost>=1.2,<2`.
- Trainer uses `boosting_type="Ordered"` (the inductive bias that justifies the family),
  Bernoulli row subsample, per-split `rsm` column sample, `thread_count=1`, and records
  `catboostVersion` in hyperparameters so artifacts stay reproducible.
- Dedicated SHAP adapter via `get_feature_importance(type="ShapValues")`, registered in
  `CONTRIBUTION_METHOD_BY_ALGORITHM` as `TREE_SHAP_V1`. Multiclass and binary additivity
  tests pass: reported contributions reconstruct the selected-class raw margin.
- `LabelEncodedClassifier.predict` now flattens CatBoost's `(n, 1)` multiclass class-index
  shape so the shared pipeline contract stays intact.
- API `algorithmFamily` maps the new identifier to `GRADIENT_BOOSTING`.

### Measured against exact baselines

Same windows, cutoff (`2026-08-03T14:00Z`), folds, and v6 schema as the Stage 2 LightGBM
runs:

| Run | LightGBM / logistic (Stage 2) | CatBoost |
| --- | --- | --- |
| Pooled 1d volatility, 5-fold walk-forward mean macro-F1 | LightGBM **0.4222** | 0.3904 |
| Pooled 1d volatility, CPCV (15 splits) macro-F1 | LightGBM **0.4352** (σ 0.0170) | 0.4239 (σ 0.0252) |
| NIFTY50 1d volatility logistic / CatBoost, 2-fold mean | logistic **0.3636** | 0.3376 |
| NIFTY50 1d directional logistic / CatBoost, 2-fold mean | logistic **0.3235** | 0.2910 |

CatBoost still beats the trivial predictor on every pooled and single-instrument
volatility CPCV split (15/15). The directional leakage audit returns `PASS`, with the
`NO_SKILL_TO_AUDIT` short-circuit (base holdout 0.2824 below the 0.333 random baseline)
— a model-quality result, not a leakage finding.

### Decision

**Do not enroll CatBoost in the EOD `ML_ALGORITHMS` loop.** The research acceptance
criteria require incremental out-of-sample value over existing trees on identical folds.
Here CatBoost loses to LightGBM on the pooled volatility task that actually works, and
loses to logistic on both single-instrument tasks. Training successfully and beating
trivial is not enough; ordered boosting did not buy a measurable edge on this schema and
sample.

The family stays available for research (`npm run ml:train:catboost`) and for a later
re-evaluation if a categorical schema experiment or a materially different target appears.
Useful error diversity for stacking is also deferred: Stage 6 stacking requires base
learners that already qualify on their own.


## Stage 4 record: Intraday data foundation and sequence-readiness (2026-08-04)

Status: **`tcn-1m` research gate PASS on NIFTYBEES. `tcn-5m` FAIL (bar count). Option-chain
deferred. Stage 5 may open only for the PASSed candidate.**

### Already in place before this stage

Workstream D1/D2 work from 2026-08-03 still stands:

| Series | Bars | Sessions | Non-zero volume | Indicators (`ta-v1`) | Workstream A state |
|---|---|---|---|---|---|
| NIFTYBEES `1m` | 331,141 | 887 | ~100% | complete (incl. VWAP) | READY |
| NIFTYBEES `5m` | 66,229 | 887 | ~100% | complete (incl. VWAP) | READY |
| NIFTY50 `1m`/`5m` | ~54k / ~12k | 143 / 165 | index volume | present | READY / DEGRADED |

Instrument semantics remain `ETF_PROXY` for NIFTYBEES (`is_active = FALSE`). Spot-index
series are negative controls, not TCN training instruments.

### Built this stage

- Domain module `sequence-readiness.ts` encodes the Workstream D gate table
  (`tcn-1m` ≥200k bars / ≥250 sessions / ≤1% zero-volume; `tcn-5m` ≥100k; `tcn-15m`
  ≥50k), rejects `SPOT_INDEX` semantics, requires a single `fyers-api-v3` lineage and a
  Workstream A `READY` series, and records the default sequence contract
  (`NO_OVERNIGHT_CROSSING`, per-instrument windows, completed candles only, independence
  caveat).
- Migration `036-sequence-readiness-reports` plus
  `npm run data:audit:sequence` persist a hashed gate report Stage 5 can cite.
- The audit reads series state from the latest Workstream A report so the two audits
  cannot disagree about READY/DEGRADED.

### Measured gate results (2026-08-04)

| Candidate | Verdict | Why |
|---|---|---|
| NIFTYBEES `1m` (`tcn-1m`) | **PASS** | 331,141 bars, 887 sessions, 0% zero-vol, ETF_PROXY, READY, Fyers native |
| NIFTYBEES `5m` (`tcn-5m`) | FAIL | 66,229 bars below the 100,000 floor (all other integrity checks clear) |
| NIFTY50 `1m` | FAIL | spot-index semantics + insufficient bars/sessions |
| NIFTY50 `5m` | BLOCKED | series DEGRADED (internal gap) plus spot-index / volume / depth failures |

`anyResearchAuthorized = true` solely because of NIFTYBEES `1m`.

### Explicitly not done

- **5m depth extension.** A deeper Fyers backfill (2021–2022) was attempted to close the
  100k gap and failed: refresh-token API returns SEBI-disabled (`HTTP 400, code -16`).
  Re-authorize Fyers interactively, then extend; until then `tcn-5m` stays closed.
- **Option-chain snapshots (D3).** No authorized historical feed. Scraping current pages
  into the past remains prohibited.
- **Futures record-forward collector.** Still the right long-term traded series, still
  blocked for history by Fyers' live-contract-only endpoint; needs a point-in-time
  rollover policy before scheduling.

### Stage 4 exit

Met for the **1m TCN research candidate on NIFTYBEES**. Stage 5 may implement a compact
TCN against that series and that series only. Opening 5m or 15m research, or training on
spot-index bars, requires a new sequence-readiness PASS.


## Volatility settlement path (2026-08-03)

Status: **grading and settlement built and tested. The loop is not closed — nothing
writes volatility predictions yet.**

### The problem

`auxiliary_model_predictions` was write-only. It recorded what a non-directional model
predicted and had no column for what happened: no realised label, no settled_at, no
outcome of any kind, and nothing in the codebase settled it. The exclusion was correct
when it was made — `competition-eligibility.ts` documents a real bug where a volatility
model sat "permanently unpromotable at the top of" a directional competition — but the
consequence inverted once volatility became the only target beating trivial on both
macro-F1 and accuracy. The architecture guaranteed that the one thing that works could
never satisfy invariant 9, "shadow before primary".

### Built

- Migration `031-auxiliary-prediction-settlement` adds `realized_label`,
  `realized_ratio`, `realized_forward_range`, `realized_trailing_range`,
  `label_available_at`, `settled_at`, and `unsettleable_reason`, plus partial indexes for
  the unsettled tail and the settled scoreboard. `realized_ratio` is stored because the
  label is only that ratio thresholded, so a band change stays re-scorable from history
  instead of invalidating every settled row.
- `expansionBand` is now recorded in `validationProtocol` and cross-checked by the
  artifact gate for the scheme it governs. Previously the band — which *is* the label
  rule — existed only inside the model key, while the protocol recorded a
  `neutralThresholdBps` that means nothing for this target. Settlement reads the band
  from the model's own protocol and refuses to grade a model that lacks it.
- `volatility-expansion-label.ts` grades an outcome, deliberately as a second
  implementation of the Python labeller. **Both are pinned to shared golden vectors** in
  `volatility-expansion-golden.json`, asserted by the TypeScript suite and by
  `GoldenVectorParityTests` in `apps/ml`. Nothing else forces training and settlement to
  agree, and a divergence would silently make a live scoreboard measure a different
  target than the model learned.
- `SettleAuxiliaryPredictions` plus its Postgres repository and
  `npm run models:settle-auxiliary`, wired into the EOD pipeline as step 2b. Only
  completed candles are read: a provisional bar's envelope is still forming and would
  bias narrow, manufacturing CONTRACTION.
- Refusal is preserved end to end. A flat trailing window and an incomplete forward
  window are reported as unmeasurable, never graded STABLE — that would manufacture
  agreement exactly where evidence is absent, and at the most recent end of the series.

### Not built: the write side

`models:settle-auxiliary` runs clean and reports `examined: 0`, because
`auxiliary_model_predictions` is empty. `save_auxiliary_prediction` exists in the Python
repository, but `ml:predict --competition-pool` scores enrolled *directional* pool
members, and volatility models are excluded from that pool by design. So:

1. volatility candidates need a shadow-prediction path — most plausibly their own pool,
   scoped by label scheme, rather than relaxing the directional pool's filter; and
2. a volatility scoreboard and competition is needed before promotion can be decided on
   settled outcomes, mirroring the directional rolling metrics.

Until (1) lands, settlement is correct and idle. The grading rule and the storage are the
parts that had to be right first; generating predictions into a path that could not score
them was what created this situation.


## Volatility scoreboard and competition (2026-08-03)

Completes the chain. Every stage is in the EOD pipeline:

```
train (pooled, gate MET) -> shadow-predict (4b) -> settle (2b) -> compete (5b) -> PRIMARY
```

### Design decisions

- **Metric arithmetic generalised, not duplicated.** `computeSettledMetrics` was bound to
  the directional labels, but the computation -- including `trivialAccuracy` -- is
  alphabet-agnostic. It moved to `settled-metrics.ts` and the directional entry point is
  now a thin binding; all 15 pre-existing directional tests pass unchanged. Copying it
  would have meant maintaining the trivial-accuracy reasoning in two places, and that is
  the single guard that exposed the directional target.
- **Correction (2026-08-03, later):** as first written this gate compared **accuracy
  only**, while its own doc comment claimed it required both axes. The claim in the
  commit message and in this record was therefore wrong at the time. `trivialMacroF1` -
  the closed-form macro-F1 of an always-majority predictor, `2p/(1+p)/N` - was added to
  `settled-metrics.ts` and the gate now genuinely checks both. The accuracy-only form had
  the mirror-image hole to the spreader: a majority-hugger edging past trivial accuracy
  while discriminating no better between classes than the trivial predictor itself.
  The **directional** gate in `model-competition.ts` had the same accuracy-only test and
  has been brought in line, with a test for the hugger case. That change is strictly
  narrowing - it can only exclude a pool member, never promote one - and no live PRIMARY
  moves, since every directional model already fails on accuracy.
- **The qualifying gate requires macro-F1 *and* accuracy above trivial.** Directly
  encodes the CPCV result: the directional target beat trivial on macro-F1 on 100% of
  splits while losing on accuracy on 93%. A macro-F1-only ranking promotes the
  class-spreader. A test constructs exactly that spreader and asserts exclusion.
- **Settled floor of 300, against the directional 60.** A pooled model writes one
  prediction per instrument per session, so 60 rows can be three sessions of twenty
  correlated names. 300 is roughly fifteen sessions.
- **No head-to-head daily-wins rule yet.** The directional 6-of-7 is calibrated against a
  coin-flip pass rate. With zero settled volatility predictions in existence, calibrating
  an equivalent would be inventing a threshold rather than measuring one. Recorded as
  deliberately absent.
- **Separate table, database-enforced.** `volatility_competition_state` with a unique
  partial index on `(label_scheme) WHERE role = 'PRIMARY'`. Verified by attempting to
  insert two PRIMARY rows; Postgres rejected it. A bug producing two champions fails
  loudly rather than leaving risk consumers reading whichever row they select.
- **Quarantine paths vacate the slot.** A PRIMARY that goes silent past the tolerance, or
  falls to or below trivial, is removed even when no challenger qualifies. The role write
  happens even when the assignment list is empty, or a demoted model would keep its
  authority.

### Verified against v2

```
candidatesExamined: 5, qualifying: 0, excludedForSample: 5,
decision: NO_QUALIFYING_MODEL, primaryModelKey: null
```

Correct: five volatility models exist and none has a settled prediction yet. It will sit
here until roughly fifteen sessions of settled outcomes accumulate. That is the design.

### Scope limit

A volatility PRIMARY authorises **risk and regime context only**. No directional consumer
reads `volatility_competition_state`, and no risk consumer reads it yet either -- wiring
that is a separate, explicit decision.

## Workstream A record: the data-readiness audit exists and gates training (2026-08-03)

Status: **built, measured, remediated, and wired into training and the EOD
pipeline. Stage 0's missing deliverable — the repeatable machine-readable
report — now exists, so Stage 0 is complete.**

### What was built

- Migration `034-data-readiness-reports`: immutable audit reports, hashed
  (SHA-256 over canonicalised JSON) and persisted, latest-first index.
- `npm run data:audit`: measures every stored `(instrument, timeframe)` series
  — coverage, integrity, provenance, freshness, volume, `ta-v1` indicator
  coverage — plus FII/DII context, and assigns each series
  READY / DEGRADED / STALE / INVALID. Assessment rules are pure functions in
  `market-data/domain/data-readiness.ts`, tested without a database. The audit
  exits 0 on findings: a DEGRADED series is a finding, not an audit failure.
- Fail-closed gate in `train.py`: before any data loads, the latest report must
  exist, be under seven days old, and show every trained series READY —
  a pooled run is refused listing every failing member at once. The clearing
  report's id and hash are recorded in `validationProtocol.dataReadiness`
  inside the checksummed artifact, so every model can prove the data health it
  trained under. `--allow-unaudited-data` exists for scratch databases and
  records `enforced: false` permanently.
- EOD pipeline: the audit runs as step 1b (after collection, before training),
  and training steps are now individually isolated — a gate refusal is recorded
  loudly and the pipeline still settles, shadow-predicts, and competes, exiting
  non-zero at the end if any training step failed.

Measurement choices that need stating: expected bars per intraday session are
the series' own modal bars-per-session (no exchange holiday calendar is stored,
and the modal count needs none); freshness and gaps are measured in missed
weekday sessions, tolerating 3 and 5 respectively; indicator coverage is
measured over post-warm-up bars (40-bar allowance) and VWAP is reported but
never gated, since it is undefined without traded volume.

### What the first audit found

The first run measured 100 series: 28 READY, 72 DEGRADED, 0 STALE, 0 INVALID.
Three findings mattered:

1. **NIFTY50 and BANKNIFTY 15m had 0–8% `ta-v1` indicator coverage.** The
   nightly 15m models had been training against almost entirely imputed
   indicator features, and nothing said so. Remediated by recomputing
   indicators over the full stored range (~7,900 snapshots per index); both
   series are now READY.
2. **Every Yahoo intraday series carried expired provisional bars** (2–3 per
   index series, 57–59 on the India VIX intraday series): Yahoo's chart API
   appends the in-progress bar keyed at *last trade time* rather than the
   timeframe grid, the importer stored it provisionally, and no later fetch
   could ever match its off-grid key to finalise it. Fixed at the source —
   `ImportHistoricalMarketData` now defers in-progress bars entirely
   (settled evidence only; the forming bar belongs to the live collector) —
   and the accumulated orphans were removed by migration
   `035-purge-expired-provisional-candles`, same reasoning as the 013 and 033
   purges: fabricated windows, not market coverage.
3. **NIFTY50 5m has a 500-weekday internal gap** — a January 2026 Fyers probe
   cluster plus the Jan–Jul 2026 backfill. Left DEGRADED deliberately; nothing
   trains on it, and the gap is now visible instead of implied.

After remediation: 32 READY, 68 DEGRADED. Every series the EOD pipeline trains
on (NIFTY50 15m, NIFTY50 1d, the twenty research equities 1d) is READY. The
remaining DEGRADED series are honest: equity/index 30m and 60m have no `ta-v1`
snapshots because nothing trains there, and INDIAVIX 5m sits at 90–94%
indicator coverage while its short history accumulates.

### Verified end to end

- A 30m NIFTY50 training run is refused, exit 1, citing the audit id and every
  failing indicator floor.
- A 1d NIFTY50 run trains and its persisted `validationProtocol.dataReadiness`
  carries `enforced: true`, the report id, hash, and per-symbol states.
- 21 new TypeScript domain tests and 8 new Python gate tests; full suites pass
  (API 415, ML 171 + 195 subtests).

## Timeframe naming collision resolved (2026-08-03)

`1h` and `60m` were two names for one interval. `1h` is absent from
`supportedHistoricalTimeframes`, so no collector could produce it; the only rows carrying
it came from `seed-market-data.ts`.

It was not cosmetic. `postgres-trade-review-repository.ts` ranked timeframes finest-first
and listed `1h` but **not** `60m`, so every trade review searched 108 fabricated seed bars
while 78,000 real `60m` bars sat under the canonical name -- and fell through to `1d`
whenever the seed bars did not span the holding period, silently loosening the MAE/MFE
bound to a whole daily range. `30m` was missing from the ladder too, despite 11,846
stored bars.

Fixed: the ladder now reads `1m, 3m, 5m, 10m, 15m, 30m, 60m, 1d`; the seed emits `60m`;
and migration `033-purge-seeded-1h-candles` removes the 108 rows (466 dependent indicator
snapshots cascading). 84 of the 108 aligned to a real `60m` open time, 24 did not, and 18
were not on the `:45` session grid -- seed interval arithmetic, not market observations,
so the deletion removes fabricated evidence rather than coverage. Same reasoning as
`013-purge-fabricated-rsi`.


## Straddle cost study: what the volatility signal must achieve (2026-08-03)

The first attempt to price the volatility signal as a straddle produced an 80.5% win rate.
That was wrong, and the error is worth recording because it is the exact failure this
project's purging machinery exists to prevent.

**Error 1 - conditioning on the outcome.** The study selected bars whose *realised* label
was EXPANSION. That label is computed from the forward window, so it selects the bars where
the future move was large and then measures whether the future move was large. There was no
model in the study at all.

**Error 2 - tenor mismatch.** The straddle was priced to the next Thursday, sometimes one
day away and therefore very cheap, while the payoff was measured over five days. A cheap
option against a long measurement window manufactures profit; it accounted for the entire
apparent +56 pts baseline in the corrected-selection run.

With the tenor matched to the label horizon (a synthetic five-trading-day option, which is
the right research construct for asking whether predicted range beats implied move over the
*same* window), NIFTY50 `1d`, 2023-01 onward, IV from that session's India VIX, held to
expiry and valued at intrinsic:

| Panel | Entries | Win rate | Mean P&L per unit |
|---|---|---|---|
| **A - buy every actionable straddle (no signal)** | 765 | 36.9% | **-43.5 pts** |
| C - selecting on the realised label (INVALID) | 211 | 73.9% | +145.2 pts |

Panel A is the honest baseline and it is *negative*, as theory requires: buying premium
loses to the variance risk premium. The 36.9% win rate is squarely in the expected range
for a long straddle held to expiry. The gap between the two panels is look-ahead, not edge.

### The decision-relevant number

Splitting the baseline by realised outcome and solving for the precision at which expected
P&L reaches zero:

| | |
|---|---|
| Mean P&L when range did expand | +145.2 pts (n=211) |
| Mean P&L when it did not | -115.4 pts (n=554) |
| EXPANSION base rate — a no-skill model's precision | 27.6% |
| **Breakeven EXPANSION precision, before fees** | **44.3%** |
| Required lift over the base rate | **1.61x** |

So the model must reach roughly 44% precision on the EXPANSION class before the strategy
stops losing money, and that is before two legs of brokerage and STT. Fees push it higher.

### The gap this exposes

**Per-class precision is not recorded anywhere.** The pooled model's stored
`validationMetrics` carries macro-F1, accuracy, balanced accuracy, coverage, class counts,
and a committed hit rate — but no per-class precision. The promotion gate scores macro-F1;
the trading decision needs EXPANSION precision specifically. Those are different
quantities, and only the second determines whether the straddle makes money.

The closest available proxy is the committed hit rate of 0.5532 over 479 committed calls,
which is above the 44.3% breakeven. That is encouraging and it is **not** a measurement of
what matters: it pools CONTRACTION with EXPANSION, and only EXPANSION is tradeable at all
under `023-option-contract-requires-long`.

Recording per-class precision and recall in `validationMetrics` is therefore the next
concrete step, and it is a prerequisite for any decision about trading this signal. It also
satisfies invariant 8 directly: a classification gain that does not improve net-of-cost
utility is not an improvement, and until per-class precision is recorded that cannot be
evaluated.

The economics gate itself refuses 12.1% of bars, 78 of them because the option chain
already prices a move larger than the signal predicts.


## Per-class precision recorded, and what it says about the straddle (2026-08-04)

`EvaluationMetrics` now carries a `per_class` block -- precision, recall, F1, predicted
count and actual count for every label -- serialised into `validationMetrics.perClass`.
Added because macro-F1 cannot answer a trading question: a straddle is taken only on a
predicted EXPANSION, so that one class's precision decides whether the strategy pays, and
macro-F1 averages exactly that away.

**`precision` is null, not zero, when a class was never predicted.** sklearn's
`zero_division=0` reports 0.0 there, which reads as "always wrong" when the truth is
"never attempted" -- opposite situations for a strategy that only acts on one class. Same
rule for `recall` when a class never occurred. Five tests pin this.

### The answer, and it is not the encouraging one

Against the 44.3% breakeven EXPANSION precision established by the straddle cost study:

| Model | EXPANSION precision | n | Std. error | vs 44.3% breakeven |
|---|---|---|---|---|
| Pooled 19 equities, 5 folds | **0.486** | 286 | +/-3.0pp | 1.45 SE **above** |
| NIFTY50 single instrument, 2 folds | **0.385** | 13 | +/-13.5pp | 0.43 SE **below** |

The two point in opposite directions, and the mismatch is the finding:

- The **pooled equity** model clears the breakeven with a tight error bar -- but the
  breakeven was computed on **NIFTY50 index** straddles. Equity options have different
  liquidity, lot sizes and IV surfaces, so that 0.486 does not transfer to the
  instrument the economics were measured on.
- The **NIFTY50** model, whose instrument actually has a liquid straddle, sits *below*
  breakeven -- on **13 predictions**. At that sample the standard error is 13.5pp and the
  breakeven is well inside one SE, so this is **inconclusive, not decisively negative**.
  It also barely calls EXPANSION at all: recall 0.167.

So the honest position: **the signal that has a tradeable options market cannot yet be
shown to clear its breakeven, and the model that clears a breakeven trades instruments
whose straddle economics have not been measured.** Nothing here justifies trading, and
nothing here rules it out. Thirteen predictions cannot decide a 6pp question.

What would decide it, in order:

1. Straddle economics computed on the **equity panel**, so the 0.486 can be compared
   against a breakeven from the same instruments. Equity option liquidity is the risk.
2. A NIFTY50 EXPANSION sample large enough to have an error bar under ~3pp, which means
   roughly 250 predictions rather than 13 -- i.e. settled live evidence, not holdout.
3. Fees. Both figures are pre-cost, and two legs of brokerage plus STT eat directly into
   a 4pp margin.

### Operational notes from this run

- The data-readiness gate refused training twice, correctly. First for 20 stale
  provisional daily bars whose window had closed unfinalised; re-collecting finalised 18
  of them. Then for TITAN alone, whose bar the importer defers because Yahoo has no
  settled value for it. TITAN was **excluded from the pool** rather than having its data
  deleted to make a gate pass -- hence `pool19` and a different model key.
- The gate reads the **stored** audit report, not a live check, so `npm run data:audit`
  must be re-run after fixing data or the training refusal cites the stale report.

### Stage 2: Feature discipline and validation activation

- Evaluate aggregate/drop alternatives for sparse features.
- Add breadth/cross-index features point-in-time.
- Bump the swing schema once.
- Use multiple walk-forward folds where sample size supports the minimum fold rows.
- Run CPCV as a report-only diagnostic.

**Exit:** new schema beats or matches the old schema with lower capacity and stable folds.
**Met 2026-08-03:** `ml-feature-v6` (36 columns) matches v5 (113 columns) within noise on
the pooled CPCV and beats it outright on both single-instrument runs — see the Stage 2
`ml-feature-v6` record above.

### Stage 3: CatBoost challenger

- Add the numeric CatBoost family and dedicated SHAP path.
- Train on identical folds and exact baselines.
- Enroll only after the research gates pass.

**Exit:** retain as challenger only if value or useful error diversity is demonstrated.
**Met partially 2026-08-03:** family + SHAP path shipped and audited; research gates did
*not* clear for EOD enrollment (CatBoost loses to LightGBM/logistic on identical folds).
See the Stage 3 CatBoost record above. Revisit only with new evidence.

### Stage 4: Intraday data foundation

- Choose futures/ETF/constituent semantics.
- Backfill native intraday history from a consistent source.
- Recompute indicators.
- Add authorized option-chain snapshots if included.
- Run the sequence-readiness audit.

**Exit:** the relevant TCN data gate passes.
**Met 2026-08-04 for `tcn-1m` on NIFTYBEES.** The 5m gate remains unmet (66k / 100k
bars) and option-chain snapshots remain unauthorized — see the Stage 4 record above.

### Stage 5: Compact TCN experiment

- Introduce optional deep-learning infrastructure.
- Implement sequence contract, group-aware purge, model, artifact, and explanation.
- Benchmark against trees with equivalent lagged information.

Status: **TCN research gate PASS (NIFTYBEES 1m, tcn-1m)** — the candidate beats the strongest tabular lag baseline and trivial on every outer fold.

**Measured (volatility-expansion-v1, horizon=5, lookback=64, channels=16, params=6771):**

| Fold | TCN macro-F1 | lag LightGBM macro-F1 | trivial macro-F1 |
| --- | ---: | ---: | ---: |
| 1/3 | 0.5383 | 0.5054 | 0.1811 |
| 2/3 | 0.5127 | 0.4894 | 0.1734 |
| 3/3 | 0.4907 | 0.4585 | 0.1726 |

| Mean (3 folds) | macro-F1 |
| --- | ---: |
| TCN | **0.5139** |
| lag LightGBM | 0.4844 |
| trivial | 0.1757 |

Artifact:
- algorithm: `pytorch-causal-tcn-v1`
- path: `models/volatility-expansion-tcn--NIFTYBEES--1m--h5--lookback64--ml-feature-scalp-v2--volatility-expansion-v1--band0.25/20260804T071226339499Z-tcn.pkl`
- sha256: `85ae39d07573bc26f0a96191a1721153c29c88900c92a2139239f5b2f63e993c`

Enrollment decision: **defer EOD** (research-only run; no live promotion in Stage 5), but **unblock Stage 6 stacking** using the TCN + existing lag LightGBM family.

**Exit:** advance only on stable incremental out-of-sample and net-of-cost value.

### Stage 6: Stacking

- Confirm base-model qualification and error diversity.
- Generate nested temporal OOF probabilities.
- Train/evaluate the regularized meta-learner.
- Add two-layer explanation and full lineage.

Status: **research gate PASS on NIFTYBEES 1m** — OOF logistic stack beats the best
base (TCN) on the untouched holdout fold and improves holdout log-loss/Brier.

**Bases:** `pytorch-causal-tcn-v1` + lag `lightgbm-gradient-boosting-v1` (same Stage 5
folds / sequences). CatBoost remains excluded (Stage 3 no-go).

**Diversity (all OOF rows):** disagreement 32.2%, error correlation 0.505 → PASS.

**Holdout fold 3 (n=2926):**

| Model | macro-F1 | accuracy | log-loss | Brier |
| --- | ---: | ---: | ---: | ---: |
| Stack (`oof-logistic-stack-v1`) | **0.5103** | **0.5062** | **0.9759** | **0.1958** |
| Best base (TCN) | 0.4907 | 0.4891 | 0.9779 | 0.1969 |
| lag LightGBM | (outer fold 3) 0.4585 | — | 1.0092 | 0.2031 |

Artifacts:
- stack: `models/volatility-expansion-stack--NIFTYBEES--1m--h5--lookback64--ml-feature-scalp-v2--volatility-expansion-v1--band0.25/20260804T080245660072Z-stack.pkl`
- sha256: `96bccc33d2e70c0b6a8aa0d7477d4552b9b8d99558a6238f591d6d7d337aeb76`
- bases cited in stack metadata (TCN + lag LightGBM checksums)

Enrollment decision: **defer EOD** (researchAdvances true; settled shadow evidence still
required before promotion). CLI: `npm run ml:train:stack`.

**Shadow enrollment (2026-08-04 follow-on):** TCN and stack are registered as
`CANDIDATE` rows under `volatility-expansion-v1` (not EOD-trained). Sequence scoring
is wired into `ml:predict --shadow-scheme volatility-expansion-v1` via
`sequence_inference.py`; register with `npm run ml:register:sequence-shadow`. Torch is
installed in the API image (`requirements-dl.txt`). Honest no-backdating refuses
candles at/before the research cutoff (`2026-08-04T05:00:00Z`); settled evidence
accrues once fresh NIFTYBEES 1m bars arrive and EOD steps 4b→2b→5b run.

**Exit:** stack must beat the best base model by more than evaluation noise.

### Stage 7: Reconsider deferred architectures

- TFT only for a large, clean, multi-horizon panel with point-in-time covariates.
- TabNet only after sufficient tabular scale and failure of simpler models.
- PPO only in a separately approved execution-research phase with L2/tick data.

Status: **all three remain deferred / out of scope (2026-08-04).** No new architecture
is authorized. Phase 25's staged model queue is closed at Stage 6 for implementation
work; Stage 7 is a recorded reconsideration, not a build.

Evidence against each gate (fresh sequence-readiness report
`d18f61d8-ae03-4478-a0e9-73349df53c20` + DB probe):

| Architecture | Gate | Current evidence | Decision |
| --- | --- | --- | --- |
| TFT | TCN gates + large multi-instrument panel + multiple explicit horizons + ≥1y PIT exogenous snapshots | Only `NIFTYBEES 1m` sequence-PASS; `tcn-5m` FAIL (66k/100k); 4 instruments with 1m history; no option-chain / dedicated exogenous snapshot tables | **Defer** |
| TabNet | Sufficient tabular scale **and** failure of simpler models | Swing GBDTs, NIFTYBEES TCN, and OOF stack already produce usable OOS signal; all-numeric schema still favors trees | **Defer** |
| PPO / deep RL | Recorded L2/ticks, order/fill history, independently validated fill/cost simulator | No tick / order-book / fill / execution tables in the v2 DB; no approved execution-research phase | **Out of scope** |

Do **not** add TFT, TabNet, or PPO dependencies, trainers, or EOD enrollment on the basis
of Stage 5/6 research success. The correct follow-on for accepted research candidates
(TCN, stack) is settled shadow evidence under the existing competition/promotion rules —
not a new architecture family.

## Rollback and recovery

- Data collectors are additive until independently validated.
- New algorithms use new immutable identifiers; old artifacts remain auditable.
- Feature changes create a new schema and competition group rather than modifying v5.
- Research equities remain inactive to prevent accidental scanner/strategy expansion.
- A failed candidate is archived or pruned only through existing reference-safe rules.
- A new data source does not overwrite immutable completed candles without an explicit,
  audited migration/cutover plan.
- PyTorch remains optional; removing the deep profile must not affect tree inference.
- The PRIMARY remains unchanged throughout research unless the existing live promotion
  conditions are genuinely satisfied.

## Definition of done

This phase is complete only when:

1. A repeatable data-readiness report exists and gates training.
2. Swing external/context features are historically populated or explicitly unavailable.
3. The feature-capacity experiment has a recorded decision and immutable new schema if
   adopted.
4. CatBoost has been evaluated on the exact same rows/folds as existing GBDTs, with a
   dedicated valid explanation path.
5. TCN is either correctly deferred by an unmet numeric data gate or evaluated under the
   full sequence/CV contract.
6. Stacking is either correctly deferred for lack of qualified diverse bases or evaluated
   using nested temporal OOF predictions.
7. Every accepted model has predictive, calibration, cost, leakage, operational, and live
   settlement evidence.
8. No model was promoted because it merely trained successfully or produced an attractive
   dashboard score.
9. The project retains a clear audit trail explaining every go/no-go decision.

## Recommended immediate next action

Stages 0–7 of this phase are complete for their intended scope: readiness gates, v6
capacity, CatBoost (no-go), intraday sequence foundation, TCN (research advance), OOF
stack (research advance), and deferred-architecture reconsideration (still no-go).

Shadow wiring for TCN/stack is in place (candidates registered; sequence predict path
live). Remaining operational work:

1. Re-auth Fyers interactively (`npm run data:auth:fyers`) then collect **NIFTYBEES 1m**
   past the research cutoff so EOD 4b→2b→5b can write, settle, and compete auxiliary
   predictions. (Refresh API is SEBI-disabled — automatic token refresh fails.)
2. api-v2/scheduler-v2 images rebuilt with torch (2026-08-04); keep them current after
   further ML dependency changes.
3. Keep CatBoost / TFT / TabNet / PPO out of EOD until their gates independently clear.

## Primary references

- CatBoost ordered boosting: https://proceedings.neurips.cc/paper/2018/hash/14491b756b3a51daac41c24863285549-Abstract.html
- TCN sequence evaluation: https://arxiv.org/abs/1803.01271
- Temporal Fusion Transformer: https://arxiv.org/abs/1912.09363
- TabNet: https://arxiv.org/abs/1908.07442
- PPO: https://arxiv.org/abs/1707.06347
- Tabular trees versus deep learning: https://proceedings.neurips.cc/paper_files/paper/2022/hash/0378c7692da36807bdec87ab043cdadc-Abstract-Datasets_and_Benchmarks.html
- NSE India VIX: https://www.nseindia.com/static/products-services/indices-indiavix-index
- NSE data products: https://www.nseindia.com/static/nse-data-and-analytics
