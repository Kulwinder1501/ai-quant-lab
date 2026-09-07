import type { Migration } from "../migration-runner.js";

/** Adds exact decision and outcome joins to early driver-tape audit rows. */
export const driverTapeOutcomeLinksMigration: Migration = {
  id: "058-driver-tape-outcome-links",
  sql: `
    ALTER TABLE driver_tape_adjustments ADD COLUMN IF NOT EXISTS pre_adjustment_confidence INTEGER;
    ALTER TABLE driver_tape_adjustments ADD COLUMN IF NOT EXISTS source_candle_id UUID REFERENCES candles(id) ON DELETE SET NULL;
    ALTER TABLE driver_tape_adjustments ADD COLUMN IF NOT EXISTS trade_idea_id UUID REFERENCES trade_ideas(id) ON DELETE SET NULL;
    ALTER TABLE driver_tape_adjustments ADD COLUMN IF NOT EXISTS paper_trade_id UUID REFERENCES paper_trades(id) ON DELETE SET NULL;

    CREATE INDEX IF NOT EXISTS driver_tape_adjustments_trade_idx
    ON driver_tape_adjustments (paper_trade_id) WHERE paper_trade_id IS NOT NULL;
  `,
};
