import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import { matchingPolicyVersion, settlementPolicyVersion } from "../../../modules/research/scalp-harness/domain/contracts.js";

export interface ScalpResearchAcceptanceReport {
  readonly generatedAt: Date;
  readonly from: Date;
  readonly through: Date;
  readonly counts: Readonly<Record<string, number>>;
  /** Spec-named rates. Null where the denominator is zero — an empty window is not a pass. */
  readonly rates: Readonly<Record<string, number | null>>;
  readonly assertions: Readonly<Record<string, boolean>>;
  readonly passed: boolean;
  readonly staticEvidence: {
    readonly executionDependency: "COVERED_BY_ARCHITECTURE_TEST";
    readonly productionStateMutation: "COVERED_BY_ARCHITECTURE_TEST_AND_DB_ROLE";
    readonly changedPayloadRetry: "COVERED_BY_REPOSITORY_TEST";
  };
}

interface AuditRow extends QueryResultRow {
  duplicate_persisted_keys: string;
  reference_candle_mismatches: string;
  feature_timestamp_after_data_through: string;
  opportunities_without_members: string;
  orphan_risk_decisions: string;
  risk_snapshots_after_decision: string;
  orphan_observations: string;
  orphan_terminal_settlements: string;
  cross_session_observations: string;
  expected_control_grid_rows: string;
  missing_control_grid_rows: string;
  matured_eligible_observations: string;
  missing_matured_eligible_observations: string;
  matured_canonical_observations: string;
  missing_matured_canonical_observations: string;
  matured_native_terminals: string;
  missing_matured_native_terminals: string;
  matured_canonical_terminals: string;
  missing_matured_canonical_terminals: string;
  matured_terminals: string;
  missing_matured_terminals: string;
  unresolved_control_matching: string;
  ambiguous_terminals: string;
  same_candle_ambiguity: string;
  data_incomplete_terminals: string;
  eligible_data_incomplete: string;
  policy_invalid_terminals: string;
  off_grid_control_points: string;
  off_grid_opportunities: string;
  policy_determinism_violations: string;
  common_support_failures: string;
  matured_opportunities: string;
}

const integer = (value: unknown): number => Number.parseInt(String(value), 10);

/** Read-only five-day plumbing audit. Edge estimation deliberately lives elsewhere. */
export class PostgresScalpResearchAcceptanceRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async generate(input: { from: Date; through: Date }): Promise<ScalpResearchAcceptanceReport> {
    if (!(input.from < input.through)) throw new Error("Acceptance audit requires from < through.");
    const result = await this.database.query<AuditRow>(`
      WITH
      duplicate_keys AS (
        SELECT COALESCE(SUM(duplicate_count), 0)::bigint AS count FROM (
          SELECT COUNT(*) - COUNT(DISTINCT strategy_definition_hash) AS duplicate_count FROM research_scalp.strategy_definitions
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT proposal_key) FROM research_scalp.proposals
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT opportunity_key) FROM research_scalp.opportunities
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT membership_key) FROM research_scalp.opportunity_memberships
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT control_point_key) FROM research_scalp.control_points
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT control_match_key) FROM research_scalp.control_matches
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT risk_snapshot_key) FROM research_scalp.risk_snapshots
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT risk_subject_key) FROM research_scalp.risk_subjects
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT risk_decision_key) FROM research_scalp.risk_decisions
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT observation_key) FROM research_scalp.settlement_observations
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT terminal_settlement_key) FROM research_scalp.terminal_settlements
          UNION ALL SELECT COUNT(*) - COUNT(DISTINCT event_key) FROM research_scalp.events
        ) duplicates
      ),
      expected_observations AS (
        SELECT subject.subject_type, subject.subject_id, horizon.minutes
        FROM research_scalp.risk_subjects subject
        CROSS JOIN (VALUES (5), (15), (30), (60)) horizon(minutes)
        WHERE subject.decision_at >= $1 AND subject.decision_at < $2
          AND subject.decision_at + make_interval(mins => horizon.minutes) <= subject.session_close_at
          AND subject.decision_at + make_interval(mins => horizon.minutes) <= $2
        UNION ALL
        SELECT 'CONTROL_POINT'::text, control.id, horizon.minutes
        FROM research_scalp.control_points control
        CROSS JOIN (VALUES (5), (15), (30), (60)) horizon(minutes)
        WHERE control.sample_eligible = TRUE
          AND control.decision_at >= $1 AND control.decision_at < $2
          AND control.decision_at + make_interval(mins => horizon.minutes) <= control.session_close_at
          AND control.decision_at + make_interval(mins => horizon.minutes) <= $2
      ),
      expected_control_grid AS (
        SELECT candle.id AS source_candle_id, direction.value AS evaluation_direction
        FROM candles candle
        JOIN instruments instrument ON instrument.id = candle.instrument_id
        CROSS JOIN (VALUES ('LONG'), ('SHORT')) direction(value)
        WHERE instrument.symbol IN ('NIFTY50', 'BANKNIFTY')
          AND candle.timeframe = '1m' AND candle.is_complete = TRUE
          AND candle.close_time >= $1 AND candle.close_time < $2
          AND (candle.close_time AT TIME ZONE 'Asia/Kolkata')::time
            BETWEEN TIME '09:16:00' AND TIME '15:30:00'
      ),
      -- Terminal-eligible subjects of EVERY type, not just native. Restricting this to NATIVE_PROPOSAL
      -- let a settlement bug that dropped canonical terminals still report "100%", and canonical
      -- coverage matters more to Signal Edge than native coverage does.
      expected_terminals AS (
        SELECT subject.subject_type, subject.subject_id
        FROM research_scalp.risk_subjects subject
        WHERE subject.decision_at >= $1 AND subject.decision_at < $2
          AND (subject.geometry->>'expiresAt')::timestamptz <= subject.session_close_at
          AND (subject.geometry->>'expiresAt')::timestamptz <= $2
      ),
      observation_subjects AS (
        SELECT subject_type, subject_id, session_close_at FROM research_scalp.risk_subjects
        UNION ALL SELECT 'CONTROL_POINT', id, session_close_at FROM research_scalp.control_points
      )
      SELECT
        (SELECT count FROM duplicate_keys) AS duplicate_persisted_keys,
        (SELECT COUNT(*) FROM research_scalp.proposals proposal
          JOIN candles reference ON reference.id = proposal.reference_candle_id
          WHERE proposal.decision_at >= $1 AND proposal.decision_at < $2
            AND (reference.timeframe <> '1m' OR reference.close_time <> proposal.decision_at
              OR reference.close::numeric <> proposal.reference_price
              OR proposal.data_through <> proposal.decision_at - INTERVAL '1 millisecond'))
          +
        (SELECT COUNT(*) FROM research_scalp.opportunities opportunity
          JOIN candles reference ON reference.id = opportunity.reference_candle_id
          WHERE opportunity.canonical_decision_at >= $1 AND opportunity.canonical_decision_at < $2
            AND (reference.timeframe <> '1m' OR reference.close_time <> opportunity.canonical_decision_at
              OR reference.close::numeric <> opportunity.reference_price
              OR opportunity.data_through <> opportunity.canonical_decision_at - INTERVAL '1 millisecond'))
          AS reference_candle_mismatches,
        (SELECT COUNT(*) FROM research_scalp.proposals proposal
          WHERE proposal.decision_at >= $1 AND proposal.decision_at < $2
            AND ((proposal.raw_context->>'featureDataThrough') IS NULL
              OR (proposal.raw_context->>'featureDataThrough')::timestamptz > proposal.data_through))
          AS feature_timestamp_after_data_through,
        (SELECT COUNT(*) FROM research_scalp.opportunities opportunity
          WHERE opportunity.canonical_decision_at >= $1 AND opportunity.canonical_decision_at < $2
            AND NOT EXISTS (SELECT 1 FROM research_scalp.opportunity_memberships member WHERE member.opportunity_id = opportunity.id))
          AS opportunities_without_members,
        (SELECT COUNT(*) FROM research_scalp.risk_decisions decision
          LEFT JOIN research_scalp.risk_subjects subject ON subject.id = decision.risk_subject_id
          LEFT JOIN research_scalp.risk_snapshots snapshot ON snapshot.id = decision.risk_snapshot_id
          WHERE decision.created_at >= $1 AND decision.created_at < $2 AND (subject.id IS NULL OR snapshot.id IS NULL))
          AS orphan_risk_decisions,
        (SELECT COUNT(*) FROM research_scalp.risk_decisions decision
          JOIN research_scalp.risk_subjects subject ON subject.id = decision.risk_subject_id
          JOIN research_scalp.risk_snapshots snapshot ON snapshot.id = decision.risk_snapshot_id
          WHERE subject.decision_at >= $1 AND subject.decision_at < $2 AND snapshot.as_of > subject.decision_at)
          AS risk_snapshots_after_decision,
        (SELECT COUNT(*) FROM research_scalp.settlement_observations observation
          LEFT JOIN observation_subjects subject ON subject.subject_type = observation.subject_type AND subject.subject_id = observation.subject_id
          WHERE observation.created_at >= $1 AND observation.created_at < $2 AND subject.subject_id IS NULL)
          AS orphan_observations,
        (SELECT COUNT(*) FROM research_scalp.terminal_settlements terminal
          LEFT JOIN observation_subjects subject ON subject.subject_type = terminal.subject_type AND subject.subject_id = terminal.subject_id
          WHERE terminal.created_at >= $1 AND terminal.created_at < $2 AND subject.subject_id IS NULL)
          AS orphan_terminal_settlements,
        (SELECT COUNT(*) FROM research_scalp.settlement_observations observation
          JOIN observation_subjects subject ON subject.subject_type = observation.subject_type AND subject.subject_id = observation.subject_id
          WHERE observation.created_at >= $1 AND observation.created_at < $2
            AND observation.horizon_eligible = TRUE AND observation.horizon_end_at > subject.session_close_at)
          AS cross_session_observations,
        (SELECT COUNT(*) FROM expected_control_grid) AS expected_control_grid_rows,
        (SELECT COUNT(*) FROM expected_control_grid expected
          WHERE NOT EXISTS (SELECT 1 FROM research_scalp.control_points control
            WHERE control.source_candle_id = expected.source_candle_id
              AND control.evaluation_direction = expected.evaluation_direction))
          AS missing_control_grid_rows,
        (SELECT COUNT(*) FROM expected_observations) AS matured_eligible_observations,
        (SELECT COUNT(*) FROM expected_observations expected
          WHERE NOT EXISTS (SELECT 1 FROM research_scalp.settlement_observations observation
            WHERE observation.subject_type = expected.subject_type AND observation.subject_id = expected.subject_id
              AND observation.horizon_minutes = expected.minutes AND observation.settlement_policy_version = $3))
          AS missing_matured_eligible_observations,
        (SELECT COUNT(*) FROM expected_observations WHERE subject_type = 'CANONICAL_OPPORTUNITY') AS matured_canonical_observations,
        (SELECT COUNT(*) FROM expected_observations expected
          WHERE expected.subject_type = 'CANONICAL_OPPORTUNITY'
            AND NOT EXISTS (SELECT 1 FROM research_scalp.settlement_observations observation
              WHERE observation.subject_type = expected.subject_type AND observation.subject_id = expected.subject_id
                AND observation.horizon_minutes = expected.minutes AND observation.settlement_policy_version = $3))
          AS missing_matured_canonical_observations,
        (SELECT COUNT(*) FROM expected_terminals WHERE subject_type = 'NATIVE_PROPOSAL') AS matured_native_terminals,
        (SELECT COUNT(*) FROM expected_terminals expected
          WHERE expected.subject_type = 'NATIVE_PROPOSAL'
            AND NOT EXISTS (SELECT 1 FROM research_scalp.terminal_settlements terminal
              WHERE terminal.subject_type = expected.subject_type AND terminal.subject_id = expected.subject_id
                AND terminal.settlement_policy_version = $3))
          AS missing_matured_native_terminals,
        (SELECT COUNT(*) FROM expected_terminals WHERE subject_type = 'CANONICAL_OPPORTUNITY') AS matured_canonical_terminals,
        (SELECT COUNT(*) FROM expected_terminals expected
          WHERE expected.subject_type = 'CANONICAL_OPPORTUNITY'
            AND NOT EXISTS (SELECT 1 FROM research_scalp.terminal_settlements terminal
              WHERE terminal.subject_type = expected.subject_type AND terminal.subject_id = expected.subject_id
                AND terminal.settlement_policy_version = $3))
          AS missing_matured_canonical_terminals,
        (SELECT COUNT(*) FROM expected_terminals) AS matured_terminals,
        (SELECT COUNT(*) FROM expected_terminals expected
          WHERE NOT EXISTS (SELECT 1 FROM research_scalp.terminal_settlements terminal
            WHERE terminal.subject_type = expected.subject_type AND terminal.subject_id = expected.subject_id
              AND terminal.settlement_policy_version = $3))
          AS missing_matured_terminals,
        (SELECT COUNT(*) FROM research_scalp.opportunities opportunity
          WHERE opportunity.canonical_decision_at >= $1
            AND opportunity.canonical_decision_at + INTERVAL '15 minutes' <= $2
            AND NOT EXISTS (SELECT 1 FROM research_scalp.control_matches match
              WHERE match.opportunity_id = opportunity.id AND match.matching_policy_version = $4)
            AND NOT EXISTS (SELECT 1 FROM research_scalp.events event
              WHERE event.entity_id = opportunity.id AND event.event_type = 'CONTROL_COMMON_SUPPORT_FAILED'
                AND event.policy_version = $4))
          AS unresolved_control_matching,
        (SELECT COUNT(*) FROM research_scalp.terminal_settlements WHERE resolved_at >= $1 AND resolved_at < $2 AND outcome = 'AMBIGUOUS') AS ambiguous_terminals,
        -- The spec's sameCandleAmbiguityCount is specifically INTRABAR_ORDER_UNKNOWN, which is narrower
        -- than "every AMBIGUOUS row". An acceptance gate must report the exact quantity it names.
        (SELECT COUNT(*) FROM research_scalp.terminal_settlements
          WHERE resolved_at >= $1 AND resolved_at < $2 AND outcome = 'AMBIGUOUS'
            AND outcome_reason LIKE '%INTRABAR_ORDER_UNKNOWN%') AS same_candle_ambiguity,
        (SELECT COUNT(*) FROM research_scalp.terminal_settlements WHERE resolved_at >= $1 AND resolved_at < $2 AND outcome = 'DATA_INCOMPLETE') AS data_incomplete_terminals,
        -- eligibleDataIncompleteCount is observation-level in the spec: a horizon that was eligible but
        -- could not be measured. The terminal-level count above answers a different question.
        (SELECT COUNT(*) FROM research_scalp.settlement_observations observation
          WHERE observation.horizon_end_at >= $1 AND observation.horizon_end_at < $2
            AND observation.horizon_eligible = TRUE
            AND observation.status = 'ELIGIBLE_DATA_INCOMPLETE') AS eligible_data_incomplete,
        (SELECT COUNT(*) FROM research_scalp.terminal_settlements WHERE resolved_at >= $1 AND resolved_at < $2 AND outcome = 'POLICY_INVALID') AS policy_invalid_terminals,
        -- GRID_POLICY_V1 is a domain invariant; the domain now refuses an off-grid decision, and this is
        -- the standing check that no historical or out-of-band write slipped past it.
        (SELECT COUNT(*) FROM research_scalp.control_points
          WHERE decision_at >= $1 AND decision_at < $2
            AND (EXTRACT(SECOND FROM decision_at) <> 0
              OR (decision_at AT TIME ZONE 'Asia/Kolkata')::time <= TIME '09:15:00'
              OR (decision_at AT TIME ZONE 'Asia/Kolkata')::time > TIME '15:30:00')) AS off_grid_control_points,
        (SELECT COUNT(*) FROM research_scalp.opportunities
          WHERE canonical_decision_at >= $1 AND canonical_decision_at < $2
            AND (EXTRACT(SECOND FROM canonical_decision_at) <> 0
              OR (canonical_decision_at AT TIME ZONE 'Asia/Kolkata')::time <= TIME '09:15:00'
              OR (canonical_decision_at AT TIME ZONE 'Asia/Kolkata')::time > TIME '15:30:00')) AS off_grid_opportunities,
        -- A settlement version must resolve to one frozen component set forever; a second distinct hash
        -- under the same version is a POLICY_DETERMINISM_VIOLATION (see settlementPolicyRegistry).
        (SELECT COUNT(*) FROM (
          SELECT settlement_policy_version FROM research_scalp.terminal_settlements
          WHERE settlement_definition_hash IS NOT NULL
          GROUP BY settlement_policy_version
          HAVING COUNT(DISTINCT settlement_definition_hash) > 1
        ) violations) AS policy_determinism_violations,
        (SELECT COUNT(*) FROM research_scalp.events WHERE logical_event_at >= $1 AND logical_event_at < $2
          AND event_type = 'CONTROL_COMMON_SUPPORT_FAILED' AND policy_version = $4) AS common_support_failures,
        -- Denominator for controlCommonSupportFailureRate: every opportunity whose matching has matured.
        (SELECT COUNT(*) FROM research_scalp.opportunities opportunity
          WHERE opportunity.canonical_decision_at >= $1
            AND opportunity.canonical_decision_at + INTERVAL '15 minutes' <= $2) AS matured_opportunities
    `, [input.from, input.through, settlementPolicyVersion, matchingPolicyVersion]);
    const row = result.rows[0];
    if (!row) throw new Error("Acceptance audit returned no result.");
    const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, integer(value)]));
    const assertions = {
      duplicatePersistedKeys: counts.duplicate_persisted_keys === 0,
      referencePolicy: counts.reference_candle_mismatches === 0,
      featurePointInTime: counts.feature_timestamp_after_data_through === 0,
      opportunityTraceability: counts.opportunities_without_members === 0,
      riskDecisionTraceability: counts.orphan_risk_decisions === 0 && counts.risk_snapshots_after_decision === 0,
      settlementTraceability: counts.orphan_observations === 0 && counts.orphan_terminal_settlements === 0,
      noCrossSessionObservation: counts.cross_session_observations === 0,
      controlGridCoverage: counts.missing_control_grid_rows === 0,
      eligibleObservationCoverage: counts.missing_matured_eligible_observations === 0,
      canonicalObservationCoverage: counts.missing_matured_canonical_observations === 0,
      // Per subject type, so a canonical/control settlement gap can no longer hide behind native 100%.
      nativeTerminalResolution: counts.missing_matured_native_terminals === 0,
      canonicalTerminalResolution: counts.missing_matured_canonical_terminals === 0,
      terminalResolutionCoverage: counts.missing_matured_terminals === 0,
      controlMatchingResolved: counts.unresolved_control_matching === 0,
      onGridDecisions: counts.off_grid_control_points === 0 && counts.off_grid_opportunities === 0,
      settlementPolicyDeterminism: counts.policy_determinism_violations === 0,
    };
    const rate = (numerator: number, denominator: number): number | null =>
      denominator === 0 ? null : Number((numerator / denominator).toFixed(6));
    return {
      generatedAt: new Date(),
      from: input.from,
      through: input.through,
      counts,
      // Rates the spec names explicitly. Null denominators stay null rather than becoming a
      // reassuring 0 — "no opportunities matured yet" is not "no failures".
      rates: {
        controlCommonSupportFailureRate: rate(counts.common_support_failures, counts.matured_opportunities),
        nativeTerminalResolutionCoverage: rate(
          counts.matured_native_terminals - counts.missing_matured_native_terminals,
          counts.matured_native_terminals,
        ),
        canonicalTerminalResolutionCoverage: rate(
          counts.matured_canonical_terminals - counts.missing_matured_canonical_terminals,
          counts.matured_canonical_terminals,
        ),
        terminalResolutionCoverage: rate(
          counts.matured_terminals - counts.missing_matured_terminals,
          counts.matured_terminals,
        ),
      },
      assertions,
      passed: Object.values(assertions).every(Boolean),
      staticEvidence: {
        executionDependency: "COVERED_BY_ARCHITECTURE_TEST",
        productionStateMutation: "COVERED_BY_ARCHITECTURE_TEST_AND_DB_ROLE",
        changedPayloadRetry: "COVERED_BY_REPOSITORY_TEST",
      },
    };
  }
}
