# Phase 24: Model capacity discipline before new architectures

Status: **plan only**. No code in this phase has been written yet. This document is the
design and the decision record; implementation follows in a separate change.

This phase exists because of a specific question: should the stack add CatBoost, Temporal
Fusion Transformers, LSTMs/TCNs, TabNet, or PPO alongside the existing tree models? The
answer, measured against the current database rather than argued in the abstract, is *one
of them, later than you would like, and not for the reason you would expect*. What follows
is that measurement and the work it implies.

## Scope

Four things, none of them a new model family except the cheapest one:

1. Cut `ml-feature-v5` from 113 features to roughly 30, scored under purged CV.
2. Use the validation options `train.py` already exposes and nothing ever passes.
3. Add CatBoost as a fourth entry in `TRAINERS`.
4. Build constituent breadth features from the migration-027 equity universe.

Explicitly **out of scope**: TFT, LSTM, TCN, TabNet, PPO, any PyTorch dependency, and any
change to the promotion gate's chronological semantics. The data gates that would justify
revisiting the sequence models are recorded at the end so the decision can be reopened on
evidence rather than enthusiasm.

## Theory and purpose

The stack is not short of algorithms. It has three trainable estimators, a purged
chronological split, optional walk-forward folds, Combinatorial Purged CV with an embargo,
a three-check leakage audit, a champion/challenger competition pool, and shadow
predictions. Measured against what most retail quant projects run, the harness is the
strong part.

It is short of data, and the shortfall is not marginal.

**The last promoted model trained on 653 rows with 113 features.** That is 5.8 observations
per feature. Training macro-F1 was 0.5165 and holdout macro-F1 was 0.4008 against a 0.3333
random baseline for the three-class target, so roughly two-thirds of the apparent skill did
not survive contact with unseen data. Every architecture in the question adds parameters.
Adding parameters to a model that already loses two-thirds of its training score on holdout
does not produce alpha; it produces a larger gap and a more confident wrong answer.

**Intraday history is measured in sessions.** As of 2026-07-31, `candles` holds, for
NIFTY50:

| Timeframe | Bars | Range | Sessions | Zero-volume |
|---|---|---|---|---|
| `1m` | 2,254 | 2026-07-24 → 07-31 | 6 | 100% |
| `5m` | 129 | 2026-07-30 → 07-31 | 2 | 100% |
| `15m` | 1,104 | 2026-06-01 → 07-31 | ~44 | 100% |
| `1h` | 41 | 2026-07-24 → 07-31 | 6 | 100% |
| `1d` | 882 | 2023-01-02 → 2026-07-31 | 882 | 0.8% |

BANKNIFTY is within a few bars of identical. A TCN on six sessions of 1-minute data is not
a research project, it is a memorisation exercise.

**The zero-volume column is not cosmetic.** Phase 23 documents why index intraday volume is
absent and why a provider swap will not fix it. The consequence for this phase is that
`indicator.VWAP.value_bps` never resolves on an intraday index bar — the engine only
accumulates VWAP when `volume > 0` — and `candle.volume_median_ratio` imputes to a
constant, which `features.py` already says out loud:

```117:120:apps/ml/ai_quant_lab_ml/features.py
# ``volume_median_ratio`` is deliberately retained. It is the right normalisation
# for scalping the moment the feed carries real volume; note that Yahoo's ^NSEI
# 1m series reports zero volume on every bar, so against that source the column
# imputes to a constant and contributes nothing.
```

**There is no order book anywhere in the system.** The finest granularity is OHLCV. The
Kite live provider polls quote snapshots on a 30-second interval and is not registered with
the scheduler; there is no websocket, no SSE market-data stream, no bid/ask, no depth, no
tick tape. Deep reinforcement learning over Level-2 flow has no input modality to consume,
and unlike every other gap in this document it cannot be closed retroactively — brokers
stream depth but sell no historical archive.

## The capacity argument

Composition of `ml-feature-v5`, from `_build_feature_schema` at
`apps/ml/ai_quant_lab_ml/features.py:190-210`:

| Group | Count | Share |
|---|---|---|
| Candlestick pattern confidences (14 codes × 3 directions) | 42 | 37% |
| Price-action event confidences (10 events × 3 directions) | 30 | 27% |
| Technical indicators | 17 | 15% |
| Raw candle geometry | 11 | 10% |
| Price-action level distances | 10 | 9% |
| Regime and flow (VIX, FII, DII) | 3 | 3% |

Sixty-four percent of the feature space is pattern and event confidence scores that are
zero on most bars. On 653 rows those columns are close to pure noise, and they are the
reason the model has enough freedom to fit 0.5165 in training. The three features carrying
genuine external information — VIX regime, FII flow, DII flow — are outnumbered
twenty-four to one, and two of the three are dead (see below).

This is the actual bottleneck. A feature-selection pass scored under the existing purged CV
is very likely to move holdout score more than any new model class, and it costs no new
data, no new dependency, and no new infrastructure.

## What the harness already does — do not rebuild it

Two capabilities exist and are simply never invoked. Both are opt-in flags with defaults
that disable them.

**Walk-forward folds default to one.** `train.py:267` declares
`--folds` with `default=1`, and `walk_forward_splits` short-circuits to a single
chronological split at that value. Every `validation_protocol` recorded in `model_versions`
therefore shows `"folds": 1`, meaning the whole promotion decision rests on one trailing
20% block — about 166 rows — and on whichever regime the final months happened to be. This
is the gate, so raising it is a legitimate and high-value change.

**CPCV is implemented, correct, and off.** `combinatorial_purged_splits` in
`apps/ml/ai_quant_lab_ml/validation.py:145` implements Lopez de Prado ch. 12 with two
defences: purging evaluated on real `observed_at` → `label_available_at` timestamps rather
than a bar count, so an early-resolving triple-barrier label purges exactly as much as it
must, and an embargo that drops training rows immediately after each test block. It runs
only when `--cpcv-groups` is passed, which nothing does.

A caution that matters more than it looks: CPCV must **not** be promoted into the gate.
`train.py:934-939` already explains why, and the reasoning is correct — CPCV trains on
later data to score earlier data, which is a fair robustness question and an unfair
deployment simulation. The work here is to *run* it as a research second opinion alongside
the chronological gate, not to let it decide anything. Anyone reading "wire up CPCV" as
"gate on CPCV" has inverted the design.

## Architecture decisions

Data requirements below are the practical volume under which each architecture reliably
memorises financial series. They are order-of-magnitude judgements, not citations.

| Architecture | Target timeframe | Needs | Have | Decision |
|---|---|---|---|---|
| **CatBoost** | Swing `1d` | ~500 rows | 653 | **Adopt.** Ordered boosting targets exactly this failure mode |
| TabNet | Swing `1d` | ~10k rows | 653 | Reject — 15× short, and it loses to GBDTs on tabular data at any size the lab will reach |
| LSTM | Intraday `5m`/`15m` | ~50k bars | 1,233 | Defer — 40× short, and no volume to learn from |
| TFT | Intraday `5m`/`15m` | ~100k+ bars | 1,233 | Defer — 80× short; its value is multi-horizon covariates not yet ingested |
| TCN | Scalp `1m` | ~200k bars | 2,254 | Defer — 90× short, six sessions, zero volume |
| PPO / deep RL | Tick / L2 | Order book + fills | None | Reject for now — the input does not exist and cannot be backfilled |

CatBoost is the only adopt, and it earns that on small-sample behaviour rather than
capacity. Ordered boosting computes each example's leaf statistics from a permutation
prefix that excludes the example itself, which directly attacks the target leakage that
makes standard GBDTs overfit thin data. It is also the cheapest possible change: the
trainer registry is a three-entry dict,

```493:497:apps/ml/ai_quant_lab_ml/training.py
TRAINERS = {
    "logistic": train_logistic_regression_baseline,
    "xgboost": train_xgboost_classifier,
    "lightgbm": train_lightgbm_classifier,
}
```

and `apps/ml/tests/test_gradient_boosting.py:161-163` already asserts that
`train_model("catboost", ...)` raises `TrainingError`, so the seam is defined and the test
that must change is already written.

Two honest qualifications. CatBoost will not rescue a 653-row dataset — expect single-digit
basis points of holdout macro-F1, not a step change; it is worth doing because it is a
day's work inside an existing competition loop, not because it solves the problem. And it
adds a third gradient-boosting library to `requirements.txt` for a marginal gain, which is
a real cost if the lab ever cares about image size or install time.

## Latency is not the constraint

The original question asked about deep-learning inference speed in real-time trading. That
concern is premature here by two orders of magnitude. There is no streaming market-data
feed; intraday predictions run on a 15-minute cron
(`INTRADAY_MODEL_PREDICTIONS`, `*/15 9-15 * * 1-5`), the EOD pipeline runs once at 16:05
IST, and the only live collector is a 30-second poll that the scheduler does not run.
Against a pipeline measured in minutes, the difference between a microsecond GBDT and a
millisecond sequence model does not appear in any result. Latency becomes a real design
input only after a streaming feed exists, which is a separate build from anything here.

## Work items

### 1. Feature reduction

Target roughly 30 features from the current 113, chosen by a selection pass scored under
`walk_forward_splits`, not under a single split and not by in-sample importance.

The pattern and price-action confidence blocks are the obvious candidates. Two options,
preferring the first:

1. **Aggregate.** Replace the 42 pattern columns with a small number of summary features —
   net bullish-minus-bearish pattern confidence, count of patterns firing, maximum
   confidence — and do the same for the 30 price-action confidences. This keeps the signal
   the blocks were meant to carry while collapsing the dimensionality.
2. **Drop outright** and measure. Faster, and if holdout does not move it is the better
   answer, but it discards the possibility that a specific pattern matters.

This is a feature-schema change, so it takes a version bump to `ml-feature-v6` and a fresh
competition pool. Models trained on v5 must not be compared against v6 models on holdout
score, for the same reason Phase 23 retires the pre-purge scalp models.

### 2. Turn on the validation the harness already has

Raise the default for `--folds` above 1 in the EOD pipeline invocation, and start passing
`--cpcv-groups` for research reporting. Neither requires code changes to `validation.py`.

The number of folds is bounded by the data: with 653 examples, a 20% validation fraction
and a 10-bar purge, five folds leaves roughly 26 rows per fold, which is below the gate's
own `minimumValidationRows` of 60. Three folds is the realistic ceiling today, and that
constraint is itself an argument for the data work rather than the model work.

### 3. CatBoost

Add `train_catboost_classifier` beside the XGBoost and LightGBM trainers, following their
shape exactly: `SimpleImputer` → `StandardScaler` → classifier wrapped in
`LabelEncodedClassifier`, hyperparameters threaded through the same dict, `random_state`
honoured, deterministic settings on. Register `"catboost"` in `TRAINERS` and
`ALGORITHM_BY_CHOICE`, add `catboost-gradient-boosting-v1` to the algorithm constants, and
invert the rejection test. Native TreeSHAP is available through the same `pred_contribs`
family of APIs that `inference.py` already uses for the other two.

### 4. Constituent breadth features

Migration `027-equity-training-universe` registers twenty NSE large-caps with
`is_active = FALSE`, described as being for ML training breadth. They carry 886 daily bars
each **with real volume**, unlike the index itself. Nothing reads them.

This is the highest-value feature work available because it requires no new data source, no
broker credential, and no infrastructure. Candidates, all computable from bars already
stored:

- Advance-decline ratio across the twenty names.
- Share of constituents trading above their own 20-day moving average.
- Cross-sectional dispersion of daily returns — a regime signal in its own right.
- Banking versus IT relative strength, using the existing bank and IT names as crude sector
  proxies.
- Median constituent volume ratio, which is the volume signal the index cannot provide.

These are also, precisely, the sector-rotation effects a meta-learner was hoped to
discover. Handing them to the model directly is strictly better than asking it to infer
them from 653 rows.

Two cautions. The twenty names are not weighted and are not the index constituents, so
these are breadth proxies rather than a decomposition of NIFTY — do not name them as though
they were. And the equities are `is_active = FALSE`, so confirm the ML repository's
evidence query reaches inactive instruments before assuming the data is loadable.

### 5. Dead features and the VIX ingestion gap

Three features currently contribute nothing:

| Feature | Why it is dead |
|---|---|
| `market.fii_net_flow_ratio` | `institutional_flows` holds one row |
| `market.dii_net_flow_ratio` | same |
| `candle.volume_median_ratio` | constant on zero-volume index intraday, per the comment above |

The FII/DII collector is scheduled and runs at 18:30 IST on weekdays, so this is a history
gap rather than a missing pipeline — the fix is a backfill from NSE, not a new integration.
Until that lands, a constant column with an informative name is worse than no column,
because it invites trust in a signal that is not there.

Separately, and more urgent than anything else in this document: **nothing refreshes India
VIX on a schedule.** No seed, migration, or scheduler job registers an `INDIAVIX` instrument
or fetches its candles. The 629 daily bars in the database were collected by hand, and they
start 2024-01-02 while the training window opens 2023-01-01, so the first year has no VIX
at all. Three consumers assume the series is current: the ML regime feature, the strategy
regime gate in `PostgresStrategyMarketContextRepository`, and the Black-Scholes implied
volatility source that prices paper-trading options. This is a live staleness risk today,
independent of models. Backfill to 2023 and add a collector job.

## Data gates for revisiting the deferred architectures

Recorded so the decision reopens on evidence. Each gate is necessary, not sufficient.

| Architecture | Reopen when |
|---|---|
| LSTM / TCN on `15m` | ≥ 50k bars of `15m` with non-zero volume, from a single provider |
| TCN on `1m` | ≥ 200k bars of `1m` with non-zero volume, and `ta-v1` indicator coverage on those bars |
| TFT | The above, **plus** an option-chain pipeline supplying PCR / OI / Max Pain as known-future covariates |
| TabNet | ≥ 10k training rows on the swing schema, and only after CatBoost has been beaten by nothing simpler |
| PPO / deep RL | ≥ 6 months of recorded depth snapshots, which means starting a recorder first |

Two of these gates depend on Phase 23 landing, and one depends on a pipeline that does not
exist in any phase yet.

Note also that non-zero volume on an *index* is not obtainable from any vendor — Phase 23's
volume caveat applies unchanged. Satisfying the intraday gates realistically means training
on NIFTY futures or a liquid ETF proxy rather than the spot index, which is an instrument
change with its own rollover problems, or on the equity universe, which has real volume at
every resolution today.

### The scalp schema has a second blocker

`ml-feature-scalp-v2` needs the seventeen indicator features at `algorithm_version = 'ta-v1'`.
On `1m`, the database currently holds `ta-v1` snapshots for RSI, SMA and Bollinger only —
no `ta-v1` EMA, VWAP, ATR, MACD or SuperTrend exists at that timeframe. The abundant 1-minute
EMA/RSI/VWAP rows are the seeded `v1` approximations, which the TA pipeline deliberately does
not match. So even with Fyers data in hand, the scalp feature builder would assemble vectors
with most indicator columns imputed until `analysis:calculate-indicators` is run across the
backfilled 1-minute range. Budget that step; it is easy to forget and it fails quietly.

## Implementation order

Each step leaves the tree working.

1. Backfill India VIX to 2023 and add a scheduled collector. Independent of everything else
   and fixes a live problem.
2. Backfill FII/DII daily history from NSE.
3. CatBoost trainer, registry entries, inverted rejection test. Additive; the competition
   pool decides whether it is worth keeping.
4. Constituent breadth features behind a `ml-feature-v6` schema bump.
5. Feature reduction of the pattern and price-action blocks, in the same v6 bump as step 4
   so there is one schema change and one competition reset rather than two.
6. Raise `--folds` in the EOD pipeline; start passing `--cpcv-groups` for reporting.
7. Retrain and reset the swing competition pool under v6.

Steps 1–3 are additive and reversible. Steps 4–5 change the feature schema, which is the
point where old and new models stop being comparable.

## Code decisions

- CatBoost joins `TRAINERS` rather than getting a bespoke path, because the whole value of
  the registry is that a fourth algorithm is a dict entry and a test.
- The feature cut and the breadth features ship as one schema version, not two, so the
  competition pool resets once.
- CPCV stays out of the promotion gate. The existing comment in `train.py` is the reason and
  it does not need relitigating.
- No PyTorch dependency is added. Nothing in scope needs it, and adding it "for later"
  invites a sequence model to be prototyped against data that cannot support one.
- The deferred architectures get numeric gates rather than a vague "when we have more data",
  so the decision is falsifiable.

## Common mistakes

- Reading "the harness is good" as "the harness is finished" — folds are still at one.
- Gating promotion on CPCV scores. They are a robustness measurement, not a deployment
  simulation.
- Comparing a v6 model's holdout score against a v5 model's. Different feature spaces,
  different numbers.
- Backfilling intraday candles and training immediately, without running
  `analysis:calculate-indicators` over the new range first.
- Expecting CatBoost to move the needle. It is cheap insurance, not a fix.
- Treating the twenty equities as index constituents with weights. They are a breadth proxy.
- Adding features to compensate for a weak holdout score. That is the move that produced 113
  features on 653 rows.

## Open questions

1. Should the pattern and price-action blocks be aggregated or dropped? Measure both under
   walk-forward before choosing; the answer is empirical and cheap to obtain.
2. Is the volatility-expansion label scheme or the directional one the better primary target
   at this sample size? The three-class regime target may simply be easier to learn than
   direction, and the promotion gate currently scores both kinds of model on macro-F1 as
   though they were comparable.
3. Does the ML evidence query reach `is_active = FALSE` instruments? Gates work item 4.
4. Should the swing model train on the twenty equities as additional *rows* rather than only
   as breadth *columns*? That is the cheapest available route to more training rows — 20
   instruments × 886 bars is a far larger dataset than 653 — at the cost of assuming a shared
   cross-sectional model. The XGBoost runs at 1,933 training rows suggest multi-instrument
   training already happens somewhere; confirm what those runs used before designing around
   it.
5. Is Kite a cheaper route to intraday history than Fyers? Phase 23 flags this and prices the
   Kite historical subscription at ₹2000/month, which likely settles it — but the adapter is
   already written and maps all eight timeframes natively, so confirm the subscription status
   before writing Fyers code.
