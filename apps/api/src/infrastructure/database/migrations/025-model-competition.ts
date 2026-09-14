import type { Migration } from "../migration-runner.js";

/**
 * Daily model competition (champion–challenger).
 *
 * Predictions gain settlement columns so live outcomes become a durable,
 * scorable record instead of an ephemeral explanation-time query. Daily
 * per-model aggregates land in `model_daily_scores`, and `model_competition_state`
 * assigns competition roles: the PRIMARY model (the sole PRODUCTION version per
 * key) drives trade direction, while SECONDARY/COMPETITOR pool members are
 * CANDIDATEs that shadow-predict to build a live track record.
 *
 * `model_promotions.model_version_id` loses its UNIQUE constraint: a demoted
 * champion stays in the pool and may win the title back, which is a second
 * promotion of the same version.
 */
export const modelCompetitionMigration: Migration = {
  id: "025-model-competition",
  sql: `
    ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;
    ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS realized_label TEXT;
    ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS realized_return_bps NUMERIC(14, 4);
    ALTER TABLE model_predictions ADD COLUMN IF NOT EXISTS was_correct BOOLEAN;

    ALTER TABLE model_predictions DROP CONSTRAINT IF EXISTS model_predictions_realized_label_check;
    ALTER TABLE model_predictions
      ADD CONSTRAINT model_predictions_realized_label_check
      CHECK (realized_label IS NULL OR realized_label IN ('BULLISH', 'BEARISH', 'NEUTRAL'));

    -- A settled prediction always carries its outcome; an unsettled one never does.
    ALTER TABLE model_predictions DROP CONSTRAINT IF EXISTS model_predictions_settlement_check;
    ALTER TABLE model_predictions
      ADD CONSTRAINT model_predictions_settlement_check
      CHECK (
        (settled_at IS NULL AND realized_label IS NULL AND realized_return_bps IS NULL AND was_correct IS NULL)
        OR (settled_at IS NOT NULL AND realized_label IS NOT NULL AND realized_return_bps IS NOT NULL AND was_correct IS NOT NULL)
      );

    CREATE INDEX IF NOT EXISTS model_predictions_unsettled_idx
      ON model_predictions (model_version_id, created_at)
      WHERE settled_at IS NULL;

    CREATE TABLE IF NOT EXISTS model_daily_scores (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_version_id UUID NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
      score_date DATE NOT NULL,
      predictions_settled INTEGER NOT NULL CHECK (predictions_settled >= 0),
      predictions_correct INTEGER NOT NULL CHECK (predictions_correct >= 0 AND predictions_correct <= predictions_settled),
      accuracy NUMERIC(8, 6) CHECK (accuracy IS NULL OR (accuracy >= 0 AND accuracy <= 1)),
      macro_f1 NUMERIC(8, 6) CHECK (macro_f1 IS NULL OR (macro_f1 >= 0 AND macro_f1 <= 1)),
      directional_hit_rate NUMERIC(8, 6) CHECK (directional_hit_rate IS NULL OR (directional_hit_rate >= 0 AND directional_hit_rate <= 1)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (model_version_id, score_date)
    );

    DROP TRIGGER IF EXISTS model_daily_scores_touch_updated_at ON model_daily_scores;
    CREATE TRIGGER model_daily_scores_touch_updated_at
    BEFORE UPDATE ON model_daily_scores
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    CREATE TABLE IF NOT EXISTS model_competition_state (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_version_id UUID NOT NULL UNIQUE REFERENCES model_versions(id) ON DELETE CASCADE,
      competition_group TEXT NOT NULL CHECK (length(trim(competition_group)) > 0),
      role TEXT NOT NULL CHECK (role IN ('PRIMARY', 'SECONDARY', 'COMPETITOR')),
      enrolled_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_rolling_macro_f1 NUMERIC(8, 6),
      last_evaluated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_primary_per_competition_group_idx
      ON model_competition_state (competition_group) WHERE role = 'PRIMARY';
    CREATE UNIQUE INDEX IF NOT EXISTS one_secondary_per_competition_group_idx
      ON model_competition_state (competition_group) WHERE role = 'SECONDARY';
    CREATE INDEX IF NOT EXISTS model_competition_state_group_idx
      ON model_competition_state (competition_group, role);

    DROP TRIGGER IF EXISTS model_competition_state_touch_updated_at ON model_competition_state;
    CREATE TRIGGER model_competition_state_touch_updated_at
    BEFORE UPDATE ON model_competition_state
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

    ALTER TABLE model_promotions DROP CONSTRAINT IF EXISTS model_promotions_model_version_id_key;
    CREATE INDEX IF NOT EXISTS model_promotions_model_version_idx
      ON model_promotions (model_version_id, promoted_at DESC);
  `,
};
