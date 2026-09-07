import type { Migration } from "../migration-runner.js";

/**
 * Versioned ICT Composite State Snapshots (ict-state-v1).
 *
 * Dedicated store for four-pillar institutional order flow state,
 * completely decoupled from the legacy indicator_definitions table
 * and its look-ahead-purged CHECK constraints.
 */
export const ictStateSnapshotsMigration: Migration = {
  id: "105-ict-state-snapshots",
  sql: `
    CREATE TABLE IF NOT EXISTS ict_state_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
      timeframe TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      bar_index INT NOT NULL,
      bar_time TIMESTAMPTZ NOT NULL,
      structure_trend TEXT NOT NULL,
      bias_direction TEXT NOT NULL,
      daily_template TEXT NOT NULL,
      dealing_range_eq NUMERIC,
      primary_target_price NUMERIC,
      primary_target_kind TEXT,
      invalidation_level NUMERIC,
      alignment_status TEXT NOT NULL,
      snapshot_payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT ict_state_snapshots_bar_unique UNIQUE (instrument_id, timeframe, bar_time, engine_version, config_hash)
    );

    CREATE INDEX IF NOT EXISTS ict_state_snapshots_lookup_idx
      ON ict_state_snapshots (instrument_id, timeframe, bar_time DESC);
  `,
};
