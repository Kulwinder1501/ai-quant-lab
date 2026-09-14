import type { Migration } from "../migration-runner.js";

/**
 * Gate 6 immutable prediction snapshots and decay marks. Holdings/watchlist
 * overlays are user context, not the scanner registry, and stay mutable.
 */
export const stockIntelligenceSnapshotMigration: Migration = {
  id: "103-stock-intelligence-prediction-snapshots",
  sql: `
    CREATE TABLE stock_intelligence.prediction_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      prediction_as_of TIMESTAMPTZ NOT NULL,
      data_cutoff TIMESTAMPTZ NOT NULL,
      horizon TEXT NOT NULL CHECK (horizon IN ('6M', '12M')),
      status TEXT NOT NULL CHECK (status IN (
        'VALID', 'INSUFFICIENT_DATA', 'INSUFFICIENT_ANALOGUES', 'OUT_OF_REGIME',
        'CALIBRATION_UNCERTAIN', 'STALE_DATA', 'UNDER_REVIEW'
      )),
      investor_facing BOOLEAN NOT NULL,
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      outcome_model_version TEXT NOT NULL CHECK (length(trim(outcome_model_version)) > 0),
      calibration_model_version TEXT NOT NULL CHECK (length(trim(calibration_model_version)) > 0),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at),
      CHECK (data_cutoff = prediction_as_of)
    );
    CREATE UNIQUE INDEX stock_intelligence_snapshots_identity_idx
      ON stock_intelligence.prediction_snapshots (
        instrument_id, prediction_as_of, horizon, outcome_model_version, calibration_model_version
      );
    CREATE INDEX stock_intelligence_snapshots_asof_idx
      ON stock_intelligence.prediction_snapshots (instrument_id, available_at DESC);

    CREATE TABLE stock_intelligence.prediction_decay_marks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      snapshot_id UUID NOT NULL REFERENCES stock_intelligence.prediction_snapshots(id) ON DELETE RESTRICT,
      mark_kind TEXT NOT NULL CHECK (mark_kind IN ('WEEKLY_MTM', 'HORIZON_FINAL', 'CORPORATE_EVENT')),
      as_of DATE NOT NULL,
      forward_price_return NUMERIC,
      forward_total_return NUMERIC,
      max_drawdown NUMERIC,
      outcome_type TEXT,
      overlay_status TEXT CHECK (overlay_status IS NULL OR overlay_status IN (
        'VALID', 'INSUFFICIENT_DATA', 'INSUFFICIENT_ANALOGUES', 'OUT_OF_REGIME',
        'CALIBRATION_UNCERTAIN', 'STALE_DATA', 'UNDER_REVIEW'
      )),
      review_flag BOOLEAN NOT NULL DEFAULT FALSE,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE UNIQUE INDEX stock_intelligence_decay_identity_idx
      ON stock_intelligence.prediction_decay_marks (snapshot_id, mark_kind, as_of);

    CREATE TABLE stock_intelligence.investor_holdings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL UNIQUE REFERENCES instruments(id) ON DELETE RESTRICT,
      entry_price NUMERIC NOT NULL CHECK (entry_price > 0),
      quantity NUMERIC NOT NULL CHECK (quantity > 0),
      thesis TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE stock_intelligence.investor_watchlist (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL UNIQUE REFERENCES instruments(id) ON DELETE RESTRICT,
      target_price NUMERIC CHECK (target_price IS NULL OR target_price > 0),
      target_entry NUMERIC CHECK (target_entry IS NULL OR target_entry > 0),
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TRIGGER reject_mutation_prediction_snapshots
      BEFORE UPDATE OR DELETE ON stock_intelligence.prediction_snapshots
      FOR EACH ROW EXECUTE FUNCTION stock_intelligence.reject_mutation();
    CREATE TRIGGER reject_mutation_prediction_decay_marks
      BEFORE UPDATE OR DELETE ON stock_intelligence.prediction_decay_marks
      FOR EACH ROW EXECUTE FUNCTION stock_intelligence.reject_mutation();
  `,
};
