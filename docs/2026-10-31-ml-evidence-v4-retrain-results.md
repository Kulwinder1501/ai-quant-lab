# Results: the daily volatility models on candlestick-v2 / price-action-v4 against v7

Run 2026-10-31 under `docs/2026-10-31-ml-evidence-v4-retrain-preregistration.md` (commit `26f2c4ec`), unchanged. Twelve training runs, one at a time, 142 to 282 seconds each, all exit 0. Runner and analysis in the session scratchpad (`run_ml_exp.sh`, `ml_exp/results.psv`, `ml_exp/analysis.json`).

## Verdict, as pre-registered: **no demonstrated difference**

B (`ml-feature-v7-pa4`, candlestick-v2 / price-action-v4) was better in 0 of 6 configurations, A (`ml-feature-v7`, candlestick-v1 / price-action-v2) was better in 0 of 6, and all 6 were ties. The bar was 0.010 on both CPCV edges over trivial; the largest gap on either edge was 0.0052.

CPCV mean edge over the trivial predictor (accuracy / macro-F1), 15 splits, 6 groups:

| configuration | rows | A | B | B minus A |
|---|--:|---|---|---|
| NIFTY50 lightgbm | 2,179 | +0.0983 / +0.2452 | +0.0931 / +0.2402 | -0.0052 / -0.0050 |
| NIFTY50 xgboost | 2,179 | +0.0999 / +0.2451 | +0.0984 / +0.2427 | -0.0015 / -0.0023 |
| BANKNIFTY lightgbm | 1,064 | +0.0690 / +0.2476 | +0.0709 / +0.2492 | +0.0019 / +0.0015 |
| BANKNIFTY xgboost | 1,064 | +0.0677 / +0.2447 | +0.0707 / +0.2471 | +0.0030 / +0.0025 |
| pool (23) lightgbm | 20,079 | +0.1238 / +0.2763 | +0.1235 / +0.2761 | -0.0003 / -0.0002 |
| pool (23) xgboost | 20,079 | +0.1211 / +0.2690 | +0.1205 / +0.2687 | -0.0006 / -0.0004 |

Every model beat trivial on macro-F1 in 100% of CPCV splits; accuracy in 100% of splits for 11 of 12 (A BANKNIFTY lightgbm won 93%, B 100%). Training rows are identical between arms, as they should be.

## What the numbers say beyond the verdict

1. **The pooled models, where both arms have the same evidence history, are indistinguishable:** differences of 0.0002 to 0.0006. Training rows (20,079) are the same and so are the scores to the third decimal.
2. **The single-index models differ by at most 0.005, with mixed signs** (B lower on NIFTY50, higher on BANKNIFTY), even though arm B sees price-action evidence on 7.3% of NIFTY50's and 13.3% of BANKNIFTY's daily candles against 47.8% and 47.0% for arm A. Giving a model a seventh as much of a feature family left its score unchanged. That is the direct confirmation of the 2026-07-30 finding that the volatility signal is range and ATR clustering and these columns add almost nothing.
3. **Walk-forward means move more than CPCV and without a pattern:** B minus A is +0.015 (NIFTY50 lightgbm), -0.017 (NIFTY50 xgboost), +0.009 (BANKNIFTY lightgbm), -0.029 (BANKNIFTY xgboost), +0.002 and +0.004 (pools). That is the known fold-noise (walk-forward swinging 0.31 to 0.40 on these series while CPCV sits still), and it is why the primary metric was CPCV.
4. **The 10-21 candidate was reproduced.** A NIFTY50 lightgbm scored +0.2452 on macro-F1 edge against +0.2435 for the earlier model of the same configuration, a sanity check that the harness trains what production trains.

## What it decides

Under the pre-registered rule the scheduled plan moves to `ml-feature-v7-pa4` unless the verdict was "v4 hurts", and it was not. `eod-training-plan.ts` now trains all six daily configurations on the new schema (family keys change, so each trains once at the next end-of-day run and then on its 30-day cadence). The reason is not a better score: it is that v7 models predict from inputs detection no longer writes, and pa4 models predict from inputs that exist.

## Limits (as declared before the run)

One time split per configuration; CPCV splits overlap. This is scoring in time order, not live behaviour; only a shadow record tests that, and it takes sessions. The index arms differ in feature availability by construction. 0.010 was chosen from recorded noise, not from these outcomes.

## Side effects of running it

Twelve `model_versions` rows with keys `exp-pa4--<A|B>--<algorithm>--<series>` and artifacts under a scratch folder outside the repository. They were run `--research-only`, so none is enrolled in the volatility shadow pool (checked: 0 enrollments) and none was promoted. They are artifacts flagged `dataReadiness.enforced = false` (`--allow-unaudited-data`) and are not candidates for anything.
