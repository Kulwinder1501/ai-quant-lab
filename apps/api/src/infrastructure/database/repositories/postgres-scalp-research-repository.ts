import type { PoolClient, QueryResultRow } from "pg";
import type { DatabasePool } from "../database.js";
import {
  matchingPolicyVersion,
  type ImmutableStrategyProposal,
  type MarketOpportunity,
  type RecordedRiskDecision,
  type ResearchControlPoint,
  type ResearchRiskSnapshot,
  type ResearchRiskSubject,
  type ResearchSettlementObservation,
  type ResearchStrategyDefinition,
  type ResearchTerminalSettlement,
} from "../../../modules/research/scalp-harness/domain/contracts.js";
import { controlMatchKey } from "../../../modules/research/scalp-harness/domain/matched-controls.js";
import { opportunityMembershipKey } from "../../../modules/research/scalp-harness/domain/opportunity-resolver.js";
import { logicalKey, sha256CanonicalJson } from "../../../modules/platform/identity/identity.js";

interface ImmutableRow extends QueryResultRow { id: string; payload_hash: string }

export class IdempotencyPayloadConflictError extends Error {
  constructor(readonly logicalKeyValue: string, readonly existingPayloadHash: string, readonly incomingPayloadHash: string) {
    super(`Idempotent retry for ${logicalKeyValue} changed payload (${existingPayloadHash} != ${incomingPayloadHash}).`);
    this.name = "IdempotencyPayloadConflictError";
  }
}

async function insertImmutable(input: {
  client: Pick<PoolClient, "query">;
  insertSql: string;
  insertValues: readonly unknown[];
  lookupSql: string;
  logicalKeyValue: string;
  payloadHash: string;
}): Promise<string> {
  const inserted = await input.client.query<ImmutableRow>(input.insertSql, input.insertValues as unknown[]);
  const row = inserted.rows[0] ?? (await input.client.query<ImmutableRow>(input.lookupSql, [input.logicalKeyValue])).rows[0];
  if (!row) throw new Error(`Immutable write for ${input.logicalKeyValue} returned no row.`);
  if (row.payload_hash !== input.payloadHash) {
    throw new IdempotencyPayloadConflictError(input.logicalKeyValue, row.payload_hash, input.payloadHash);
  }
  return row.id;
}

export class PostgresScalpResearchRepository {
  constructor(private readonly database: DatabasePool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async saveStrategyDefinition(definition: ResearchStrategyDefinition): Promise<string> {
    const payloadHash = sha256CanonicalJson(definition);
    return insertImmutable({
      client: this.database,
      insertSql: `
        INSERT INTO research_scalp.strategy_definitions (
          strategy_definition_hash, strategy_key, research_version, feature_schema_version,
          implementation_artifact_checksum, configuration, payload_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (strategy_definition_hash) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [definition.strategyDefinitionHash, definition.strategyKey, definition.researchVersion,
        definition.featureSchemaVersion, definition.implementationArtifactChecksum, definition.configuration, payloadHash],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.strategy_definitions WHERE strategy_definition_hash = $1",
      logicalKeyValue: definition.strategyDefinitionHash,
      payloadHash,
    });
  }

  async saveProposal(proposal: ImmutableStrategyProposal): Promise<ImmutableStrategyProposal & { id: string }> {
    const id = await insertImmutable({
      client: this.database,
      insertSql: `
        INSERT INTO research_scalp.proposals (
          proposal_key, payload_hash, strategy_definition_hash, strategy_key, strategy_research_version,
          instrument_id, source_candle_id, reference_candle_id, timeframe, direction, decision_at,
          data_through, reference_price, setup_type, setup_fingerprint, native_geometry, raw_context
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        ON CONFLICT (proposal_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [proposal.proposalKey, proposal.payloadHash, proposal.strategyDefinitionHash, proposal.strategyKey,
        proposal.strategyResearchVersion, proposal.instrumentId, proposal.sourceCandleId, proposal.referenceCandleId,
        proposal.timeframe, proposal.direction, proposal.decisionAt, proposal.dataThrough, proposal.referencePrice,
        proposal.setupType, proposal.setupFingerprint, proposal.nativeGeometry, proposal.rawContext],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.proposals WHERE proposal_key = $1",
      logicalKeyValue: proposal.proposalKey,
      payloadHash: proposal.payloadHash,
    });
    return { ...proposal, id };
  }

  async saveOpportunity(opportunity: MarketOpportunity): Promise<MarketOpportunity & { id: string }> {
    return this.transaction(async (client) => {
      const id = await insertImmutable({
        client,
        insertSql: `
          INSERT INTO research_scalp.opportunities (
            opportunity_key, payload_hash, instrument_id, session_id, session_close_at, direction, canonical_decision_at,
            data_through, reference_price, reference_candle_id, grouping_policy_version, reference_policy_version
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (opportunity_key) DO NOTHING RETURNING id, payload_hash`,
        insertValues: [opportunity.opportunityKey, opportunity.payloadHash, opportunity.instrumentId,
          opportunity.sessionId, opportunity.sessionCloseAt, opportunity.direction, opportunity.canonicalDecisionAt, opportunity.dataThrough,
          opportunity.referencePrice, opportunity.referenceCandleId, opportunity.groupingPolicyVersion,
          opportunity.referencePolicyVersion],
        lookupSql: "SELECT id, payload_hash FROM research_scalp.opportunities WHERE opportunity_key = $1",
        logicalKeyValue: opportunity.opportunityKey,
        payloadHash: opportunity.payloadHash,
      });
      for (const proposalId of opportunity.proposalIds) {
        const membershipKey = opportunityMembershipKey(id, proposalId);
        const payloadHash = sha256CanonicalJson({ membershipKey, opportunityId: id, proposalId });
        await insertImmutable({
          client,
          insertSql: `INSERT INTO research_scalp.opportunity_memberships
            (membership_key, opportunity_id, proposal_id, payload_hash) VALUES ($1,$2,$3,$4)
            ON CONFLICT (membership_key) DO NOTHING RETURNING id, payload_hash`,
          insertValues: [membershipKey, id, proposalId, payloadHash],
          lookupSql: "SELECT id, payload_hash FROM research_scalp.opportunity_memberships WHERE membership_key = $1",
          logicalKeyValue: membershipKey,
          payloadHash,
        });
      }
      return { ...opportunity, id };
    });
  }

  async saveControlPoint(control: ResearchControlPoint): Promise<ResearchControlPoint & { id: string }> {
    const id = await insertImmutable({
      client: this.database,
      insertSql: `INSERT INTO research_scalp.control_points (
        control_point_key, payload_hash, instrument_id, source_candle_id, session_id, session_close_at, evaluation_direction,
        decision_at, data_through, reference_price, minute_of_day, volatility_regime, sample_eligible,
        ineligible_reason, control_policy_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (control_point_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [control.controlPointKey, control.payloadHash, control.instrumentId, control.sourceCandleId,
        control.sessionId, control.sessionCloseAt, control.evaluationDirection, control.decisionAt, control.dataThrough,
        control.referencePrice, control.minuteOfDay, control.volatilityRegime, control.sampleEligible,
        control.ineligibleReason, control.controlPolicyVersion],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.control_points WHERE control_point_key = $1",
      logicalKeyValue: control.controlPointKey,
      payloadHash: control.payloadHash,
    });
    return { ...control, id };
  }

  async saveControlMatches(input: {
    opportunityId: string;
    controlPointIds: readonly string[];
    equalWeight: number;
  }): Promise<void> {
    await this.transaction(async (client) => {
      for (const controlPointId of input.controlPointIds) {
        const key = controlMatchKey(input.opportunityId, controlPointId);
        const stablePayloadHash = sha256CanonicalJson({
          controlMatchKey: key,
          opportunityId: input.opportunityId,
          controlPointId,
          matchingPolicyVersion,
          equalWeight: input.equalWeight,
        });
        await insertImmutable({
          client,
          insertSql: `INSERT INTO research_scalp.control_matches
            (control_match_key, payload_hash, opportunity_id, control_point_id, matching_policy_version, equal_weight)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (control_match_key) DO NOTHING RETURNING id, payload_hash`,
          insertValues: [key, stablePayloadHash, input.opportunityId, controlPointId, matchingPolicyVersion, input.equalWeight],
          lookupSql: "SELECT id, payload_hash FROM research_scalp.control_matches WHERE control_match_key = $1",
          logicalKeyValue: key,
          payloadHash: stablePayloadHash,
        });
      }
    });
  }

  async saveRiskSnapshot(snapshot: ResearchRiskSnapshot): Promise<ResearchRiskSnapshot & { id: string }> {
    const id = await insertImmutable({
      client: this.database,
      insertSql: `INSERT INTO research_scalp.risk_snapshots
        (risk_snapshot_key, payload_hash, account_id, as_of, state, risk_snapshot_policy_version)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (risk_snapshot_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [snapshot.riskSnapshotKey, snapshot.payloadHash, snapshot.accountId, snapshot.asOf,
        snapshot.state, snapshot.riskSnapshotPolicyVersion],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.risk_snapshots WHERE risk_snapshot_key = $1",
      logicalKeyValue: snapshot.riskSnapshotKey,
      payloadHash: snapshot.payloadHash,
    });
    return { ...snapshot, id };
  }

  async saveRiskSubject(subject: ResearchRiskSubject): Promise<ResearchRiskSubject & { id: string }> {
    const id = await insertImmutable({
      client: this.database,
      insertSql: `INSERT INTO research_scalp.risk_subjects
        (risk_subject_key, payload_hash, subject_type, subject_id, instrument_id, decision_at, session_close_at,
         geometry, geometry_policy_version, lot_size)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (risk_subject_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [subject.riskSubjectKey, subject.payloadHash, subject.subjectType, subject.subjectId,
        subject.instrumentId, subject.decisionAt, subject.sessionCloseAt, subject.geometry, subject.geometry.geometryPolicyVersion, subject.lotSize],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.risk_subjects WHERE risk_subject_key = $1",
      logicalKeyValue: subject.riskSubjectKey,
      payloadHash: subject.payloadHash,
    });
    return { ...subject, id };
  }

  async saveRiskDecision(decision: RecordedRiskDecision): Promise<string> {
    return insertImmutable({
      client: this.database,
      insertSql: `INSERT INTO research_scalp.risk_decisions
        (risk_decision_key, payload_hash, risk_subject_id, risk_snapshot_id, risk_policy_version, decision)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (risk_decision_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [decision.riskDecisionKey, decision.payloadHash, decision.riskSubjectId,
        decision.riskSnapshotId, decision.riskPolicyVersion, decision.decision],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.risk_decisions WHERE risk_decision_key = $1",
      logicalKeyValue: decision.riskDecisionKey,
      payloadHash: decision.payloadHash,
    });
  }

  async saveSettlements(input: {
    observations: readonly ResearchSettlementObservation[];
    terminal: ResearchTerminalSettlement | null;
  }): Promise<void> {
    await this.transaction(async (client) => {
      for (const item of input.observations) await this.saveObservation(client, item);
      if (input.terminal) await this.saveTerminal(client, input.terminal);
    });
  }

  private async saveObservation(client: PoolClient, item: ResearchSettlementObservation): Promise<void> {
    await insertImmutable({
      client,
      insertSql: `INSERT INTO research_scalp.settlement_observations (
        observation_key, payload_hash, subject_type, subject_id, horizon_minutes, horizon_end_at,
        horizon_eligible, status, status_reason, mfe_bps, mae_bps, target_touched, stop_touched,
        entry_triggered_at, first_target_touch_at, first_stop_touch_at, bars_expected, bars_observed,
        geometry_policy_version, fill_policy_version, settlement_policy_version, settlement_definition_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (observation_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [item.observationKey, item.payloadHash, item.subjectType, item.subjectId, item.horizonMinutes,
        item.horizonEndAt, item.horizonEligible, item.status, item.statusReason, item.mfeBps, item.maeBps,
        item.targetTouchedByHorizon, item.stopTouchedByHorizon, item.entryTriggeredAt, item.firstTargetTouchAt,
        item.firstStopTouchAt, item.barsExpected, item.barsObserved, item.geometryPolicyVersion,
        item.fillPolicyVersion, item.settlementPolicyVersion, item.settlementDefinitionHash],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.settlement_observations WHERE observation_key = $1",
      logicalKeyValue: item.observationKey,
      payloadHash: item.payloadHash,
    });
  }

  private async saveTerminal(client: PoolClient, item: ResearchTerminalSettlement): Promise<void> {
    await insertImmutable({
      client,
      insertSql: `INSERT INTO research_scalp.terminal_settlements (
        terminal_settlement_key, payload_hash, subject_type, subject_id, outcome, outcome_reason,
        entry_fill_condition, exit_fill_condition, entry_triggered_at, resolved_at, entry_fill_price, exit_fill_price, return_bps,
        r_multiple, geometry_policy_version, fill_policy_version, settlement_policy_version,
        settlement_definition_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      ON CONFLICT (terminal_settlement_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [item.terminalSettlementKey, item.payloadHash, item.subjectType, item.subjectId,
        item.outcome, item.outcomeReason, item.entryFillCondition, item.exitFillCondition, item.entryTriggeredAt, item.resolvedAt,
        item.entryFillPrice, item.exitFillPrice, item.returnBps, item.rMultiple, item.geometryPolicyVersion,
        item.fillPolicyVersion, item.settlementPolicyVersion, item.settlementDefinitionHash],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.terminal_settlements WHERE terminal_settlement_key = $1",
      logicalKeyValue: item.terminalSettlementKey,
      payloadHash: item.payloadHash,
    });
  }

  async appendEvent(input: {
    entityId: string;
    eventType: string;
    policyVersion: string;
    logicalEventAt: Date;
    causationId: string;
    payload: Record<string, unknown>;
  }): Promise<string> {
    const eventKey = logicalKey("event", [input.entityId, input.eventType, input.policyVersion,
      input.logicalEventAt, input.causationId]);
    const payloadHash = sha256CanonicalJson({ eventKey, ...input });
    return insertImmutable({
      client: this.database,
      insertSql: `INSERT INTO research_scalp.events
        (event_key, payload_hash, entity_id, event_type, policy_version, logical_event_at, causation_id, payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (event_key) DO NOTHING RETURNING id, payload_hash`,
      insertValues: [eventKey, payloadHash, input.entityId, input.eventType, input.policyVersion,
        input.logicalEventAt, input.causationId, input.payload],
      lookupSql: "SELECT id, payload_hash FROM research_scalp.events WHERE event_key = $1",
      logicalKeyValue: eventKey,
      payloadHash,
    });
  }
}
