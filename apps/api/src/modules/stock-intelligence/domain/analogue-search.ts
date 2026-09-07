import { STOCK_INTELLIGENCE_FEATURE_CATALOG, type StockIntelligenceFeatureName } from "./feature-catalog.js";
import type { StockIntelligenceHorizon } from "./data-quality.js";
import { DEFAULT_MIN_EFFECTIVE_ANALOGUES } from "./data-quality.js";
import {
  euclideanDistance,
  invertMatrix,
  mahalanobisDistance,
  sampleCovariance,
  sampleMean,
} from "./matrix.js";
import { utcDateKey } from "./returns.js";

export const ANALOGUE_SIGNAL_6M = "analogue_set_6m";
export const ANALOGUE_SIGNAL_12M = "analogue_set_12m";
export const REGIME_SIGNAL_NAME = "regime_bucket";
export const DEFAULT_CROSS_REGIME_SIMILARITY_MIN = 0.85;
export const TEMPORAL_CLUSTER_DAYS = 91;

export const analogueDistanceMetrics = ["mahalanobis", "euclidean"] as const;
export type AnalogueDistanceMetric = (typeof analogueDistanceMetrics)[number];

const ENGINE_WEIGHT_6M: Record<string, number> = {
  fundamental: 0.25,
  technical: 0.45,
  valuation: 0.15,
  event: 0.08,
  macro_sector: 0.07,
};

const ENGINE_WEIGHT_12M: Record<string, number> = {
  fundamental: 0.40,
  technical: 0.20,
  valuation: 0.20,
  event: 0.10,
  macro_sector: 0.10,
};

export interface AnalogueFeatureSnapshot {
  readonly instrumentId: string;
  readonly asOf: string;
  readonly values: Partial<Record<StockIntelligenceFeatureName, number | string>>;
  readonly regimeBucket: string | null;
  readonly eligible: boolean;
}

export interface AnalogueMember {
  readonly instrumentId: string;
  readonly asOf: string;
  readonly distance: number;
  readonly similarity: number;
  readonly weight: number;
  readonly sameRegime: boolean;
}

export interface AnalogueSet {
  readonly horizon: StockIntelligenceHorizon;
  readonly queryInstrumentId: string;
  readonly queryAsOf: string;
  readonly regimeBucket: string | null;
  readonly distanceMetric: AnalogueDistanceMetric;
  readonly nCandidates: number;
  readonly nSameRegime: number;
  readonly nCrossRegime: number;
  readonly effectiveSampleSize: number;
  readonly similarityQuality: number;
  readonly investorFacing: boolean;
  readonly industryPenaltyApplied: false;
  readonly members: readonly AnalogueMember[];
}

function engineWeight(horizon: StockIntelligenceHorizon, engine: string): number {
  return (horizon === "6M" ? ENGINE_WEIGHT_6M : ENGINE_WEIGHT_12M)[engine] ?? 0;
}

export function featureWeight(name: StockIntelligenceFeatureName, horizon: StockIntelligenceHorizon): number {
  const catalog = STOCK_INTELLIGENCE_FEATURE_CATALOG.find((row) => row.name === name);
  if (!catalog) return 0;
  const names = STOCK_INTELLIGENCE_FEATURE_CATALOG.filter((row) => row.engine === catalog.engine);
  const share = engineWeight(horizon, catalog.engine);
  return names.length === 0 ? 0 : share / names.length;
}

function numericValue(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sharedNumericNames(
  query: AnalogueFeatureSnapshot,
  candidates: readonly AnalogueFeatureSnapshot[],
): StockIntelligenceFeatureName[] {
  const names = STOCK_INTELLIGENCE_FEATURE_CATALOG
    .map((row) => row.name)
    .filter((name) => numericValue(query.values[name]) !== null);
  return names.filter((name) => candidates.some((candidate) => numericValue(candidate.values[name]) !== null));
}

function asVector(
  snapshot: AnalogueFeatureSnapshot,
  names: readonly StockIntelligenceFeatureName[],
): number[] {
  return names.map((name) => numericValue(snapshot.values[name]) ?? 0);
}

function standardize(rows: readonly (readonly number[])[]): { rows: number[][]; mean: number[]; scale: number[] } {
  const mean = sampleMean(rows);
  const scale = mean.map((_, column) => {
    const variance = rows.reduce((sum, row) => sum + (row[column]! - mean[column]!) ** 2, 0)
      / Math.max(1, rows.length - 1);
    const stdev = Math.sqrt(variance);
    return stdev < 1e-12 ? 1 : stdev;
  });
  return {
    mean,
    scale,
    rows: rows.map((row) => row.map((value, column) => (value - mean[column]!) / scale[column]!)),
  };
}

function similarityFromDistance(distance: number): number {
  return 1 / (1 + distance);
}

function temporalClusterKey(asOf: string): string {
  const time = Date.parse(`${asOf}T00:00:00.000Z`);
  return String(Math.floor(time / (TEMPORAL_CLUSTER_DAYS * 86_400_000)));
}

function effectiveSampleSize(members: readonly AnalogueMember[]): number {
  const clusters = new Map<string, number>();
  for (const member of members) {
    const key = temporalClusterKey(member.asOf);
    clusters.set(key, (clusters.get(key) ?? 0) + 1);
  }
  let ess = 0;
  for (const member of members) {
    const size = clusters.get(temporalClusterKey(member.asOf)) ?? 1;
    ess += member.similarity / Math.sqrt(size);
  }
  return ess;
}

export function searchAnalogues(input: {
  query: AnalogueFeatureSnapshot;
  candidates: readonly AnalogueFeatureSnapshot[];
  horizon: StockIntelligenceHorizon;
  minEffective?: number;
  crossRegimeSimilarityMin?: number;
}): AnalogueSet {
  const minEffective = input.minEffective ?? DEFAULT_MIN_EFFECTIVE_ANALOGUES;
  const crossMin = input.crossRegimeSimilarityMin ?? DEFAULT_CROSS_REGIME_SIMILARITY_MIN;
  const queryDay = input.query.asOf;

  const pitEligible = input.candidates.filter((candidate) => {
    if (!candidate.eligible) return false;
    if (candidate.asOf >= queryDay) return false;
    if (candidate.instrumentId === input.query.instrumentId && candidate.asOf === queryDay) return false;
    return true;
  });

  const names = sharedNumericNames(input.query, pitEligible);

  const scored: AnalogueMember[] = [];
  let metric: AnalogueDistanceMetric = "euclidean";

  if (names.length > 0 && pitEligible.length > 0) {
    const weights = names.map((name) => featureWeight(name, input.horizon));
    const weightSum = weights.reduce((sum, value) => sum + value, 0);
    const normalized = weightSum === 0 ? weights.map(() => 1 / names.length) : weights.map((value) => value / weightSum);

    const rawRows = pitEligible.map((candidate) => asVector(candidate, names));
    const queryRaw = asVector(input.query, names);
    const standardized = standardize([...rawRows, queryRaw]);
    const candidateZ = standardized.rows.slice(0, -1);
    const queryZ = standardized.rows[standardized.rows.length - 1]!;
    const weightedZ = candidateZ.map((row) => row.map((value, index) => value * Math.sqrt(normalized[index]!)));
    const queryWeighted = queryZ.map((value, index) => value * Math.sqrt(normalized[index]!));

    const covariance = sampleCovariance(weightedZ, sampleMean(weightedZ));
    const inverse = weightedZ.length > names.length ? invertMatrix(covariance) : null;
    metric = inverse ? "mahalanobis" : "euclidean";

    for (let index = 0; index < pitEligible.length; index += 1) {
      const candidate = pitEligible[index]!;
      const distance = inverse
        ? mahalanobisDistance(queryWeighted, weightedZ[index]!, inverse)
        : euclideanDistance(queryWeighted, weightedZ[index]!);
      const similarity = similarityFromDistance(distance);
      const same = input.query.regimeBucket !== null && candidate.regimeBucket === input.query.regimeBucket;
      if (!same && similarity < crossMin) continue;
      scored.push({
        instrumentId: candidate.instrumentId,
        asOf: candidate.asOf,
        distance,
        similarity,
        weight: similarity,
        sameRegime: same,
      });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity || a.distance - b.distance);
  const ess = effectiveSampleSize(scored);
  const similarityQuality = scored.length === 0
    ? 0
    : scored.reduce((sum, member) => sum + member.similarity, 0) / scored.length;

  return {
    horizon: input.horizon,
    queryInstrumentId: input.query.instrumentId,
    queryAsOf: queryDay,
    regimeBucket: input.query.regimeBucket,
    distanceMetric: metric,
    nCandidates: scored.length,
    nSameRegime: scored.filter((member) => member.sameRegime).length,
    nCrossRegime: scored.filter((member) => !member.sameRegime).length,
    effectiveSampleSize: ess,
    similarityQuality,
    investorFacing: ess >= minEffective,
    industryPenaltyApplied: false,
    members: scored.slice(0, 50),
  };
}

export function snapshotsFromFeatureRows(
  rows: readonly {
    instrumentId: string;
    featureName: string;
    featureValue: Record<string, unknown>;
    effectiveAt: Date;
  }[],
  regimes: ReadonlyMap<string, string>,
  eligible: (instrumentId: string, asOf: string) => boolean,
): AnalogueFeatureSnapshot[] {
  const grouped = new Map<string, AnalogueFeatureSnapshot>();
  for (const row of rows) {
    const asOf = utcDateKey(row.effectiveAt);
    const key = `${row.instrumentId}|${asOf}`;
    const current = grouped.get(key) ?? {
      instrumentId: row.instrumentId,
      asOf,
      values: {},
      regimeBucket: regimes.get(key) ?? null,
      eligible: eligible(row.instrumentId, asOf),
    };
    const raw = row.featureValue.value;
    const unavailable = row.featureValue.unavailableReason;
    if (unavailable) {
      grouped.set(key, current);
      continue;
    }
    if (typeof raw === "number" || typeof raw === "string") {
      grouped.set(key, {
        ...current,
        values: { ...current.values, [row.featureName]: raw },
      });
    } else {
      grouped.set(key, current);
    }
  }
  return [...grouped.values()];
}
