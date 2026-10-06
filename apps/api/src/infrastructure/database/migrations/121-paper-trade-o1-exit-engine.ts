import type { Migration } from "../migration-runner.js";

/**
 * Adds O1 exit state machine columns to `paper_trades`:
 * - exit_engine_version: "LEGACY" | "O1" (default "LEGACY")
 * - underlying_direction: "LONG" | "SHORT"
 * - entry_underlying: real observed underlying entry price
 * - invalidation_level_at_entry: underlying structural stop level from trade idea
 * - initial_risk_distance: |entry_underlying - invalidation_level_at_entry|
 */
export const paperTradeO1ExitEngineMigration: Migration = {
  id: "121-paper-trade-o1-exit-engine",
  sql: `
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_engine_version VARCHAR(16) NOT NULL DEFAULT 'LEGACY';
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying_direction VARCHAR(8) NULL;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS entry_underlying NUMERIC(14, 4) NULL;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS invalidation_level_at_entry NUMERIC(14, 4) NULL;
    ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS initial_risk_distance NUMERIC(14, 4) NULL;

    COMMENT ON COLUMN paper_trades.exit_engine_version IS
      'Version of exit state machine running this trade. LEGACY: pre-O1 engine. O1: frozen O1 exit state machine.';
    COMMENT ON COLUMN paper_trades.underlying_direction IS
      'Underlying trade direction ("LONG" or "SHORT") captured at entry.';
    COMMENT ON COLUMN paper_trades.entry_underlying IS
      'Observed underlying fill price at entry.';
    COMMENT ON COLUMN paper_trades.invalidation_level_at_entry IS
      'Immutable underlying structural stop price captured at entry from trade idea.';
    COMMENT ON COLUMN paper_trades.initial_risk_distance IS
      'Immutable initial risk distance |entry_underlying - invalidation_level_at_entry| captured at entry.';
  `,
};
