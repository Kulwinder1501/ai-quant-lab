import type { Migration } from "../migration-runner.js";

/**
 * Identity for corporate-action ingest. Two Yahoo events on the same ex-date for
 * the same type are the same row; a restatement is a new row only when the ex-date
 * or type differs. Append-only UPDATE/DELETE triggers are unchanged: ON CONFLICT
 * DO NOTHING is an insert that does not fire them.
 */
export const stockIntelligenceCorporateActionIdentityMigration: Migration = {
  id: "100-stock-intelligence-corporate-action-identity",
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS stock_intelligence_corporate_actions_identity_idx
      ON stock_intelligence.corporate_actions (instrument_id, action_type, ex_date);
  `,
};
