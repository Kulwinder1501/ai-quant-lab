import type { Migration } from "../migration-runner.js";

/**
 * Week 4 feature identity. Replaying the same (instrument, as-of, version) pair
 * must not duplicate derived features or the data_quality signal.
 */
export const stockIntelligenceFeatureIdentityMigration: Migration = {
  id: "102-stock-intelligence-feature-identity",
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS stock_intelligence_features_identity_idx
      ON stock_intelligence.derived_features (instrument_id, feature_name, effective_at, feature_version);

    CREATE UNIQUE INDEX IF NOT EXISTS stock_intelligence_signals_identity_idx
      ON stock_intelligence.signals (instrument_id, signal_name, effective_at, engine_version);
  `,
};
