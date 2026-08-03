import type { Migration } from "../migration-runner.js";

/**
 * Gives non-directional predictions somewhere to record their realised outcome.
 *
 * `auxiliary_model_predictions` was created as write-only: it stored what a
 * volatility model predicted and had no column for what actually happened. That was
 * consistent while such a model was a curiosity, but it is now the only target
 * measured to beat the trivial predictor on both macro-F1 and accuracy across every
 * CPCV split, and the only configuration to clear the promotion gate's initial
 * baseline. Without settlement it can never satisfy "shadow before primary", so the
 * architecture guaranteed that the one thing that works could never be used.
 *
 * Deliberately mirrors the directional settlement columns rather than inventing a
 * second vocabulary, but keeps the two tables separate for the reason migration 011
 * gives: filtering a shared table depends on remembering a predicate at every call
 * site, and a separate table makes the mistake impossible.
 *
 * `realized_ratio` is stored alongside the label because the label is a
 * *thresholded* view of it. Keeping the underlying ratio means a band change can be
 * re-scored from history instead of silently invalidating every settled row, and it
 * lets a near-boundary call be distinguished from a decisive one.
 */
export const auxiliaryPredictionSettlementMigration: Migration = {
  id: "031-auxiliary-prediction-settlement",
  sql: `
    ALTER TABLE auxiliary_model_predictions
      -- Same alphabet as the prediction column, so it is likewise not value-checked
      -- here: this table serves every non-directional scheme and the alphabet is
      -- enforced at the repository boundary where the scheme is known.
      ADD COLUMN IF NOT EXISTS realized_label TEXT
        CHECK (realized_label IS NULL OR length(trim(realized_label)) > 0),
      -- forward_range / trailing_range. The label is this value thresholded against
      -- the model's own expansionBand, so storing it keeps settled rows re-scorable.
      ADD COLUMN IF NOT EXISTS realized_ratio NUMERIC(18, 8),
      ADD COLUMN IF NOT EXISTS realized_forward_range NUMERIC(20, 8),
      ADD COLUMN IF NOT EXISTS realized_trailing_range NUMERIC(20, 8),
      -- When the outcome became knowable: the close of the last bar in the forward
      -- window. Distinct from settled_at, which is when this row was written.
      ADD COLUMN IF NOT EXISTS label_available_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
      -- Why a matured prediction could not be graded. The volatility rule is
      -- undefined for a flat trailing window and is right-censored when the forward
      -- window is incomplete; both must stay visible rather than being recorded as a
      -- STABLE outcome, which would manufacture agreement.
      ADD COLUMN IF NOT EXISTS unsettleable_reason TEXT;

    COMMENT ON COLUMN auxiliary_model_predictions.realized_ratio IS
      'forward_range / trailing_range. The realised label is this thresholded against the model''s expansionBand.';
    COMMENT ON COLUMN auxiliary_model_predictions.unsettleable_reason IS
      'Set when a matured prediction cannot be graded. Never substituted with a neutral outcome.';

    -- A settlement sweep looks for matured-but-ungraded rows, which is a small tail
    -- of a growing table.
    CREATE INDEX IF NOT EXISTS auxiliary_model_predictions_unsettled_idx
    ON auxiliary_model_predictions (label_scheme, evidence_cutoff_at)
    WHERE settled_at IS NULL AND unsettleable_reason IS NULL;

    -- Scoreboard reads: settled rows for one model, newest first.
    CREATE INDEX IF NOT EXISTS auxiliary_model_predictions_settled_idx
    ON auxiliary_model_predictions (model_version_id, settled_at DESC)
    WHERE settled_at IS NOT NULL;
  `,
};
