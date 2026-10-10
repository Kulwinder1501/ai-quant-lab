import type { Migration } from "../migration-runner.js";

export const candidateDecisionRejectionProvenanceMigration: Migration = {
  id: "128-candidate-decision-rejection-provenance",
  sql: `
    ALTER TABLE candidate_decisions 
    ADD COLUMN IF NOT EXISTS rejection_provenance JSONB;
  `,
};
