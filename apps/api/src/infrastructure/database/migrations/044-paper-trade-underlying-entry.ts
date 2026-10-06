import type { Migration } from "../migration-runner.js";

// Adds underlying_entry_price to paper_trades to track the underlying asset's price
// at the exact moment the option trade was entered. This is required for "Trap Detection"
// logic, which compares the live underlying price against the entry spot to determine
// if the asset moved favorably but the option premium failed to appreciate.
export const paperTradeUnderlyingEntryMigration: Migration = {
  id: "044-paper-trade-underlying-entry",
  sql: `
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying_entry_price NUMERIC(20, 4);

    -- Update the exit reason constraint to allow TRAP_DETECTED
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_exit_reason_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_exit_reason_check
      CHECK (exit_reason IN ('STOP_LOSS', 'TARGET', 'MANUAL', 'CANCELLED', 'EXPIRED', 'TRAP_DETECTED'));
  `,
};
