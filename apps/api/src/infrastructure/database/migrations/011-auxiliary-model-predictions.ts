import type { Migration } from "../migration-runner.js";

// Predictions from models whose target is *not* a trade direction.
//
// `model_predictions` is directional by construction: its
// `CHECK (prediction IN ('BULLISH','BEARISH','NEUTRAL'))` is relied on by the
// strategy engine, the autonomous agent, the market scanner, and the predictions
// dashboard, all of which read a row there as a statement about which way price
// is going. A volatility-expansion model answers a different question
// (CONTRACTION/STABLE/EXPANSION), and writing that into the same column would be
// read downstream as a signal to go long or short.
//
// A separate table is deliberately chosen over relaxing that CHECK and filtering
// every directional read. Filtering depends on remembering to add a predicate at
// six-plus call sites; a separate table makes the mistake structurally impossible
// and leaves the existing directional path completely untouched.
//
// `model_versions` is shared: its `model_key` already encodes the label scheme, so
// a non-directional model cannot collide with a directional one's promotion
// lineage.
export const auxiliaryModelPredictionsMigration: Migration = {
  id: "011-auxiliary-model-predictions",
  sql: `
    CREATE TABLE IF NOT EXISTS auxiliary_model_predictions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      model_version_id UUID NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      source_candle_id UUID REFERENCES candles(id) ON DELETE SET NULL,
      -- Which target this row belongs to, e.g. 'volatility-expansion-v1'. Stored
      -- rather than inferred so a reader never has to parse the model key.
      label_scheme TEXT NOT NULL CHECK (length(trim(label_scheme)) > 0),
      -- Intentionally NOT constrained to a fixed value list. This table serves
      -- every non-directional scheme, so a value CHECK would need a migration per
      -- scheme; the label alphabet is enforced at the repository boundary, where
      -- the scheme's LabelAlphabet is actually known. The non-blank check is the
      -- part the database can meaningfully guarantee.
      prediction TEXT NOT NULL CHECK (length(trim(prediction)) > 0),
      confidence NUMERIC(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      feature_contributions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(feature_contributions) = 'array'),
      explanation JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(explanation) = 'array'),
      -- The as-of boundary the prediction was made under, mirroring the directional
      -- table so the same replay discipline applies.
      evidence_cutoff_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- One prediction per model per source candle, so re-running inference is
    -- idempotent instead of accumulating duplicates. Mirrors
    -- model_predictions_model_candle_identity_idx.
    CREATE UNIQUE INDEX IF NOT EXISTS auxiliary_model_predictions_identity_idx
    ON auxiliary_model_predictions (model_version_id, source_candle_id)
    WHERE source_candle_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS auxiliary_model_predictions_lookup_idx
    ON auxiliary_model_predictions (instrument_id, label_scheme, created_at DESC);

    CREATE INDEX IF NOT EXISTS auxiliary_model_predictions_model_idx
    ON auxiliary_model_predictions (model_version_id, created_at DESC);
  `,
};
