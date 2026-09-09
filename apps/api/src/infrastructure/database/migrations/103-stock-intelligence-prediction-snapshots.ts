import type { Migration } from "../migration-runner.js";

/** Tombstone for discarded Stock Intelligence — see 099. */
export const stockIntelligenceSnapshotMigration: Migration = {
  id: "103-stock-intelligence-prediction-snapshots",
  sql: `SELECT 1; -- discarded stock-intelligence feature (tombstone)`,
};
