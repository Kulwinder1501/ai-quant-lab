import type { AnalogueSet } from "./analogue-search.js";
import type { StockIntelligenceHorizon } from "./data-quality.js";
import { DEFAULT_FUNDAMENTAL_COMPLETENESS_MIN, DEFAULT_MIN_EFFECTIVE_ANALOGUES } from "./data-quality.js";
import type { OutcomeType } from "./returns.js";
import { utcDateKey } from "./returns.js";
import type { PredictionSnapshotStatus } from "./status.js";
import { STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION } from "./versions.js";

export const OUTCOME_SIGNAL_6M = "outcome_distribution_6m";
export const OUTCOME_SIGNAL_12M = "outcome_distribution_12m";

export const HORIZON_MONTHS: Record<StockIntelligenceHorizon, number> = {
  "6M": 6,
  "12M": 12,
};

export const scenarioNames = ["bear", "base", "bull"] as const;
export type ScenarioName = (typeof scenarioNames)[number];

export interface WeightedReturn {
  readonly value: number;
  readonly weight: number;
}

export interface ReturnDistribution {
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
}

export interface ScenarioBand {
  readonly threshold: "lte_p25" | "p25_to_p75" | "gte_p75";
  readonly probability: number;
  readonly range: readonly [number, number];
}

export interface ScenarioSet {
  readonly bear: ScenarioBand;
  readonly base: ScenarioBand;
  readonly bull: ScenarioBand;
}

export interface RealizedAnalogueOutcome {
  readonly instrumentId: string;
  readonly asOf: string;
  readonly weight: number;
  readonly similarity: number;
  readonly totalReturn: number;
  readonly priceReturn: number;
  readonly maxDrawdown: number;
  readonly outcomeType: OutcomeType;
}

export type CalibrationSource = "regime_fit" | "global_fallback" | "none";

export interface HorizonForecast {
  readonly horizon: StockIntelligenceHorizon;
  readonly outcomeModelVersion: typeof STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION;
  readonly nAnaloguesConsidered: number;
  readonly nAnaloguesUsed: number;
  readonly nAnaloguesDroppedIncomplete: number;
  readonly nDelistedKept: number;
  readonly distribution: ReturnDistribution | null;
  readonly scenarios: ScenarioSet | null;
  readonly rawProbabilityPositiveReturn: number | null;
  readonly calibratedProbabilityPositiveReturn: number | null;
  readonly calibrationSource: CalibrationSource;
  readonly status: PredictionSnapshotStatus;
  readonly investorFacing: boolean;
}

/**
 * Month-end aware UTC add. 31 Jan + 1 month is the last instant of February, not 3 March.
 */
export function addUtcMonths(asOf: Date, months: number): Date {
  const year = asOf.getUTCFullYear();
  const month = asOf.getUTCMonth() + months;
  const day = asOf.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    year,
    month,
    Math.min(day, lastDay),
    asOf.getUTCHours(),
    asOf.getUTCMinutes(),
    asOf.getUTCSeconds(),
    asOf.getUTCMilliseconds(),
  ));
}

export function horizonEndUtc(asOf: Date, horizon: StockIntelligenceHorizon): Date {
  return addUtcMonths(asOf, HORIZON_MONTHS[horizon]);
}

export function horizonHasCompleted(asOf: Date, horizon: StockIntelligenceHorizon, evaluationCutoff: Date): boolean {
  return utcDateKey(horizonEndUtc(asOf, horizon)) <= utcDateKey(evaluationCutoff);
}

export function weightedQuantile(samples: readonly WeightedReturn[], probability: number): number {
  if (!(probability >= 0 && probability <= 1)) {
    throw new Error("weightedQuantile probability must be in [0, 1].");
  }
  const cleaned = samples
    .filter((row) => Number.isFinite(row.value) && Number.isFinite(row.weight) && row.weight > 0)
    .sort((a, b) => a.value - b.value);
  if (cleaned.length === 0) {
    throw new Error("weightedQuantile requires at least one finite weighted sample.");
  }
  const total = cleaned.reduce((sum, row) => sum + row.weight, 0);
  if (probability === 0) return cleaned[0]!.value;
  if (probability === 1) return cleaned[cleaned.length - 1]!.value;
  const target = probability * total;
  let accumulated = 0;
  for (const current of cleaned) {
    accumulated += current.weight;
    if (accumulated >= target) return current.value;
  }
  return cleaned[cleaned.length - 1]!.value;
}

export function empiricalDistribution(samples: readonly WeightedReturn[]): ReturnDistribution {
  return {
    p10: weightedQuantile(samples, 0.10),
    p25: weightedQuantile(samples, 0.25),
    p50: weightedQuantile(samples, 0.50),
    p75: weightedQuantile(samples, 0.75),
    p90: weightedQuantile(samples, 0.90),
  };
}

export function probabilityPositive(samples: readonly WeightedReturn[]): number {
  const total = samples.reduce((sum, row) => sum + (row.weight > 0 ? row.weight : 0), 0);
  if (total <= 0) return 0;
  const positive = samples.reduce((sum, row) => (
    row.weight > 0 && row.value > 0 ? sum + row.weight : sum
  ), 0);
  return positive / total;
}

export function scenariosFromDistribution(distribution: ReturnDistribution): ScenarioSet {
  const scenarios: ScenarioSet = {
    bear: { threshold: "lte_p25", probability: 0.25, range: [distribution.p10, distribution.p25] },
    base: { threshold: "p25_to_p75", probability: 0.50, range: [distribution.p25, distribution.p75] },
    bull: { threshold: "gte_p75", probability: 0.25, range: [distribution.p75, distribution.p90] },
  };
  const probabilitySum = scenarios.bear.probability + scenarios.base.probability + scenarios.bull.probability;
  if (Math.abs(probabilitySum - 1) > 1e-12) {
    throw new Error("Scenario probabilities must sum to 1.");
  }
  return scenarios;
}

export function assignForecastStatus(input: {
  nUsed: number;
  analogueInvestorFacing: boolean;
  fundamentalCompleteness: number;
  calibrationSource: CalibrationSource;
  completenessMin?: number;
  minUsed?: number;
}): PredictionSnapshotStatus {
  const minUsed = input.minUsed ?? DEFAULT_MIN_EFFECTIVE_ANALOGUES;
  const completenessMin = input.completenessMin ?? DEFAULT_FUNDAMENTAL_COMPLETENESS_MIN;
  if (input.nUsed < minUsed || !input.analogueInvestorFacing) return "INSUFFICIENT_ANALOGUES";
  if (input.fundamentalCompleteness < completenessMin) return "INSUFFICIENT_DATA";
  if (input.calibrationSource !== "regime_fit") return "CALIBRATION_UNCERTAIN";
  return "VALID";
}

export interface OutcomeModelInput {
  readonly analogueSet: AnalogueSet;
  readonly realized: readonly RealizedAnalogueOutcome[];
  readonly nDroppedIncomplete: number;
  readonly fundamentalCompleteness: number;
  readonly calibratedProbabilityPositiveReturn: number | null;
  readonly calibrationSource: CalibrationSource;
}

function forecastFrom(horizon: StockIntelligenceHorizon, input: OutcomeModelInput): HorizonForecast {
  const samples: WeightedReturn[] = input.realized.map((row) => ({
    value: row.totalReturn,
    weight: row.weight,
  }));
  const distribution = samples.length === 0 ? null : empiricalDistribution(samples);
  const rawProbabilityPositiveReturn = samples.length === 0 ? null : probabilityPositive(samples);
  const calibrationSource = input.calibrationSource;
  const calibrated = input.calibratedProbabilityPositiveReturn;
  const status = assignForecastStatus({
    nUsed: input.realized.length,
    analogueInvestorFacing: input.analogueSet.investorFacing,
    fundamentalCompleteness: input.fundamentalCompleteness,
    calibrationSource,
  });
  return {
    horizon,
    outcomeModelVersion: STOCK_INTELLIGENCE_OUTCOME_MODEL_VERSION,
    nAnaloguesConsidered: input.analogueSet.nCandidates,
    nAnaloguesUsed: input.realized.length,
    nAnaloguesDroppedIncomplete: input.nDroppedIncomplete,
    nDelistedKept: input.realized.filter((row) => row.outcomeType === "DELISTED").length,
    distribution,
    scenarios: distribution ? scenariosFromDistribution(distribution) : null,
    rawProbabilityPositiveReturn,
    calibratedProbabilityPositiveReturn: calibrated,
    calibrationSource,
    status,
    investorFacing: status === "VALID",
  };
}

export class OutcomeModel6M {
  readonly horizon = "6M" as const;

  predict(input: OutcomeModelInput): HorizonForecast {
    return forecastFrom(this.horizon, input);
  }
}

export class OutcomeModel12M {
  readonly horizon = "12M" as const;

  predict(input: OutcomeModelInput): HorizonForecast {
    return forecastFrom(this.horizon, input);
  }
}
