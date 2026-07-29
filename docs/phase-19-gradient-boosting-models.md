# Phase 19: gradient-boosted model families with exact tree explanations

## Purpose

Phase 10 trained one model family: a scikit-learn logistic regression. XGBoost and
LightGBM were listed in `apps/ml/requirements.txt` from the start but nothing ever
imported them, so the project claimed gradient boosting it did not have.

This phase makes both real trainable families, keeps them inside the same
leakage-safe validation and promotion machinery, and gives each one an explainer
built for its own arithmetic. Nothing about the safety boundary changes: training
and inference still read local PostgreSQL, write a local artifact, and never touch
a broker.

## Theory and why it exists

A logistic regression scores a market condition as one weighted sum. That is easy
to explain and hard to overfit, but it can only express "more RSI, more bullish" —
a straight line through the feature space. Market structure is rarely that
obedient: a breakout with rising volume can mean something entirely different from
the same breakout with falling volume, and a linear model has no way to say so.

Gradient-boosted forests learn those interactions by construction. Each new shallow
tree fits the residual error the current ensemble still makes, so the ensemble can
carve the feature space into regions — exactly what "this pattern, but only in this
volatility regime" requires.

The cost is memorisation. A deep, unregularised forest on two years of daily bars
will reproduce its own history almost perfectly and then fail on the next unseen
month. That is why this phase changes the model family and nothing else about the
protocol: the same purged chronological split, the same unseen-data promotion gate,
and a new recorded metric — the training-to-validation gap — that makes
memorisation visible instead of leaving it to be discovered in production.

## Safety boundary

- Training and inference read stored candles, indicators, patterns, and price-action
  events. They place no order and open no broker session.
- A boosted model can be promoted to `PRODUCTION` only through the same explicit
  gate: it must beat the incumbent's macro-F1 on the *candidate's own* purged
  holdout, scored from a checksum-verified incumbent artifact.
- `predict.py` still writes one `model_predictions` row and nothing else. It creates
  no trade idea, paper fill, or order.
- An algorithm with no explainer in `inference.py` is refused at the production gate
  rather than being scored with borrowed language.

## Architecture

```text
train.py --algorithm {logistic|xgboost|lightgbm}
   │
   ├─ features.build_labeled_examples        fixed ml-feature-v1 schema
   ├─ validation.chronological_purged_split  train | purge gap | holdout
   ├─ training.train_model                   registry dispatch
   │     ├─ train_logistic_regression_baseline   sklearn LogisticRegression
   │     ├─ train_xgboost_classifier             XGBClassifier
   │     └─ train_lightgbm_classifier            LGBMClassifier
   │           └─ estimators.LabelEncodedClassifier  string labels <-> int codes
   ├─ artifacts.write_model_artifact         SHA-256 checksummed pickle
   └─ promotion gate                         macro-F1 on the candidate holdout

predict.py
   └─ inference.explain_prediction(algorithm=...)
         ├─ LINEAR_COEFFICIENT_V1  standardized value * class coefficient
         └─ TREE_SHAP_V1           exact TreeSHAP value per feature
```

## One pipeline contract for three families

Every artifact is a three-step scikit-learn pipeline: `imputer`, `scaler`,
`classifier`. The boosted families do not need either transform — a split point is
scale-invariant, and both libraries route missing values down a learned default
branch — but keeping the shape identical means `predict_labels`, the promotion gate,
the artifact validator, and both explainers never special-case an artifact.

The label space is the other half of the contract. `XGBClassifier.fit` rejects a
non-numeric target and requires classes encoded as contiguous integers from zero,
while everything else in the workspace reads the fixed
`BEARISH` / `NEUTRAL` / `BULLISH` strings. `LabelEncodedClassifier`
(`apps/ml/ai_quant_lab_ml/estimators.py`) closes that gap: it encodes the target for
the wrapped estimator, decodes every prediction back to a label, and exposes
`classes_` in the canonical label order so a two-class training fold still produces
codes `0..k-1`. It is a module-level class holding no library import of its own, so a
pickled boosted artifact unpickles from this package alone.

## Explaining a forest honestly

Phase 11 explains the linear baseline as `standardized value * class coefficient`.
A forest has no coefficients, and reporting one would be a fabrication. Reporting
"feature importance" instead would be worse: a global split-gain ranking says
nothing about *this* candle.

Both libraries can compute exact TreeSHAP values, which decompose one prediction's
margin into a per-feature contribution plus an expected-value baseline — the same
additive shape as a linear term:

- XGBoost: `booster.predict(DMatrix, pred_contribs=True)`
- LightGBM: `estimator.predict(X, pred_contrib=True)`

`inference.explain_prediction` routes on the persisted algorithm, tags every
contribution with `contributionMethod` (`LINEAR_COEFFICIENT_V1` or
`TREE_SHAP_V1`), sets `coefficient` to `null` for a forest, and reuses the
`intercept` field for the TreeSHAP expected value. Because both methods are
additive in margin space, the dashboard can render either without changing shape,
and the additivity is asserted in `apps/ml/tests/test_gradient_boosting.py`:
contributions plus baseline must reconstruct the booster's own raw margin for the
selected class, in both the binary and three-class cases.

A binary booster reports only the `classes_[1]` margin. The `classes_[0]` margin is
its exact negative, so the baseline and every contribution flip sign when the
selected class is the first one — the same correction the linear branch already made.

## Promotion lineage per algorithm

`default_model_key` now includes the algorithm:

```text
market-direction-logistic--NIFTY50--1d--h5--neutral-50bps--ml-feature-v1
market-direction-xgboost---NIFTY50--1d--h5--neutral-50bps--ml-feature-v1
market-direction-lightgbm--NIFTY50--1d--h5--neutral-50bps--ml-feature-v1
```

Each family therefore keeps its own `PRODUCTION` slot by default, and the existing
logistic key is unchanged, so a model promoted before this phase keeps its lineage.

To make two algorithms compete for one slot — the interesting experiment — pass the
same explicit `--model-key` to both runs. The gate has always compared the
candidate against whatever artifact currently holds the slot, and it never required
matching algorithms, so a boosted candidate can genuinely take the slot from the
linear baseline on unseen data.

## Run locally

```bash
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --algorithm xgboost
```

```bash
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --algorithm lightgbm --num-leaves 31 --min-child-samples 30
```

Run one championship across families by sharing a key, then promote only the winner:

```bash
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --algorithm logistic --model-key nifty50-1d-championship --promote
```

```bash
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --algorithm xgboost --model-key nifty50-1d-championship --promote --minimum-improvement 0.01
```

Explain a promoted model of either family with the same command as before; the
explainer is chosen from the persisted algorithm:

```bash
npm run ml:predict -- --instrument NIFTY50 --timeframe 1d --model-key nifty50-1d-championship --as-of 2025-01-15T16:00:00Z
```

Hyperparameter flags are validated against the selected algorithm. `--num-leaves`
with `--algorithm xgboost` is an error, not a silently ignored flag, and any flag
left unset keeps the trainer's documented default — which is what gets recorded in
the artifact metadata.

## Defaults and why they are conservative

| Flag | XGBoost | LightGBM | Reason |
| --- | --- | --- | --- |
| `--n-estimators` | 300 | 300 | Enough rounds at a slow learning rate |
| `--learning-rate` | 0.05 | 0.05 | Small steps beat few large ones on noisy targets |
| `--max-depth` | 3 | 4 | Shallow trees express interactions without memorising |
| `--num-leaves` | — | 15 | Far below `2 ** max_depth`; leaf-wise growth is greedy |
| `--min-child-samples` | — | 20 | Stops single-observation leaves on a short history |
| `--min-child-weight` | 5 | — | The same guard, expressed as hessian weight |
| `--subsample` | 0.8 | 0.8 | Row sampling decorrelates successive trees |
| `--colsample-bytree` | 0.8 | 0.8 | Column sampling stops one feature dominating |
| `--reg-lambda` | 1.0 | 1.0 | L2 penalty on leaf weights |

Determinism is deliberate: `n_jobs=1`, a fixed `random_state`, `tree_method="hist"`
for XGBoost, and `deterministic=True` with `force_row_wise=True` for LightGBM. The
artifact checksum is only meaningful if a rerun on the same split reproduces the
same model.

## Best practices

- Compare families on the same purged split, never on separately drawn ones.
- Read the training-to-validation gap before the accuracy. A candidate with 0.85
  training macro-F1 and 0.52 holdout macro-F1 has learned its own history, not the
  market.
- Increase capacity only after regularisation stops helping, and one flag at a time.
- Keep `--minimum-improvement` above zero for a championship run, so a candidate
  must clear a real margin rather than a rounding difference.

## Common mistakes

- Reporting global feature importance as an explanation for one prediction. It is a
  property of the whole forest, not of this candle.
- Letting XGBoost see string labels and assuming it will encode them. It raises
  instead, which is why the encoding wrapper exists.
- Reusing the logistic model key for a boosted run without meaning to hold a
  championship — the boosted candidate then quietly inherits the linear model's
  promotion lineage.
- Tuning hyperparameters against the holdout until it looks good. That turns the
  promotion gate into a training set; add an outer window if tuning is needed.

## Production considerations

- Pickle artifacts are trusted local files. Load only artifacts this workspace wrote,
  and always with the persisted checksum.
- A boosted artifact is larger than a linear one. Prune rejected candidates from
  `models/` if disk becomes a concern; the registry row keeps the metrics either way.
- Any new model family needs its own explainer registered in
  `CONTRIBUTION_METHOD_BY_ALGORITHM` before it can reach inference. That refusal is
  a feature.

## Assignments

1. Train all three families on one shared `--model-key` and record which one holds
   the production slot, and by what macro-F1 margin.
2. Fit an intentionally overfitted forest (`--max-depth 12 --n-estimators 1500
   --reg-lambda 0`), then read its training-to-validation gap in the Model
   Performance dashboard.
3. Explain the same candle with a promoted linear model and a promoted boosted
   model, and compare which features each one leans on.
4. Verify TreeSHAP additivity by hand for one prediction: sum the contributions,
   add the baseline, and check the result against the booster's raw margin.
