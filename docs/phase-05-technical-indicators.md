# Phase 5: technical analysis engine

## Theory and purpose

Technical indicators transform completed OHLCV candles into consistent numerical descriptions of trend, momentum, volatility, price location, and participation. They do not predict the market by themselves. Their purpose in AI Quant Lab is to create reproducible features for later pattern recognition, strategies, backtests, and machine learning.

This phase calculates:

- SMA(20) and EMA(20) for trend smoothing
- RSI(14), using Wilder smoothing, for momentum
- MACD(12, 26, 9) for momentum/trend divergence
- ATR(14), using Wilder smoothing, for volatility
- session VWAP for price-versus-volume location
- Bollinger Bands(20, 2) for dispersion
- Supertrend(10, 3) for ATR-based trend state

## Architecture

```text
completed candles only
        |
        v
CalculateTechnicalIndicators (application use case)
        |
        +--> TechnicalIndicatorEngine (pure formulas)
        |
        +--> indicator_definitions (algorithm + parameters + hash)
        +--> indicator_snapshots (candle + definition + values)
```

The pure engine has no database, HTTP, or provider dependency. PostgreSQL repositories only persist definitions and calculated values.

## Folder structure

```text
apps/api/src/modules/technical-analysis/
  domain/technical-indicator.ts
  domain/technical-indicator-engine.ts
  application/calculate-technical-indicators.ts
  application/indicator-parameters-hash.ts
apps/api/src/infrastructure/database/repositories/
  postgres-indicator-definition-repository.ts
  postgres-indicator-snapshot-repository.ts
apps/api/src/interfaces/cli/
  calculate-technical-indicators.ts
```

## Database design

Phase 2 already supplied the required tables:

```text
indicator_definitions
  code + algorithm_version + parameters_hash  --> one immutable calculation identity
                  |
                  v
indicator_snapshots
  candle_id + indicator_definition_id         --> one idempotent value set per candle
```

Changing a period, multiplier, formula, or calculation rule creates a different definition identity. Re-running the same definition updates its snapshot safely, while a new definition preserves prior research output.

## Formula and warm-up rules

The first usable value is intentionally delayed until enough past candles exist:

| Indicator | Default | First usable result |
| --- | --- | --- |
| SMA / EMA | 20 | candle 20; EMA is seeded with SMA(20) |
| RSI | 14 | candle 15, after 14 close-to-close changes |
| ATR | 14 | candle 14 |
| MACD line | 12, 26 | candle 26 |
| MACD signal | 9 | candle 34 |
| Bollinger Bands | 20, 2 sigma | candle 20 |
| Supertrend | ATR 10, multiplier 3 | candle 10 |
| VWAP | session reset | first positive-volume candle in each NSE session |

Snapshots are not written before an indicator has a valid result. MACD snapshots may contain a valid `macd` line while `signal` and `histogram` remain `null` during their signal-line warm-up.

## Implementation

After importing completed history, calculate the default feature set for an instrument and timeframe:

```powershell
npm run analysis:calculate-indicators -- --instrument NIFTY50 --timeframe 1d
```

The command reads every completed candle in chronological order, registers the default definitions if needed, and upserts snapshots. It is safe to run again after more history has been collected.

For live data, run the calculation after candles finalize. Phase 4 deliberately keeps the live collector separate from analysis so market ingestion cannot be blocked by a computation failure.

## Code decisions

- Calculations only read `is_complete = true` candles, preventing an unfinished live candle from leaking into a signal.
- Persisted prices remain decimal strings. The calculation boundary converts them to finite JavaScript numbers only for mathematical operations; results are rounded to eight decimal places before persistence.
- ATR uses true range and Wilder smoothing. RSI uses Wilder average gains/losses, with explicit 0, 50, and 100 behavior for flat or one-sided windows.
- VWAP resets per `Asia/Kolkata` calendar session. If an index has no volume, VWAP stays unavailable instead of creating an artificial value.
- Bollinger Bands use population standard deviation for the configured window. This convention is documented and versioned.
- Supertrend stores its line, final upper/lower bands, and `UP`/`DOWN` direction, making later strategy explanations easier.

## Best practices

- Use the same definition version and parameters in backtesting, paper trading, and ML feature generation.
- Keep enough prior candles when calculating an incremental range; moving indicators require their lookback history.
- Treat adjusted and unadjusted price series as different datasets. Do not calculate one feature series across both.
- Recalculate after any deliberately versioned data correction, never by silently editing a completed candle.
- Record each strategy's exact indicator definitions in its configuration once Phase 7 begins.

## Common mistakes

- Using indicators from an incomplete candle creates look-ahead-like instability during live trading research.
- Filling warm-up values with zero makes a model think zero is a real signal.
- Mixing SMA-seeded and first-price-seeded EMAs makes results inconsistent across libraries.
- Resetting VWAP at UTC midnight rather than the local exchange session.
- Comparing indicator values from different periods without storing their parameter definitions.

## Production considerations

For a large watchlist, calculate incrementally from the earliest affected candle plus the maximum required warm-up window, then upsert only changed snapshots. Add job scheduling, failure tracking, and metrics before automating post-close backfills. Keep the pure engine covered by reference-data tests whenever a formula version changes.

## Assignment

1. Import at least 40 completed daily candles for NIFTY 50.
2. Run the indicator command twice and confirm snapshot counts do not grow on the second run.
3. Inspect SMA(20), EMA(20), and RSI(14) at the same candle; explain why their values differ.
4. Find the first MACD snapshot with a non-null signal line and verify the warm-up count.
5. Compare one calculated value against a trusted charting tool, noting its indicator settings and data-adjustment policy.
