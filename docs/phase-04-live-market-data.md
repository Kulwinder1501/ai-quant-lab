# Phase 4: live market-data collection

## Theory and purpose

Live collection turns read-only quote snapshots into time-bucketed OHLCV candles. A quote is not a candle: it is only the latest observed price and, sometimes, cumulative session volume. The collector owns the aggregation rule, stores the current candle as provisional, and seals it only when its NSE time window is over.

The optional Kite adapter uses the documented full-quote endpoint only. Kite describes that endpoint as a market-data snapshot API and documents the `exchange:tradingsymbol` identifiers, LTP, exchange timestamp, and cumulative volume fields in its [market-quote reference](https://kite.trade/docs/connect/v3/market-quotes/). It does not call WebSocket, order, portfolio, or trading endpoints.

## Architecture

```text
Kite /quote snapshots (read-only)
              |
              v
KiteLiveMarketDataProvider
              |
              v
CollectLiveMarketData
  | session gate: NSE weekday + 09:15-15:30 IST + manual holidays
  | bucket: 1m / 3m / ... / daily
  | aggregate: open, high, low, close, volume delta
              |
              v
provisional candles -> completed candles -> later indicator/pattern modules
```

## Folder structure

```text
apps/api/src/modules/market-data/
  domain/live-market-data-provider.ts
  domain/nse-market-session.ts
  domain/decimal.ts
  application/collect-live-market-data.ts
apps/api/src/infrastructure/market-data/
  kite-live-market-data-provider.ts
apps/api/src/interfaces/cli/
  collect-live-market-data.ts
```

## Database design

No new table is needed. Phase 2 already includes the required model:

- A live CLI session opens a `market_data_ingestions` row with `mode = LIVE`.
- Each in-progress candle is upserted into `candles` with `is_complete = false`.
- When the bucket closes, the exact row is upserted as `is_complete = true`.
- The database repository refuses later changes to that completed candle.
- `source_metadata` records the provider identifier, cumulative-volume baseline, observed quote timestamp, and exchange timestamp.

This keeps every candle traceable without allowing a live feed to rewrite historical evidence.

## Implementation

Configure valid data-only credentials in `.env`:

```text
KITE_API_KEY=...
KITE_ACCESS_TOKEN=...
# Optional manual exchange holidays. Do not invent holidays in code.
NSE_HOLIDAYS=2026-01-26,2026-03-04
```

Seed the indices and optionally register an equity:

```powershell
npm run data:seed:core-instruments
npm run data:register:instrument -- --symbol RELIANCE --name "Reliance Industries Limited" --type EQUITY --exchange NSE --kite-quote-symbol "NSE:RELIANCE"
```

Run a one-minute collection loop for selected symbols:

```powershell
npm run data:collect:live -- --provider kite --timeframe 1m --poll-seconds 30 --instruments NIFTY50,BANKNIFTY,RELIANCE
```

For a safe connectivity and configuration check that exits after one poll:

```powershell
npm run data:collect:live -- --provider kite --timeframe 1m --instruments NIFTY50 --once
```

Outside the configured NSE weekday session, the command does not fetch quotes. It still finalizes any stale provisional candles whose time window has closed.

## Code decisions

- NSE session windows are calculated in UTC from the fixed IST offset, while all stored timestamps remain `timestamptz`.
- Quotes with a timestamp from a different trading day than the current poll are ignored; stale data cannot create a fresh candle.
- A quote's cumulative volume is converted to a non-negative delta between snapshots. Decimal-string arithmetic avoids JavaScript floating-point rounding.
- If a collector starts mid-session without an earlier volume baseline, it records zero rather than falsely assigning the day's entire cumulative volume to one candle. The next snapshot establishes the baseline.
- A manual `NSE_HOLIDAYS` list is safer than attempting to infer exchange holidays. A future calendar adapter can replace it.
- Polling is deliberately used for this local first version. A WebSocket adapter can later implement the same `LiveMarketDataProvider` port when lower latency is justified.

## Best practices

- Start the collector before market open if per-candle volume accuracy is important.
- Set the polling interval according to your provider's terms and rate limits; 30 seconds is a conservative starting point for one-minute candles.
- Use the canonical local instrument symbol, and map provider-specific symbols through metadata (`kiteQuoteSymbol`).
- Stop the collector gracefully with `Ctrl+C` so its ingestion row is completed and its final count is recorded.
- Monitor `market_data_ingestions` for failed or unexpectedly long-running sessions.

## Common mistakes

- Writing every quote as a completed candle instead of aggregating it within a bucket.
- Polling outside exchange hours and mistaking a stale last price for a current trade.
- Assuming a provider's daily cumulative volume is already a candle volume.
- Letting a restarted collector overwrite a completed candle.
- Treating a market-data credential as permission to add order APIs. This project has no order-routing code.

## Production considerations

Use an official exchange calendar, persistent collector checkpoints, provider rate-limit handling, telemetry, and alerts before relying on a continuous unattended feed. For larger watchlists, batch providers' supported quote requests and add bounded concurrency. If you later choose a streaming adapter, keep the aggregation, session, and candle-repository rules unchanged.

## Assignment

1. Add the upcoming NSE holidays to `NSE_HOLIDAYS` from an official exchange calendar.
2. Run the `--once` command during market hours and confirm a provisional candle appears.
3. Run the loop across a candle boundary and verify the prior candle becomes complete.
4. Compare a completed candle's OHLCV values against the provider's chart.
5. Stop and restart the collector to observe how the volume baseline is handled, then explain why the system avoids inventing the missing pre-restart volume.
