import type { DatabasePool } from "../../../infrastructure/database/database.js";

/**
 * Seed static definitions only.
 *
 * Price bars deliberately do not belong in application bootstrapping. Scheduled Fyers
 * collection owns exchange candles, so restarting the API cannot introduce a second
 * provider or write an in-progress bar into a training series.
 */
export async function seedMarketData(database: DatabasePool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");

    /*
     * No strategy or strategy_version is seeded here, deliberately.
     *
     * This block used to insert `trend-breakout` version **1** with `is_active = TRUE` and
     * `ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE` -- so every API startup
     * reasserted an obsolete version as active. The code declares version 2, which is why the
     * database carried two active versions for that strategy, and why adding a unique index on the
     * active row crash-looped the API on 2026-09-03: the seed's upsert violated it before the
     * process could serve anything.
     *
     * `StrategyVersionRepository.ensure` already creates the strategy and the version the code
     * declares, on every generation pass, and refuses to proceed if a stored configuration has
     * drifted from the code's. A seed cannot improve on that and could only contradict it -- the
     * configuration this one pinned (`lookback`, `stopLossPct`, `targetPct`) bears no resemblance to
     * `defaultTrendBreakoutStrategyConfiguration` as it stands today.
     *
     * The version id it produced was used for nothing but its own existence check.
     */


    await client.query(`
      INSERT INTO indicator_definitions
        (indicator_code, algorithm_version, parameters, parameters_hash, output_schema)
      VALUES
        ('SMA', 'v1', '{"period": 20}'::jsonb, 'sma_20', '{}'::jsonb),
        ('BOLLINGER_BANDS', 'v1', '{"period": 20, "stdDev": 2}'::jsonb, 'bb_20_2', '{}'::jsonb),
        ('RSI', 'v1', '{"period": 14}'::jsonb, 'rsi_14', '{}'::jsonb)
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO pattern_definitions (pattern_code, category, algorithm_version, description)
      VALUES
        ('BULLISH_ENGULFING', 'CANDLESTICK', 'v1', 'Bullish Engulfing reversal pattern'),
        ('BEARISH_ENGULFING', 'CANDLESTICK', 'v1', 'Bearish Engulfing reversal pattern'),
        ('DOJI', 'CANDLESTICK', 'v1', 'Doji indecision pattern')
      ON CONFLICT DO NOTHING
    `);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
