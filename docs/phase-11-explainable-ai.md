# Phase 11: explainable local AI predictions

## Purpose

Phase 11 turns a deliberately promoted Phase 10 model into one auditable local
research prediction for a completed candle. It answers three narrow questions:

- What directional class did this model produce?
- Which source-candle features most changed that class's linear score?
- What historical-label evidence was available at the selected as-of boundary?

It does **not** decide that a trade exists. A model prediction is neither a
trade idea nor a paper fill, and it is never connected to broker or real-order
code.

## Theory and why it exists

A classifier maps a feature vector to a directional label; it does not observe
the market's future or discover a universal trading rule. Explainability is
useful when it lets a researcher inspect the actual input, model version, and
linear terms behind one result. That makes the prediction falsifiable: a user
can see what the model used, what it did not use, and whether the same evidence
would have been available at that time.

The phase keeps the model separate from the strategy engine on purpose. A
strategy may later choose to compare a model observation with its own rules,
risk geometry, and paper-trading assumptions, but the model must not silently
turn a probability into a proposed or executed trade.

## Safety boundary

The Phase 11 command reads local PostgreSQL evidence, reads a trusted local
model artifact, and writes one `model_predictions` research record. It does
not import strategy generation, paper trading, broker authentication, or order
routing. Its JSON result explicitly reports:

```json
{
  "tradeIdeaCreated": false,
  "paperTradeCreated": false,
  "realOrderPlaced": false
}
```

`confidence` is the selected classifier probability. It is not certainty,
expected return, profitability, or a recommendation.

## Architecture

```text
PRODUCTION model_versions row + checksum-verified local artifact
                              |
                              | exact schema / algorithm / lineage checks
                              v
selected cutoff ----> latest completed candle + versioned evidence
                              |
                              | no future close is loaded
                              v
fixed ml-feature-v1 ----> imputer -> scaler -> logistic classifier
                              |
              +---------------+----------------+
              |                                |
              v                                v
 selected-class linear terms        training-only similar-setup labels
              |                                |
              +---------------+----------------+
                              v
        model_predictions (one model + source candle, idempotent)
```

The implementation lives in:

```text
apps/ml/
  predict.py                         # local inference CLI
  ai_quant_lab_ml/
    inference.py                     # artifact gates and logistic explanation
    reference_data.py                # training-only similar-setup comparison
    postgres_repository.py           # cutoff-bound reads and prediction storage
    contracts.py                     # inference/persistence contracts

apps/api/src/infrastructure/database/migrations/
  003-model-prediction-identity.ts   # cutoff + idempotency schema migration
```

## Production-model gate

`predict.py` accepts only the one `PRODUCTION` version for the requested model
key. Before it can score anything, it verifies all of the following:

- the stored artifact checksum matches the local artifact;
- the model is the Phase 10 logistic baseline, not an unsupported algorithm;
- the persisted and artifact feature schemas exactly equal `ml-feature-v1`;
- the feature definition, model key, instrument, timeframe, label horizon, and
  analysis algorithm versions agree;
- the artifact contains its temporal validation protocol and metrics;
- the artifact contains a valid, training-only reference set.

The selected source candle must also be later than the persisted production
promotion time. This prevents a currently promoted model from being quietly
used to rewrite its own pre-promotion history. A missing or timezone-free
promotion timestamp fails safely.

Older Phase 10 artifacts intentionally fail the final check. Retrain and
explicitly promote a Phase 11-compatible candidate rather than using a vague
or post-hoc similar-setup explanation. Only the logistic baseline is supported
because its arithmetic is transparent; a new model family needs its own
explainer.

## As-of data discipline

The reader accepts an explicit `--as-of` / `--data-cutoff-at` timestamp. It
selects a completed candle only when both `received_at` and `close_time` are at
or before that cutoff. Indicator snapshots must have been calculated by the
cutoff; pattern and price-action records must have been detected by it. Their
algorithm versions must match the artifact contract.

The inference reader does not use the training query's later-close window.
`CandleEvidence.future_close` is absent for a prediction. Training metadata
records the final training label's availability time and the dataset cutoff.
Inference refuses a source candle at or before the later of those boundaries,
so an in-sample or otherwise prematurely trained historical score cannot be
presented as a contemporaneous prediction. It also refuses a candle at or
before the model's recorded promotion time.

## Feature contributions

The model pipeline reuses the fitted training imputer and scaler. For the
selected class, a displayed contribution is:

```text
standardized feature value x selected-class logistic coefficient
```

Each persisted entry has the fixed feature name, category (`CANDLE`,
`INDICATOR`, `PATTERN`, or `PRICE_ACTION`), raw value, imputed value,
standardized value, selected-class coefficient, contribution, and whether the
term supports the selected class. Entries are sorted by absolute contribution.

For binary logistic models, the lower-class explanation reverses both the
intercept and coefficients, matching the lower class's decision function.
Contributions explain the model's local arithmetic, not market causality.

## Implementation walk-through

`apps/ml/predict.py` is a small local command boundary. It loads environment
configuration only after argument parsing, resolves the promoted model, checks
its checksum, and then calls the pure/adapter components in this order:

1. `validate_production_artifact()` rejects mismatched model lineage, schema,
   data contract, or missing training-only reference data.
2. `load_latest_completed_candle_evidence()` returns one cutoff-bounded candle
   with compatible indicator, pattern, and price-action evidence; it never
   attaches a label close.
3. `build_feature_vector()` reconstructs the exact fixed feature order.
4. `explain_logistic_prediction()` runs the fitted imputer, scaler, and
   classifier, then returns selected-class contributions.
5. `nearest_reference_label_agreement()` compares only the stored training
   reference examples; the database adapter separately derives only outcomes
   that were known at the source candle's close.
6. `build_prediction_explanation()` creates JSON-safe, human-readable evidence
   before `save_model_prediction()` persists the research record.

Pure explanation and reference-data functions use duck-typed pipeline steps in
their unit tests, so their essential safety behavior is testable without a
running database or scikit-learn installation.

## Historical reference evidence

New training artifacts include a deterministic, bounded, stratified,
chronological sample drawn only from the fitting partition. Validation rows are
never included. Inference transforms that sample with the same fitted
imputer/scaler, finds nearby feature vectors, and reports the selected label's
agreement among those neighbors.

`trainingOnlySimilarSetups` is label agreement, not a backtested P&L statistic.
The command also reports earlier persisted same-label predictions only when
their source, creation time, and later outcome were observable by the current
source candle. It may be empty for a new model and is not performance proof.

## Database design, storage, and idempotency

Migration `003-model-prediction-identity` adds `evidence_cutoff_at` to
`model_predictions`, backfills existing rows from `created_at`, and adds a
partial unique index over `(model_version_id, source_candle_id)`. The adapter
uses `INSERT ... ON CONFLICT`, so rerunning a model against the same source
candle does not create a duplicate record. Its original `created_at` remains
the observation time used by historical reliability checks. It always stores
`trade_idea_id` as `NULL`.

## Run locally

Install the Python requirements, bring up local PostgreSQL, and apply the
migrations as described in the root README. Train and explicitly promote a
fresh Phase 11-compatible model. Then score a candle after its
training-information boundary:

```powershell
npm run ml:predict -- --instrument NIFTY50 --timeframe 1d --model-key <promoted-model-key> --as-of 2025-01-15T16:00:00Z
```

Use a pinned cutoff for reproducible research. A bare date means the final UTC
instant of that date. `--maximum-features` controls returned linear terms and
`--similar-neighbors` controls the bounded training-only neighbor count.

The command prints compact JSON and creates no trade idea, paper trade, or
order. It fails safely for no production model, no eligible candle, a checksum
mismatch, incompatible evidence, unsupported model family, or unsafe historic
source candle.

## Best practices

- Pin `--as-of` when comparing runs or discussing a historical observation.
- Keep artifact files local and trusted; a checksum detects damage, not a
  malicious pickle payload.
- Inspect class probabilities, top positive and negative terms, and validation
  metrics together rather than relying on a single confidence value.
- Retrain and promote explicitly when the feature contract changes; never edit
  an artifact in place.
- Keep model observations, strategy proposals, backtests, and paper fills as
  separate evidence types.

## Common mistakes

- Treating a class probability as probability of profit.
- Scoring a candle at or before the training-information boundary.
- Claiming a current-time result is a reproducible historical result without a
  cutoff.
- Mixing validation examples into the similar-setup reference set.
- Explaining an unsupported non-linear model with logistic coefficients.
- Automatically connecting a prediction to strategy or paper-trading actions.

## Production considerations

For a larger research system, retain immutable raw/evidence revisions, artifact
dependency versions, calibration diagnostics, drift metrics, and a human review
workflow. Any future strategy integration must be an explicit, separately
reviewed phase; Phase 11 intentionally stops at explainable research records.

## Assignments

1. Train and explicitly promote a fresh local model, then save a prediction
   with a fixed as-of cutoff. Record the model checksum, source candle, and top
   two supporting and opposing terms.
2. Rerun the same command and verify that the model/source-candle identity does
   not produce a duplicate prediction row.
3. Change only the cutoff to a time before the source candle closes and explain
   why the command correctly finds no eligible candle.
4. Inspect the training-only neighbor label agreement and explain why it is not
   a substitute for Phase 9 strategy P&L or an out-of-sample validation metric.
5. Try a source candle at the promoted model's timestamp and verify that
   inference refuses to backdate the model.
