import type { Migration } from "../migration-runner.js";

/**
 * Week 3 replay harness. `replay_jobs` stays mutable so a run can checkpoint.
 * Pair results and Yahoo daily raw bars are append-only and idempotent.
 */
export const stockIntelligenceReplayHarnessMigration: Migration = {
  id: "101-stock-intelligence-replay-harness",
  sql: `
    ALTER TABLE stock_intelligence.replay_jobs
      ADD COLUMN IF NOT EXISTS pipeline_versions JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS window_from DATE,
      ADD COLUMN IF NOT EXISTS window_to DATE,
      ADD COLUMN IF NOT EXISTS job_kind TEXT NOT NULL DEFAULT 'monthly_data_replay';

    ALTER TABLE stock_intelligence.replay_jobs
      DROP CONSTRAINT IF EXISTS replay_jobs_job_kind_check;
    ALTER TABLE stock_intelligence.replay_jobs
      ADD CONSTRAINT replay_jobs_job_kind_check
      CHECK (job_kind IN ('monthly_data_replay', 'prediction_replay'));

    CREATE UNIQUE INDEX IF NOT EXISTS stock_intelligence_raw_yahoo_daily_bar_identity_idx
      ON stock_intelligence.raw_records (instrument_id, source_kind, effective_at)
      WHERE source_kind = 'yahoo_daily_bar' AND instrument_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS stock_intelligence.replay_pair_results (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES stock_intelligence.replay_jobs(id) ON DELETE RESTRICT,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      as_of DATE NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'COMPLETE', 'SKIPPED_INELIGIBLE', 'INSUFFICIENT_MARKET_DATA', 'PIT_VIOLATION', 'FAILED'
      )),
      eligibility_reason TEXT NOT NULL CHECK (length(trim(eligibility_reason)) > 0),
      pit_passed BOOLEAN NOT NULL,
      market_bar_count INTEGER NOT NULL CHECK (market_bar_count >= 0),
      market_data_completeness NUMERIC NOT NULL CHECK (
        market_data_completeness >= 0 AND market_data_completeness <= 1
      ),
      censorship JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(censorship) = 'object'),
      pipeline_versions JSONB NOT NULL CHECK (jsonb_typeof(pipeline_versions) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (job_id, instrument_id, as_of)
    );

    CREATE INDEX IF NOT EXISTS stock_intelligence_replay_pair_job_idx
      ON stock_intelligence.replay_pair_results (job_id, as_of);

    COMMENT ON TABLE stock_intelligence.replay_pair_results IS
      'One (instrument, month-end) result per job. Append-only. Resume skips unique conflicts.';

    CREATE TRIGGER reject_mutation_replay_pair_results
      BEFORE UPDATE OR DELETE ON stock_intelligence.replay_pair_results
      FOR EACH ROW EXECUTE FUNCTION stock_intelligence.reject_mutation();
  `,
};
