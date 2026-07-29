# Phase 21: model integrity — stationary features, leakage audits, and an honest gate

## Purpose

Phase 10's promotion gate accepted any candidate that beat the incumbent on a
purged holdout. It had no way to ask whether the score itself was believable, and
the local registry contained a promoted logistic model scoring **0.703 macro-F1
with a −0.084 training-to-holdout gap** — a model fitting unseen data *better* than
its own training partition.

That combination is not skill, it is a leakage fingerprint. This phase removes the
cause, adds the checks that catch it, and teaches the gate to refuse a score that
is too good to be true.

## Theory and why it exists

### A price level is a clock

The `ml-feature-v1` schema fed the model absolute rupee values: `candle.close`,
`candle.volume`, and every level-valued indicator (EMA, SMA, VWAP, Bollinger bands,
Supertrend). On a trending series an absolute price is a proxy for *time*. A
chronological split therefore hands the model a covert timestamp, and from a
timestamp it can infer which market era a row belongs to and what the local label
distribution looks like there. The model appears to predict direction; what it
actually predicts is *when*.

That is why the gap went negative. The holdout was one later era with its own label
balance, and a model that had learned "prices near this level behave like this"
scored better on that narrow slice than across the varied training period.

### Macro-F1 is not a hit rate

Three-class macro-F1 has a random baseline of **1/3**, not the 1/2 of a coin flip.
A 0.38 macro-F1 is a real find; 0.53 would be extraordinary. Reading the metric
against a binary intuition is how a mediocre model gets mistaken for a good one and
a leaking one for a great one.

So this phase also reports the figure that *is* comparable to "right N% of the
time": the **directional hit rate**, computed only over rows where the model
committed to `BULLISH` or `BEARISH`, alongside the **coverage** that says how often
it committed at all. A 56% hit rate on 20% coverage is a far better research result
than a higher macro-F1 earned by predicting `NEUTRAL` constantly.

### A single holdout is one noisy read

One 20% chronological slice produces a score with a wide error bar. Two candidates
differing by less than that bar are not distinguishable, and ranking them is reading
noise. Walk-forward validation replaces the single read with several sequential ones
and reports the spread next to the mean.

## Safety boundary

- Training, auditing, and inference read local PostgreSQL only. No broker
  authentication, order routing, or execution path exists anywhere.
- `audit.py` fits throwaway models and persists nothing: no artifact, no model
  version, no prediction, no paper fill. Its JSON output asserts all four.
- A candidate above the plausible ceiling, with a negative gap, or with a failed
  audit **cannot** auto-promote. Promotion stays an explicit operator action.
- The artifact checksum gate, the purge gap, and `predict.py`'s no-look-ahead timing
  guards are unchanged.

## Architecture

```text
train.py --algorithm ... --folds N [--promote]
   │
   ├─ features.build_labeled_examples     ml-feature-v2, every column scale-free
   ├─ validation.walk_forward_splits      N folds, each with its own purge gap
   ├─ training.train_model                one fit per fold
   ├─ train.fold_summary                  mean, min, max, spread, final fold
   ├─ leakage.run_leakage_audit           only when --promote is requested
   └─ train.promotion_assessment          refuses before comparing to the incumbent

audit.py                                   standalone, read-only, exit 2 on INVESTIGATE
   └─ leakage.run_leakage_audit
         ├─ LABEL_SHUFFLE   a permuted target must collapse toward 1/3
         ├─ FEATURE_LAG     stale features must cost real score
         └─ ERA_HOLDOUT     an early-trained model must survive a later era
```

## The stationary schema (`ml-feature-v2`)

| v1 feature | v2 replacement | Why |
| --- | --- | --- |
| `candle.close` | `candle.close_return_bps` | Return against the prior close |
| `candle.open` | `candle.overnight_gap_bps` | Gap against the prior close |
| `candle.high` / `candle.low` | `candle.high_atr_ratio` / `candle.low_atr_ratio` | Excursion in ATR units |
| `candle.volume` | `candle.volume_median_ratio` | Ratio to a trailing 20-bar median |
| `indicator.EMA.value`, SMA, VWAP, Bollinger, Supertrend | `…_bps` | Signed distance from close in bps |
| `indicator.ATR.value`, `BOLLINGER_BANDS.standardDeviation` | `…_ratio` | Rupee magnitude as a fraction of close |
| `indicator.RSI`, `MACD`, patterns, price action | unchanged | Already scale-free |

`test_features.py` asserts the invariant directly: every schema entry must be a bps
distance, a ratio, a bounded oscillator, or a confidence. That test is what caught
`BOLLINGER_BANDS.standardDeviation`, a rupee amount that survived the first pass.

Two features need history rather than a single candle — the prior close and the
rolling median volume. Training walks bars in order maintaining a trailing window;
inference calls `load_trailing_close_volume_series` against the *same* as-of cutoff
and derives both through the shared `trailing_feature_context` helper. Passing
placeholders at inference instead would be train/serve skew, and the imputer would
hide it by filling in a training-fold median.

### The break, and why it is not worked around

`FEATURE_SCHEMA_VERSION` is now `ml-feature-v2`, and
`inference.validate_production_artifact` compares that version against every
artifact. The previously promoted model therefore **cannot serve predictions and
must be retrained**. There is deliberately no compatibility shim: the entire point
is that its score was measured on features that leaked.

## The volatility-regime column (`ml-feature-v3`)

`ml-feature-v3` adds one column, `regime.vix_sma20.value_ratio`: India VIX's close over
its own SMA(20). It obeys the v2 rule that every column be scale-free — it is a ratio,
so no rupee amount enters the schema.

Adding a column *is* a schema change, so it takes a new version rather than being
folded into v2. The version check compares a string, not a column count, so an artifact
still stamped `ml-feature-v2` would otherwise pass validation and then be handed a
feature vector one column wider than it was fit on. Models trained under v2 must be
retrained, for the same reason v1 models had to be.

Two properties make the column safe to use:

- **It is resolved identically in training and inference.** Both paths call the same
  loader, so a served prediction cannot see a differently-derived feature than the one
  the model was fit on. Passing a placeholder at inference would be train/serve skew,
  and the imputer would hide it.
- **A missing regime stays missing.** When no VIX bar qualifies — none registered, a gap
  wider than five bars, or no average recorded — the feature is absent and the
  training-fold imputer handles it, exactly as for any other absent evidence. It is
  never substituted with a neutral-looking 1.0.

Because the column reads a *second* instrument, the leakage audit gained a matching
check: the VIX bar behind any row must have closed no later than that row's own bar.
The cross-instrument join is the easiest place to reintroduce look-ahead, so it is
asserted rather than assumed.

## What the v2 schema revealed

Retraining the same logistic model on the same data, changing only the schema:

| | `ml-feature-v1` | `ml-feature-v2` |
| --- | --- | --- |
| Holdout macro-F1 | 0.703 | **0.288** |
| Train→holdout gap | −0.084 | positive |
| Gate decision | promoted | `INITIAL_BASELINE_THRESHOLD_NOT_MET` |

Nearly all of the apparent skill was the absolute price levels. A score below the
0.333 random baseline is the honest measurement and the correct thing to build on —
bearing in mind the local database is still Phase 15 synthetic seed data, so even
this number says nothing about real markets yet.

## The gate

```text
1. suspicious score      macro-F1 > --maximum-plausible-macro-f1 (default 0.60)
2. negative gap          holdout macro-F1 > training macro-F1
3. failed leakage audit  any check FAILED, when --promote was requested
4. quality floor         macro-F1 >= --minimum-initial-macro-f1 (default 0.38)
5. incumbent comparison  improvement > --minimum-improvement, floor still met
```

The order matters. A leaking candidate that "beats" production is exactly the
failure this gate exists to prevent, so checks 1–3 run *before* any comparison with
the incumbent.

With `--folds N > 1` the gate reads **two** scores and requires both to clear the
floor: the mean across folds, and the final (most recent) fold whose model is the
one actually persisted. A mean carried by early folds cannot promote a model whose
latest period failed, and one lucky final fold cannot promote a weak mean.
`--override-suspicious` allows a deliberate promotion after investigation, and the
override is recorded in the promotion comparison JSON.

## The three checks

**Label shuffle.** Retrain on a permuted target; the score must collapse toward 1/3.
If it does not, the pipeline is learning from something other than the labels. This
assumes a schema wide enough that a random fit cannot land on the true decision
boundary by luck — with two or three features it can, which is why the test fixture
deliberately includes noise columns.

**Feature lag.** Score each holdout row with the *previous* bar's features. The score
must fall by at least 0.02 macro-F1. If staleness costs nothing, the current bar was
not carrying the signal and the features may already encode the answer.

**Era holdout.** Train on the first half, score the final fifth. Failure is reported
two distinguishable ways: a score at or below the random baseline (the effect does
not exist outside its own window), or a decay of more than 0.15 from the in-window
holdout.

Randomness is confined to a local `random.Random(random_state)`, so a rerun
reproduces the verdict exactly.

## Dashboard

The Model Performance registry surfaces the same evidence: a **leakage-risk badge**
(`SUSPICIOUS_SCORE` or `NEGATIVE_GAP`) on the leaderboard and detail card, the
directional hit rate and coverage beside macro-F1, and the fold count with its
spread so two candidates within the error bar cannot be read as a ranking.

## Run locally

Audit a dataset before trusting any score from it:

```bash
npm run ml:audit -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2026-01-01
```

Train with walk-forward validation:

```bash
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2026-01-01 --folds 4
```

Retrain and re-promote under `ml-feature-v2` once a dataset audits clean:

```bash
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2026-01-01 --folds 4 --promote
```

The audit exits `2` on `INVESTIGATE`, so a shell or CI step cannot mistake it for a
pass. Both commands write exactly one JSON object to stdout and send progress to
stderr.

## Best practices

- Read the gap and the audit before the accuracy. A high score with a small or
  negative gap is a bug report, not a result.
- Quote the directional hit rate with its coverage. One without the other is
  meaningless.
- Compare candidates using the fold spread. A difference smaller than the spread is
  not a ranking.
- Audit after any change to features, labels, or the data source — not once.

## Common mistakes

- Reading 3-class macro-F1 against a 0.50 coin-flip baseline.
- Feeding a model any absolute price or volume level.
- Deriving a feature at inference differently from training, then letting the
  imputer smooth over the difference.
- Tuning hyperparameters against the same holdout that gates promotion.
- Treating a stored audit file as current. The audit that gates a promotion runs
  inline on that exact dataset, in the same process.

## Production considerations

- The inline audit fits three extra models, so it only runs when `--promote` is
  requested.
- Every threshold is a CLI flag. They are screening heuristics for a research
  dashboard, not statistical tests, and should be re-tuned against real data.
- A new model family needs its own explainer registered before it can reach
  inference, and its own audit before it can be believed.

## Assignments

1. Retrain the previously promoted model under `ml-feature-v2` and record how much of
   its 0.703 macro-F1 survives.
2. Run the audit and explain, from the per-check numbers, which check fails on the
   synthetic seed data and why that is the expected answer.
3. Train with `--folds 6` and decide from the spread whether two algorithms are
   actually distinguishable on this dataset.
4. Re-add `candle.close` to the schema locally, retrain, and watch both the score and
   the gap move. Then remove it again.
