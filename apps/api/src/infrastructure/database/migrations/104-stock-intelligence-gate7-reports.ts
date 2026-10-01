import type { Migration } from "../migration-runner.js";

/** Tombstone for discarded Stock Intelligence — see 099. */
export const stockIntelligenceGate7ReportMigration: Migration = {
  id: "104-stock-intelligence-gate7-reports",
  sql: `SELECT 1; -- discarded stock-intelligence feature (tombstone)`,
};
