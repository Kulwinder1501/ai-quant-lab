# momentum-scalp setup classifier — exploratory ML experiment v1

**Registered 2026-09-18, before training anything.** This is an exploratory research question, not a
falsification program with a strategy-shaped hypothesis, so it does not follow the exact Gate 1-4
template used by the entry-filter cohort -- but the same discipline applies: features, label, split
and decision rule are fixed before any model is fit, and the result gets reported however it comes
out.

## Why this exists

Nine hand-crafted filters on `momentum-scalp`/1m (chop metrics, time-of-day, RVOL, SMC gate, pattern
alignment, pattern-anchored stops, confirmation-lag retuning) have all failed to separate future
winners from future losers using the setup's own indicators at entry. The question this program asks
is different in kind, not degree: does *any* combination of the already-computed features -- linear
or not -- carry signal that a human-picked threshold on one or two of them would miss? If nine honest
attempts at picking the right threshold all failed, a model is not expected to succeed either, but it
has not actually been tried on this exact data, and the data to try it already exists.

**The data already exists and needs no new capture.** `research_scalp.proposals` (append-only,
`"no execution path reads these tables"`) stores one row per `MOMENTUM_CONTINUATION` candidate setup
with a full point-in-time feature snapshot in `raw_context` (EMA 3/8/9/20, RSI, ATR, VWAP, Bollinger
Bands, SUPERTREND, MACD, SMA, and the full SMC suite -- BOS, CHOCH, FVG, LIQUIDITY_SWEEP, ORDER_BLOCK,
EQUILIBRIUM_ZONE -- plus candlestick patterns and volatility regime), joined via
`(subject_type='NATIVE_PROPOSAL', subject_id=proposals.id)` to `research_scalp.terminal_settlements`
for the realized outcome (`outcome`, `r_multiple`, `return_bps`). 2,661 rows, 2026-08-25 to
2026-09-18, all after the harness's own data-quality fix (the "mid-computation" capture-race bug --
`docs/scalp-engine-research-harness-v1.3.1.md` -- predates this whole window, so no exclusion is
needed here).

## What gets built

A standalone Python script, `apps/ml/scalp_setup_classifier_experiment.py` -- a one-off experiment in
the same vein as `run_ict_feature_experiment.py`, not a change to `train.py`'s production pipeline
(that pipeline is hard-wired to candle-based labelling; pointing it at `research_scalp` would be a
larger, separate change not justified before knowing whether there is anything to find).

**Label:** `r_multiple` from `terminal_settlements` (continuous, the trade's own realized economics --
not a TARGET/STOP/TIMEOUT taxonomy collapsed to win/loss, since `TIMEOUT` rows have real, often
negative, economics of their own and dropping or mislabelling them would throw away a third of the
data). Reported both as regression (predict the value) and as a `win = r_multiple > 0` classification
view, since both audiences (a continuous edge and a practical threshold) matter for the same
question.

**Features:** flattened from `raw_context` -- every indicator's raw value, the same derived terms
`momentum-scalp` itself computes (EMA spread in ATR units, VWAP displacement in ATR units, RSI value),
SMC-signal presence/direction (BOS, CHOCH, FVG, LIQUIDITY_SWEEP, ORDER_BLOCK, EQUILIBRIUM_ZONE),
pattern alignment (aligned/contradicting/none, reusing the exact definition from
[[pattern-alignment-small-real-effect-not-actionable]]), Bollinger position, SUPERTREND direction,
volatility regime, direction (LONG/SHORT), instrument, IST minute-of-day, day-of-week, and
`strategy_research_version` (kept as a feature rather than silently pooled away, so the model itself
can surface a version-specific effect if one exists -- this pools across momentum-scalp's research
versions to get a usable sample size, a deliberate choice made explicit rather than hidden).

**Split:** time-ordered walk-forward, never a random shuffle -- these are sequential market bars, and
`data_through < decision_at` is enforced at the DB level but a shuffled split would still let a model
implicitly learn from a day it will later be "tested" on. Five expanding-window folds ordered by
`decision_at`.

**Models:** a trivial baseline (predict the training set's own mean/majority), logistic regression
(is there a linear signal at all), and a shallow LightGBM classifier/regressor (is there a non-linear
one) -- deliberately not a deep or heavily-tuned model, so a positive result stays inspectable rather
than becoming a new black box to trust on faith.

## Decision rule

- **Beats trivial, out-of-sample, on the held-out fold(s) -- both accuracy/macro-F1 (classification)
  and a real economics check**: mean realized `r_multiple` on the subset of proposals the model scores
  above its own median predicted confidence, compared to the unconditional mean. This is the same
  discipline as [[cpcv-accuracy-discriminator]] -- a metric that only looks good in isolation is not
  trusted; it must survive being compared to what a strategy could have kept as trades.
- Any result -- positive, negative, or mixed between the linear and non-linear model -- gets reported
  honestly, including feature importances if either model finds something, so a positive result can be
  sanity-checked against what the nine hand-crafted filters already found (and ruled out) about the
  same features.
- A result that beats trivial only in training and not out-of-sample is not a result -- same
  overfitting trap this project has already been burned by once (leakage/CPCV history).

## What a null result means, going in

Given the same features have already been checked nine different ways by hand with nothing found,
the base-rate expectation is another null. That is a legitimate, useful answer -- it would mean the
setup's own inputs genuinely do not carry separable signal in this data, closing the "smarter
filter" question for this bot for good rather than leaving it open to keep being re-asked.

## Results

Executed 2026-09-18. 2,632 settled `MOMENTUM_CONTINUATION` proposals, 2026-08-24 to 2026-09-18.
Outcome mix: STOP 1,112 / TIMEOUT 926 / TARGET 594; win rate (`r_multiple > 0`) 44.3%. Five expanding
walk-forward folds, ~438 held-out rows each.

| fold | train n | trivial acc | logreg acc | lgbm acc | trivial F1 | logreg F1 | lgbm F1 | uncond. mean R | lgbm top-half mean R |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 1 | 438 | 0.475 | 0.516 | 0.534 | 0.322 | 0.503 | 0.516 | 0.103 | 0.159 |
| 2 | 876 | 0.541 | 0.539 | 0.516 | 0.351 | 0.539 | 0.510 | -0.017 | 0.073 |
| 3 | 1,314 | 0.589 | 0.578 | 0.477 | 0.371 | 0.550 | 0.477 | -0.023 | **-0.124** |
| 4 | 1,752 | 0.578 | 0.525 | 0.459 | 0.366 | 0.493 | 0.453 | -0.077 | **-0.183** |
| 5 | 2,190 | 0.559 | 0.580 | 0.521 | 0.359 | 0.501 | 0.503 | 0.044 | **-0.083** |
| **mean** | | **0.548** | **0.547** | **0.501** | 0.354 | 0.517 | 0.492 | **0.006** | **-0.032** |

### Reading the numbers honestly, not just the ones that look good

- **Accuracy**: neither model beats the trivial baseline on average. LightGBM (0.501) is worse than
  trivial (0.548); logistic regression (0.547) is a statistical tie.
- **Macro-F1 is not a fair signal here and is reported for completeness, not as evidence of skill**:
  trivial's F1 looks bad (0.354) only because it always predicts one class, which is a `zero_division`
  artifact for the class it never predicts -- any model that predicts both classes at all beats that
  by construction, independent of whether it is actually right more often. [[cpcv-accuracy-discriminator]]
  already flagged this exact trap for a different program; the same correction applies here.
- **The economics check is the real test, and it fails, decisively.** Taking the model's own
  top-half-by-confidence trades would have done *worse* than just taking every setup unconditionally
  in 3 of 5 folds (fold 3: -0.124 vs -0.023; fold 4: -0.183 vs -0.077; fold 5: -0.083 vs +0.044), and
  the pooled mean across all five folds is **negative** (-0.032) against a barely-positive
  unconditional mean (+0.006). The model's confidence score is, if anything, mildly anti-predictive.
- **Fold 1 looked good and that is precisely why it is not trusted on its own.** The smallest-training,
  earliest fold shows the strongest positive numbers for both models; every fold after it, with more
  training data, gets worse or reverses sign. That is the shape of a model fitting noise in a small
  early sample, not a shape consistent with a real, stable signal getting confirmed as more data
  arrives. Reporting only fold 1 would have reproduced the exact mistake this project's own leakage
  history warns against.
- **Feature importance** (final fold, most data): dominated by `ist_minute_of_day`, `atr`,
  `bb_position`, `bb_width_atr`, `regime_value_ratio` -- context/volatility features, not a specific
  directional-quality signal, consistent with there being nothing to explain.

### Verdict

**NO_SIGNAL.** Neither a linear nor a shallow non-linear model, given the full feature set already
computed for this strategy (EMA, RSI, ATR, VWAP, Bollinger, SUPERTREND, the full SMC suite, pattern
alignment, regime, time-of-day), finds anything that survives out-of-sample walk-forward validation
on 2,632 real settled setups. This closes the "smarter filter" question for `momentum-scalp`/1m on
its own inputs: nine hand-picked thresholds and now two trained models, on the same features, all
land in the same place. Nothing here touches the live bot; the script stays in `apps/ml/` as a
one-off experiment, not a scheduled or production job.

