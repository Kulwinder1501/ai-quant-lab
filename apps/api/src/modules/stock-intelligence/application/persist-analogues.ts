import type { CanonicalSignal } from "../domain/canonical.js";
import {
  ANALOGUE_SIGNAL_12M,
  ANALOGUE_SIGNAL_6M,
  REGIME_SIGNAL_NAME,
  searchAnalogues,
  snapshotsFromFeatureRows,
  type AnalogueFeatureSnapshot,
  type AnalogueSet,
} from "../domain/analogue-search.js";
import type { FeatureValue } from "../domain/feature-catalog.js";
import type { RegimeAssignment } from "../domain/regime-engine.js";
import { utcDateKey } from "../domain/returns.js";
import type { StockIntelligenceStore } from "../domain/store.js";
import { isEligibleAt, type UniverseMembership } from "../domain/universe.js";
import {
  STOCK_INTELLIGENCE_ANALOGUE_METHOD_VERSION,
  STOCK_INTELLIGENCE_FEATURE_VERSION,
  STOCK_INTELLIGENCE_REGIME_MODEL_VERSION,
} from "../domain/versions.js";
import { DEFAULT_MIN_EFFECTIVE_ANALOGUES, type StockIntelligenceHorizon } from "../domain/data-quality.js";
import type { ReplayRuntimeCache } from "./replay-runtime-cache.js";

export function snapshotFromGeneratedFeatures(input: {
  instrumentId: string;
  asOf: Date;
  features: readonly FeatureValue[];
  regime: RegimeAssignment | null;
  eligible: boolean;
}): AnalogueFeatureSnapshot {
  const values: Partial<Record<FeatureValue["name"], number | string>> = {};
  for (const feature of input.features) {
    if (feature.unavailableReason !== null) continue;
    if (typeof feature.value === "number" || typeof feature.value === "string") {
      values[feature.name] = feature.value;
    }
  }
  return {
    instrumentId: input.instrumentId,
    asOf: utcDateKey(input.asOf),
    values,
    regimeBucket: input.regime?.bucket ?? null,
    eligible: input.eligible,
  };
}

export function analogueSignal(
  instrumentId: string,
  asOf: Date,
  set: AnalogueSet,
  signalName: string,
): Omit<CanonicalSignal, "signalId"> {
  return {
    instrumentId,
    signalName,
    signalValue: {
      horizon: set.horizon,
      regimeBucket: set.regimeBucket,
      distanceMetric: set.distanceMetric,
      nCandidates: set.nCandidates,
      nSameRegime: set.nSameRegime,
      nCrossRegime: set.nCrossRegime,
      effectiveSampleSize: set.effectiveSampleSize,
      similarityQuality: set.similarityQuality,
      investorFacing: set.investorFacing,
      industryPenaltyApplied: set.industryPenaltyApplied,
      members: set.members,
    },
    strength: set.effectiveSampleSize,
    derivedFrom: { nCandidates: set.nCandidates },
    sourceFacts: { regimeBucket: set.regimeBucket },
    featureVersion: STOCK_INTELLIGENCE_FEATURE_VERSION,
    engineVersion: STOCK_INTELLIGENCE_ANALOGUE_METHOD_VERSION,
    publishedAt: asOf,
    effectiveAt: asOf,
    availableAt: asOf,
  };
}

export function regimeSignal(
  instrumentId: string,
  asOf: Date,
  regime: RegimeAssignment,
): Omit<CanonicalSignal, "signalId"> {
  return {
    instrumentId,
    signalName: REGIME_SIGNAL_NAME,
    signalValue: { ...regime },
    strength: null,
    derivedFrom: { macroSource: regime.macroSource },
    sourceFacts: { vixLevel: regime.vixLevel },
    featureVersion: STOCK_INTELLIGENCE_FEATURE_VERSION,
    engineVersion: STOCK_INTELLIGENCE_REGIME_MODEL_VERSION,
    publishedAt: asOf,
    effectiveAt: asOf,
    availableAt: asOf,
  };
}

export class PersistAnalogueSets {
  constructor(private readonly store: StockIntelligenceStore) {}

  async execute(input: {
    instrumentId: string;
    asOf: Date;
    query: AnalogueFeatureSnapshot;
    membershipsByInstrument: ReadonlyMap<string, readonly UniverseMembership[]>;
    minEffective?: number;
    /** When set, skip per-pair DB scans of features / regimes / existence. */
    runtimeCache?: ReplayRuntimeCache;
  }): Promise<{ analogue6m: AnalogueSet; analogue12m: AnalogueSet }> {
    let candidates: AnalogueFeatureSnapshot[];
    if (input.runtimeCache && input.runtimeCache.analogueSnapshots.length > 0) {
      candidates = input.runtimeCache.analogueSnapshotsBefore(input.query.asOf);
    } else {
      const featureRows = input.runtimeCache
        ? input.runtimeCache.featuresBefore(input.asOf)
        : await this.store.listFeaturesBefore(input.asOf);
      const regimeRows = input.runtimeCache
        ? input.runtimeCache.signalsBefore(input.asOf, REGIME_SIGNAL_NAME)
        : await this.store.listSignalsBefore(input.asOf, REGIME_SIGNAL_NAME);
      const regimes = new Map<string, string>();
      for (const row of regimeRows) {
        const bucket = typeof row.signalValue.bucket === "string" ? row.signalValue.bucket : null;
        if (bucket) regimes.set(`${row.instrumentId}|${utcDateKey(row.effectiveAt)}`, bucket);
      }

      const eligibleCache = new Map<string, boolean>();
      for (const row of featureRows) {
        const asOf = utcDateKey(row.effectiveAt);
        const key = `${row.instrumentId}|${asOf}`;
        if (eligibleCache.has(key)) continue;
        const asOfDate = new Date(`${asOf}T23:59:59.999Z`);
        const existence = input.runtimeCache
          ? input.runtimeCache.findExistenceAsOf(row.instrumentId, asOfDate)
          : await this.store.findExistenceAsOf(row.instrumentId, asOfDate);
        eligibleCache.set(key, isEligibleAt({
          asOf: asOfDate,
          memberships: input.membershipsByInstrument.get(row.instrumentId) ?? [],
          existence,
        }).eligible);
      }

      candidates = snapshotsFromFeatureRows(featureRows, regimes, (instrumentId, asOf) =>
        eligibleCache.get(`${instrumentId}|${asOf}`) ?? false
      );
      if (input.runtimeCache && input.runtimeCache.analogueSnapshots.length === 0) {
        input.runtimeCache.analogueSnapshots.push(...candidates);
      }
    }

    const horizons: StockIntelligenceHorizon[] = ["6M", "12M"];
    const [analogue6m, analogue12m] = horizons.map((horizon) => searchAnalogues({
      query: input.query,
      candidates,
      horizon,
      minEffective: input.minEffective ?? DEFAULT_MIN_EFFECTIVE_ANALOGUES,
    }));

    const signal6m = analogueSignal(input.instrumentId, input.asOf, analogue6m!, ANALOGUE_SIGNAL_6M);
    const signal12m = analogueSignal(input.instrumentId, input.asOf, analogue12m!, ANALOGUE_SIGNAL_12M);
    await Promise.all([
      this.store.insertSignal(signal6m),
      this.store.insertSignal(signal12m),
    ]);
    return { analogue6m: analogue6m!, analogue12m: analogue12m! };
  }
}
