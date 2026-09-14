import type { Migration } from "../migration-runner.js";

/**
 * Storage for Pattern Intelligence V1.0.1 — the detector's observations, their lifecycle, and proof
 * that a window was evaluated.
 *
 * ## Why new tables rather than the incumbent ones
 *
 * `pattern_detections` (913k rows) and `price_action_events` (568k rows) are built on `confidence`
 * and `direction: BULLISH/BEARISH` — fields V1.0.1 bans outright, because a stored confidence is a
 * judgement the detector is not entitled to make and a judgement nobody can later falsify. Writing
 * V1.0.1 observations into those tables would mean either inventing values for the banned columns or
 * making them nullable and hoping readers notice. Errata Section 8 settles it: the module writes to
 * its own namespaced tables and the incumbent keeps running untouched on its own. The two coexist;
 * neither reads the other.
 *
 * ## The uniqueness rule is a logical key, not the observation hash
 *
 * `observation_hash` is the immutable-record fingerprint and covers `observation_id`, a fresh UUID per
 * detection pass. Keyed on it, a re-scan of an overlapping window would insert a second copy of every
 * pattern it re-found, because the same market event hashes differently on every run. So the
 * uniqueness constraint is on `logical_key` — the observable facts of the event — and inserts are
 * `ON CONFLICT DO NOTHING`. A backfill pass and a live pass over the same bar collide, which is what
 * makes the detector safely re-runnable. See `calculateObservationLogicalKey`.
 *
 * ## Coverage is a separate table for the reason 079 exists
 *
 * "The detectors ran across this window and nothing qualified" and "the detectors have not run" are
 * the same zero rows in `pattern_observations_v2`, and no query over it can separate them. This
 * repository has already paid for that ambiguity once: the scalp harness read an incomplete feature
 * layer on 46% of live evaluations and could not tell it from a quiet market. `recorded_at` is left
 * alone on conflict so it dates *first* cover; a re-run must not restamp it, or the column decays
 * into the most-recent-write field that made `pattern_detections.detected_at` useless for this.
 *
 * ## No backfill
 *
 * Nothing is stamped for history. For any window already evaluated we do not know when its
 * observations landed relative to a reader, and inventing coverage would assert precisely the fact
 * these rows exist to establish. Absent reads as unknown, which is true.
 */
export const patternIntelligenceObservationsMigration: Migration = {
  id: "084-pattern-intelligence-observations",
  sql: `
    -- The frozen Pattern Definition Registry. The Implementation Gate requires a definition to exist
    -- before its detector may persist, so this is the table the write path checks against.
    CREATE TABLE IF NOT EXISTS pattern_definitions_v2 (
      definition_id TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      family TEXT NOT NULL,
      parameters JSONB NOT NULL,
      invalidation_conditions TEXT[] NOT NULL CHECK (cardinality(invalidation_conditions) > 0),
      definition_hash CHAR(64) NOT NULL CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
      -- Honest provenance: true when the record was written from an already-implemented detector
      -- rather than before it. All twelve V1.0.1 records are retrofits and say so.
      derived_from_implementation BOOLEAN NOT NULL,
      frozen_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (definition_id, definition_version)
    );

    CREATE TABLE IF NOT EXISTS pattern_observations_v2 (
      observation_id UUID PRIMARY KEY,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,

      -- Identity
      pattern_family TEXT NOT NULL,
      pattern_subtype TEXT NOT NULL,
      orientation TEXT NOT NULL CHECK (orientation IN ('UP', 'DOWN', 'NONE', 'BIDIRECTIONAL')),

      -- Source. Denormalised from ObservationSource so a reader can filter without parsing JSON.
      timeframe TEXT NOT NULL,
      instrument_type TEXT NOT NULL CHECK (instrument_type IN ('FUTIDX', 'INDEX')),
      contract_symbol TEXT NOT NULL,
      contract_expiry TIMESTAMPTZ,
      contract_role TEXT,
      data_vintage_id TEXT NOT NULL,
      data_vintage_at TIMESTAMPTZ NOT NULL,

      -- Definition reference, carrying the hash the observation was actually produced under.
      definition_id TEXT NOT NULL,
      definition_version TEXT NOT NULL,
      definition_hash CHAR(64) NOT NULL,

      -- Timing. earliest_execution_at is Bar 0 for any forward evaluation (errata Section 6).
      start_at TIMESTAMPTZ NOT NULL,
      data_through TIMESTAMPTZ NOT NULL,
      detected_at TIMESTAMPTZ NOT NULL,
      known_at TIMESTAMPTZ NOT NULL,
      earliest_execution_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT pattern_observations_v2_timing_ordered
        CHECK (start_at <= data_through AND data_through <= detected_at AND detected_at <= known_at
               AND earliest_execution_at > known_at),

      -- Geometry. range_atr is NOT NULL and strictly positive by the strict non-emission rule: a
      -- detector refuses to emit before ATR warmup rather than substituting a value.
      duration_bars INTEGER NOT NULL CHECK (duration_bars >= 1),
      range_bps DOUBLE PRECISION NOT NULL,
      range_atr DOUBLE PRECISION NOT NULL CHECK (range_atr >= 0),

      -- Context. The three nullable columns are nullable on purpose: null means "not computable",
      -- never zero. A zero-volume bar anywhere in the 20-bar window makes volume_zscore null.
      trend_state TEXT NOT NULL CHECK (trend_state IN ('UP', 'DOWN', 'SIDEWAYS', 'TRANSITIONING', 'UNKNOWN')),
      session_segment TEXT NOT NULL CHECK (session_segment IN ('PRE_OPEN', 'OPENING', 'MIDDAY', 'CLOSING')),
      volume_zscore DOUBLE PRECISION,
      range_zscore DOUBLE PRECISION,
      effort_result_divergence DOUBLE PRECISION,
      CONSTRAINT pattern_observations_v2_divergence_requires_both
        CHECK ((effort_result_divergence IS NULL)
               OR (volume_zscore IS NOT NULL AND range_zscore IS NOT NULL)),

      details JSONB NOT NULL,

      -- Provenance
      engine_version TEXT NOT NULL,
      config_version TEXT NOT NULL,
      config_hash CHAR(64) NOT NULL,
      data_source TEXT NOT NULL,
      data_schema_version TEXT NOT NULL,
      observation_hash CHAR(64) NOT NULL CHECK (observation_hash ~ '^[0-9a-f]{64}$'),

      -- Storage identity. See the header: this, not observation_hash, is what makes the detector
      -- safely re-runnable over an overlapping window.
      logical_key CHAR(64) NOT NULL UNIQUE CHECK (logical_key ~ '^[0-9a-f]{64}$'),

      FOREIGN KEY (definition_id, definition_version)
        REFERENCES pattern_definitions_v2 (definition_id, definition_version)
    );

    -- The read pattern the research harness uses: everything this instrument produced at this
    -- timeframe for a given bar.
    CREATE INDEX IF NOT EXISTS pattern_observations_v2_bar_idx
      ON pattern_observations_v2 (instrument_id, timeframe, detected_at);

    -- The point-in-time read: what was knowable by a given instant. Separate from the above because a
    -- leakage-safe consumer filters on known_at, not detected_at.
    CREATE INDEX IF NOT EXISTS pattern_observations_v2_known_idx
      ON pattern_observations_v2 (instrument_id, timeframe, known_at);

    CREATE INDEX IF NOT EXISTS pattern_observations_v2_family_idx
      ON pattern_observations_v2 (pattern_family, pattern_subtype, detected_at);

    CREATE TABLE IF NOT EXISTS pattern_lifecycle_events_v2 (
      event_id UUID PRIMARY KEY,
      observation_id UUID NOT NULL REFERENCES pattern_observations_v2(observation_id) ON DELETE CASCADE,
      event_schema_version TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK (event_type IN ('DETECTED', 'CONFIRMED', 'INVALIDATED', 'EXPIRED', 'COMPLETED')),
      data_through TIMESTAMPTZ NOT NULL,
      event_time TIMESTAMPTZ NOT NULL,
      known_at TIMESTAMPTZ NOT NULL,
      sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
      -- Discards a duplicate append before it reaches lifecycle validation.
      idempotency_key CHAR(64) NOT NULL UNIQUE,
      cause TEXT,
      -- Append-only ordering: one event per position per observation.
      UNIQUE (observation_id, sequence_number),
      CONSTRAINT pattern_lifecycle_events_v2_timing_ordered
        CHECK (data_through <= event_time AND event_time <= known_at)
    );

    CREATE TABLE IF NOT EXISTS pattern_coverage_v2 (
      coverage_id UUID PRIMARY KEY,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
      timeframe TEXT NOT NULL,
      from_time TIMESTAMPTZ NOT NULL,
      to_time TIMESTAMPTZ NOT NULL,
      candles_evaluated INTEGER NOT NULL CHECK (candles_evaluated >= 0),
      patterns_found INTEGER NOT NULL CHECK (patterns_found >= 0),
      engine_version TEXT NOT NULL,
      -- First-cover time. Never advanced on re-run; see the header.
      recorded_at TIMESTAMPTZ NOT NULL,
      UNIQUE (instrument_id, timeframe, from_time, to_time, engine_version),
      CONSTRAINT pattern_coverage_v2_window_ordered CHECK (from_time <= to_time)
    );

    CREATE INDEX IF NOT EXISTS pattern_coverage_v2_window_idx
      ON pattern_coverage_v2 (instrument_id, timeframe, from_time, to_time);
  `,
};
