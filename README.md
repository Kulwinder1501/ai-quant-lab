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
2. Start the v2 system-of-record database: `docker compose -f docker-compose.v2.yml up -d database-v2`.
3. Install JavaScript dependencies: `npm install`.
4. Apply the local schema: `npm run db:migrate`.
5. Start the API: `npm run dev:api`.
6. Start the dashboard: `npm run dev:web`.

Market-data integrations are added only after a provider is selected and its terms are reviewed.

The v2 Compose stack publishes the dashboard, API, and database on `127.0.0.1` only. The API
also restricts browser origins, caps JSON bodies at 256 KB, and rate-limits state-changing
requests per source address (`API_MUTATION_RATE_LIMIT`, 120/minute by default). Do not change
the port bindings to `0.0.0.0` without putting authenticated TLS termination in front of both
the dashboard and API. Environment files and their backups are excluded from every Docker
build context.

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

Phase 15 containerizes the entire stack (API, Web, and PostgreSQL/pgvector database) using Docker and Docker Compose. The current system of record is the v2 stack: start it with `docker compose -f docker-compose.v2.yml up -d --build`. The unqualified `docker-compose.yml` stack is retained only as the v1 audit environment and must not be used for current ingestion or training. See [the Phase 15 Docker orchestration and seeding guide](docs/phase-15-docker-orchestration-seeding.md) for container networking, multi-stage Dockerfiles, and automated bootstrapper mechanics.

Phase 19 makes XGBoost and LightGBM real trainable model families alongside the logistic baseline with `npm run ml:train -- --instrument NIFTY50 --timeframe 1d --from 2022-01-01 --to 2025-01-01 --algorithm xgboost`. Each family keeps its own promotion lineage by default, a shared `--model-key` makes two algorithms compete for one production slot on identical unseen data, and a boosted prediction is explained with exact TreeSHAP contributions rather than borrowed linear-coefficient language. See [the Phase 19 gradient-boosting guide](docs/phase-19-gradient-boosting-models.md) for defaults, determinism, and the explainer contract.

Phase 20 adds the two remaining specified dashboard modules: a **Trade History** ledger (`/trade-history`) with realised profit factor, expectancy, reward multiples, and ordered drawdown across every local paper account, and a **Model Performance** registry (now served under `/ai-models`) exposing each version's holdout metrics, hyperparameters, purged validation protocol, promotion decision, and training-to-validation gap. Both are GET-only and cannot alter paper activity or the model registry. See [the Phase 20 trade-history and model-performance guide](docs/phase-20-trade-history-model-performance.md) for the API contract and metric semantics.

Phase 21 hardens model integrity. The feature schema moves to `ml-feature-v2`, where every column is a basis-point distance, a ratio, a bounded oscillator, or a confidence — no absolute rupee level, because a price level acts as a proxy for time and lets a chronological holdout leak its label distribution. A new leakage audit (`npm run ml:audit -- --instrument NIFTY50 --timeframe 1d --from 2024-01-01 --to 2026-01-01`) runs label-shuffle, feature-lag, and era-holdout checks, and blocks promotion when one fails. The promotion gate now also refuses a suspiciously high score or a negative training-to-holdout gap, reports the directional hit rate and coverage next to macro-F1, and supports walk-forward validation via `--folds N` where both the mean and the most recent fold must clear the floor. Retraining the previously promoted model under v2 dropped it from 0.703 to 0.288 macro-F1, which is what the leak was worth. See [the Phase 21 model-integrity guide](docs/phase-21-model-integrity-and-leakage-audits.md) for the schema mapping, gate order, and check thresholds.

Phase 22 integrates FII/DII Institutional Flows and GIFT Nifty data via a daily automated NSE scraper (`npm run data:collect:institutional`), feeding into the ML features and the `AiAutonomousAgent` logic. It also introduces `npm run ml:prune` to automatically garbage-collect old candidate models, and finalizes the scalping views, which now live as a mode tab on the shared pages rather than as separate routes: `/strategy?mode=scalp` and `/trade-history?mode=scalp`. The former `/scalp-strategy` and `/scalp-trade-history` paths still resolve as redirects so older bookmarks and this document's earlier revisions keep working. See [the Phase 22 institutional & scalping guide](docs/phase-22-institutional-scalping.md) for data flow and UI isolation details.

Phase 23 expands the Market News architecture by replacing the volatile mock memory-repository with real PostgreSQL persistence. It deprecates stale publishers (MoneyControl, ET) and integrates highly active external RSS feeds (LiveMint, Times of India, Business Standard, NDTV Profit). This ensures authentic publication timestamps and accurate, live sentiment scoring directly from the `market_news` table.

Phase 24 introduces **Pending Paper Trades**. It adds the capability to submit simulated limit/stop-entry orders that wait for the market to trigger them instead of executing instantly at the current price. It relies on both live-tick checking and completed-candle checking to resolve `PENDING` states into `OPEN` positions, and implements End-of-Day cancellations to automatically void untriggered intraday limit orders at midnight.

## The autonomous agent runs on a schedule, not on a page view

`AiAutonomousAgent.tick` evaluates open paper trades against the live price, applies the news
sentiment circuit breakers, and can open a position. It is driven by the scheduler's
`AI_AGENT_TICK` job (`npm run agent:tick -- --symbols=NIFTY50,BANKNIFTY --timeframe=15m`), every
two minutes during the session.

It is deliberately **not** driven by the dashboard. `GET /api/v1/stream/live-agent` once called
the tick on every one-second poll of every connected browser, which meant open positions were
only evaluated while a tab happened to be open, the mutation rate limiter did not apply (it
exempts GET by design), and a slow agent pass stalled the price feed the panel exists to show.
That stream is now strictly read-only: it reports the agent's thoughts and reflections without
advancing it. If nothing is scheduled, nothing trades.

The agent scores **both directions** and trades whichever the evidence supports, in
`strategy-engine/domain/directional-setup-score.ts`. This replaced a scorer whose every term was
written for a long, after which the side was picked from the latest pattern's direction — so a
bearish pattern inverted the position while keeping a score built for the opposite thesis, and the
agent's most confident shorts were its most confidently bullish reads. Each thesis is now scored
from the same evidence and the winner carries its own number; both are recorded on the proposal so
a near-tie is distinguishable from conviction.

Positions are opened through `OpenOptionPositionFromIdea`, the same gated path the paper-trading
bot uses: `PrepareOptionEntry` picks a listed contract and fills at the observed ask (LONG → call,
SHORT → put), then `evaluateRisk` applies the concurrent-position, daily-loss and drawdown limits.
The agent previously called the trade repository directly with `fillPrice: livePrice`, so it booked
a cash-style position **at the index level** — an instrument that cannot be bought — with no risk
check and no way to cost it honestly. The sentiment circuit breaker's exit is priced from the
observed contract bid for the same reason, and refuses to close a position it cannot price rather
than closing it at the underlying's level.

### The scorer has been measured, and it does not select

`npm run measure:directional-scorer -- --instrument=NIFTY50 --timeframe=15m` replays the scorer
over stored history, applies the agent's ATR bracket, and resolves each one with the paper-trading
exit rules (gap fills, conservative same-candle stop-first). On NIFTY50 15m over 4,993 scored bars
with news/flow/macro held out:

| side | gated (score ≥ 80) | unconditional | break-even | gated expectancy |
|---|---|---|---|---|
| LONG | 0.3008 (n=256) | 0.3293 | 0.3333 | −0.10R |
| SHORT | 0.3829 (n=175) | 0.3895 | 0.3333 | +0.14R |

**Gating is worse than not gating, on both sides.** The score selects a subset that performs
slightly below the population it was drawn from. The short side's positive expectancy is not the
mirror working — the unconditional column captures all of it and more, so it is a property of this
bracket on this instrument over this window. Two limits: with news and flow held out the ceiling is
75, so clearing 80 requires a pattern (the gated population is "bars carrying a ≥0.7 pattern"), and
it could not be replicated on BANKNIFTY because **no 15m pattern detections exist for it** — a data
gap, not a second data point.

What the code claims is that the two sides are coherent: the number a position opens on is the
number computed for the direction traded, which was not true before. Whether to trade on it at all
is a separate decision, and the table above is the evidence for making it.

## Safety boundary

This project is for analysis, backtesting, and simulated paper trades. It contains no broker authentication, order-routing, or real-order execution capability.
