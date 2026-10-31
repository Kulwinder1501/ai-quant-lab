# Pre-registration: retraining the daily volatility models on candlestick-v2 / price-action-v4

Written 2026-10-31, before any model of this comparison was trained and before any of its results were seen.

## Why this exists

Every registered model's artifact pins `candlestick-v1` and `price-action-v2` in its protocol. Detection stopped writing both on 2026-10-09 (`price-action-v2`) and 2026-10-10 (`candlestick-v1`, superseded by migration 133 for a look-ahead defect: detections computed on a still-open bar and later rewritten). A model that predicts today reads evidence that no longer exists, so its price-action features arrive empty (63% with no raw value after 10-09, against 10% before). This was found on 2026-10-31 and recorded in `ml-pins-price-action-v2-dead-since-1009`.

The pins cannot be edited in place: inference rejects an artifact whose stored feature definition differs from the one the code builds for its schema, so changing v7's pins would stop every registered model from predicting. The retrain is therefore a **new feature-schema version**, `ml-feature-v7-pa4`: v7's 38 columns, with a definition that pins `candlestick-v2` and `price-action-v4`. v7 and every other schema keep their legacy pins (a test pins that).

The question this test answers is narrow: **does reading the current evidence versions change how well the daily volatility models score?**

## What is known first, and bounds the test

- **The prior is "no difference".** The volatility-expansion signal is "volatility clustering / mean-reversion, and essentially nothing else"; a range/ATR/wick/VIX-only feature subset scores as well or better than the full schema, and "the indicator, pattern, price-action, and institutional-flow columns add ~nothing" (measured 2026-07-30). The test is run to measure that, not to find an improvement.
- **v4 has far less history than v2 on the two index daily series.** v3 and v4 suppress zero-volume bars, and the index daily series carried no volume before mid-2025, so NIFTY50 1d has price-action-v4 rows only from 2025-07-01 (309 events) against price-action-v2 from 2017-01-10 (2,034), and BANKNIFTY 1d from 2025-07-01 (278) against 2022-01-14 (998); `candlestick-v2` likewise starts 2025-07 for both indices. The pooled equities are unaffected: RELIANCE has all three versions from 2023-01-09. Counted as daily candles carrying any price-action event: price-action-v2 covers 1,165 of NIFTY50's 2,436 candles (47.8%) and 563 of BANKNIFTY's 1,197 (47.0%), while price-action-v4 covers 179 (7.3%) and 159 (13.3%). So the single-index arm B trains with price-action evidence present on roughly a seventh to a quarter as many rows as arm A. That is part of what is being measured, and it is reported, not corrected.
- **Arm A is itself contaminated.** `candlestick-v1` has the look-ahead defect. A better score for A than for B does not mean v4 is worse evidence.

## Design

- **Arms.** A = `ml-feature-v7` (candlestick-v1 / price-action-v2, what the scheduled refits train today). B = `ml-feature-v7-pa4` (candlestick-v2 / price-action-v4). Nothing else differs.
- **Configurations: the six scheduled daily volatility configurations,** exactly as `eod-training-plan.ts` builds them: algorithm in {xgboost, lightgbm} x series in {NIFTY50, BANKNIFTY, the 23-instrument pool}. Label `volatility-expansion-v1`, horizon 5, band 0.25, window `2017-01-01` to `2026-10-30`, walk-forward folds 2 (single index) or 5 (pool), CPCV 6 groups, random state 42 (the default). The pool is the 20 research equities plus FINNIFTY, MIDCPNIFTY and NIFTYNXT50, as in `run-eod-pipeline.ts`.
- **Identical data for both arms:** `--data-cutoff-at 2026-10-31T05:00:00Z`, `--to 2026-10-30`.
- **Isolation.** Every run uses `--research-only` (added with this change: the model and artifact are recorded, but it is never enrolled in the volatility shadow pool and never promoted, because enrollment is sticky and an experiment must not start predicting for good), `--allow-unaudited-data` (so the artifacts are permanently flagged `dataReadiness.enforced = false` and are not candidates for anything), and a scratch `--artifact-dir`. Model keys begin `exp-pa4--A--` / `exp-pa4--B--`.

## Metric and decision rule (fixed now)

Per configuration and arm, from the stored `validationProtocol.crossValidation` (CPCV, 15 splits): the mean of `accuracyMinusTrivial` and of `macroF1MinusTrivial`, the project's discriminator (a model must beat the trivial predictor on both; macro-F1 alone has misled before). A configuration is **B better** if both means are higher for B by at least 0.010, **A better** if both are higher for A by at least 0.010, otherwise a **tie**. 0.010 is chosen from the recorded noise: per-split standard deviations of 0.015 to 0.029 across these configurations, so a smaller gap is not distinguishable from a re-draw.

- **"v4 helps"** if B is better in at least 5 of 6 configurations and A in none.
- **"v4 hurts"** if A is better in at least 5 of 6 and B in none.
- **Otherwise "no demonstrated difference".**

Reported alongside, not decisive: the CPCV win rate against trivial; walk-forward mean and final-fold macro-F1; training rows; the share of daily candles in each window that carry any price-action event under each version.

## What the result decides

Arm A cannot be used live whatever it scores: its inputs stopped existing, so a model trained on it predicts from empty features. So the question for adoption is not "is B better" but **"is B worse"**.

- Unless the verdict is "v4 hurts", the scheduled plan moves to `ml-feature-v7-pa4` (its family keys then change, so each configuration trains once immediately and then on its 30-day cadence), so new refits read evidence that exists. That is a separate, deliberate change and needs the operator's go to deploy.
- "v4 helps" would be reported as a finding, not acted on beyond that.
- "v4 hurts" means the schedule stays on v7 and the v7 models are reported as predicting on dead inputs, a decision for the operator.
- No existing model is retired, re-registered or promoted by this test.

## Limits, stated before the result

One time split per configuration (CPCV overlaps; its splits are not independent). Models are scored in-sample-time-ordered, not live: a live shadow record is the only test of live behaviour and takes sessions to accumulate. The index arms differ in feature availability by construction (above). The 0.010 threshold is a judgment from recorded noise, not tuned on these outcomes. The pooled configurations take the longest.

## Commands

```
py -3.12 apps/ml/train.py --algorithm <xgboost|lightgbm> --instrument <NIFTY50|BANKNIFTY> | --instruments <pool of 23> \
  --timeframe 1d --from 2017-01-01 --to 2026-10-30 --data-cutoff-at 2026-10-31T05:00:00Z \
  --label-scheme volatility-expansion-v1 --horizon-bars 5 --expansion-band 0.25 \
  --feature-schema <ml-feature-v7 | ml-feature-v7-pa4> --folds <2 | 5> --cpcv-groups 6 \
  --research-only --allow-unaudited-data --artifact-dir <scratch> --model-key exp-pa4--<A|B>--<algorithm>--<series>
```
