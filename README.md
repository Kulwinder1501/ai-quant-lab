# AI Quant Lab

Local-first Indian-market research and paper-trading platform. It **never places real orders**.

## Workspace

- `apps/web` — Next.js dashboard
- `apps/api` — Express API and modular research domain
- `apps/ml` — Python model training and evaluation workspace
- `packages/contracts` — shared API/domain types
- `infra` — local PostgreSQL + pgvector configuration
- `docs` — architecture and phase-by-phase learning material

## Start locally

1. Copy `.env.example` to `.env` and set secure local values.
2. Start the database: `docker compose up -d database`.
3. Install JavaScript dependencies: `npm install`.
4. Apply the local schema: `npm run db:migrate`.
5. Start the API: `npm run dev:api`.
6. Start the dashboard: `npm run dev:web`.

Market-data integrations are added only after a provider is selected and its terms are reviewed.

For Phase 3, use `npm run data:seed:core-instruments`, then import a licensed CSV or configure the optional read-only Kite historical-data adapter. See `docs/phase-03-historical-data.md` for commands and data-source guidance.

Phase 4 adds optional live quote polling that aggregates provisional and completed candles during NSE market hours. See `docs/phase-04-live-market-data.md` before running it.

Phase 5 calculates versioned technical indicators from completed candles with `npm run analysis:calculate-indicators -- --instrument NIFTY50 --timeframe 1d`. See `docs/phase-05-technical-indicators.md` for formulas and warm-up behavior.

Phase 6 records versioned candlestick and price-action evidence from completed candles with `npm run analysis:detect-patterns -- --instrument NIFTY50 --timeframe 1d`. See `docs/phase-06-pattern-recognition.md` for rule thresholds and no-look-ahead swing confirmation.

Phase 7 turns compatible completed-candle evidence into versioned, explainable paper-trade proposals with `npm run analysis:generate-trade-ideas -- --instrument NIFTY50 --timeframe 1d`. See `docs/phase-07-strategy-engine.md` for the `trend-breakout` v1 rules, risk geometry, and no-look-ahead timing.

Phase 8 records explicit local simulated fills and evaluates completed-candle exits with `npm run paper:accounts:create`, `npm run paper:trades:open`, `npm run paper:trades:evaluate`, and `npm run paper:accounts:summary`. See `docs/phase-08-paper-trading.md` for the fill policy, gap and same-candle conflict rules, costs, and performance metrics.

Phase 9 replays the versioned strategy through completed historical candles with `npm run backtest:run -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2025-01-01 --quantity 1 --initial-capital 100000`. See [the Phase 9 backtesting guide](docs/phase-09-backtesting.md) for no-look-ahead timing, fill/exit assumptions, capacity, and metrics.

Phase 10 trains a local, cutoff-bound market-direction candidate with purged chronological validation using `npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01`. See [the Phase 10 machine-learning guide](docs/phase-10-machine-learning.md) for labels, feature lineage, validation, artifact integrity, and promotion gates.

Phase 11 creates one local, explainable research prediction from a promoted, checksum-verified logistic model using `npm run ml:predict -- --instrument NIFTY50 --timeframe 1d --model-key <promoted-model-key> --as-of 2025-01-15T16:00:00Z`. See [the Phase 11 explainable-AI guide](docs/phase-11-explainable-ai.md) for the model gate, no-look-ahead cutoff, feature contributions, and safety boundary.

Phase 12 adds a GET-only dashboard and API for inspecting already-persisted model predictions and explanations. It cannot generate a prediction or create a trade, paper trade, broker connection, or order. See [the Phase 12 read-only dashboard guide](docs/phase-12-read-only-dashboard.md) for its API contract, pagination, evidence semantics, and safety boundary.

Phase 13 adds a GET-only Market Scanner and active local instrument Watchlist. It shows only persisted completed-candle research context and cannot collect data, generate predictions or trade ideas, alter paper activity, connect to a broker, or place an order. See [the Phase 13 scanner and watchlist guide](docs/phase-13-market-scanner-watchlist.md) for its evidence lineage, API contract, and safety boundary.

Phase 14 transforms the platform into an interactive, full-stack Next.js web application operable from the FE. It introduces rich UI modules for Paper Trading (`/paper-trading`), Strategy & Trade Ideas (`/strategy`), Chronological Backtesting (`/backtesting`), and Interactive Technical Charts (`/charts`) with indicator/pattern overlays, eliminating CLI dependence while strictly maintaining the no-live-trading safety boundary. See [the Phase 14 interactive full-stack guide](docs/phase-14-interactive-fullstack-fe.md) for transport helpers, UI aesthetics, and feature operability.

Phase 15 containerizes the entire stack (API, Web, and PostgreSQL/pgvector database) using Docker and Docker Compose. It establishes automated container startup workflows, including database schema migration, core instrument registration, and comprehensive market data seeding (600+ candlesticks, indicator snapshots, pattern detections, and 12 active trade proposals), enabling turnkey out-of-the-box UI operability with `docker compose up -d --build`. See [the Phase 15 Docker orchestration and seeding guide](docs/phase-15-docker-orchestration-seeding.md) for container networking, multi-stage Dockerfiles, and automated bootstrapper mechanics.

Phase 19 makes XGBoost and LightGBM real trainable model families alongside the logistic baseline with `npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --algorithm xgboost`. Each family keeps its own promotion lineage by default, a shared `--model-key` makes two algorithms compete for one production slot on identical unseen data, and a boosted prediction is explained with exact TreeSHAP contributions rather than borrowed linear-coefficient language. See [the Phase 19 gradient-boosting guide](docs/phase-19-gradient-boosting-models.md) for defaults, determinism, and the explainer contract.

Phase 20 adds the two remaining specified dashboard modules: a **Trade History** ledger (`/trade-history`) with realised profit factor, expectancy, reward multiples, and ordered drawdown across every local paper account, and a **Model Performance** registry (`/model-performance`) exposing each version's holdout metrics, hyperparameters, purged validation protocol, promotion decision, and training-to-validation gap. Both are GET-only and cannot alter paper activity or the model registry. See [the Phase 20 trade-history and model-performance guide](docs/phase-20-trade-history-model-performance.md) for the API contract and metric semantics.

Phase 21 hardens model integrity. The feature schema moves to `ml-feature-v2`, where every column is a basis-point distance, a ratio, a bounded oscillator, or a confidence — no absolute rupee level, because a price level acts as a proxy for time and lets a chronological holdout leak its label distribution. A new leakage audit (`npm run ml:audit -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2026-01-01`) runs label-shuffle, feature-lag, and era-holdout checks, and blocks promotion when one fails. The promotion gate now also refuses a suspiciously high score or a negative training-to-holdout gap, reports the directional hit rate and coverage next to macro-F1, and supports walk-forward validation via `--folds N` where both the mean and the most recent fold must clear the floor. Retraining the previously promoted model under v2 dropped it from 0.703 to 0.288 macro-F1, which is what the leak was worth. See [the Phase 21 model-integrity guide](docs/phase-21-model-integrity-and-leakage-audits.md) for the schema mapping, gate order, and check thresholds.

## Safety boundary

This project is for analysis, backtesting, and simulated paper trades. It contains no broker authentication, order-routing, or real-order execution capability.
