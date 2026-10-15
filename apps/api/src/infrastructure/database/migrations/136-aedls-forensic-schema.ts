import type { Migration } from "../migration-runner.js";

// AEDLS Phase 1 Forensic Schema & Shadow Recommendation Ledger.
//
// Extends ai_journal_reflections with decomposed path events, target assessments,
// independent outcome and excursion validity, 4-timestamp point-in-time boundaries,
// and embedding model provenance.
//
// Creates aedls_shadow_recommendations with a database-level CHECK constraint
// locking applied_confidence_delta to exactly 0, enforcing zero live execution authority.
export const aedlsForensicSchemaMigration: Migration = {
  id: "136-aedls-forensic-schema",
  sql: `
    -- 1. Additive forensic columns on ai_journal_reflections
    ALTER TABLE ai_journal_reflections
      ADD COLUMN IF NOT EXISTS candidate_id UUID,
      ADD COLUMN IF NOT EXISTS trade_side TEXT CHECK (trade_side IN ('LONG', 'SHORT')),
      ADD COLUMN IF NOT EXISTS setup_family TEXT,
      ADD COLUMN IF NOT EXISTS regime_class TEXT,
      ADD COLUMN IF NOT EXISTS structural_context JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS target_assessments JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS observed_events JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS primary_observed_event TEXT,
      ADD COLUMN IF NOT EXISTS terminal_outcome TEXT CHECK (terminal_outcome IS NULL OR terminal_outcome IN ('STOP_LOSS', 'TARGET', 'TIMEOUT', 'MANUAL_EXIT', 'OTHER')),
      ADD COLUMN IF NOT EXISTS outcome_validity TEXT NOT NULL DEFAULT 'INSUFFICIENT_FILL_DATA' CHECK (outcome_validity IN ('VALID_RECONCILED', 'COSTS_UNRECONCILED', 'INSUFFICIENT_FILL_DATA')),
      ADD COLUMN IF NOT EXISTS excursion_validity TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA' CHECK (excursion_validity IN ('COMPLETE', 'INSUFFICIENT_DATA', 'CONFLICTING_DATA')),
      ADD COLUMN IF NOT EXISTS planned_risk_rupees NUMERIC(20, 6) CHECK (planned_risk_rupees IS NULL OR planned_risk_rupees > 0),
      ADD COLUMN IF NOT EXISTS realized_gross_rupees NUMERIC(20, 6),
      ADD COLUMN IF NOT EXISTS realized_net_rupees NUMERIC(20, 6),
      ADD COLUMN IF NOT EXISTS realized_gross_r NUMERIC(20, 6),
      ADD COLUMN IF NOT EXISTS realized_net_r NUMERIC(20, 6),
      ADD COLUMN IF NOT EXISTS mae_3_bars_r NUMERIC(20, 6) CHECK (mae_3_bars_r IS NULL OR mae_3_bars_r >= 0),
      ADD COLUMN IF NOT EXISTS mfe_3_bars_r NUMERIC(20, 6) CHECK (mfe_3_bars_r IS NULL OR mfe_3_bars_r >= 0),
      ADD COLUMN IF NOT EXISTS max_adverse_excursion_r NUMERIC(20, 6) CHECK (max_adverse_excursion_r IS NULL OR max_adverse_excursion_r >= 0),
      ADD COLUMN IF NOT EXISTS max_favourable_excursion_r NUMERIC(20, 6) CHECK (max_favourable_excursion_r IS NULL OR max_favourable_excursion_r >= 0),
      ADD COLUMN IF NOT EXISTS underlying_excursion_points NUMERIC(20, 6),
      ADD COLUMN IF NOT EXISTS causal_hypothesis TEXT CHECK (causal_hypothesis IS NULL OR causal_hypothesis IN ('OPPOSING_ORDER_FLOW', 'VOLATILITY_CRUSH_VEGA', 'LIQUIDITY_VACUUM_SLIP', 'COUNTER_DRIVER_TAPE', 'UNATTRIBUTED_MARKET_VARIANCE')),
      ADD COLUMN IF NOT EXISTS attribution_status TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (attribution_status IN ('SUPPORTED', 'REFUTED', 'UNKNOWN')),
      ADD COLUMN IF NOT EXISTS trade_closed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS evidence_available_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_available_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS embedding_available_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS review_embedding_template_version TEXT,
      ADD COLUMN IF NOT EXISTS embedding_model_id TEXT,
      ADD COLUMN IF NOT EXISTS embedding_model_revision TEXT,
      ADD COLUMN IF NOT EXISTS embedding_config_hash TEXT,
      ADD COLUMN IF NOT EXISTS embedding_dim INTEGER CHECK (embedding_dim IS NULL OR embedding_dim = 384),
      ADD COLUMN IF NOT EXISTS taxonomy_version TEXT,
      ADD COLUMN IF NOT EXISTS reviewer_version TEXT;

    -- Backfill trade_side from existing side column where null
    UPDATE ai_journal_reflections
    SET trade_side = side
    WHERE trade_side IS NULL AND side IS NOT NULL;

    -- 2. Performance indexes for PIT queries & structural pre-filtering
    CREATE INDEX IF NOT EXISTS ai_journal_reflections_pit_idx
      ON ai_journal_reflections (trade_closed_at, evidence_available_at, review_available_at, embedding_available_at);

    CREATE INDEX IF NOT EXISTS ai_journal_reflections_target_assessments_idx
      ON ai_journal_reflections USING gin (target_assessments);

    CREATE INDEX IF NOT EXISTS ai_journal_reflections_structural_idx
      ON ai_journal_reflections (instrument_symbol, trade_side, setup_family, regime_class);

    CREATE INDEX IF NOT EXISTS ai_journal_reflections_candidate_idx
      ON ai_journal_reflections (candidate_id);

    -- 3. Decoupled AEDLS Shadow Recommendations Table
    CREATE TABLE IF NOT EXISTS aedls_shadow_recommendations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      candidate_decision_id UUID,
      candidate_id UUID NOT NULL,
      decided_at TIMESTAMPTZ NOT NULL,
      hypothetical_admission_decision TEXT NOT NULL CHECK (hypothetical_admission_decision IN ('ADMIT', 'REJECT')),
      -- HARD SAFETY INVARIANT: applied_confidence_delta is strictly 0 in shadow mode
      applied_confidence_delta NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (applied_confidence_delta = 0),
      proposed_confidence_delta NUMERIC(6, 2),
      reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL,
      candidate_query_template_version TEXT NOT NULL,
      embedding_model_id TEXT NOT NULL,
      embedding_model_revision TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS aedls_shadow_recommendations_decided_idx
      ON aedls_shadow_recommendations (decided_at DESC);

    CREATE INDEX IF NOT EXISTS aedls_shadow_recommendations_candidate_idx
      ON aedls_shadow_recommendations (candidate_id);
  `,
};
