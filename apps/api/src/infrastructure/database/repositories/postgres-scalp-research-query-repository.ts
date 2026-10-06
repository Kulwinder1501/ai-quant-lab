import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import type {
  MarketOpportunity,
  ResearchControlPoint,
  ResearchGeometry,
  ResearchPriceCandle,
  ResearchSubjectType,
} from "../../../modules/research/scalp-harness/domain/contracts.js";
import { matchingPolicyVersion, settlementPolicyVersion } from "../../../modules/research/scalp-harness/domain/contracts.js";

interface SubjectRow extends QueryResultRow {
  subject_type: ResearchSubjectType;
  subject_id: string;
  decision_at: Date;
  session_close_at: Date;
  geometry: Omit<ResearchGeometry, "expiresAt"> & { expiresAt: string | Date };
}

interface ControlRow extends QueryResultRow {
  id: string;
  control_point_key: string;
  payload_hash: string;
  instrument_id: string;
  source_candle_id: string;
  session_id: string;
  session_close_at: Date;
  evaluation_direction: "LONG" | "SHORT";
  decision_at: Date;
  data_through: Date;
  reference_price: string;
  minute_of_day: number;
  volatility_regime: string | null;
  sample_eligible: boolean;
  ineligible_reason: string | null;
  control_policy_version: string;
  atr: string | null;
  tick_size: string;
}

interface OpportunityRow extends QueryResultRow {
  id: string;
  opportunity_key: string;
  payload_hash: string;
  instrument_id: string;
  session_id: string;
  session_close_at: Date;
  direction: "LONG" | "SHORT";
  canonical_decision_at: Date;
  data_through: Date;
  reference_price: string;
  reference_candle_id: string;
  grouping_policy_version: string;
  reference_policy_version: string;
  volatility_regime: string | null;
}

export class PostgresScalpResearchQueryRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async listPendingRiskSubjects(limit: number): Promise<Array<{
    subjectType: ResearchSubjectType;
    subjectId: string;
    decisionAt: Date;
    sessionCloseAt: Date;
    geometry: ResearchGeometry;
  }>> {
    const result = await this.database.query<SubjectRow>(`
      SELECT subject_type, subject_id, decision_at, session_close_at, geometry
      FROM research_scalp.risk_subjects subject
      WHERE NOT EXISTS (
        SELECT 1 FROM research_scalp.settlement_observations observation
        WHERE observation.subject_type = subject.subject_type
          AND observation.subject_id = subject.subject_id
          AND observation.settlement_policy_version = $1
      )
      ORDER BY decision_at ASC, subject_id ASC
      LIMIT $2
    `, [settlementPolicyVersion, Math.max(1, Math.floor(limit))]);
    return result.rows.map((row) => ({
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      decisionAt: row.decision_at,
      sessionCloseAt: row.session_close_at,
      geometry: { ...row.geometry, expiresAt: new Date(row.geometry.expiresAt) },
    }));
  }

  async listPendingControls(limit: number): Promise<Array<ResearchControlPoint & { id: string; atr: number; tickSize: number }>> {
    const result = await this.database.query<ControlRow>(`
      SELECT control.*, instrument.tick_size,
        (SELECT snapshot.values->>'value'
         FROM indicator_snapshots snapshot
         INNER JOIN indicator_definitions definition ON definition.id = snapshot.indicator_definition_id
         WHERE snapshot.candle_id = control.source_candle_id
           AND definition.indicator_code = 'ATR'
           AND definition.algorithm_version = 'ta-v1'
           AND definition.parameters->>'period' = '14'
           AND definition.parameters->>'smoothing' = 'WILDER'
         ORDER BY definition.parameters_hash ASC LIMIT 1) AS atr
      FROM research_scalp.control_points control
      INNER JOIN instruments instrument ON instrument.id = control.instrument_id
      WHERE control.sample_eligible = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM research_scalp.settlement_observations observation
          WHERE observation.subject_type = 'CONTROL_POINT'
            AND observation.subject_id = control.id
            AND observation.settlement_policy_version = $1
        )
      ORDER BY control.decision_at ASC, control.id ASC
      LIMIT $2
    `, [settlementPolicyVersion, Math.max(1, Math.floor(limit))]);
    return result.rows.flatMap((row) => {
      const atr = Number(row.atr);
      const tickSize = Number(row.tick_size);
      if (!Number.isFinite(atr) || atr <= 0 || !Number.isFinite(tickSize) || tickSize <= 0) return [];
      return [{
        id: row.id,
        controlPointKey: row.control_point_key,
        payloadHash: row.payload_hash,
        instrumentId: row.instrument_id,
        sourceCandleId: row.source_candle_id,
        sessionId: row.session_id,
        sessionCloseAt: row.session_close_at,
        evaluationDirection: row.evaluation_direction,
        decisionAt: row.decision_at,
        dataThrough: row.data_through,
        referencePrice: Number(row.reference_price),
        minuteOfDay: Number(row.minute_of_day),
        volatilityRegime: row.volatility_regime,
        sampleEligible: row.sample_eligible,
        ineligibleReason: row.ineligible_reason,
        controlPolicyVersion: row.control_policy_version,
        atr,
        tickSize,
      }];
    });
  }

  async listForwardCandles(input: {
    instrumentId: string;
    decisionAt: Date;
    endAt: Date;
  }): Promise<ResearchPriceCandle[]> {
    const result = await this.database.query<{
      id: string; open_time: Date; close_time: Date; open: string; high: string; low: string; close: string;
    }>(`
      SELECT id, open_time, close_time, open, high, low, close
      FROM candles
      WHERE instrument_id = $1 AND timeframe = '1m' AND is_complete = TRUE
        AND close_time > $2 AND close_time <= $3
        AND (open_time AT TIME ZONE 'Asia/Kolkata')::date = ($2 AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY close_time ASC, id ASC
    `, [input.instrumentId, input.decisionAt, input.endAt]);
    return result.rows.map((row) => ({
      id: row.id,
      openTime: row.open_time,
      closeTime: row.close_time,
      open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    }));
  }

  async findInstrumentIdForSubject(subjectType: ResearchSubjectType, subjectId: string): Promise<string | null> {
    if (subjectType === "CONTROL_POINT") {
      const result = await this.database.query<{ instrument_id: string }>(
        "SELECT instrument_id FROM research_scalp.control_points WHERE id = $1", [subjectId],
      );
      return result.rows[0]?.instrument_id ?? null;
    }
    const result = await this.database.query<{ instrument_id: string }>(
      subjectType === "CANONICAL_OPPORTUNITY"
        ? "SELECT instrument_id FROM research_scalp.opportunities WHERE id = $1"
        : "SELECT instrument_id FROM research_scalp.proposals WHERE id = $1",
      [subjectId],
    );
    return result.rows[0]?.instrument_id ?? null;
  }

  async listUnmatchedOpportunities(limit: number): Promise<Array<(MarketOpportunity & { id: string }) & { volatilityRegime: string | null }>> {
    const result = await this.database.query<OpportunityRow>(`
      SELECT opportunity.*,
        (SELECT control.volatility_regime FROM research_scalp.control_points control
         WHERE control.instrument_id = opportunity.instrument_id
           AND control.session_id = opportunity.session_id
           AND control.decision_at = opportunity.canonical_decision_at
         ORDER BY control.id LIMIT 1) AS volatility_regime
      FROM research_scalp.opportunities opportunity
      WHERE NOT EXISTS (
        SELECT 1 FROM research_scalp.control_matches match
        WHERE match.opportunity_id = opportunity.id AND match.matching_policy_version = $1
      )
        AND NOT EXISTS (
          SELECT 1 FROM research_scalp.events event
          WHERE event.entity_id = opportunity.id
            AND event.event_type = 'CONTROL_COMMON_SUPPORT_FAILED'
            AND event.policy_version = $1
        )
      ORDER BY opportunity.canonical_decision_at ASC, opportunity.id ASC
      LIMIT $2
    `, [matchingPolicyVersion, Math.max(1, Math.floor(limit))]);
    return result.rows.map((row) => ({
      id: row.id,
      opportunityKey: row.opportunity_key,
      payloadHash: row.payload_hash,
      instrumentId: row.instrument_id,
      sessionId: row.session_id,
      sessionCloseAt: row.session_close_at,
      direction: row.direction,
      canonicalDecisionAt: row.canonical_decision_at,
      dataThrough: row.data_through,
      referencePrice: Number(row.reference_price),
      referenceCandleId: row.reference_candle_id,
      proposalIds: [],
      groupingPolicyVersion: row.grouping_policy_version,
      referencePolicyVersion: row.reference_policy_version,
      volatilityRegime: row.volatility_regime,
    }));
  }

  async listControlsForOpportunity(input: {
    instrumentId: string;
    sessionId: string;
    direction: "LONG" | "SHORT";
    decisionAt: Date;
  }): Promise<Array<ResearchControlPoint & { id: string }>> {
    const result = await this.database.query<ControlRow>(`
      SELECT control.*, NULL::text AS atr, '0.05'::text AS tick_size
      FROM research_scalp.control_points control
      WHERE control.instrument_id = $1 AND control.session_id = $2
        AND control.evaluation_direction = $3
        AND control.decision_at BETWEEN $4::timestamptz - INTERVAL '15 minutes'
          AND $4::timestamptz + INTERVAL '15 minutes'
      ORDER BY control.decision_at ASC, control.id ASC
    `, [input.instrumentId, input.sessionId, input.direction, input.decisionAt]);
    return result.rows.map((row) => ({
      id: row.id,
      controlPointKey: row.control_point_key,
      payloadHash: row.payload_hash,
      instrumentId: row.instrument_id,
      sourceCandleId: row.source_candle_id,
      sessionId: row.session_id,
      sessionCloseAt: row.session_close_at,
      evaluationDirection: row.evaluation_direction,
      decisionAt: row.decision_at,
      dataThrough: row.data_through,
      referencePrice: Number(row.reference_price),
      minuteOfDay: Number(row.minute_of_day),
      volatilityRegime: row.volatility_regime,
      sampleEligible: row.sample_eligible,
      ineligibleReason: row.ineligible_reason,
      controlPolicyVersion: row.control_policy_version,
    }));
  }

  async listTreatedDecisionKeys(sessionId: string): Promise<Set<string>> {
    const result = await this.database.query<{
      instrument_id: string; direction: string; canonical_decision_at: Date;
    }>(`SELECT instrument_id, direction, canonical_decision_at
        FROM research_scalp.opportunities WHERE session_id = $1`, [sessionId]);
    return new Set(result.rows.map((row) => `${row.instrument_id}|${row.direction}|${row.canonical_decision_at.toISOString()}`));
  }
}
