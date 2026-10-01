import type { Migration } from "../migration-runner.js";

/**
 * Adds the "Optimal Trade Entry" (OTE) columns to `ict_structural_features` (108/109 are already
 * applied, so this widens it with a new migration rather than editing an applied one -- same
 * posture as 109).
 *
 * `ote_side` is nullable rather than reusing `nearest_order_block_side`'s convention implicitly:
 * a null row here means "no dealing range/trend to draw a band from at all" (see `ote.ts`), not
 * "the band exists but has no polarity" -- OTE always has a side once it exists.
 */
export const ictOteMigration: Migration = {
  id: "110-ict-ote",
  sql: `
    ALTER TABLE ict_structural_features
      ADD COLUMN IF NOT EXISTS ote_side TEXT,
      ADD COLUMN IF NOT EXISTS ote_is_within BOOLEAN,
      ADD COLUMN IF NOT EXISTS ote_band_low NUMERIC,
      ADD COLUMN IF NOT EXISTS ote_band_high NUMERIC,
      ADD COLUMN IF NOT EXISTS ote_distance_to_band NUMERIC;
  `,
};
