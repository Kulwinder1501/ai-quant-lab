import type { Migration } from "../migration-runner.js";

/** Tombstone for discarded Stock Intelligence — see 099. */
export const stockIntelligenceFeatureIdentityMigration: Migration = {
  id: "102-stock-intelligence-feature-identity",
  sql: `SELECT 1; -- discarded stock-intelligence feature (tombstone)`,
};
