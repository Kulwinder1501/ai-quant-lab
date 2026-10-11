import type { Migration } from "../migration-runner.js";

/**
 * Replaces Twelve Data with OANDA as the supported non-Indian exchange and data source.
 * 
 * 1. Updates `instruments` to replace TWELVEDATA with OANDA.
 * 2. Re-creates the `instruments_exchange_check` constraint.
 * 3. Updates `candle_series_provenance` to migrate `twelvedata` declarations to `oanda`.
 * 4. Updates existing `candles` rows from `twelvedata` to `oanda`.
 */
export const oandaInstrumentSupportMigration: Migration = {
  id: "127-oanda-instrument-support",
  sql: `
    -- 1. Drop the constraint first so we can update the rows
    ALTER TABLE instruments DROP CONSTRAINT instruments_exchange_check;

    -- 2. Update existing data in instruments
    UPDATE instruments 
    SET exchange = 'OANDA' 
    WHERE exchange = 'TWELVEDATA';

    -- 3. Re-add the constraint with OANDA instead of TWELVEDATA
    ALTER TABLE instruments ADD CONSTRAINT instruments_exchange_check
      CHECK (exchange IN ('NSE', 'NFO', 'BSE', 'OANDA'));

    -- 4. Drop the candles foreign key temporarily
    ALTER TABLE candles DROP CONSTRAINT IF EXISTS candles_series_provenance_fkey;

    -- 5. Update candle provenance to point to OANDA
    UPDATE candle_series_provenance
    SET source = 'oanda'
    WHERE source = 'twelvedata';

    -- 6. Update existing historical candles
    UPDATE candles
    SET source = 'oanda'
    WHERE source = 'twelvedata';

    -- 7. Re-add the foreign key
    ALTER TABLE candles ADD CONSTRAINT candles_series_provenance_fkey
      FOREIGN KEY (instrument_id, timeframe, source)
      REFERENCES candle_series_provenance(instrument_id, timeframe, source);
  `,
};
