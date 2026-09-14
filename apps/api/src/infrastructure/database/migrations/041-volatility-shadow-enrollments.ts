import type { Migration } from "../migration-runner.js";

/**
 * Stable, explicit membership for non-directional shadow competitions.
 *
 * Training a newer candidate must not reset the live evidence clock or silently
 * replace the version being evaluated. Enrollment changes are therefore rows,
 * not an implicit "latest model" query.
 */
export const volatilityShadowEnrollmentsMigration: Migration = {
  id: "041-volatility-shadow-enrollments",
  sql: `
    CREATE TABLE IF NOT EXISTS volatility_shadow_enrollments (
      label_scheme TEXT NOT NULL CHECK (length(trim(label_scheme)) > 0),
      model_key TEXT NOT NULL CHECK (length(trim(model_key)) > 0),
      model_version_id UUID NOT NULL UNIQUE REFERENCES model_versions(id) ON DELETE RESTRICT,
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (label_scheme, model_key)
    );

    CREATE INDEX IF NOT EXISTS volatility_shadow_enrollments_scheme_idx
      ON volatility_shadow_enrollments (label_scheme, enrolled_at);

    -- Seed only tabular candidates that cleared the recorded promotion baseline.
    -- Legacy TCN/stack rows are intentionally excluded: their whole-series gate
    -- did not describe the much shorter window they actually trained on.
    WITH qualified AS (
      SELECT DISTINCT ON (mv.model_key)
        mv.model_key,
        mv.id AS model_version_id,
        mv.validation_metrics -> 'validationProtocol' ->> 'labelScheme' AS label_scheme
      FROM model_versions mv
      WHERE mv.stage IN ('CANDIDATE', 'PRODUCTION')
        AND mv.validation_metrics -> 'validationProtocol' ->> 'labelScheme' = 'volatility-expansion-v1'
        AND mv.validation_metrics -> 'promotionAssessment' ->> 'decision'
          = 'INITIAL_BASELINE_THRESHOLD_MET'
      ORDER BY mv.model_key, mv.trained_at DESC, mv.version DESC
    )
    INSERT INTO volatility_shadow_enrollments (label_scheme, model_key, model_version_id)
    SELECT label_scheme, model_key, model_version_id FROM qualified
    ON CONFLICT (label_scheme, model_key) DO NOTHING;

    -- Older rows that point to an artifact path later overwritten with different
    -- bytes cannot be reproduced. Keep the audit row, but make it non-loadable.
    UPDATE model_versions older
    SET stage = 'ARCHIVED'
    FROM model_versions newer
    WHERE older.model_key = newer.model_key
      AND older.version < newer.version
      AND older.artifact_uri = newer.artifact_uri
      AND older.artifact_checksum IS DISTINCT FROM newer.artifact_checksum
      AND older.algorithm IN ('pytorch-causal-tcn-v1', 'oof-logistic-stack-v1')
      AND older.stage = 'CANDIDATE';

    COMMENT ON TABLE volatility_shadow_enrollments IS
      'Explicit immutable-version enrollment for non-directional shadow evidence; newer training does not replace an enrolled version.';
  `,
};
