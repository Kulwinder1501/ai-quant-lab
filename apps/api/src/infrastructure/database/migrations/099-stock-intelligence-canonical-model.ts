import type { Migration } from "../migration-runner.js";

/**
 * Tombstone: Stock Intelligence was discarded. The ID stays so the migration
 * sequence remains gapless. Environments that already applied the original SQL
 * keep their schema_migrations row and never re-run this. Fresh databases get a
 * no-op and never create the stock_intelligence schema.
 */
export const stockIntelligenceCanonicalModelMigration: Migration = {
  id: "099-stock-intelligence-canonical-model",
  sql: `SELECT 1; -- discarded stock-intelligence feature (tombstone)`,
};
