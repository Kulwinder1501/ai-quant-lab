import type { Migration } from "../migration-runner.js";

/**
 * Adds the cross-timeframe "Refined Order Block" columns to `ict_structural_features` (108 is
 * already applied, so this widens it with a new migration rather than editing an applied one).
 *
 * `htf_timeframe` records which higher timeframe the refinement was anchored to, since a row's
 * `timeframe` column is the LTF/execution series -- without this, a later reader could not tell
 * whether a null `refined_order_block_distance` meant "no refinement was found" or "this row was
 * never backfilled with an HTF pairing at all".
 */
export const ictRefinedOrderBlockMigration: Migration = {
  id: "109-ict-refined-order-block",
  sql: `
    ALTER TABLE ict_structural_features
      ADD COLUMN IF NOT EXISTS htf_timeframe TEXT,
      ADD COLUMN IF NOT EXISTS htf_order_block_side TEXT,
      ADD COLUMN IF NOT EXISTS htf_order_block_distance NUMERIC,
      ADD COLUMN IF NOT EXISTS refined_order_block_distance NUMERIC,
      ADD COLUMN IF NOT EXISTS stop_compression_ratio NUMERIC;
  `,
};
