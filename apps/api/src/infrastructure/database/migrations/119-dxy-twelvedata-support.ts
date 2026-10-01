import type { Migration } from "../migration-runner.js";

/**
 * Registers the US Dollar Index (DXY) instrument under TWELVEDATA exchange and declares
 * Twelve Data as its candle series provenance across standard timeframes (1m, 5m, 15m, 30m, 60m, 1d).
 *
 * The `instruments` table has no `name` column -- it's `display_name` -- and
 * `instrument_type` is NOT NULL with no default (CHECK'd to one of
 * 'INDEX' | 'EQUITY' | 'ETF' | 'OPTION' | 'FUTURE', widened for non-NSE assets by migration 113).
 * DXY is registered as `'INDEX'`, matching its nature as an index of currency exchange rates.
 */
export const dxyTwelveDataSupportMigration: Migration = {
  id: "119-dxy-twelvedata-support",
  sql: `
    INSERT INTO instruments (exchange, symbol, display_name, instrument_type, currency, tick_size, lot_size)
    VALUES ('TWELVEDATA', 'DXY', 'US Dollar Index', 'INDEX', 'USD', 0.001, 1)
    ON CONFLICT (exchange, symbol) DO NOTHING;

    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT i.id, tf.timeframe, 'twelvedata'
    FROM instruments i
    CROSS JOIN (VALUES ('1m'), ('5m'), ('15m'), ('30m'), ('60m'), ('1d')) AS tf(timeframe)
    WHERE i.exchange = 'TWELVEDATA' AND i.symbol = 'DXY'
    ON CONFLICT (instrument_id, timeframe) DO NOTHING;
  `,
};
