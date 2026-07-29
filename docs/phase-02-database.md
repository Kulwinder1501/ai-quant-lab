# Phase 2: database foundation

## Theory and purpose

The database is the research record of AI Quant Lab. A trade idea, backtest, or model score is useful only when it can be traced to the exact market data, strategy version, and model version that produced it. This phase creates that audit trail before any collector or strategy is introduced.

The design uses PostgreSQL for transactional research data and enables pgvector for a future similarity-search feature. It deliberately does not add an embedding table before an embedding model and vector dimension are chosen.

## Architecture

```text
Collector / strategy / ML code
             |
             v
Repository interfaces (domain boundary)
             |
             v
PostgreSQL repositories --> PostgreSQL + pgvector
             ^
             |
Migration runner --> schema_migrations --> ordered SQL migrations
```

Only repository adapters know SQL. Future application use cases depend on repository interfaces, so a market-data provider or database can be replaced without changing domain rules.

## Folder structure

```text
apps/api/src/infrastructure/database/
  database.ts                 connection pool and readiness check
  migration-runner.ts         advisory-locked transactional migrations
  migrate.ts                  command-line migration entry point
  migrations/001-initial-schema.ts
  repositories/               PostgreSQL implementations
apps/api/src/modules/market-data/domain/
  instrument.ts               framework-free repository port
  candle.ts                   decimal-safe candle port
```

## Database design

```text
market_data_ingestions --> candles --> indicator_snapshots
                              |  \-> pattern_detections
instruments -------------------+  \-> price_action_events

strategies -> strategy_versions -> trade_ideas -> paper_trades -> paper_trade_events
model_versions --------------------^       |
  |                                         +-> trade_idea_evidence
  +-> model_predictions

strategy_versions -> backtest_runs -> backtest_trades
                                  \-> backtest_monthly_performance
                                  \-> backtest_run_instruments
```

Important integrity rules include:

- An instrument is unique per exchange and symbol and is deactivated rather than deleted.
- A candle is unique per instrument, timeframe, and opening timestamp. OHLC and volume checks reject malformed market data.
- The candle repository updates an in-progress candle but refuses to alter a completed one. A later provider correction must be represented as a deliberate data-revision feature, not an invisible overwrite.
- Indicator parameters and pattern algorithms are versioned. Research output therefore remains reproducible after algorithms improve.
- Strategy versions, model versions, backtest engine versions, and data cutoffs are stored with results to prevent accidental look-ahead bias.
- A partial unique index ensures only one production model exists for each model key.
- Trade ideas and paper trades have separate lifecycle states. The latter contains no broker, order, or real-money fields.

## Implementation

Copy `.env.example` to `.env`, start PostgreSQL, then apply the migration:

```powershell
docker compose up -d database
npm run db:migrate
```

The migration runner takes a PostgreSQL advisory lock, records successful migration IDs in `schema_migrations`, and wraps each migration in a transaction. Re-running it is safe: applied migrations are skipped.

The API has two checks:

- `GET /api/v1/health` confirms the process is alive.
- `GET /api/v1/health/ready` also verifies that PostgreSQL accepts a query.

## Code decisions

Prices, volumes, and P/L are stored as PostgreSQL `numeric`, not floating-point values. The persistence-facing candle type carries them as strings so JavaScript cannot silently round them before a deliberate computation boundary.

Indicator values and explanations are JSONB because multi-output indicators (such as MACD and Bollinger Bands) vary in shape. Their definitions, versions, and parameters are relational fields; this preserves queryability and reproducibility without creating a fragile column for every indicator setting.

## Best practices

- Store all operational timestamps as UTC `timestamptz`; use `Asia/Kolkata` only to apply NSE session rules and display local time.
- Create a new migration for every schema change after `001` has been applied anywhere. Never edit a recorded migration.
- Every signal, trade idea, model feature set, and backtest must be anchored to completed candles only.
- Keep model artifacts outside the database, but store their URI, checksum, feature schema, and validation metrics in `model_versions`.
- Parameterize all SQL. The repositories never concatenate runtime values into queries.

## Common mistakes

- Randomly splitting time-series data leaks future information into training and evaluation.
- Using JavaScript `number` values for persisted money or price calculations introduces rounding errors.
- Replacing a completed candle in place makes historical backtests impossible to reproduce.
- Storing only aggregate backtest metrics hides the individual trades needed to diagnose strategy behavior.
- Treating a paper-trade record as an order record creates a dangerous path toward real execution. This system deliberately has no such path.

## Production considerations

Two years of one-minute data across a broad NSE universe can reach millions of candles. The current indexes suit a local single-user deployment. Before reaching that scale, introduce time partitioning for `candles` through a planned migration and include the partition key in all relevant uniqueness constraints. Monitor database size, run backups, and capture provider ingestion failures in `market_data_ingestions`.

## Assignment

1. Run `npm run db:migrate` twice and confirm the second run skips `001-initial-schema`.
2. Add NIFTY 50, BANKNIFTY, and one NSE equity through the `InstrumentRepository` in a small seed use case (Phase 3 will use it).
3. Sketch the exact data-provider adapter you want to use, including its licensing constraints and the timeframe/data history it can legally provide.
