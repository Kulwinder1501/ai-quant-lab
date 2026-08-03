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

### Stage 2: Feature discipline and validation activation

- Evaluate aggregate/drop alternatives for sparse features.
- Add breadth/cross-index features point-in-time.
- Bump the swing schema once.
- Use multiple walk-forward folds where sample size supports the minimum fold rows.
- Run CPCV as a report-only diagnostic.

**Exit:** new schema beats or matches the old schema with lower capacity and stable folds.

### Stage 3: CatBoost challenger

- Add the numeric CatBoost family and dedicated SHAP path.
- Train on identical folds and exact baselines.
- Enroll only after the research gates pass.

**Exit:** retain as challenger only if value or useful error diversity is demonstrated.

### Stage 4: Intraday data foundation

- Choose futures/ETF/constituent semantics.
- Backfill native intraday history from a consistent source.
- Recompute indicators.
- Add authorized option-chain snapshots if included.
- Run the sequence-readiness audit.

**Exit:** the relevant TCN data gate passes.

### Stage 5: Compact TCN experiment

- Introduce optional deep-learning infrastructure.
- Implement sequence contract, group-aware purge, model, artifact, and explanation.
- Benchmark against trees with equivalent lagged information.

**Exit:** advance only on stable incremental out-of-sample and net-of-cost value.

### Stage 6: Stacking

- Confirm base-model qualification and error diversity.
- Generate nested temporal OOF probabilities.
- Train/evaluate the regularized meta-learner.
- Add two-layer explanation and full lineage.

**Exit:** stack must beat the best base model by more than evaluation noise.

### Stage 7: Reconsider deferred architectures

- TFT only for a large, clean, multi-horizon panel with point-in-time covariates.
- TabNet only after sufficient tabular scale and failure of simpler models.
- PPO only in a separately approved execution-research phase with L2/tick data.

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

Do **Stage 0 only** first: generate the current data-readiness baseline. It will determine
whether the time-stamped counts in Phase 24 still hold and will turn the discussion from
"which model should we add?" into a measurable queue of missing data, dead features, and
eligible experiments.

Do not add CatBoost, PyTorch, TCN, or stacking in the same change as Stage 0. The baseline
must exist before the architecture work so that every later result has an honest reference.

## Primary references

- CatBoost ordered boosting: https://proceedings.neurips.cc/paper/2018/hash/14491b756b3a51daac41c24863285549-Abstract.html
- TCN sequence evaluation: https://arxiv.org/abs/1803.01271
- Temporal Fusion Transformer: https://arxiv.org/abs/1912.09363
- TabNet: https://arxiv.org/abs/1908.07442
- PPO: https://arxiv.org/abs/1707.06347
- Tabular trees versus deep learning: https://proceedings.neurips.cc/paper_files/paper/2022/hash/0378c7692da36807bdec87ab043cdadc-Abstract-Datasets_and_Benchmarks.html
- NSE India VIX: https://www.nseindia.com/static/products-services/indices-indiavix-index
- NSE data products: https://www.nseindia.com/static/nse-data-and-analytics
