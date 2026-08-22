import type { SessionCandle } from "../domain/session-calendar.js";
import type { DirectionalDataset, DirectionalSample } from "./generate-directional-dataset.js";
import { extractMinimalFeaturesForSample, MINIMAL_FEATURE_NAMES } from "./feature-engine.js";
import { QuantileRegression } from "./learnability-baselines.js";
import { fitFoldScaler } from "./purged-walk-forward-cv.js";
import {
  D2_SIGNAL_TAIL_FRACTION,
  evaluateD2PremiumCostGate,
  type D2PremiumCostGateResult,
  type D2PremiumTick,
  type D2Signal,
} from "../domain/d2-premium-cost-gate.js";

export const FROZEN_D2_PARENT_MANIFEST_HASH = "4862abb38ba241dc0a81a2cbb9fc993eefd20b4330fb3e8a909c058a57745a79";
export const FROZEN_D2_TARGET = "D0-D Quantile Median";
export const FROZEN_D2_MODEL = "QuantileRegression(q=0.5)";

export interface D2CandidateModelReport {
  readonly parentManifestHash: string;
  readonly target: string;
  readonly model: string;
  readonly horizonMinutes: 30;
  readonly featureNames: readonly string[];
  readonly trainingCutoffSessionExclusive: string;
  readonly trainingFirstSession: string;
  readonly trainingLastSession: string;
  readonly trainingSampleCount: number;
  readonly lowerScoreThreshold: number;
  readonly upperScoreThreshold: number;
  readonly signalTailFraction: number;
}

export interface D2ScoredDecision {
  readonly sessionDate: string;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly score: number;
  readonly side: "UP" | "DOWN" | null;
  readonly underlyingReferencePrice: number;
  readonly realizedUnderlyingReturnBps: number;
}

export interface D2CostStudyResult {
  readonly underlyingSymbol: string;
  readonly model: D2CandidateModelReport;
  readonly evaluatedDecisionCount: number;
  readonly scoredDecisions: readonly D2ScoredDecision[];
  readonly costGate: D2PremiumCostGateResult;
}

export interface D2CostStudyInput {
  readonly underlyingSymbol: string;
  readonly dataset: DirectionalDataset;
  readonly candles: readonly SessionCandle[];
  readonly premiumTicks: readonly D2PremiumTick[];
  readonly premiumSessionDates: readonly string[];
  readonly lotSize: number;
}

function candlesBySession(candles: readonly SessionCandle[]): ReadonlyMap<string, readonly SessionCandle[]> {
  const result = new Map<string, SessionCandle[]>();
  for (const candle of candles) {
    const sessionDate = new Date(candle.openTime.getTime() + 330 * 60_000).toISOString().slice(0, 10);
    const values = result.get(sessionDate) ?? [];
    values.push(candle);
    result.set(sessionDate, values);
  }
  for (const values of result.values()) values.sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
  return result;
}

function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) throw new Error("Cannot calculate a D2 score threshold from no values.");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function featureForSample(
  sample: DirectionalSample,
  sessionCandles: ReadonlyMap<string, readonly SessionCandle[]>,
): readonly number[] | null {
  const vector = extractMinimalFeaturesForSample(sample, sessionCandles.get(sample.sessionDate) ?? []);
  return vector.isEligible ? vector.features : null;
}

/**
 * Fits the already-selected D1 architecture on index history strictly before premium evaluation.
 * Thresholds are learned from the same pre-evaluation training block, never from D2 outcomes.
 */
export function runD2CostStudy(input: D2CostStudyInput): D2CostStudyResult {
  if (input.dataset.instrument !== input.underlyingSymbol) {
    throw new Error("D2 dataset instrument must match the option underlying.");
  }
  if (!Number.isInteger(input.lotSize) || input.lotSize <= 0) {
    throw new Error("D2 requires the positive whole-number exchange lot size.");
  }
  const premiumSessionDates = [...new Set(input.premiumSessionDates)].sort();
  const cutoffSession = premiumSessionDates[0];
  if (!cutoffSession) throw new Error("D2 requires at least one real premium session.");
  const candleMap = candlesBySession(input.candles);

  const trainingRows: Array<{ sample: DirectionalSample; features: readonly number[]; target: number }> = [];
  for (const sample of input.dataset.samples) {
    if (sample.sessionDate >= cutoffSession || !sample.continuous30) continue;
    const features = featureForSample(sample, candleMap);
    if (!features) continue;
    trainingRows.push({ sample, features, target: sample.continuous30.rawReturnBps });
  }
  if (trainingRows.length === 0) {
    throw new Error(`No eligible ${input.underlyingSymbol} training rows exist before ${cutoffSession}.`);
  }

  const scaler = fitFoldScaler(trainingRows.map((row) => row.features));
  const trainingX = trainingRows.map((row) => scaler.transform(row.features));
  const model = new QuantileRegression();
  model.fit(trainingX, trainingRows.map((row) => row.target), 0.5);
  const trainingScores = trainingX.map((features) => model.predict(features));
  const lowerScoreThreshold = quantile(trainingScores, D2_SIGNAL_TAIL_FRACTION);
  const upperScoreThreshold = quantile(trainingScores, 1 - D2_SIGNAL_TAIL_FRACTION);
  if (!(lowerScoreThreshold < upperScoreThreshold)) {
    throw new Error("Frozen D2 score tails collapsed; the candidate cannot define directional entries.");
  }

  const evaluationSet = new Set(premiumSessionDates);
  const scoredDecisions: D2ScoredDecision[] = [];
  const signals: D2Signal[] = [];
  for (const sample of input.dataset.samples) {
    if (!evaluationSet.has(sample.sessionDate) || !sample.continuous30) continue;
    const features = featureForSample(sample, candleMap);
    if (!features) continue;
    const score = model.predict(scaler.transform(features));
    const side = score <= lowerScoreThreshold ? "DOWN" : score >= upperScoreThreshold ? "UP" : null;
    scoredDecisions.push({
      sessionDate: sample.sessionDate,
      decisionAt: sample.decisionAt,
      dataThrough: sample.dataThrough,
      score,
      side,
      underlyingReferencePrice: sample.referencePrice,
      realizedUnderlyingReturnBps: sample.continuous30.rawReturnBps,
    });
    if (side) {
      signals.push({
        sessionDate: sample.sessionDate,
        decisionAt: sample.decisionAt,
        dataThrough: sample.dataThrough,
        score,
        side,
        underlyingReferencePrice: sample.referencePrice,
      });
    }
  }

  const trainingSessions = [...new Set(trainingRows.map((row) => row.sample.sessionDate))].sort();
  return {
    underlyingSymbol: input.underlyingSymbol,
    model: {
      parentManifestHash: FROZEN_D2_PARENT_MANIFEST_HASH,
      target: FROZEN_D2_TARGET,
      model: FROZEN_D2_MODEL,
      horizonMinutes: 30,
      featureNames: MINIMAL_FEATURE_NAMES,
      trainingCutoffSessionExclusive: cutoffSession,
      trainingFirstSession: trainingSessions[0]!,
      trainingLastSession: trainingSessions[trainingSessions.length - 1]!,
      trainingSampleCount: trainingRows.length,
      lowerScoreThreshold,
      upperScoreThreshold,
      signalTailFraction: D2_SIGNAL_TAIL_FRACTION,
    },
    evaluatedDecisionCount: scoredDecisions.length,
    scoredDecisions,
    costGate: evaluateD2PremiumCostGate({
      underlyingSymbol: input.underlyingSymbol,
      signals,
      ticks: input.premiumTicks,
      quantity: input.lotSize,
      premiumSessionDates,
    }),
  };
}
