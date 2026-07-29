import type { Migration } from "../migration-runner.js";

export const addRegimeEvidenceMigration: Migration = {
  id: "006-add-regime-evidence",
  sql: `
    ALTER TABLE trade_idea_evidence 
    DROP CONSTRAINT IF EXISTS trade_idea_evidence_source_type_check;

    ALTER TABLE trade_idea_evidence 
    ADD CONSTRAINT trade_idea_evidence_source_type_check 
    CHECK (source_type IN ('INDICATOR', 'PATTERN', 'PRICE_ACTION', 'MODEL', 'STRATEGY', 'REGIME'));
  `,
};
