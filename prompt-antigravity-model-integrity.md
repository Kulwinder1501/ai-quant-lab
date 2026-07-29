# Task prompt: model-integrity hardening (AI Quant Lab, Phase 21)

You are a Senior Machine Learning Engineer and Quantitative Researcher working on an
existing local-first research platform. Read this whole brief before editing anything.

---

## 1. Project context

**AI Quant Lab** is a single-user, local Indian-market (NSE) research and paper-trading
platform. It **never places real orders** — there is no broker authentication, no
order routing, and no execution path anywhere in the codebase. Keep it that way.

- Modular monolith. No microservices, Kafka, Kubernetes, or cloud services.
- `apps/api` — Express + TypeScript. Modules follow `domain` → `application` layers;
  `infrastructure/` and `interfaces/` are centralised under `apps/api/src/`.
  Dependencies point inward; domain code knows nothing about Express or PostgreSQL.
- `apps/ml` — Python 3.12 research workspace (run as `py -3.12` on Windows).
- `apps/web` — Next.js 16 + React 19 + TailwindCSS dashboard, Highcharts for charts.
- `packages/contracts` — shared framework-neutral types.
- PostgreSQL + pgvector, via Docker Compose.
- Platform is Windows. Shell examples assume PowerShell or Git Bash.

**Codebase conventions you must follow:**

- `scikit-learn`, `xgboost`, and `lightgbm` are imported **lazily inside functions**,
  never at module top level, and an `ImportError` is converted into a `RuntimeError`
  with an "install apps/ml/requirements.txt first" message. This keeps modules
  importable when optional dependencies are absent, which the test suite relies on.
- Training must be deterministic: `n_jobs=1`, fixed `random_state`,
  `tree_method="hist"` for XGBoost, `deterministic=True` + `force_row_wise=True` for
  LightGBM. The artifact SHA-256 checksum is only meaningful if reruns reproduce.
- Model artifacts are pickled sklearn `Pipeline` objects with exactly three steps:
  `imputer`, `scaler`, `classifier`. Every explainer and the promotion gate depend on
  that shape. Do not change it.
- Statistics that have no data behind them return `null`, never `0`. "No win rate" and
  "a zero win rate" are different facts and the UI renders them differently.
- Comment density and naming should match surrounding code. Explain *why*, not *what*.

---

## 2. The problem you are solving

The promotion gate currently accepts a model that is almost certainly leaking.

Observed state of the local model registry:

| Algorithm | Stage | Holdout macro-F1 | Train→holdout gap | Rows | Predictions |
| --- | --- | --- | --- | --- | --- |
| `sklearn-logistic-regression-v1` | PRODUCTION | **0.703** | **−0.084** | 633 train / 160 holdout | 133 |
| `xgboost-gradient-boosting-v1` | CANDIDATE | 0.521 | +0.223 | 1933 / 485 | 0 |
| `lightgbm-gradient-boosting-v1` | CANDIDATE | 0.538 | +0.322 | 1933 / 485 | 0 |

Three separate problems are visible here:

1. **A high holdout score paired with a negative train→holdout gap is a leakage
   fingerprint.** A model scoring better out-of-sample than in-sample has usually seen
   information it should not have. Nothing in the pipeline flags this today; the model
   was promoted automatically.

2. **The feature schema contains non-stationary absolute levels.** The 108-feature
   `ml-feature-v1` schema includes `candle.open`, `candle.high`, `candle.low`,
   `candle.close`, `candle.volume`, and level-valued indicators such as EMA, SMA, VWAP,
   Bollinger bands, and Supertrend. On a trending series an absolute price acts as a
   proxy for *time*, so a chronological split lets a model infer which era it is in and
   therefore the local label distribution. This is the most likely cause of the 0.703.

3. **The reported metric is being read against the wrong baseline.** The gate compares
   3-class macro-F1 (`BEARISH` / `NEUTRAL` / `BULLISH`), whose random baseline is ~0.33
   — not the 0.50 coin-flip baseline of a binary hit rate. There is currently no metric
   in the pipeline that is directly comparable to "the model was right 54% of the
   time," which is the number that actually drives trading expectancy.

Realistic targets for genuine edge on liquid index data, for calibration:

- 3-class macro-F1: ~0.33 is random, ~0.38–0.45 is a real find, **above ~0.60 should be
  treated as a suspected bug until an audit says otherwise.**
- Directional hit rate (binary framing): 0.50 is random, 0.53–0.56 is excellent,
  above 0.65 is almost always leakage.

---

## 3. Files you will be working in

```text
apps/ml/ai_quant_lab_ml/features.py         feature schema and vector construction
apps/ml/ai_quant_lab_ml/contracts.py        FEATURE_SCHEMA_VERSION, EvaluationMetrics
apps/ml/ai_quant_lab_ml/validation.py       chronological_purged_split
apps/ml/ai_quant_lab_ml/training.py         trainers, evaluate_predictions, metadata
apps/ml/ai_quant_lab_ml/inference.py        artifact gate + explainers
apps/ml/ai_quant_lab_ml/reference_data.py   training-only similar-setup reference set
apps/ml/train.py                            CLI, promotion_assessment()
apps/ml/tests/                              unittest suites

apps/api/src/modules/model-performance/domain/model-performance.ts
apps/web/src/features/model-performance/domain.ts
apps/web/src/features/model-performance/api.ts
apps/web/src/features/model-performance/components/model-performance-dashboard.tsx
```

Reference docs already in the repo: `docs/phase-10-machine-learning.md`,
`docs/phase-11-explainable-ai.md`, `docs/phase-19-gradient-boosting-models.md`,
`docs/phase-20-trade-history-model-performance.md`.

---

## 4. Work items

Deliver these in the order given. Each one must leave the test suites green.

### Item 1 — Raise the promotion floor and add a danger-zone alarm

**Files:** `apps/ml/train.py` (`build_parser`, `promotion_assessment`),
`apps/api/src/modules/model-performance/domain/model-performance.ts`,
`apps/web/src/features/model-performance/*`.

- Raise the `--minimum-initial-macro-f1` default from `0.34` to `0.38`, keeping it
  configurable. Update the help text to explain that ~0.33 is the 3-class random
  baseline.
- Add `--maximum-plausible-macro-f1` (default `0.60`). A candidate scoring above it
  must **not** auto-promote. Emit decision `SUSPICIOUSLY_HIGH_REQUIRES_AUDIT`.
- A negative train→holdout gap must also block auto-promotion with decision
  `HOLDOUT_EXCEEDS_TRAINING_REQUIRES_AUDIT`.
- Add `--override-suspicious` so an operator can promote deliberately after
  investigating. Record the override in the promotion comparison JSON.
- Surface a `leakageRisk` field (`NONE` / `SUSPICIOUS_SCORE` / `NEGATIVE_GAP`) through
  the model-performance domain and render it as a warning badge on the leaderboard and
  the detail card.

**Acceptance:** the existing PRODUCTION logistic model, if retrained today, would be
refused by both new rules. New unit tests cover each decision branch.

### Item 2 — Directional hit rate and coverage

**Files:** `contracts.py` (`EvaluationMetrics`), `training.py` (`evaluate_predictions`,
`training_metadata`), model-performance domain + web.

- Add `directional_predictions`, `directional_hit_rate`, and `coverage` to
  `EvaluationMetrics`. Hit rate is accuracy computed **only over rows the model called
  `BULLISH` or `BEARISH`**; coverage is the share of rows it committed on. Both are
  `None` when the model never committed.
- Persist them in artifact metadata and `model_versions.validation_metrics`.
- Display hit rate and coverage beside macro-F1 in the Model Performance leaderboard
  and detail card, labelled as the number comparable to a binary hit rate.
- Existing envelope parsers must tolerate older rows that lack these keys.

**Acceptance:** a model that predicts `NEUTRAL` for every row reports
`coverage = 0` and `directional_hit_rate = null` rather than a misleading score.

### Item 3 — Leakage audit command

**Files:** new `apps/ml/ai_quant_lab_ml/leakage.py`, new `apps/ml/audit.py`, npm script
`ml:audit` in the root `package.json`, new tests.

Implement three checks over one dataset request, each returning a structured verdict:

1. **Label shuffle** — retrain on a permuted target. Macro-F1 must collapse toward the
   ~0.33 random baseline. Failure to collapse means the pipeline is leaking.
2. **Feature lag** — score each row using features from one bar *earlier* than allowed.
   The score must degrade materially; if it barely moves, features encode the future.
3. **Era holdout** — train on an early period, evaluate on a much later untouched
   period, and report the delta against the in-window holdout score.

Emit one compact JSON result with an overall `PASS` / `INVESTIGATE` verdict and a
per-check reason. Follow the CLI conventions already used by `train.py` and
`predict.py`: argparse, `load_dotenv`, `DATABASE_URL` from `.env`, JSON stdout, and a
non-zero exit code on failure.

Then wire it in: when a leakage audit result is present and its shuffle check failed,
`train.py --promote` must refuse regardless of score.

**Acceptance:** running the audit against the current synthetic-seed data produces an
`INVESTIGATE` verdict, and the reason names which check failed.

### Item 4 — Stationary feature schema (`ml-feature-v2`)

**Files:** `features.py`, `contracts.py`, `reference_data.py` if it hardcodes schema
assumptions, `tests/test_features.py`.

Replace every absolute-level feature with a scale-free equivalent:

- `candle.close` → log return versus the prior close.
- `candle.open` → overnight gap in bps.
- `candle.high` / `candle.low` → range as a fraction of ATR.
- `candle.volume` → ratio to its own rolling median.
- Every level-valued indicator (EMA, SMA, VWAP, Bollinger upper/middle/lower,
  Supertrend) → signed distance from close in bps: `(close − level) / close × 10000`.
- ATR → ATR divided by close.
- RSI, MACD histogram, pattern confidences, and price-action confidences are already
  scale-free; leave them alone.

Bump `FEATURE_SCHEMA_VERSION` to `ml-feature-v2`.

**Important consequence to handle deliberately, not work around:**
`inference.validate_production_artifact` compares both `featureSchemaVersion` and
`featureDefinition` against every artifact, so bumping the version **invalidates the
existing promoted model for inference by design**. Do not add a compatibility shim.
Instead, make the resulting error message tell the operator to retrain and re-promote,
and note the break in the phase doc. Already-stored `model_predictions` rows must stay
readable in the dashboard.

**Acceptance:** no feature in the schema is denominated in rupees. Tests assert that
every schema entry is either a ratio, a bps distance, a bounded oscillator, or a
confidence/boolean.

### Item 5 — Walk-forward validation

**Files:** `validation.py`, `training.py`, `train.py`, model-performance domain + web,
tests.

- Add `walk_forward_splits(examples, *, horizon_bars, folds, validation_fraction)`
  returning a list of `TemporalSplit`, each preserving its own purge gap of at least
  `horizon_bars`. Keep the existing single-split function working unchanged.
- Add `--folds N` to `train.py`, defaulting to `1` so current behaviour is preserved.
- With `folds > 1`, the promotion gate compares the **mean** macro-F1 across folds and
  additionally requires the final (most recent) fold to clear the floor. Record every
  per-fold score plus the spread in artifact metadata, and set
  `validationProtocol.method` to `WALK_FORWARD_PURGED_V1`.
- Show fold count and score spread in the Model Performance UI, so two candidates whose
  scores differ by less than the spread are visibly not separable.

**Acceptance:** a walk-forward run records N fold scores; the gate refuses a candidate
whose mean clears the floor but whose most recent fold does not.

### Item 6 — Phase documentation

Write `docs/phase-21-model-integrity-and-leakage-audits.md` following the structure of
the existing phase docs: Purpose, Theory and why it exists, Safety boundary,
Architecture, Implementation walk-through, Run locally, Best practices, Common
mistakes, Production considerations, Assignments.

State plainly that the pre-existing 0.703 model was a leakage suspect, what the audit
found, and why the schema bump forces a retrain. Then add a short paragraph to
`README.md` and a bullet to `docs/architecture.md` matching how phases 19 and 20 are
described there.

---

## 5. Explicitly out of scope

- **Do not attempt to obtain, import, or generate market data.** The local database is
  currently populated by the Phase 15 synthetic seeder
  (`apps/api/src/modules/market-data/application/seed-market-data.ts`), which is why
  scores are inflated. Importing licensed NSE history requires the owner's data-source
  decision and credentials. Note the dependency in your summary and stop there.
- Do not add broker authentication, order routing, or any execution path.
- Do not weaken or bypass the artifact checksum gate, the purge gap, or the
  no-look-ahead timing guards in `predict.py`.
- Do not tune hyperparameters against the same holdout that gates promotion. If tuning
  is needed, use an inner split and leave the gating split untouched.
- Do not auto-promote a model as part of any change. Promotion stays an explicit,
  operator-invoked action.

---

## 6. Verification

Run after each work item:

```bash
npm run ml:test
```

```bash
npm run lint --workspace @ai-quant-lab/api
```

```bash
npm run test --workspace @ai-quant-lab/api
```

```bash
npm run build --workspace @ai-quant-lab/web
```

**Two API tests already fail before you start, and are unrelated to this work** — do
not chase them and do not count them as regressions:

- `migration-runner.test.ts` expects 3 migration IDs; there are now 4.
- `run-backtest.test.ts` expects 4 lifecycle steps; the code now emits 5.

Everything else is green today: 65 Python tests pass, 77 API tests pass, the web build
compiles clean. Keep it that way.

Web lint is also already failing with ~40 pre-existing `react-hooks/set-state-in-effect`
errors across the dashboards. Do not undertake that refactor here.

---

## 7. Report back

When finished, summarise: which decisions the new gate now refuses and why, what the
leakage audit reported on the current data, the before/after feature schema in one
table, and the exact commands the owner needs to run to retrain and re-promote a model
under `ml-feature-v2`.
