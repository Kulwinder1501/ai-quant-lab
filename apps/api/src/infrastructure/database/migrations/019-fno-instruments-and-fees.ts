import type { Migration } from "../migration-runner.js";

/**
 * F&O instrument metadata + paper-trade fee breakdown storage.
 *
 * Lot sizes are the official NSE figures as of Jul 2025 (NIFTY 75, BANKNIFTY 15).
 * Update the row when NSE revises them — no code change required.
 */
export const fnoInstrumentsAndFeesMigration: Migration = {
  id: "019-fno-instruments-and-fees",
  sql: `
    ALTER TABLE instruments
      DROP CONSTRAINT IF EXISTS instruments_instrument_type_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_instrument_type_check
      CHECK (instrument_type IN ('INDEX', 'EQUITY', 'ETF', 'OPTION', 'FUTURE'));

    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS underlying_symbol TEXT;
    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS strike_price NUMERIC(20, 2);
    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS expiry_date DATE;
    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS option_type TEXT;

    ALTER TABLE instruments DROP CONSTRAINT IF EXISTS instruments_option_type_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_option_type_check
      CHECK (option_type IS NULL OR option_type IN ('CE', 'PE'));

    ALTER TABLE instruments DROP CONSTRAINT IF EXISTS instruments_option_fields_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_option_fields_check
      CHECK (
        (instrument_type <> 'OPTION')
        OR (
          underlying_symbol IS NOT NULL
          AND strike_price IS NOT NULL
          AND expiry_date IS NOT NULL
          AND option_type IS NOT NULL
        )
      );

    UPDATE instruments SET lot_size = 75 WHERE symbol = 'NIFTY50';
    UPDATE instruments SET lot_size = 15 WHERE symbol = 'BANKNIFTY';

    ALTER TABLE paper_trades
      ADD COLUMN IF NOT EXISTS fee_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;
  `,
};
