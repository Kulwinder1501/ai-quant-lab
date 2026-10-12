import type { Migration } from "../migration-runner.js";

// The Asia-to-India pre-market engine: an execution log, an immutable terminal snapshot per run
// slot, and the measured session outcomes that snapshots are scored against.
//
// Attempts and snapshots are separate so a transient failure (a model timeout, a feed outage) is
// recorded without ever occupying the slot's one terminal row. `logical_run_key` is UNIQUE and the
// repository inserts with ON CONFLICT DO NOTHING, so the first terminal snapshot for a slot wins and
// a re-run can never rewrite the record a later score is computed from.
export const premarketIntelligenceMigration: Migration = {
  id: "134-premarket-intelligence",
  sql: `
    CREATE TABLE IF NOT EXISTS daily_market_bias_attempts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_slot VARCHAR(120) NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status VARCHAR(20) NOT NULL CHECK (status IN ('FAILED', 'INSUFFICIENT_DATA', 'SUCCESS')),
      error_details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS daily_market_bias_attempts_slot_idx
      ON daily_market_bias_attempts (run_slot, attempted_at DESC);

    CREATE TABLE IF NOT EXISTS daily_market_bias (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      logical_run_key VARCHAR(160) NOT NULL UNIQUE,
      assessment_date DATE NOT NULL,
      run_slot VARCHAR(120) NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status VARCHAR(20) NOT NULL CHECK (status IN ('VALID', 'INSUFFICIENT_DATA')),
      -- Whether the model arm produced a validated assessment. The deterministic baseline is stored
      -- either way, so a day with no model output still contributes to the benchmark population.
      llm_status VARCHAR(20) NOT NULL CHECK (llm_status IN ('VALIDATED', 'NOT_CONFIGURED', 'FAILED')),
      assessments JSONB,
      deterministic_baselines JSONB NOT NULL,
      evidence_manifest JSONB NOT NULL,
      model_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS daily_market_bias_date_idx
      ON daily_market_bias (assessment_date DESC, run_slot);

    CREATE TABLE IF NOT EXISTS market_session_outcomes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_symbol TEXT NOT NULL CHECK (instrument_symbol IN ('NIFTY50', 'BANKNIFTY')),
      session_date DATE NOT NULL,
      previous_close NUMERIC,
      open_0915 NUMERIC,
      price_1015 NUMERIC,
      closing_vwap NUMERIC,
      gap_return_pct NUMERIC,
      first60_return_pct NUMERIC,
      full_session_return_pct NUMERIC,
      gap_outcome TEXT CHECK (gap_outcome IN ('UP', 'DOWN', 'FLAT')),
      first60_outcome TEXT CHECK (first60_outcome IN ('UP', 'DOWN', 'FLAT')),
      full_session_outcome TEXT CHECK (full_session_outcome IN ('UP', 'DOWN', 'FLAT')),
      -- [{ levelRef, price, touched, firstTouchAt }] for every candidate level of the session.
      level_touches JSONB NOT NULL DEFAULT '[]'::jsonb,
      -- { OPENING_GAP?: reason, FIRST_60_MINUTES?: reason, FULL_SESSION?: reason } for targets that
      -- could not be measured, so a missing outcome says why rather than reading as "pending".
      unmeasurable JSONB NOT NULL DEFAULT '{}'::jsonb,
      computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (instrument_symbol, session_date)
    );
  `,
};
