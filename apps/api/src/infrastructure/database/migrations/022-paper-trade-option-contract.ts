import type { Migration } from "../migration-runner.js";

/**
 * Persists option-buyer contract fields on paper trades so evaluation can
 * reprice the live premium (theta / IV) instead of treating entry-time
 * premium SL/TP as a static index-like barrier.
 *
 * Also adds EXPIRED exit/event types for force-close at option expiry, and
 * seeds weekly expiry weekdays for the core index underlyings.
 */
export const paperTradeOptionContractMigration: Migration = {
  id: "022-paper-trade-option-contract",
  sql: `
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS option_strike NUMERIC(20, 2);
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS option_expiry TIMESTAMPTZ;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS option_type TEXT;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying_symbol TEXT;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS entry_iv NUMERIC(12, 8);

    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_option_type_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_option_type_check
      CHECK (option_type IS NULL OR option_type IN ('CE', 'PE'));

    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_option_contract_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_option_contract_check
      CHECK (
        (
          option_strike IS NULL
          AND option_expiry IS NULL
          AND option_type IS NULL
          AND underlying_symbol IS NULL
        )
        OR (
          option_strike IS NOT NULL
          AND option_expiry IS NOT NULL
          AND option_type IS NOT NULL
          AND underlying_symbol IS NOT NULL
        )
      );

    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_exit_reason_check
      CHECK (exit_reason IS NULL OR exit_reason IN ('STOP_LOSS', 'TARGET', 'MANUAL', 'CANCELLED', 'EXPIRED'));

    ALTER TABLE paper_trade_events DROP CONSTRAINT IF EXISTS paper_trade_events_event_type_check;
    ALTER TABLE paper_trade_events
      ADD CONSTRAINT paper_trade_events_event_type_check
      CHECK (event_type IN (
        'PENDING_PLACED', 'OPENED', 'STOP_LOSS_HIT', 'TARGET_HIT',
        'MANUALLY_CLOSED', 'CANCELLED', 'EXPIRED'
      ));

    UPDATE instruments SET weekly_expiry_weekday = 4 WHERE symbol = 'NIFTY50';
    UPDATE instruments SET weekly_expiry_weekday = 3 WHERE symbol = 'BANKNIFTY';
  `,
};
