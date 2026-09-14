import type { Migration } from "../migration-runner.js";

/** V1.3.1 physically isolated, append-only scalp research ledger. */
export const scalpResearchHarnessMigration: Migration = {
  id: "074-scalp-research-harness",
  sql: `
    CREATE SCHEMA IF NOT EXISTS research_scalp;

    CREATE OR REPLACE FUNCTION research_scalp.reject_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'research_scalp records are append-only';
    END;
    $$;

    CREATE TABLE research_scalp.strategy_definitions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      strategy_definition_hash CHAR(64) NOT NULL UNIQUE CHECK (strategy_definition_hash ~ '^[0-9a-f]{64}$'),
      strategy_key TEXT NOT NULL CHECK (length(trim(strategy_key)) > 0),
      research_version INTEGER NOT NULL CHECK (research_version > 0),
      feature_schema_version TEXT NOT NULL CHECK (length(trim(feature_schema_version)) > 0),
      implementation_artifact_checksum CHAR(64) NOT NULL CHECK (implementation_artifact_checksum ~ '^[0-9a-f]{64}$'),
      configuration JSONB NOT NULL CHECK (jsonb_typeof(configuration) = 'object'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE research_scalp.proposals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      proposal_key CHAR(64) NOT NULL UNIQUE CHECK (proposal_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      strategy_definition_hash CHAR(64) NOT NULL REFERENCES research_scalp.strategy_definitions(strategy_definition_hash) ON DELETE RESTRICT,
      strategy_key TEXT NOT NULL,
      strategy_research_version INTEGER NOT NULL CHECK (strategy_research_version > 0),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      source_candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE RESTRICT,
      reference_candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE RESTRICT,
      timeframe TEXT NOT NULL CHECK (length(trim(timeframe)) BETWEEN 2 AND 16),
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      decision_at TIMESTAMPTZ NOT NULL,
      data_through TIMESTAMPTZ NOT NULL CHECK (data_through < decision_at),
      reference_price NUMERIC(20, 6) NOT NULL CHECK (reference_price > 0),
      setup_type TEXT NOT NULL CHECK (length(trim(setup_type)) > 0),
      setup_fingerprint CHAR(64) NOT NULL CHECK (setup_fingerprint ~ '^[0-9a-f]{64}$'),
      native_geometry JSONB NOT NULL CHECK (jsonb_typeof(native_geometry) = 'object'),
      raw_context JSONB NOT NULL CHECK (jsonb_typeof(raw_context) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX research_scalp_proposals_decision_idx
      ON research_scalp.proposals (instrument_id, decision_at, direction);

    CREATE TABLE research_scalp.opportunities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      opportunity_key CHAR(64) NOT NULL UNIQUE CHECK (opportunity_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL CHECK (session_id ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      session_close_at TIMESTAMPTZ NOT NULL CHECK (session_close_at >= canonical_decision_at),
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      canonical_decision_at TIMESTAMPTZ NOT NULL,
      data_through TIMESTAMPTZ NOT NULL CHECK (data_through < canonical_decision_at),
      reference_price NUMERIC(20, 6) NOT NULL CHECK (reference_price > 0),
      reference_candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE RESTRICT,
      grouping_policy_version TEXT NOT NULL,
      reference_policy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE research_scalp.opportunity_memberships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      membership_key CHAR(64) NOT NULL UNIQUE CHECK (membership_key ~ '^[0-9a-f]{64}$'),
      opportunity_id UUID NOT NULL REFERENCES research_scalp.opportunities(id) ON DELETE RESTRICT,
      proposal_id UUID NOT NULL REFERENCES research_scalp.proposals(id) ON DELETE RESTRICT,
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (opportunity_id, proposal_id)
    );

    CREATE TABLE research_scalp.control_points (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      control_point_key CHAR(64) NOT NULL UNIQUE CHECK (control_point_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      source_candle_id UUID NOT NULL REFERENCES candles(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL CHECK (session_id ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      session_close_at TIMESTAMPTZ NOT NULL CHECK (session_close_at >= decision_at),
      evaluation_direction TEXT NOT NULL CHECK (evaluation_direction IN ('LONG', 'SHORT')),
      decision_at TIMESTAMPTZ NOT NULL,
      data_through TIMESTAMPTZ NOT NULL CHECK (data_through < decision_at),
      reference_price NUMERIC(20, 6) NOT NULL CHECK (reference_price > 0),
      minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
      volatility_regime TEXT,
      sample_eligible BOOLEAN NOT NULL,
      ineligible_reason TEXT,
      control_policy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK ((sample_eligible AND ineligible_reason IS NULL) OR (NOT sample_eligible AND ineligible_reason IS NOT NULL))
    );
    CREATE INDEX research_scalp_controls_match_idx
      ON research_scalp.control_points (instrument_id, session_id, evaluation_direction, minute_of_day)
      WHERE sample_eligible;

    CREATE TABLE research_scalp.control_matches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      control_match_key CHAR(64) NOT NULL UNIQUE CHECK (control_match_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      opportunity_id UUID NOT NULL REFERENCES research_scalp.opportunities(id) ON DELETE RESTRICT,
      control_point_id UUID NOT NULL REFERENCES research_scalp.control_points(id) ON DELETE RESTRICT,
      matching_policy_version TEXT NOT NULL,
      equal_weight NUMERIC(12, 10) NOT NULL CHECK (equal_weight > 0 AND equal_weight <= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (opportunity_id, control_point_id, matching_policy_version)
    );

    CREATE TABLE research_scalp.risk_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      risk_snapshot_key CHAR(64) NOT NULL UNIQUE CHECK (risk_snapshot_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      account_id UUID NOT NULL REFERENCES paper_accounts(id) ON DELETE RESTRICT,
      as_of TIMESTAMPTZ NOT NULL,
      state JSONB NOT NULL CHECK (jsonb_typeof(state) = 'object'),
      risk_snapshot_policy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE research_scalp.risk_subjects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      risk_subject_key CHAR(64) NOT NULL UNIQUE CHECK (risk_subject_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      subject_type TEXT NOT NULL CHECK (subject_type IN ('CANONICAL_OPPORTUNITY', 'NATIVE_PROPOSAL')),
      subject_id UUID NOT NULL,
      instrument_id UUID NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      decision_at TIMESTAMPTZ NOT NULL,
      session_close_at TIMESTAMPTZ NOT NULL CHECK (session_close_at >= decision_at),
      geometry JSONB NOT NULL CHECK (jsonb_typeof(geometry) = 'object'),
      geometry_policy_version TEXT NOT NULL,
      lot_size INTEGER NOT NULL CHECK (lot_size > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE research_scalp.risk_decisions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      risk_decision_key CHAR(64) NOT NULL UNIQUE CHECK (risk_decision_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      risk_subject_id UUID NOT NULL REFERENCES research_scalp.risk_subjects(id) ON DELETE RESTRICT,
      risk_snapshot_id UUID NOT NULL REFERENCES research_scalp.risk_snapshots(id) ON DELETE RESTRICT,
      risk_policy_version TEXT NOT NULL,
      decision JSONB NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE research_scalp.settlement_observations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      observation_key CHAR(64) NOT NULL UNIQUE CHECK (observation_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      subject_type TEXT NOT NULL CHECK (subject_type IN ('CANONICAL_OPPORTUNITY', 'NATIVE_PROPOSAL', 'CONTROL_POINT')),
      subject_id UUID NOT NULL,
      horizon_minutes INTEGER NOT NULL CHECK (horizon_minutes IN (5, 15, 30, 60)),
      horizon_end_at TIMESTAMPTZ NOT NULL,
      horizon_eligible BOOLEAN NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ELIGIBLE_COMPLETE', 'ELIGIBLE_DATA_INCOMPLETE', 'INELIGIBLE_SESSION_BOUNDARY')),
      status_reason TEXT,
      mfe_bps NUMERIC(16, 6),
      mae_bps NUMERIC(16, 6),
      target_touched BOOLEAN,
      stop_touched BOOLEAN,
      entry_triggered_at TIMESTAMPTZ,
      first_target_touch_at TIMESTAMPTZ,
      first_stop_touch_at TIMESTAMPTZ,
      bars_expected INTEGER NOT NULL CHECK (bars_expected > 0),
      bars_observed INTEGER NOT NULL CHECK (bars_observed >= 0),
      geometry_policy_version TEXT NOT NULL,
      fill_policy_version TEXT NOT NULL,
      settlement_policy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (subject_type, subject_id, settlement_policy_version, horizon_minutes)
    );

    CREATE TABLE research_scalp.terminal_settlements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      terminal_settlement_key CHAR(64) NOT NULL UNIQUE CHECK (terminal_settlement_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      subject_type TEXT NOT NULL CHECK (subject_type IN ('CANONICAL_OPPORTUNITY', 'NATIVE_PROPOSAL', 'CONTROL_POINT')),
      subject_id UUID NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('TARGET', 'STOP', 'TIMEOUT', 'AMBIGUOUS', 'ENTRY_NOT_TRIGGERED', 'DATA_INCOMPLETE', 'POLICY_INVALID')),
      outcome_reason TEXT NOT NULL,
      entry_fill_condition TEXT NOT NULL CHECK (entry_fill_condition IN ('AT_REFERENCE', 'AT_LEVEL', 'GAP_THROUGH_LIMIT_ENTRY', 'GAP_THROUGH_STOP_ENTRY', 'GAP_THROUGH_STOP', 'GAP_THROUGH_TARGET', 'TIMEOUT_CLOSE', 'NONE')),
      exit_fill_condition TEXT NOT NULL CHECK (exit_fill_condition IN ('AT_REFERENCE', 'AT_LEVEL', 'GAP_THROUGH_LIMIT_ENTRY', 'GAP_THROUGH_STOP_ENTRY', 'GAP_THROUGH_STOP', 'GAP_THROUGH_TARGET', 'TIMEOUT_CLOSE', 'NONE')),
      entry_triggered_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ NOT NULL,
      entry_fill_price NUMERIC(20, 6),
      exit_fill_price NUMERIC(20, 6),
      return_bps NUMERIC(16, 6),
      r_multiple NUMERIC(16, 6),
      geometry_policy_version TEXT NOT NULL,
      fill_policy_version TEXT NOT NULL,
      settlement_policy_version TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (subject_type, subject_id, settlement_policy_version)
    );

    CREATE TABLE research_scalp.events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_key CHAR(64) NOT NULL UNIQUE CHECK (event_key ~ '^[0-9a-f]{64}$'),
      payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      entity_id UUID NOT NULL,
      event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
      policy_version TEXT NOT NULL,
      logical_event_at TIMESTAMPTZ NOT NULL,
      causation_id TEXT NOT NULL CHECK (length(trim(causation_id)) > 0),
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    DO $$
    DECLARE table_name TEXT;
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[
        'strategy_definitions', 'proposals', 'opportunities', 'opportunity_memberships',
        'control_points', 'control_matches', 'risk_snapshots', 'risk_subjects',
        'risk_decisions', 'settlement_observations', 'terminal_settlements', 'events'
      ] LOOP
        EXECUTE format(
          'CREATE TRIGGER %I_reject_mutation BEFORE UPDATE OR DELETE ON research_scalp.%I FOR EACH ROW EXECUTE FUNCTION research_scalp.reject_mutation()',
          table_name, table_name
        );
      END LOOP;
    END;
    $$;

    COMMENT ON SCHEMA research_scalp IS
      'Physically isolated V1.3.1 shadow research. No execution path reads these tables.';
  `,
};
