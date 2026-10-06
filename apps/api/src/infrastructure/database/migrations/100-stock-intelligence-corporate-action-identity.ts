import type { Migration } from "../migration-runner.js";

/** Tombstone for discarded Stock Intelligence — see 099. */
export const stockIntelligenceCorporateActionIdentityMigration: Migration = {
  id: "100-stock-intelligence-corporate-action-identity",
  sql: `SELECT 1; -- discarded stock-intelligence feature (tombstone)`,
};
