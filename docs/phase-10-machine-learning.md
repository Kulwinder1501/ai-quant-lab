# Phase 10: time-aware machine learning and model validation

## Theory and purpose

Machine learning is useful here only when it is treated as a falsifiable research experiment. A model may learn a relationship between a completed market setup and a later price move, but it cannot see a future candle at prediction time, promise a profitable trade, or authorize an order.

Phase 10 adds a local, reproducible market-direction baseline. It trains a three-class classifier from source-candle OHLCV, persisted indicator values, candlestick detections, and price-action evidence. The target is a later completed close:

- `BULLISH` when the forward return is above the configured neutral band;
- `BEARISH` when it is below the negative neutral band;
- `NEUTRAL` inside that inclusive band.

Future closes are used solely to label historical rows after the fact. They are never added to the feature vector. The model is evaluated on a later, purged chronological holdout rather than a shuffled split.

## Safety boundary

This phase is local research and model governance only. It does not access a broker, route an order, modify a paper trade, transfer money, or make a live-market claim. Training a model does not create a trade idea or prediction record; inference and human review remain separate work.

## Architecture

```text
completed candles + persisted analytical evidence
                  |
                  | cutoff-bound read
                  v
       PostgresMlRepository / CandleEvidence
                  |
                  v
   fixed ml-feature-v1 + later-close labels
                  |
                  | source-candle features only
                  v
    purged chronological train / validation split
                  |
                  v
 sklearn median-imputer -> scaler -> logistic regression
                  |
       +----------+-----------+
       |                      |
       v                      v
local checksummed artifact   model_versions (CANDIDATE)
       |                      |
       +----------+-----------+
                  |
                  | explicit --promote and unseen-data gate
                  v
 model_promotions + one local PRODUCTION version
```

The Python application owns feature engineering, fitting, artifact integrity, and evaluation. The PostgreSQL adapter owns SQL and model-lifecycle transactions. The database already has `model_versions` and `model_promotions`, so no schema migration is needed for this phase.

## Folder structure

```text
apps/ml/
  train.py                                      # local training / optional promotion CLI
  requirements.txt
  ai_quant_lab_ml/
    contracts.py                                # stable data and model contracts
    features.py                                 # ml-feature-v1 and later-close labels
    validation.py                               # purged chronological split
    training.py                                 # scikit-learn baseline and metrics
    artifacts.py                                # local pickle envelope + SHA-256
    postgres_repository.py                      # evidence and model-lifecycle adapter
  tests/
    ...                                         # deterministic unit tests

models/                                         # generated local artifacts (gitignored)
```

## Dataset design

The Phase 10 runner trains one NSE instrument and one timeframe per experiment. It reads only final candles inside the requested source window and only data/evidence stored by `--data-cutoff-at`:

- candles: `received_at <= cutoff` and `close_time <= cutoff`;
- indicator snapshots: `calculated_at <= cutoff`;
- pattern and price-action detections: `detected_at <= cutoff`.

The label uses the close exactly `--horizon-bars` later, provided that later candle is also inside the requested data window and cutoff-bound dataset. Rows at the tail without a complete in-window future label are omitted instead of guessed.

`--data-cutoff-at` is an as-of boundary: it must be at or after `--to`, and no source candle that closes after the cutoff is included.

`ml-feature-v1` has a fixed ordered schema, even when a particular observation has no indicator or pattern. Its sources are:

- source-candle OHLCV and body/range/wick ratios;
- numerical values from SMA, EMA, RSI, MACD, ATR, VWAP, Bollinger Bands, and Supertrend;
- Supertrend directional flags;
- directional confidence features for persisted candlestick patterns;
- directional confidence and price-level-distance features for persisted price-action events.

Missing analytical values remain missing until the model pipeline's **training-fold** median imputer handles them. A missing feature is never filled with a future value or a statistic learned from validation rows.

The first schema deliberately fixes the analytical definitions as well as the
column order: SMA/EMA use 20 bars; RSI and ATR use 14-bar Wilder smoothing;
MACD uses 12/26/9; VWAP resets each NSE session; Bollinger Bands use 20 bars
and two standard deviations; and Supertrend uses ATR 10 with multiplier 3.
The runner accepts only `ta-v1`, `candlestick-v1`, and `price-action-v2` for
this feature contract. Changing any of these meanings requires a new feature
schema version rather than silently reusing `ml-feature-v1`.

## No-look-ahead validation

For a source bar `T` and a horizon of `h` bars, the label is only available when `T+h` closes. A shuffled split would allow an early row's future target to overlap information in the validation period. Phase 10 instead sorts examples by source close and reserves the final fraction as validation.

```text
|-------- training --------|-- purge h bars --|------ unseen validation ------|
features/labels used to fit   discarded         never used to fit transforms
```

The purge removes `h` source observations immediately before validation. Thus no training label can use a later close that belongs to the validation source period. The validation metrics are therefore a more honest estimate than in-sample score, though still not a performance guarantee.

The persisted cutoff is a current-row revision boundary, like Phase 9. The first schema does not retain old versions of overwritten indicator/pattern/event rows, so a timestamp alone cannot recreate a row that was later overwritten. Preserve raw data revisions or content hashes before treating a result as audit-grade.

## Baseline model and metrics

The first model is intentionally interpretable and reproducible:

```text
SimpleImputer(strategy=median, fit on training only)
  -> StandardScaler(fit on training only)
  -> LogisticRegression(random_state=42 by default)
```

It reports validation accuracy, balanced accuracy, macro F1, sample count, and the actual label distribution. Macro F1 is the promotion metric because a plain accuracy score can look good when `NEUTRAL` dominates the data. The model artifact stores its feature schema, training configuration, split protocol, and metrics in a SHA-256-checked envelope.

Phase 11-compatible artifacts also store a bounded, deterministic reference set
from the **training partition only**, plus the last training label's
availability time. These fields let local inference explain similar label
setups without pulling validation rows into the explanation or deploying a
historical model before its final training target was knowable.

Pickle artifacts must be treated as trusted local files only. A checksum detects accidental corruption, not a malicious artifact substitution.

## Model lifecycle and promotion

Every training invocation writes a new immutable local artifact, re-reads it against its SHA-256 checksum and metadata contract, then persists a `CANDIDATE` row in `model_versions`. Unless you pass `--model-key`, the runner derives a model family key from the instrument, timeframe, horizon, neutral threshold, and feature-schema version so incompatible experiments do not contend for one production slot. The record stores:

- model key and monotonically allocated version;
- algorithm and fixed feature schema;
- artifact path and SHA-256 checksum;
- training source window and row count;
- dataset cutoff, label definition, split protocol, and metrics.
- the final training-label availability boundary and a training-only reference
  set for later explainable inference.

Promotion is never automatic. `--promote` is required, and the candidate is tested against the incumbent production artifact on the **same** newly held-out validation rows. The candidate must have strictly greater macro F1 by more than `--minimum-improvement`. An initial production model requires the explicit `--minimum-initial-macro-f1` threshold.

Before promotion, the runner re-checks the candidate artifact checksum and checks feature-schema/definition compatibility plus the incumbent artifact checksum. If either artifact cannot be safely evaluated, the new candidate stays a candidate. A transaction and per-model advisory lock re-check that the incumbent did not change after comparison, archives the old production version, promotes the candidate, and inserts `model_promotions` with the comparison record.

## Running the workflow

Install the local Python dependencies once. On Windows, create and activate a virtual environment first:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r apps/ml/requirements.txt
npm run ml:test
```

Prepare completed historical data and compatible Phase 5/6 evidence for one instrument/timeframe, then train a candidate:

```powershell
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --horizon-bars 5 --neutral-threshold-bps 50
```

For reproducibility, pin the stored-data revision boundary rather than allowing the default current UTC time:

```powershell
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --data-cutoff-at 2025-01-02T00:00:00Z --horizon-bars 5 --neutral-threshold-bps 50
```

Review the candidate's data coverage and validation metrics before requesting promotion. If it is appropriate to try the governed gate, opt in explicitly:

```powershell
npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --promote --minimum-improvement 0.01
```

The command prints the candidate version, local artifact path/checksum, row counts, validation metrics, purge size, and promotion decision. It does not write `model_predictions`, generate trade ideas, or place any order.

## Best practices

- Keep an untouched final period beyond the validation window for a later final evaluation.
- Train and compare candidates on the same instrument, timeframe, label horizon, cutoff, feature schema, and holdout protocol.
- Inspect class counts. A high score on a nearly single-class dataset is not useful.
- Treat feature/schema changes as a new model family or explicit version, never as an invisible artifact replacement.
- Use non-zero transaction cost assumptions in Phase 9 independently; directional classification is not a trading P/L model.
- Compare against simple baselines, such as persistence or neutral-only predictions, before trusting a more complex algorithm.
- Record source provenance, corporate-action policy, survivorship handling, and delisting treatment before expanding the universe.

## Common mistakes

- Randomly shuffling candles before validation.
- Computing an indicator using future bars or choosing a later corrected snapshot without recording a cutoff.
- Letting a training label overlap the validation feature period.
- Reusing validation data repeatedly to tune horizons, thresholds, and features, then calling it unseen.
- Promoting from a stored historical metric without running the incumbent on the exact candidate holdout.
- Loading an untrusted pickle artifact or ignoring its persisted checksum.
- Treating classification accuracy as a forecast of realised strategy profit.
- Automatically connecting model output to a paper-trade fill or broker order.

## Production considerations

For a larger research environment, snapshot raw data revisions, feature matrices, split assignments, dependency versions, and artifact hashes. Add walk-forward folds, embargoes for correlated instruments, calibration checks, drift monitoring, model cards, and a separate approval process. Prefer safe artifact formats for any multi-user or remote deployment. This local phase intentionally prioritizes explainable lineage and failure-safe promotion over throughput.

## Assignment

1. Train a candidate on one daily NSE instrument and record the cutoff, horizon, row counts, class balance, macro F1, and artifact checksum.
2. Change only the neutral threshold and explain why the class balance and promotion comparison are no longer directly comparable.
3. Build a small fixture with a five-bar horizon and prove that the purge removes the last five training-source rows before validation.
4. Corrupt a copy of a saved artifact and verify that checksum validation refuses to evaluate it for promotion.
5. Compare a candidate against a production artifact on the same holdout and explain why a better in-sample score alone cannot promote it.

