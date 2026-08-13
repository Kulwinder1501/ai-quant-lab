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

    const strategy = await client.query<{ id: string }>(`
      INSERT INTO strategies (strategy_key, name, description, is_archived)
      VALUES ('trend-breakout', 'Trend Breakout Strategy', 'Momentum breakout trading strategy', FALSE)
      ON CONFLICT (strategy_key) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `);
    const strategyId = strategy.rows[0]?.id;
    if (!strategyId) throw new Error("Failed to insert/resolve strategy");

    const version = await client.query<{ id: string }>(`
      INSERT INTO strategy_versions (strategy_id, version, configuration, is_active)
      VALUES ($1, 1, '{"lookback": 20, "stopLossPct": 1.5, "targetPct": 3.0}'::jsonb, TRUE)
      ON CONFLICT (strategy_id, version) DO UPDATE SET is_active = TRUE
      RETURNING id
    `, [strategyId]);
    if (!version.rows[0]?.id) throw new Error("Failed to insert/resolve strategy version");

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
