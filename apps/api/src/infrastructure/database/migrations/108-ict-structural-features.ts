import type { Migration } from "../migration-runner.js";

/**
 * Per-bar ICT structural covariates for the ML training pipeline (`ml-feature-v-ict`).
 *
 * `ict_state_snapshots` already stores the full composite engine state, but only as an opaque
 * `snapshot_payload` JSONB blob -- reading a derived feature (e.g. distance to the nearest order
 * block) out of it would mean re-implementing `extractIctStructuralFeatures` a second time in
 * Python, which is exactly the kind of dual-implementation drift this codebase avoids elsewhere.
 * This table instead stores the ALREADY-EXTRACTED, flat feature record, computed once in TypeScript
 * (the single source of truth) and read as plain columns by `postgres_repository.py`.
 *
 * Keyed by `candle_id` rather than `(instrument_id, timeframe, bar_time)`: the Python loader already
 * batches every other evidence table (indicators, patterns, price-action, institutional flow) by the
 * candle id set for one query, so this follows the same join key rather than introducing a
 * timestamp-matching path none of the other loaders use.
 */
export const ictStructuralFeaturesMigration: Migration = {
  id: "108-ict-structural-features",
  sql: `
    CREATE TABLE IF NOT EXISTS ict_structural_features (
      candle_id UUID PRIMARY KEY REFERENCES candles(id) ON DELETE CASCADE,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
      timeframe TEXT NOT NULL,
      bar_time TIMESTAMPTZ NOT NULL,
      engine_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      htf_bias TEXT,
      premium_discount_zone TEXT NOT NULL,
      distance_to_nearest_order_block NUMERIC,
      nearest_order_block_side TEXT,
      has_bos_level BOOLEAN NOT NULL,
      has_choch_level BOOLEAN NOT NULL,
      distance_to_bos_level NUMERIC,
      distance_to_choch_level NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS ict_structural_features_lookup_idx
      ON ict_structural_features (instrument_id, timeframe, bar_time DESC);
  `,
};
