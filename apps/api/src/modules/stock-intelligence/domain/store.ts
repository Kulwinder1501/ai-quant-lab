import type { AsReportedFundamental, CanonicalFact, CanonicalFeature, CanonicalRawRecord, CanonicalSignal, CorporateActionRecord } from "./canonical.js";
import type { HoldingOverlay, WatchlistOverlay } from "./consumer-context.js";
import type { DecayMarkKind, PredictionDecayMark } from "./decay.js";
import type { ReplayJob, ReplayJobKind, ReplayJobStatus, ReplayPair, ReplayPairResult } from "./replay.js";
import type { StockIntelligenceHorizon } from "./data-quality.js";
import type { Gate7Report } from "./gate7.js";
import type { PredictionSnapshot } from "./snapshot.js";
import type { InstrumentExistence, StockIntelligenceUniverse, UniverseMembership } from "./universe.js";
import type { StockIntelligenceVersions } from "./versions.js";

export interface InstrumentAlias {
  readonly alias: string;
  readonly instrumentId: string;
}

export interface StockIntelligenceStore {
  findAlias(alias: string): Promise<string | null>;
  upsertAlias(alias: InstrumentAlias): Promise<void>;
  listMemberships(instrumentId: string): Promise<UniverseMembership[]>;
  listAllMemberships(universes?: readonly StockIntelligenceUniverse[]): Promise<UniverseMembership[]>;
  upsertMembership(membership: UniverseMembership): Promise<void>;
  findExistenceAsOf(instrumentId: string, asOf: Date): Promise<InstrumentExistence | null>;
  listAllExistence(): Promise<InstrumentExistence[]>;
  upsertExistence(existence: InstrumentExistence): Promise<void>;
  insertRaw(record: Omit<CanonicalRawRecord, "rawId"> & { rawId?: string }): Promise<string>;
  listRawAsOf(instrumentId: string, dataCutoff: Date, sourceKind?: string): Promise<CanonicalRawRecord[]>;
  insertFact(record: Omit<CanonicalFact, "factId"> & { factId?: string }): Promise<string>;
  insertFeature(record: Omit<CanonicalFeature, "featureId"> & { featureId?: string }): Promise<string>;
  listFeaturesAsOf(instrumentId: string, dataCutoff: Date): Promise<CanonicalFeature[]>;
  listFeaturesBefore(before: Date): Promise<CanonicalFeature[]>;
  insertSignal(record: Omit<CanonicalSignal, "signalId"> & { signalId?: string }): Promise<string>;
  insertFundamentalSnapshot(record: Omit<AsReportedFundamental, "snapshotId"> & { snapshotId?: string }): Promise<string>;
  insertCorporateAction(record: Omit<CorporateActionRecord, "actionId"> & { actionId?: string }): Promise<string>;
  listCorporateActionsAsOf(instrumentId: string, dataCutoff: Date): Promise<CorporateActionRecord[]>;
  listFactsAsOf(instrumentId: string, dataCutoff: Date): Promise<CanonicalFact[]>;
  listSignalsAsOf(instrumentId: string, dataCutoff: Date): Promise<CanonicalSignal[]>;
  listSignalsBefore(before: Date, signalName: string): Promise<CanonicalSignal[]>;
  listFundamentalsAsOf(instrumentId: string, dataCutoff: Date): Promise<AsReportedFundamental[]>;
  createReplayJob(input: {
    remainingPairs: readonly ReplayPair[];
    jobKind?: ReplayJobKind;
    windowFrom?: string;
    windowTo?: string;
    pipelineVersions: StockIntelligenceVersions;
  }): Promise<ReplayJob>;
  getReplayJob(jobId: string): Promise<ReplayJob | null>;
  checkpointReplayJob(input: {
    jobId: string;
    status: ReplayJobStatus;
    completedPairs: readonly ReplayPair[];
    remainingPairs: readonly ReplayPair[];
  }): Promise<void>;
  insertReplayPairResult(result: ReplayPairResult): Promise<void>;
  listReplayPairResults(jobId: string): Promise<ReplayPairResult[]>;
  insertSnapshot(record: Omit<PredictionSnapshot, "snapshotId"> & { snapshotId?: string }): Promise<string>;
  listSnapshotsAsOf(instrumentId: string, dataCutoff: Date): Promise<PredictionSnapshot[]>;
  listSnapshotsAvailableAt(dataCutoff: Date): Promise<PredictionSnapshot[]>;
  insertDecayMark(record: Omit<PredictionDecayMark, "markId"> & { markId?: string }): Promise<string>;
  listDecayMarks(snapshotId: string): Promise<PredictionDecayMark[]>;
  listHoldings(): Promise<HoldingOverlay[]>;
  listInvestorWatchlist(): Promise<WatchlistOverlay[]>;
  insertGate7Report(record: Gate7Report & { reportId?: string }): Promise<string>;
  latestGate7Report(jobId: string, horizon: StockIntelligenceHorizon): Promise<Gate7Report | null>;
}
