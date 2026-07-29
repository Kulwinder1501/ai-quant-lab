import type { Migration } from "../migration-runner.js";

/**
 * A Phase 11 prediction is a reproducible research observation for exactly one
 * production model and one completed source candle. The as-of cutoff is stored
 * explicitly because created_at alone cannot describe what evidence was
 * available to the inference workflow.
 */
export const modelPredictionIdentityMigration: Migration = {
  id: "003-model-prediction-identity",
  sql: `
    ALTER TABLE model_predictions
      ADD COLUMN IF NOT EXISTS evidence_cutoff_at TIMESTAMPTZ;

    UPDATE model_predictions
    SET evidence_cutoff_at = created_at
    WHERE evidence_cutoff_at IS NULL;

    ALTER TABLE model_predictions
      ALTER COLUMN evidence_cutoff_at SET NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS model_predictions_model_candle_identity_idx
    ON model_predictions (model_version_id, source_candle_id)
    WHERE source_candle_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS model_predictions_as_of_idx
    ON model_predictions (instrument_id, evidence_cutoff_at DESC);
  `,
};
