import type { AnalogueSet } from "./analogue-search.js";
import type { DataQualityScores, StockIntelligenceHorizon } from "./data-quality.js";
import type { FeatureValue } from "./feature-catalog.js";
import {
  scenariosFromDistribution,
  type CalibrationSource,
  type HorizonForecast,
  type ReturnDistribution,
  type ScenarioSet,
} from "./outcome-model.js";
import { utcDateKey } from "./returns.js";
import type { PredictionSnapshotStatus } from "./status.js";
import type { PointInTimeClocks } from "./timestamps.js";
import { stockIntelligenceVersions, type StockIntelligenceVersions } from "./versions.js";
import { STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION } from "./versions.js";

export interface SnapshotAnalogueSummary {
  readonly nCandidates: number;
  readonly effectiveSampleSize: number;
  readonly similarityQuality: number;
  readonly nUsed: number;
  readonly nDroppedIncomplete: number;
}

export interface SnapshotAdjustmentMethodology {
  readonly version: typeof STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION;
  readonly priceSeriesBasis: "split_adjusted";
  readonly entryPriceUnchanged: true;
}

export interface PredictionSnapshot extends PointInTimeClocks {
  readonly snapshotId: string;
  readonly instrumentId: string;
  readonly predictionAsOf: Date;
  readonly dataCutoff: Date;
  readonly horizon: StockIntelligenceHorizon;
  readonly status: PredictionSnapshotStatus;
  readonly investorFacing: boolean;
  readonly regimeBucket: string | null;
  readonly versions: StockIntelligenceVersions;
  readonly dataQuality: DataQualityScores;
  readonly analogueSet: SnapshotAnalogueSummary;
  readonly returnDistribution: ReturnDistribution | null;
  readonly scenarios: ScenarioSet | null;
  readonly rawProbabilityPositiveReturn: number | null;
  readonly calibratedProbabilityPositiveReturn: number | null;
  readonly calibrationSource: CalibrationSource;
  readonly signalsSnapshot: Readonly<Record<string, unknown>>;
  readonly entryPrice: number | null;
  readonly corporateActionAdjustment: SnapshotAdjustmentMethodology;
}

export function priceFromReturn(entryPrice: number, returnFraction: number): number {
  return entryPrice * (1 + returnFraction);
}

export function scenariosWithPriceBands(entryPrice: number, scenarios: ScenarioSet): ScenarioSet {
  const convert = (range: readonly [number, number]): [number, number] => [
    priceFromReturn(entryPrice, range[0]),
    priceFromReturn(entryPrice, range[1]),
  ];
  const priced: ScenarioSet = {
    bear: { ...scenarios.bear, range: convert(scenarios.bear.range) },
    base: { ...scenarios.base, range: convert(scenarios.base.range) },
    bull: { ...scenarios.bull, range: convert(scenarios.bull.range) },
  };
  const sum = priced.bear.probability + priced.base.probability + priced.bull.probability;
  if (Math.abs(sum - 1) > 1e-12) {
    throw new Error("Scenario probabilities must sum to 1.");
  }
  return priced;
}

export function signalsSnapshotFromFeatures(features: readonly FeatureValue[]): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const feature of features) {
    snapshot[feature.name] = {
      value: feature.value,
      unavailableReason: feature.unavailableReason,
      engine: feature.engine,
    };
  }
  return snapshot;
}

export function assemblePredictionSnapshot(input: {
  snapshotId?: string;
  instrumentId: string;
  asOf: Date;
  forecast: HorizonForecast;
  analogueSet: AnalogueSet;
  dataQuality: DataQualityScores;
  features: readonly FeatureValue[];
  regimeBucket: string | null;
  entryPrice: number | null;
}): Omit<PredictionSnapshot, "snapshotId"> & { snapshotId?: string } {
  const scenarios = input.forecast.scenarios
    ?? (input.forecast.distribution ? scenariosFromDistribution(input.forecast.distribution) : null);
  const priced = scenarios && input.entryPrice !== null && input.entryPrice > 0
    ? scenariosWithPriceBands(input.entryPrice, scenarios)
    : scenarios;
  return {
    snapshotId: input.snapshotId,
    instrumentId: input.instrumentId,
    predictionAsOf: input.asOf,
    dataCutoff: input.asOf,
    horizon: input.forecast.horizon,
    status: input.forecast.status,
    investorFacing: input.forecast.investorFacing,
    regimeBucket: input.regimeBucket,
    versions: stockIntelligenceVersions,
    dataQuality: input.dataQuality,
    analogueSet: {
      nCandidates: input.analogueSet.nCandidates,
      effectiveSampleSize: input.analogueSet.effectiveSampleSize,
      similarityQuality: input.analogueSet.similarityQuality,
      nUsed: input.forecast.nAnaloguesUsed,
      nDroppedIncomplete: input.forecast.nAnaloguesDroppedIncomplete,
    },
    returnDistribution: input.forecast.distribution,
    scenarios: priced,
    rawProbabilityPositiveReturn: input.forecast.rawProbabilityPositiveReturn,
    calibratedProbabilityPositiveReturn: input.forecast.calibratedProbabilityPositiveReturn,
    calibrationSource: input.forecast.calibrationSource,
    signalsSnapshot: signalsSnapshotFromFeatures(input.features),
    entryPrice: input.entryPrice,
    corporateActionAdjustment: {
      version: STOCK_INTELLIGENCE_CORPORATE_ACTION_ADJUSTMENT_VERSION,
      priceSeriesBasis: "split_adjusted",
      entryPriceUnchanged: true,
    },
    publishedAt: input.asOf,
    effectiveAt: input.asOf,
    availableAt: input.asOf,
  };
}

export function snapshotIdentityKey(snapshot: Pick<PredictionSnapshot, "instrumentId" | "predictionAsOf" | "horizon" | "versions">): string {
  return [
    snapshot.instrumentId,
    utcDateKey(snapshot.predictionAsOf),
    snapshot.horizon,
    snapshot.versions.outcomeModel,
    snapshot.versions.calibrationModel,
  ].join("|");
}

export function unavailableReason(snapshot: Pick<PredictionSnapshot, "status" | "analogueSet">): string {
  if (snapshot.status === "INSUFFICIENT_ANALOGUES") {
    return `Insufficient historical analogues (N = ${Math.round(snapshot.analogueSet.effectiveSampleSize)}; minimum required = 50)`;
  }
  if (snapshot.status === "INSUFFICIENT_DATA") return "Missing fundamental or market data below threshold.";
  if (snapshot.status === "CALIBRATION_UNCERTAIN") return "Calibration data sparse for this type of prediction.";
  if (snapshot.status === "STALE_DATA") return "Data freshness exceeds acceptable threshold.";
  if (snapshot.status === "OUT_OF_REGIME") return "Current regime has no reliable historical precedent.";
  if (snapshot.status === "UNDER_REVIEW") return "Outlook under review";
  return "Outlook unavailable.";
}
