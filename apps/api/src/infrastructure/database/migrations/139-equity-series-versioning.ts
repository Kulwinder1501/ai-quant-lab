import type { Migration } from "../migration-runner.js";

// Add series versioning and rebackfill state tracking for equity research (Gate S4).
//
// Hard rule: every table and column lives inside the equity_research schema,
// with NO foreign key to or from any other schema.
export const equitySeriesVersioningMigration: Migration = {
  id: "139-equity-series-versioning",
  sql: `
    -- Add rebackfill tracking and series versioning to watchlist stocks
    ALTER TABLE equity_research.watchlist_stock
      ADD COLUMN IF NOT EXISTS rebackfill_needed BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS series_version INTEGER NOT NULL DEFAULT 1;

    -- Add series version to price bars
    ALTER TABLE equity_research.price_bar
      ADD COLUMN IF NOT EXISTS series_version INTEGER NOT NULL DEFAULT 1;

    -- Index for quickly querying stocks requiring rebackfill
    CREATE INDEX IF NOT EXISTS watchlist_stock_rebackfill_idx
      ON equity_research.watchlist_stock (rebackfill_needed)
      WHERE rebackfill_needed = TRUE;
  `,
};
