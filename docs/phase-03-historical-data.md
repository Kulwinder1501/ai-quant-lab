# Phase 3: historical market-data collection

## Theory and purpose

Technical indicators, backtests, and ML models are only as trustworthy as their source candles. Historical collection therefore treats OHLCV data as immutable research evidence: every import has a provider, request range, timestamps, result count, and failure record.

The collector is provider-agnostic. It starts with a local CSV adapter so you can import data obtained under a provider's terms, and includes an optional read-only Kite Connect v3 adapter for users with valid credentials. The Kite adapter calls only its documented historical-candle endpoint; it contains no order, portfolio, or execution code. Kite documents historical OHLCV candles, available intervals, and `instrument_token` requirements in its [historical data reference](https://kite.trade/docs/connect/v3/historical/).

## Architecture

```text
CSV export or licensed HTTP provider
              |
              v
HistoricalMarketDataProvider (port)
              |
              v
ImportHistoricalMarketData (validation + provenance)
              |
              +--> market_data_ingestions
              +--> candles (completed, idempotent upserts)
```

The application service has no dependency on CSV, HTTP, Kite, Express, or PostgreSQL. Each adapter can change independently.

## Folder structure

```text
apps/api/src/modules/market-data/
  domain/historical-data-provider.ts
  domain/market-data-ingestion.ts
  application/import-historical-market-data.ts
  application/seed-core-instruments.ts
apps/api/src/infrastructure/market-data/
  csv-historical-data-provider.ts
  kite-historical-data-provider.ts
apps/api/src/interfaces/cli/
  collect-historical-data.ts
  seed-core-instruments.ts
```

## Database design

`market_data_ingestions` records provider, mode, request metadata, count, timing, and errors. Its ID is attached to every imported `candles` row. `candles` remains unique on `(instrument_id, timeframe, open_time)`, so an interrupted or re-run import is idempotent.

The collector only writes `is_complete = true`. The repository permits changes to an in-progress live candle later, but refuses to overwrite a completed historical candle with different values. This protects backtest reproducibility.

## Implementation

First initialize the local database and canonical index instruments:

```powershell
docker compose up -d database
npm run db:migrate
npm run data:seed:core-instruments
```

### CSV import

Import a CSV using headers such as `Date,Open,High,Low,Close,Volume`. `Date` may be `YYYY-MM-DD`, a day-first NSE date, an ISO timestamp, or an NSE-local timestamp. Volume may be omitted for broad index data and is then stored as `0`.

```powershell
npm run data:collect:historical -- --provider csv --instrument NIFTY50 --timeframe 1d --from 2024-07-25 --to 2026-07-25 --file "C:\market-data\nifty50-daily.csv"
```

For an NSE equity, register it through an application use case or seed script before import, then use its canonical symbol (for example `RELIANCE`). The repository is not limited to the two seeded indices.

```powershell
npm run data:register:instrument -- --symbol RELIANCE --name "Reliance Industries Limited" --type EQUITY --exchange NSE --isin INE002A01018
```

### Optional Kite collection

Set only read-only market-data credentials in `.env`:

```text
KITE_API_KEY=...
KITE_ACCESS_TOKEN=...
```

Then provide the provider-specific `instrument_token` obtained from the provider's instrument list:

```powershell
npm run data:collect:historical -- --provider kite --instrument NIFTY50 --provider-instrument-id YOUR_INSTRUMENT_TOKEN --timeframe 1d --from 2024-07-25 --to 2026-07-25
```

The adapter chunks requests, normalizes decimal strings, canonicalizes daily candles to the NSE session, and records the provider token as source metadata. Never commit credentials or use any provider endpoint beyond market-data retrieval.

Kite caps how much history a single request may span, and the cap depends on the
interval — a year of daily candles is one call, a year of minute candles is not, and an
over-wide request is rejected rather than truncated. The adapter therefore chunks by a
per-interval window instead of one shared limit, so the same `--from`/`--to` range works
for `1m` and `1d`:

```powershell
npm run data:collect:historical -- --provider kite --instrument NIFTY50 --provider-instrument-id YOUR_INSTRUMENT_TOKEN --timeframe 5m --from 2025-07-25 --to 2026-07-25
```

Those per-interval windows are Kite's documented limits at the time of writing, and
`maxDaysPerRequest` still overrides all of them. Check the current Kite Connect
documentation before widening any of them, and note that historical data is a separate
subscription whose available lookback decides how much intraday history you can hold.

## Code decisions

- The `HistoricalMarketDataProvider` port makes licensed APIs and files interchangeable.
- Price and volume values remain decimal strings from source through persistence; JavaScript floating-point values are not used for storage.
- The service validates the complete fetched batch before its first write, rejecting duplicate timestamps and invalid OHLC relationships before a malformed batch can partially import.
- The import service intentionally has no HTTP endpoint that accepts arbitrary filesystem paths. Local imports run through an explicit CLI.

## Best practices

- Begin with at least two years of daily candles for NIFTY 50, NIFTY BANK, and each selected NSE equity.
- Persist raw data first; derive indicators and patterns in later modules rather than inserting synthetic history.
- Record whether a provider's data is adjusted for splits/dividends and do not mix adjusted and unadjusted series for the same backtest.
- Keep imports repeatable: same provider, instrument token, timeframe, and date range should safely re-run.
- Respect vendor terms, authentication requirements, rate limits, and data-entitlement restrictions.

## Common mistakes

- Scraping a website that was not intended as a data API. Prefer licensed exports or documented APIs.
- Treating provider symbols as canonical symbols. Store canonical `NSE` symbols locally and keep provider IDs in source metadata.
- Mixing daily timestamps at midnight with intraday session timestamps without normalization.
- Editing completed candles silently after a provider correction, which invalidates prior backtests.
- Importing an incomplete current-day candle as history.

## Production considerations

For a broad NSE universe, import in bounded ranges, retry only idempotent requests, and monitor `market_data_ingestions` for failure rates. As data grows, add provider-specific rate limiting, source data fingerprints, and a controlled candle-revision model. Do not add broker trading APIs merely because a data provider also exposes them.

## Assignment

1. Obtain a legally permitted daily OHLCV export covering at least two years for NIFTY 50.
2. Seed the core indices and import the export with the CSV command above.
3. Repeat the exact command and verify that candle count does not duplicate.
4. Register one NSE equity and import its daily data.
5. Inspect `market_data_ingestions` and `candles` in PostgreSQL to identify the provenance of every imported candle.
