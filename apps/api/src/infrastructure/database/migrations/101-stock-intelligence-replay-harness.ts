import type { Migration } from "../migration-runner.js";

/** Tombstone for discarded Stock Intelligence — see 099. */
export const stockIntelligenceReplayHarnessMigration: Migration = {
  id: "101-stock-intelligence-replay-harness",
  sql: `SELECT 1; -- discarded stock-intelligence feature (tombstone)`,
};
