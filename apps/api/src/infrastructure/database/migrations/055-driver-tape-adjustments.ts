import type { Migration } from "../migration-runner.js";

/**
 * Audit log for soft driver-tape confidence adjustments on the autonomous agent.
 *
 * Metrics are approximate (hand weights × Yahoo day%). Rows exist so the filter
 * can be measured against outcomes before it is ever hardened into a hard gate.
 */
export const driverTapeAdjustmentsMigration: Migration = {
  id: "055-driver-tape-adjustments",
  sql: `
    CREATE TABLE IF NOT EXISTS driver_tape_adjustments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      underlying_symbol TEXT NOT NULL CHECK (length(trim(underlying_symbol)) > 0),
      thesis_side TEXT NOT NULL CHECK (thesis_side IN ('LONG', 'SHORT')),
      adjustment INTEGER NOT NULL,
      reasoning TEXT NOT NULL,
      advance_share NUMERIC(8, 6),
      decline_share NUMERIC(8, 6),
      concentration NUMERIC(8, 6),
      coverage NUMERIC(8, 6),
      quoted_count INTEGER,
      roster_count INTEGER,
      est_net_pts NUMERIC(20, 6),
      pre_adjustment_confidence INTEGER,
      resulting_confidence INTEGER,
      resulting_side TEXT CHECK (resulting_side IS NULL OR resulting_side IN ('LONG', 'SHORT')),
      thought_id TEXT,
      source_candle_id UUID REFERENCES candles(id) ON DELETE SET NULL,
      trade_idea_id UUID REFERENCES trade_ideas(id) ON DELETE SET NULL,
      paper_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS driver_tape_adjustments_symbol_time_idx
    ON driver_tape_adjustments (underlying_symbol, observed_at DESC);

    CREATE INDEX IF NOT EXISTS driver_tape_adjustments_trade_idx
    ON driver_tape_adjustments (paper_trade_id) WHERE paper_trade_id IS NOT NULL;

    COMMENT ON TABLE driver_tape_adjustments IS
      'Soft driver-tape confidence adjustments for measurement. Approximate weights; not ML features.';
  `,
};
