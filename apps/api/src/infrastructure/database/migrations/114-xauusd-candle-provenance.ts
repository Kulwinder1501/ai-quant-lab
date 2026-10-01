import type { Migration } from "../migration-runner.js";

/**
 * Declares Twelve Data as the permitted source for XAU_USD's candle series, across every
 * timeframe `TwelveDataHistoricalDataProvider` actually serves.
 *
 * `candle_series_provenance` (migration 043) has no auto-declare path for a brand-new
 * (instrument, timeframe) pair -- it only retroactively declared ownership for series that
 * already had rows at the time it ran. The very first backfill attempt for XAU_USD failed on
 * `candles_series_provenance_fkey`: there is no parent row for a series with zero rows yet.
 * Every existing declaration in this codebase is a migration, not an ad-hoc INSERT, so this
 * follows that same pattern rather than being a one-off psql command with no audit trail.
 *
 * Written as a `SELECT ... FROM instruments WHERE symbol = 'XAU_USD'` rather than a literal
 * instrument_id: this only takes effect once the instrument is registered (via
 * `register-instrument.ts --exchange TWELVEDATA --symbol XAU_USD`), which in practice already
 * happened before this migration was written. If it ever ran before registration it would be a
 * silent no-op, which is why this migration exists close to registration in the same session
 * rather than being written speculatively far ahead of it.
 */
export const xauUsdCandleProvenanceMigration: Migration = {
  id: "114-xauusd-candle-provenance",
  sql: `
    INSERT INTO candle_series_provenance (instrument_id, timeframe, source)
    SELECT i.id, tf.timeframe, 'twelvedata'
    FROM instruments i
    CROSS JOIN (VALUES ('1m'), ('5m'), ('15m'), ('30m'), ('60m'), ('1d')) AS tf(timeframe)
    WHERE i.exchange = 'TWELVEDATA' AND i.symbol = 'XAU_USD'
    ON CONFLICT (instrument_id, timeframe) DO NOTHING;
  `,
};
