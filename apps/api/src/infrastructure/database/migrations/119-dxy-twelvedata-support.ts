import type { Migration } from "../migration-runner.js";

/**
 * Registers the US Dollar Index (DXY) instrument under TWELVEDATA exchange and declares
 * Twelve Data as its candle series provenance across standard timeframes (1m, 5m, 15m, 30m, 60m, 1d).
 */
export const dxyTwelveDataSupportMigration: Migration = {
  id: "119-dxy-twelvedata-support",
  sql: `
    INSERT INTO instruments (exchange, symbol, name, currency, tick_size, lot_size)
    VALUES ('TWELVEDATA', 'DXY', 'US Dollar Index', 'USD', 0.001, 1)
    ON CONFLICT (exchange, symbol) DO NOTHING;

    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT i.id, tf.timeframe, 'twelvedata'
    FROM instruments i
    CROSS JOIN (VALUES ('1m'), ('5m'), ('15m'), ('30m'), ('60m'), ('1d')) AS tf(timeframe)
    WHERE i.exchange = 'TWELVEDATA' AND i.symbol = 'DXY'
    ON CONFLICT (instrument_id, timeframe) DO NOTHING;
  `,
};
