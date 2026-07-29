# Architecture — Phase 1

## Theory: why a modular monolith?

AI Quant Lab is a single-user local application. A modular monolith keeps deployment and debugging simple, while explicit module boundaries allow later extraction if genuine scale requires it.

```text
Next.js dashboard ──HTTP──> Express API
                              │
              ┌───────────────┼────────────────┐
              │               │                │
        Market data      Research engine   Paper trading
        (future)         (future)          (future)
              │               │                │
              └──────────── PostgreSQL + pgvector
                                      │
                            Python ML workspace
```

## Folder structure

```text
apps/api/src/       API configuration and HTTP interfaces
apps/web/src/       dashboard application
apps/ml/            isolated Python research and model code
packages/contracts/ framework-neutral shared contracts
infra/postgres/     local database bootstrap
docs/               architectural decisions and teaching notes
```

## Design rule

Each backend module will follow `domain` (rules/types), `application` (use cases), `infrastructure` (database/provider adapters), and `interfaces` (HTTP/scheduler) layers. Dependencies point inward; domain code knows nothing about Express, PostgreSQL, or a data provider.

## Database design, next phase

Phase 2 creates instruments, OHLCV candles, indicator snapshots, detected patterns, trade ideas, paper trades, backtest runs, and model versions. Candles are immutable once complete and unique by instrument, timeframe, and open time. Provider credentials are kept only in `.env`, never committed.

## Phase 14, 15 & 16: Full-Stack Operability, Orchestration & Autonomous AI Strategy Lab

- **Phase 14 (Interactive UI Operability)**: Replaces CLI-only workflows with interactive Next.js dashboard modules (`/paper-trading`, `/strategy`, `/backtesting`, `/charts`). It introduces bi-directional HTTP transport helpers (`postResearchJson`) and rich client-side state management while strictly preserving the local simulation safety boundary.
- **Phase 15 (Docker Orchestration & Seeding)**: Encapsulates the stack (`api`, `web`, `database`) in Docker Compose with multi-stage Alpine builds. It implements an automated startup bootstrapper (`seed-market-data.ts`) that applies database migrations and populates 600+ multi-timeframe candles, indicators, patterns, and active trade proposals on first container boot.
- **Phase 16 (Autonomous AI Agent & Highcharts UI)**: Integrates an autonomous, multi-modal strategy brain (`AiAutonomousAgent`) that scans Indian benchmark indices (`NIFTY50`, `BANKNIFTY`) and automatically executes simulated paper trades when confidence reaches ≥80%. Introduces Server-Sent Events (SSE) for 24/7 second-by-second ticking price streams, a self-supervised reinforcement learning reflection journal, professional **Highcharts Stock** visualizers, and dedicated **📌 Positions** and **📜 Orders** auditing tabs.
- **Phase 19 (Gradient-Boosted Model Families)**: Adds XGBoost and LightGBM as trainable families behind one shared pipeline contract (`imputer` → `scaler` → `classifier`), selected with `train.py --algorithm`. `LabelEncodedClassifier` reconciles the fixed string label space with XGBoost's integer-target requirement, and `inference.explain_prediction` routes each algorithm to its own explainer — linear coefficient terms for the baseline, exact TreeSHAP contributions for a forest. The purged chronological split and unseen-data promotion gate are unchanged.
- **Phase 21 (Model Integrity & Leakage Audits)**: Replaces every absolute-level feature with a scale-free equivalent (`ml-feature-v2`), which deliberately invalidates prior artifacts through the existing schema-version gate. Adds `ai_quant_lab_ml/leakage.py` plus an `audit.py` CLI running label-shuffle, feature-lag, and era-holdout checks; `walk_forward_splits` for multi-fold purged validation where the gate requires both the mean and the final fold to clear the floor; a suspicious-score and negative-gap refusal ahead of any incumbent comparison; and directional hit rate with coverage as the figure comparable to a binary hit rate.
- **Phase 20 (Trade History & Model Performance)**: Completes the specified dashboard set with two GET-only modules. A new `model-performance` backend module (`domain` + `application`) plus SELECT-only repositories serve `/api/v1/paper-trades` (cross-account simulated ledger with realised aggregates) and `/api/v1/model-versions` (registry evidence, artifact path deliberately excluded). All aggregation lives in pure domain functions so every metric is unit-tested without a database.

## Best practices and common mistakes

- Use UTC timestamps internally, retaining the exchange timezone only for display/session rules.
- Treat market-data providers as replaceable adapters; do not embed provider response shapes in domain code.
- Use chronological validation splits for ML and backtests. Random train/test splits leak future information.
- Never make a paper-trading endpoint capable of calling a broker SDK.

## Assignment

Before Phase 2, install Docker Desktop and Node.js 20+, copy `.env.example` to `.env`, and bring up the database. Verify the API health endpoint after dependencies are installed.
