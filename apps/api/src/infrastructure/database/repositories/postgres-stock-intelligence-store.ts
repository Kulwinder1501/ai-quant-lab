import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import { fromDateColumn, toDateKey } from "../date-column.js";
import type {
  AsReportedFundamental,
  CanonicalFact,
  CanonicalFeature,
  CanonicalRawRecord,
  CanonicalSignal,
  CorporateActionRecord,
  FundamentalOrigin,
} from "../../../modules/stock-intelligence/domain/canonical.js";
import { YAHOO_DAILY_BAR_SOURCE_KIND } from "../../../modules/stock-intelligence/domain/adapters.js";
import { aliasKey } from "../../../modules/stock-intelligence/domain/identity.js";
import type {
  ReplayJob,
  ReplayJobKind,
  ReplayJobStatus,
  ReplayPair,
  ReplayPairCensorship,
  ReplayPairResult,
  ReplayPairStatus,
} from "../../../modules/stock-intelligence/domain/replay.js";
import type { Gate7Report } from "../../../modules/stock-intelligence/domain/gate7.js";
import type { HoldingOverlay, WatchlistOverlay } from "../../../modules/stock-intelligence/domain/consumer-context.js";
import type { DecayMarkKind, PredictionDecayMark } from "../../../modules/stock-intelligence/domain/decay.js";
import type { PredictionSnapshot } from "../../../modules/stock-intelligence/domain/snapshot.js";
import type { PredictionSnapshotStatus } from "../../../modules/stock-intelligence/domain/status.js";
import type { DataQualityScores, StockIntelligenceHorizon } from "../../../modules/stock-intelligence/domain/data-quality.js";
import type { CalibrationSource, ReturnDistribution, ScenarioSet } from "../../../modules/stock-intelligence/domain/outcome-model.js";
import type { InstrumentAlias, StockIntelligenceStore } from "../../../modules/stock-intelligence/domain/store.js";
import type { InstrumentExistence, StockIntelligenceUniverse, UniverseMembership } from "../../../modules/stock-intelligence/domain/universe.js";
import type { StockIntelligenceVersions } from "../../../modules/stock-intelligence/domain/versions.js";

interface IdRow extends QueryResultRow {
  id: string;
}

export class PostgresStockIntelligenceStore implements StockIntelligenceStore {
  constructor(private readonly database: DatabaseQueryable) {}

  async findAlias(alias: string): Promise<string | null> {
    const result = await this.database.query<{ instrument_id: string }>(`
      SELECT instrument_id FROM stock_intelligence.aliases WHERE alias = $1
    `, [aliasKey(alias)]);
    return result.rows[0]?.instrument_id ?? null;
  }

  async upsertAlias(alias: InstrumentAlias): Promise<void> {
    await this.database.query(`
      INSERT INTO stock_intelligence.aliases (alias, instrument_id)
      VALUES ($1, $2)
      ON CONFLICT (alias) DO NOTHING
    `, [aliasKey(alias.alias), alias.instrumentId]);
  }

  async listMemberships(instrumentId: string): Promise<UniverseMembership[]> {
    return this.mapMemberships(await this.database.query<{
      instrument_id: string;
      universe: StockIntelligenceUniverse;
      effective_from: Date;
      effective_to: Date | null;
      available_at: Date;
      provenance: UniverseMembership["provenance"];
    }>(`
      SELECT instrument_id, universe, effective_from, effective_to, available_at, provenance
      FROM stock_intelligence.universe_memberships
      WHERE instrument_id = $1
      ORDER BY available_at DESC
    `, [instrumentId]));
  }

  async listAllMemberships(universes?: readonly StockIntelligenceUniverse[]): Promise<UniverseMembership[]> {
    const result = universes && universes.length > 0
      ? await this.database.query<{
        instrument_id: string;
        universe: StockIntelligenceUniverse;
        effective_from: Date;
        effective_to: Date | null;
        available_at: Date;
        provenance: UniverseMembership["provenance"];
      }>(`
        SELECT instrument_id, universe, effective_from, effective_to, available_at, provenance
        FROM stock_intelligence.universe_memberships
        WHERE universe = ANY($1::text[])
        ORDER BY available_at DESC
      `, [universes])
      : await this.database.query<{
        instrument_id: string;
        universe: StockIntelligenceUniverse;
        effective_from: Date;
        effective_to: Date | null;
        available_at: Date;
        provenance: UniverseMembership["provenance"];
      }>(`
        SELECT instrument_id, universe, effective_from, effective_to, available_at, provenance
        FROM stock_intelligence.universe_memberships
        ORDER BY available_at DESC
      `);
    return this.mapMemberships(result);
  }

  private mapMemberships(result: { rows: Array<{
    instrument_id: string;
    universe: StockIntelligenceUniverse;
    effective_from: Date;
    effective_to: Date | null;
    available_at: Date;
    provenance: UniverseMembership["provenance"];
  }> }): UniverseMembership[] {
    return result.rows.map((row) => ({
      instrumentId: row.instrument_id,
      universe: row.universe,
      effectiveFrom: row.effective_from,
      effectiveTo: row.effective_to,
      availableAt: row.available_at,
      provenance: row.provenance,
    }));
  }

  async upsertMembership(membership: UniverseMembership): Promise<void> {
    await this.database.query(`
      INSERT INTO stock_intelligence.universe_memberships (
        instrument_id, universe, effective_from, effective_to, available_at, provenance
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      membership.instrumentId,
      membership.universe,
      membership.effectiveFrom,
      membership.effectiveTo,
      membership.availableAt,
      membership.provenance,
    ]);
  }

  async findExistenceAsOf(instrumentId: string, asOf: Date): Promise<InstrumentExistence | null> {
    const result = await this.database.query<{
      instrument_id: string;
      listed_from: Date | string | null;
      listed_to: Date | string | null;
      available_at: Date;
    }>(`
      SELECT instrument_id, listed_from, listed_to, available_at
      FROM stock_intelligence.existence
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY available_at DESC
      LIMIT 1
    `, [instrumentId, asOf]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      instrumentId: row.instrument_id,
      listedFrom: row.listed_from == null ? null : fromDateColumn(row.listed_from),
      listedTo: row.listed_to == null ? null : fromDateColumn(row.listed_to),
      availableAt: row.available_at,
    };
  }

  async listAllExistence(): Promise<InstrumentExistence[]> {
    const result = await this.database.query<{
      instrument_id: string;
      listed_from: Date | string | null;
      listed_to: Date | string | null;
      available_at: Date;
    }>(`
      SELECT instrument_id, listed_from, listed_to, available_at
      FROM stock_intelligence.existence
      ORDER BY instrument_id ASC, available_at DESC
    `);
    return result.rows.map((row) => ({
      instrumentId: row.instrument_id,
      listedFrom: row.listed_from == null ? null : fromDateColumn(row.listed_from),
      listedTo: row.listed_to == null ? null : fromDateColumn(row.listed_to),
      availableAt: row.available_at,
    }));
  }

  async upsertExistence(existence: InstrumentExistence): Promise<void> {
    await this.database.query(`
      INSERT INTO stock_intelligence.existence (instrument_id, listed_from, listed_to, available_at)
      VALUES ($1, $2, $3, $4)
    `, [
      existence.instrumentId,
      existence.listedFrom ? toDateKey(existence.listedFrom) : null,
      existence.listedTo ? toDateKey(existence.listedTo) : null,
      existence.availableAt,
    ]);
  }

  async insertRaw(record: Omit<CanonicalRawRecord, "rawId"> & { rawId?: string }): Promise<string> {
    const params = [
      record.rawId ?? null,
      record.instrumentId,
      record.sourceKind,
      JSON.stringify(record.payload),
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
      record.dataSchemaVersion,
    ];
    const insertSql = `
      INSERT INTO stock_intelligence.raw_records (
        id, instrument_id, source_kind, payload, published_at, effective_at, available_at, data_schema_version
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5, $6, $7, $8)
    `;
    if (record.sourceKind === YAHOO_DAILY_BAR_SOURCE_KIND && record.instrumentId) {
      const result = await this.database.query<IdRow>(`
        ${insertSql}
        ON CONFLICT (instrument_id, source_kind, effective_at)
          WHERE source_kind = 'yahoo_daily_bar' AND instrument_id IS NOT NULL
        DO NOTHING
        RETURNING id
      `, params);
      if (result.rows[0]?.id) return result.rows[0].id;
      const existing = await this.database.query<IdRow>(`
        SELECT id FROM stock_intelligence.raw_records
        WHERE instrument_id = $1 AND source_kind = $2 AND effective_at = $3
        LIMIT 1
      `, [record.instrumentId, record.sourceKind, record.effectiveAt]);
      return existing.rows[0]!.id;
    }
    const result = await this.database.query<IdRow>(`${insertSql} RETURNING id`, params);
    return result.rows[0]!.id;
  }

  async listRawAsOf(instrumentId: string, dataCutoff: Date, sourceKind?: string): Promise<CanonicalRawRecord[]> {
    const result = sourceKind
      ? await this.database.query<{
        id: string;
        instrument_id: string | null;
        source_kind: string;
        payload: Record<string, unknown>;
        published_at: Date;
        effective_at: Date;
        available_at: Date;
        data_schema_version: string;
      }>(`
        SELECT id, instrument_id, source_kind, payload, published_at, effective_at, available_at, data_schema_version
        FROM stock_intelligence.raw_records
        WHERE instrument_id = $1 AND available_at <= $2 AND source_kind = $3
        ORDER BY available_at ASC
      `, [instrumentId, dataCutoff, sourceKind])
      : await this.database.query<{
        id: string;
        instrument_id: string | null;
        source_kind: string;
        payload: Record<string, unknown>;
        published_at: Date;
        effective_at: Date;
        available_at: Date;
        data_schema_version: string;
      }>(`
        SELECT id, instrument_id, source_kind, payload, published_at, effective_at, available_at, data_schema_version
        FROM stock_intelligence.raw_records
        WHERE instrument_id = $1 AND available_at <= $2
        ORDER BY available_at ASC
      `, [instrumentId, dataCutoff]);
    return result.rows.map((row) => ({
      rawId: row.id,
      instrumentId: row.instrument_id,
      sourceKind: row.source_kind,
      payload: row.payload,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
      dataSchemaVersion: row.data_schema_version,
    }));
  }

  async insertFact(record: Omit<CanonicalFact, "factId"> & { factId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.canonical_facts (
        id, instrument_id, fact_name, fact_value, source_raw_id, source_document, source_page,
        extraction_model, extraction_version, published_at, effective_at, available_at, data_schema_version
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `, [
      record.factId ?? null,
      record.instrumentId,
      record.factName,
      JSON.stringify(record.factValue),
      record.sourceRawId,
      record.sourceDocument,
      record.sourcePage,
      record.extractionModel,
      record.extractionVersion,
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
      record.dataSchemaVersion,
    ]);
    return result.rows[0]!.id;
  }

  async insertFeature(record: Omit<CanonicalFeature, "featureId"> & { featureId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.derived_features (
        id, instrument_id, feature_name, feature_value, derived_from_fact_ids, feature_version,
        published_at, effective_at, available_at
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5::uuid[], $6, $7, $8, $9)
      ON CONFLICT (instrument_id, feature_name, effective_at, feature_version) DO NOTHING
      RETURNING id
    `, [
      record.featureId ?? null,
      record.instrumentId,
      record.featureName,
      JSON.stringify(record.featureValue),
      record.derivedFromFactIds,
      record.featureVersion,
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
    ]);
    // Immutable table: conflict means the row already exists. Callers in replay don't
    // need the id, so skip the follow-up SELECT that doubled every conflict round-trip.
    return result.rows[0]?.id ?? record.featureId ?? "existing-feature";
  }

  async listFeaturesAsOf(instrumentId: string, dataCutoff: Date): Promise<CanonicalFeature[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      feature_name: string;
      feature_value: Record<string, unknown>;
      derived_from_fact_ids: string[] | null;
      feature_version: string;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
    }>(`
      SELECT id, instrument_id, feature_name, feature_value, derived_from_fact_ids, feature_version,
             published_at, effective_at, available_at
      FROM stock_intelligence.derived_features
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY available_at DESC
    `, [instrumentId, dataCutoff]);
    return result.rows.map((row) => ({
      featureId: row.id,
      instrumentId: row.instrument_id,
      featureName: row.feature_name,
      featureValue: row.feature_value,
      derivedFromFactIds: row.derived_from_fact_ids ?? [],
      featureVersion: row.feature_version,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
    }));
  }

  async listFeaturesBefore(before: Date): Promise<CanonicalFeature[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      feature_name: string;
      feature_value: Record<string, unknown>;
      derived_from_fact_ids: string[] | null;
      feature_version: string;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
    }>(`
      SELECT id, instrument_id, feature_name, feature_value, derived_from_fact_ids, feature_version,
             published_at, effective_at, available_at
      FROM stock_intelligence.derived_features
      WHERE available_at < $1
      ORDER BY available_at ASC
    `, [before]);
    return result.rows.map((row) => ({
      featureId: row.id,
      instrumentId: row.instrument_id,
      featureName: row.feature_name,
      featureValue: row.feature_value,
      derivedFromFactIds: row.derived_from_fact_ids ?? [],
      featureVersion: row.feature_version,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
    }));
  }

  async insertSignal(record: Omit<CanonicalSignal, "signalId"> & { signalId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.signals (
        id, instrument_id, signal_name, signal_value, strength, derived_from, source_facts,
        feature_version, engine_version, published_at, effective_at, available_at
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
      ON CONFLICT (instrument_id, signal_name, effective_at, engine_version) DO NOTHING
      RETURNING id
    `, [
      record.signalId ?? null,
      record.instrumentId,
      record.signalName,
      JSON.stringify(record.signalValue),
      record.strength,
      JSON.stringify(record.derivedFrom),
      JSON.stringify(record.sourceFacts),
      record.featureVersion,
      record.engineVersion,
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
    ]);
    if (result.rows[0]?.id) return result.rows[0].id;
    return record.signalId ?? "existing-signal";
  }

  async insertFundamentalSnapshot(record: Omit<AsReportedFundamental, "snapshotId"> & { snapshotId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.fundamental_snapshots (
        id, instrument_id, field, value, origin, report_date, period_end,
        published_at, effective_at, available_at, data_schema_version
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING id
    `, [
      record.snapshotId ?? null,
      record.instrumentId,
      record.field,
      record.value,
      record.origin,
      record.reportDate,
      record.periodEnd,
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
      record.dataSchemaVersion,
    ]);
    return result.rows[0]!.id;
  }

  async insertCorporateAction(record: Omit<CorporateActionRecord, "actionId"> & { actionId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.corporate_actions (
        id, instrument_id, action_type, ex_date, details, published_at, effective_at, available_at
      ) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (instrument_id, action_type, ex_date) DO NOTHING
      RETURNING id
    `, [
      record.actionId ?? null,
      record.instrumentId,
      record.actionType,
      record.exDate,
      JSON.stringify(record.details),
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
    ]);
    if (result.rows[0]?.id) return result.rows[0].id;
    const existing = await this.database.query<IdRow>(`
      SELECT id FROM stock_intelligence.corporate_actions
      WHERE instrument_id = $1 AND action_type = $2 AND ex_date = $3
      LIMIT 1
    `, [record.instrumentId, record.actionType, record.exDate]);
    return existing.rows[0]!.id;
  }

  async listCorporateActionsAsOf(instrumentId: string, dataCutoff: Date): Promise<CorporateActionRecord[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      action_type: CorporateActionRecord["actionType"];
      ex_date: Date | string;
      details: Record<string, unknown>;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
    }>(`
      SELECT id, instrument_id, action_type, ex_date, details, published_at, effective_at, available_at
      FROM stock_intelligence.corporate_actions
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY ex_date ASC
    `, [instrumentId, dataCutoff]);
    return result.rows.map((row) => ({
      actionId: row.id,
      instrumentId: row.instrument_id,
      actionType: row.action_type,
      exDate: toDateKey(fromDateColumn(row.ex_date)),
      details: row.details,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
    }));
  }

  async listFactsAsOf(instrumentId: string, dataCutoff: Date): Promise<CanonicalFact[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      fact_name: string;
      fact_value: Record<string, unknown>;
      source_raw_id: string | null;
      source_document: string | null;
      source_page: number | null;
      extraction_model: string | null;
      extraction_version: string | null;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
      data_schema_version: string;
    }>(`
      SELECT id, instrument_id, fact_name, fact_value, source_raw_id, source_document, source_page,
             extraction_model, extraction_version, published_at, effective_at, available_at, data_schema_version
      FROM stock_intelligence.canonical_facts
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY available_at DESC
    `, [instrumentId, dataCutoff]);
    return result.rows.map((row) => ({
      factId: row.id,
      instrumentId: row.instrument_id,
      factName: row.fact_name,
      factValue: row.fact_value,
      sourceRawId: row.source_raw_id,
      sourceDocument: row.source_document,
      sourcePage: row.source_page,
      extractionModel: row.extraction_model,
      extractionVersion: row.extraction_version,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
      dataSchemaVersion: row.data_schema_version,
    }));
  }

  async listSignalsAsOf(instrumentId: string, dataCutoff: Date): Promise<CanonicalSignal[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      signal_name: string;
      signal_value: Record<string, unknown>;
      strength: string | null;
      derived_from: Record<string, unknown>;
      source_facts: Record<string, unknown>;
      feature_version: string;
      engine_version: string;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
    }>(`
      SELECT id, instrument_id, signal_name, signal_value, strength, derived_from, source_facts,
             feature_version, engine_version, published_at, effective_at, available_at
      FROM stock_intelligence.signals
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY available_at DESC
    `, [instrumentId, dataCutoff]);
    return result.rows.map((row) => ({
      signalId: row.id,
      instrumentId: row.instrument_id,
      signalName: row.signal_name,
      signalValue: row.signal_value,
      strength: row.strength === null ? null : Number(row.strength),
      derivedFrom: row.derived_from,
      sourceFacts: row.source_facts,
      featureVersion: row.feature_version,
      engineVersion: row.engine_version,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
    }));
  }

  async listSignalsBefore(before: Date, signalName: string): Promise<CanonicalSignal[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      signal_name: string;
      signal_value: Record<string, unknown>;
      strength: string | null;
      derived_from: Record<string, unknown>;
      source_facts: Record<string, unknown>;
      feature_version: string;
      engine_version: string;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
    }>(`
      SELECT id, instrument_id, signal_name, signal_value, strength, derived_from, source_facts,
             feature_version, engine_version, published_at, effective_at, available_at
      FROM stock_intelligence.signals
      WHERE signal_name = $1 AND available_at < $2
      ORDER BY available_at ASC
    `, [signalName, before]);
    return result.rows.map((row) => ({
      signalId: row.id,
      instrumentId: row.instrument_id,
      signalName: row.signal_name,
      signalValue: row.signal_value,
      strength: row.strength === null ? null : Number(row.strength),
      derivedFrom: row.derived_from,
      sourceFacts: row.source_facts,
      featureVersion: row.feature_version,
      engineVersion: row.engine_version,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
    }));
  }

  async listFundamentalsAsOf(instrumentId: string, dataCutoff: Date): Promise<AsReportedFundamental[]> {
    const result = await this.database.query<{
      id: string;
      instrument_id: string;
      field: string;
      value: string;
      origin: FundamentalOrigin;
      report_date: Date | string;
      period_end: Date | string;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
      data_schema_version: string;
    }>(`
      SELECT id, instrument_id, field, value, origin, report_date, period_end,
             published_at, effective_at, available_at, data_schema_version
      FROM stock_intelligence.fundamental_snapshots
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY available_at DESC
    `, [instrumentId, dataCutoff]);
    return result.rows.map((row) => ({
      snapshotId: row.id,
      instrumentId: row.instrument_id,
      field: row.field,
      value: row.value,
      origin: row.origin,
      reportDate: toDateKey(fromDateColumn(row.report_date)),
      periodEnd: toDateKey(fromDateColumn(row.period_end)),
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
      dataSchemaVersion: row.data_schema_version,
    }));
  }

  async createReplayJob(input: {
    remainingPairs: readonly ReplayPair[];
    jobKind?: ReplayJobKind;
    windowFrom?: string;
    windowTo?: string;
    pipelineVersions: StockIntelligenceVersions;
  }): Promise<ReplayJob> {
    const result = await this.database.query<{
      id: string;
      status: ReplayJobStatus;
      job_kind: ReplayJobKind;
      completed_pairs: ReplayPair[];
      remaining_pairs: ReplayPair[];
      last_checkpoint: Date | null;
      pipeline_versions: StockIntelligenceVersions;
      window_from: Date | string | null;
      window_to: Date | string | null;
    }>(`
      INSERT INTO stock_intelligence.replay_jobs (
        status, completed_pairs, remaining_pairs, last_checkpoint,
        pipeline_versions, window_from, window_to, job_kind
      ) VALUES (
        'RUNNING', '[]'::jsonb, $1::jsonb, CURRENT_TIMESTAMP, $2::jsonb, $3, $4, $5
      )
      RETURNING id, status, job_kind, completed_pairs, remaining_pairs, last_checkpoint,
                pipeline_versions, window_from, window_to
    `, [
      JSON.stringify(input.remainingPairs),
      JSON.stringify(input.pipelineVersions),
      input.windowFrom ?? null,
      input.windowTo ?? null,
      input.jobKind ?? "monthly_data_replay",
    ]);
    return mapReplayJob(result.rows[0]!);
  }

  async getReplayJob(jobId: string): Promise<ReplayJob | null> {
    const result = await this.database.query<{
      id: string;
      status: ReplayJobStatus;
      job_kind: ReplayJobKind;
      completed_pairs: ReplayPair[];
      remaining_pairs: ReplayPair[];
      last_checkpoint: Date | null;
      pipeline_versions: StockIntelligenceVersions;
      window_from: Date | string | null;
      window_to: Date | string | null;
    }>(`
      SELECT id, status, job_kind, completed_pairs, remaining_pairs, last_checkpoint,
             pipeline_versions, window_from, window_to
      FROM stock_intelligence.replay_jobs
      WHERE id = $1
    `, [jobId]);
    const row = result.rows[0];
    return row ? mapReplayJob(row) : null;
  }

  async checkpointReplayJob(input: {
    jobId: string;
    status: ReplayJobStatus;
    completedPairs: readonly ReplayPair[];
    remainingPairs: readonly ReplayPair[];
  }): Promise<void> {
    await this.database.query(`
      UPDATE stock_intelligence.replay_jobs
      SET status = $2,
          completed_pairs = $3::jsonb,
          remaining_pairs = $4::jsonb,
          last_checkpoint = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `, [
      input.jobId,
      input.status,
      JSON.stringify(input.completedPairs),
      JSON.stringify(input.remainingPairs),
    ]);
  }

  async insertReplayPairResult(result: ReplayPairResult): Promise<void> {
    await this.database.query(`
      INSERT INTO stock_intelligence.replay_pair_results (
        job_id, instrument_id, as_of, status, eligibility_reason, pit_passed,
        market_bar_count, market_data_completeness, censorship, pipeline_versions
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
      ON CONFLICT (job_id, instrument_id, as_of) DO NOTHING
    `, [
      result.jobId,
      result.instrumentId,
      result.asOf,
      result.status,
      result.eligibilityReason,
      result.pitPassed,
      result.marketBarCount,
      result.marketDataCompleteness,
      JSON.stringify(result.censorship),
      JSON.stringify(result.pipelineVersions),
    ]);
  }

  async listReplayPairResults(jobId: string): Promise<ReplayPairResult[]> {
    const result = await this.database.query<{
      job_id: string;
      instrument_id: string;
      as_of: Date | string;
      status: ReplayPairStatus;
      eligibility_reason: string;
      pit_passed: boolean;
      market_bar_count: number;
      market_data_completeness: string | number;
      censorship: ReplayPairCensorship;
      pipeline_versions: StockIntelligenceVersions;
    }>(`
      SELECT job_id, instrument_id, as_of, status, eligibility_reason, pit_passed,
             market_bar_count, market_data_completeness, censorship, pipeline_versions
      FROM stock_intelligence.replay_pair_results
      WHERE job_id = $1
      ORDER BY as_of ASC, instrument_id ASC
    `, [jobId]);
    return result.rows.map((row) => ({
      jobId: row.job_id,
      instrumentId: row.instrument_id,
      asOf: toDateKey(fromDateColumn(row.as_of)),
      status: row.status,
      eligibilityReason: row.eligibility_reason,
      pitPassed: row.pit_passed,
      marketBarCount: Number(row.market_bar_count),
      marketDataCompleteness: Number(row.market_data_completeness),
      censorship: {
        eligibilityReason: row.censorship.eligibilityReason,
        pitViolationCount: row.censorship.pitViolationCount,
        marketBarCount: row.censorship.marketBarCount,
        marketDataCompleteness: row.censorship.marketDataCompleteness,
        fundamentalCompleteness: row.censorship.fundamentalCompleteness,
        featureCount: row.censorship.featureCount,
        documentCoverage: row.censorship.documentCoverage,
        analogueEffectiveSampleSize6m: row.censorship.analogueEffectiveSampleSize6m ?? 0,
        analogueEffectiveSampleSize12m: row.censorship.analogueEffectiveSampleSize12m ?? 0,
        outcomeNUsed6m: row.censorship.outcomeNUsed6m ?? 0,
        outcomeNUsed12m: row.censorship.outcomeNUsed12m ?? 0,
        rawProbabilityPositive6m: row.censorship.rawProbabilityPositive6m ?? null,
        calibratedProbabilityPositive6m: row.censorship.calibratedProbabilityPositive6m ?? null,
        calibrationSource6m: row.censorship.calibrationSource6m ?? "none",
      },
      pipelineVersions: row.pipeline_versions,
    }));
  }

  async insertSnapshot(record: Omit<PredictionSnapshot, "snapshotId"> & { snapshotId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.prediction_snapshots (
        id, instrument_id, prediction_as_of, data_cutoff, horizon, status, investor_facing,
        payload, outcome_model_version, calibration_model_version,
        published_at, effective_at, available_at
      ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13
      )
      ON CONFLICT (instrument_id, prediction_as_of, horizon, outcome_model_version, calibration_model_version)
      DO NOTHING
      RETURNING id
    `, [
      record.snapshotId ?? null,
      record.instrumentId,
      record.predictionAsOf,
      record.dataCutoff,
      record.horizon,
      record.status,
      record.investorFacing,
      JSON.stringify(snapshotPayload(record)),
      record.versions.outcomeModel,
      record.versions.calibrationModel,
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
    ]);
    if (result.rows[0]?.id) return result.rows[0].id;
    const existing = await this.database.query<IdRow>(`
      SELECT id FROM stock_intelligence.prediction_snapshots
      WHERE instrument_id = $1 AND prediction_as_of = $2 AND horizon = $3
        AND outcome_model_version = $4 AND calibration_model_version = $5
      LIMIT 1
    `, [
      record.instrumentId,
      record.predictionAsOf,
      record.horizon,
      record.versions.outcomeModel,
      record.versions.calibrationModel,
    ]);
    return existing.rows[0]!.id;
  }

  async listSnapshotsAsOf(instrumentId: string, dataCutoff: Date): Promise<PredictionSnapshot[]> {
    const result = await this.database.query<SnapshotRow>(`
      SELECT * FROM stock_intelligence.prediction_snapshots
      WHERE instrument_id = $1 AND available_at <= $2
      ORDER BY available_at DESC
    `, [instrumentId, dataCutoff]);
    return result.rows.map(mapSnapshotRow);
  }

  async listSnapshotsAvailableAt(dataCutoff: Date): Promise<PredictionSnapshot[]> {
    const result = await this.database.query<SnapshotRow>(`
      SELECT * FROM stock_intelligence.prediction_snapshots
      WHERE available_at <= $1
      ORDER BY available_at ASC
    `, [dataCutoff]);
    return result.rows.map(mapSnapshotRow);
  }

  async insertDecayMark(record: Omit<PredictionDecayMark, "markId"> & { markId?: string }): Promise<string> {
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.prediction_decay_marks (
        id, snapshot_id, mark_kind, as_of, forward_price_return, forward_total_return,
        max_drawdown, outcome_type, overlay_status, review_flag, payload,
        published_at, effective_at, available_at
      ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14
      )
      ON CONFLICT (snapshot_id, mark_kind, as_of) DO NOTHING
      RETURNING id
    `, [
      record.markId ?? null,
      record.snapshotId,
      record.markKind,
      record.asOf,
      record.forwardPriceReturn,
      record.forwardTotalReturn,
      record.maxDrawdown,
      record.outcomeType,
      record.overlayStatus,
      record.reviewFlag,
      JSON.stringify({}),
      record.publishedAt,
      record.effectiveAt,
      record.availableAt,
    ]);
    if (result.rows[0]?.id) return result.rows[0].id;
    const existing = await this.database.query<IdRow>(`
      SELECT id FROM stock_intelligence.prediction_decay_marks
      WHERE snapshot_id = $1 AND mark_kind = $2 AND as_of = $3
      LIMIT 1
    `, [record.snapshotId, record.markKind, record.asOf]);
    return existing.rows[0]!.id;
  }

  async listDecayMarks(snapshotId: string): Promise<PredictionDecayMark[]> {
    const result = await this.database.query<{
      id: string;
      snapshot_id: string;
      mark_kind: DecayMarkKind;
      as_of: Date | string;
      forward_price_return: string | number | null;
      forward_total_return: string | number | null;
      max_drawdown: string | number | null;
      outcome_type: PredictionDecayMark["outcomeType"];
      overlay_status: PredictionSnapshotStatus | null;
      review_flag: boolean;
      published_at: Date;
      effective_at: Date;
      available_at: Date;
    }>(`
      SELECT id, snapshot_id, mark_kind, as_of, forward_price_return, forward_total_return,
             max_drawdown, outcome_type, overlay_status, review_flag,
             published_at, effective_at, available_at
      FROM stock_intelligence.prediction_decay_marks
      WHERE snapshot_id = $1
      ORDER BY as_of ASC
    `, [snapshotId]);
    return result.rows.map((row) => ({
      markId: row.id,
      snapshotId: row.snapshot_id,
      markKind: row.mark_kind,
      asOf: fromDateColumn(row.as_of),
      forwardPriceReturn: row.forward_price_return === null ? null : Number(row.forward_price_return),
      forwardTotalReturn: row.forward_total_return === null ? null : Number(row.forward_total_return),
      maxDrawdown: row.max_drawdown === null ? null : Number(row.max_drawdown),
      outcomeType: row.outcome_type,
      overlayStatus: row.overlay_status,
      reviewFlag: row.review_flag,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      availableAt: row.available_at,
    }));
  }

  async listHoldings(): Promise<HoldingOverlay[]> {
    const result = await this.database.query<{
      instrument_id: string;
      entry_price: string | number;
      quantity: string | number;
      thesis: string | null;
    }>(`
      SELECT instrument_id, entry_price, quantity, thesis
      FROM stock_intelligence.investor_holdings
      ORDER BY updated_at DESC
    `);
    return result.rows.map((row) => ({
      instrumentId: row.instrument_id,
      entryPrice: Number(row.entry_price),
      quantity: Number(row.quantity),
      thesis: row.thesis,
    }));
  }

  async listInvestorWatchlist(): Promise<WatchlistOverlay[]> {
    const result = await this.database.query<{
      instrument_id: string;
      target_price: string | number | null;
      target_entry: string | number | null;
      notes: string | null;
    }>(`
      SELECT instrument_id, target_price, target_entry, notes
      FROM stock_intelligence.investor_watchlist
      ORDER BY updated_at DESC
    `);
    return result.rows.map((row) => ({
      instrumentId: row.instrument_id,
      targetPrice: row.target_price === null ? null : Number(row.target_price),
      targetEntry: row.target_entry === null ? null : Number(row.target_entry),
      notes: row.notes,
    }));
  }

  async insertGate7Report(record: Gate7Report & { reportId?: string }): Promise<string> {
    const asOf = new Date(`${record.evaluationAsOf}T23:59:59.999Z`);
    const result = await this.database.query<IdRow>(`
      INSERT INTO stock_intelligence.gate7_reports (
        id, job_id, evaluation_as_of, horizon, passed, payload,
        published_at, effective_at, available_at
      ) VALUES (
        COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::jsonb, $7, $8, $9
      )
      RETURNING id
    `, [
      record.reportId ?? null,
      record.jobId,
      record.evaluationAsOf,
      record.horizon,
      record.passed,
      JSON.stringify(record),
      asOf,
      asOf,
      asOf,
    ]);
    return result.rows[0]!.id;
  }

  async latestGate7Report(jobId: string, horizon: StockIntelligenceHorizon): Promise<Gate7Report | null> {
    const result = await this.database.query<{ payload: Gate7Report }>(`
      SELECT payload
      FROM stock_intelligence.gate7_reports
      WHERE job_id = $1 AND horizon = $2
      ORDER BY available_at DESC
      LIMIT 1
    `, [jobId, horizon]);
    return result.rows[0]?.payload ?? null;
  }
}

function mapReplayJob(row: {
  id: string;
  status: ReplayJobStatus;
  job_kind: ReplayJobKind;
  completed_pairs: ReplayPair[];
  remaining_pairs: ReplayPair[];
  last_checkpoint: Date | null;
  pipeline_versions: StockIntelligenceVersions;
  window_from: Date | string | null;
  window_to: Date | string | null;
}): ReplayJob {
  return {
    jobId: row.id,
    status: row.status,
    jobKind: row.job_kind,
    completedPairs: row.completed_pairs ?? [],
    remainingPairs: row.remaining_pairs ?? [],
    lastCheckpoint: row.last_checkpoint,
    pipelineVersions: row.pipeline_versions,
    windowFrom: row.window_from == null ? null : toDateKey(fromDateColumn(row.window_from)),
    windowTo: row.window_to == null ? null : toDateKey(fromDateColumn(row.window_to)),
  };
}

interface SnapshotPayload {
  regimeBucket: string | null;
  versions: StockIntelligenceVersions;
  dataQuality: DataQualityScores;
  analogueSet: PredictionSnapshot["analogueSet"];
  returnDistribution: ReturnDistribution | null;
  scenarios: ScenarioSet | null;
  rawProbabilityPositiveReturn: number | null;
  calibratedProbabilityPositiveReturn: number | null;
  calibrationSource: CalibrationSource;
  signalsSnapshot: Record<string, unknown>;
  entryPrice: number | null;
  corporateActionAdjustment: PredictionSnapshot["corporateActionAdjustment"];
}

interface SnapshotRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  prediction_as_of: Date;
  data_cutoff: Date;
  horizon: StockIntelligenceHorizon;
  status: PredictionSnapshotStatus;
  investor_facing: boolean;
  payload: SnapshotPayload;
  published_at: Date;
  effective_at: Date;
  available_at: Date;
}

function snapshotPayload(record: Omit<PredictionSnapshot, "snapshotId">): SnapshotPayload {
  return {
    regimeBucket: record.regimeBucket,
    versions: record.versions,
    dataQuality: record.dataQuality,
    analogueSet: record.analogueSet,
    returnDistribution: record.returnDistribution,
    scenarios: record.scenarios,
    rawProbabilityPositiveReturn: record.rawProbabilityPositiveReturn,
    calibratedProbabilityPositiveReturn: record.calibratedProbabilityPositiveReturn,
    calibrationSource: record.calibrationSource,
    signalsSnapshot: { ...record.signalsSnapshot },
    entryPrice: record.entryPrice,
    corporateActionAdjustment: record.corporateActionAdjustment,
  };
}

function mapSnapshotRow(row: SnapshotRow): PredictionSnapshot {
  const payload = row.payload;
  return {
    snapshotId: row.id,
    instrumentId: row.instrument_id,
    predictionAsOf: row.prediction_as_of,
    dataCutoff: row.data_cutoff,
    horizon: row.horizon,
    status: row.status,
    investorFacing: row.investor_facing,
    regimeBucket: payload.regimeBucket,
    versions: payload.versions,
    dataQuality: payload.dataQuality,
    analogueSet: payload.analogueSet,
    returnDistribution: payload.returnDistribution,
    scenarios: payload.scenarios,
    rawProbabilityPositiveReturn: payload.rawProbabilityPositiveReturn,
    calibratedProbabilityPositiveReturn: payload.calibratedProbabilityPositiveReturn,
    calibrationSource: payload.calibrationSource,
    signalsSnapshot: payload.signalsSnapshot,
    entryPrice: payload.entryPrice,
    corporateActionAdjustment: payload.corporateActionAdjustment,
    publishedAt: row.published_at,
    effectiveAt: row.effective_at,
    availableAt: row.available_at,
  };
}
