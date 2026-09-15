import type { Migration } from "../migration-runner.js";

/**
 * Adds the ITH/ITL/STH/STL "swing hierarchy" columns to `ict_structural_features` (108-110 are
 * already applied, so this widens it with a new migration rather than editing an applied one --
 * same posture as 109/110).
 *
 * `swing_protected_side` is nullable: null means the trend was NEUTRAL or the relevant Intermediate
 * Term point had not formed yet on this bar, not "no polarity" -- the same convention `ote_side`
 * already established in migration 110.
 */
export const ictSwingHierarchyMigration: Migration = {
  id: "111-ict-swing-hierarchy",
  sql: `
    ALTER TABLE ict_structural_features
      ADD COLUMN IF NOT EXISTS swing_distance_to_ith NUMERIC,
      ADD COLUMN IF NOT EXISTS swing_distance_to_itl NUMERIC,
      ADD COLUMN IF NOT EXISTS swing_distance_to_sth NUMERIC,
      ADD COLUMN IF NOT EXISTS swing_distance_to_stl NUMERIC,
      ADD COLUMN IF NOT EXISTS swing_protected_side TEXT,
      ADD COLUMN IF NOT EXISTS swing_protected_breached BOOLEAN;
  `,
};
