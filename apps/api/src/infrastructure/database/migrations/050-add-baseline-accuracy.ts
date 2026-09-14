import type { Migration } from "../migration-runner.js";

export const addBaselineAccuracyMigration: Migration = {
  id: "050-add-baseline-accuracy",
  sql: `
    ALTER TABLE model_daily_scores
    ADD COLUMN baseline_accuracy numeric(8,6) CHECK (baseline_accuracy IS NULL OR (baseline_accuracy >= 0 AND baseline_accuracy <= 1));
  `,
};
