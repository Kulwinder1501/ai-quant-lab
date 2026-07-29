import type { JsonObject, JsonValue, ModelStage } from "../../model-predictions/domain/model-prediction.js";
import { modelPredictionLabels, type ModelPredictionLabel } from "../../model-predictions/domain/model-prediction.js";

/**
 * The read model behind the Model Performance registry.
 *
 * Everything here is already-persisted training evidence. Reading it cannot
 * train, promote, reject, or archive a model, and it never exposes an artifact
 * path — only the checksum that proves which artifact a metric belongs to.
 */

export type LeakageRisk = "NONE" | "SUSPICIOUS_SCORE" | "NEGATIVE_GAP";

/** One partition's classification quality, exactly as the trainer recorded it. */
export interface ModelQualityMetrics {
  accuracy: number | null;
  balancedAccuracy: number | null;
  macroF1: number | null;
  directionalPredictions: number | null;
  directionalHitRate: number | null;
  coverage: number | null;
  sampleCount: number | null;
  classCounts: Record<string, number>;
}

/** The leakage-safe validation protocol a model version was measured under. */
export interface ModelValidationProtocol {
  method: string | null;
  validationFraction: number | null;
  purgeBars: number | null;
  horizonBars: number | null;
  neutralThresholdBps: number | null;
  dataCutoffAt: string | null;
}

/** The recorded outcome of the unseen-data promotion gate for this version. */
export interface ModelPromotionAssessment {
  decision: string | null;
  metric: string | null;
  improvement: number | null;
  incumbentMacroF1: number | null;
  incumbentModelVersionId: string | null;
}

/** Observed prediction activity for one model version. */
export interface ModelPredictionActivity {
  predictionCount: number;
  averageConfidence: number | null;
  labelCounts: Record<ModelPredictionLabel, number>;
  firstPredictionAt: Date | null;
  lastPredictionAt: Date | null;
}

export interface ModelVersionPerformance {
  /** A registry inspection record; it is not a signal and cannot place an order. */
  researchOnly: true;
  id: string;
  modelKey: string;
  version: number;
  algorithm: string;
  /** Short label for the model family behind the algorithm identifier. */
  algorithmFamily: "LINEAR" | "GRADIENT_BOOSTING" | "OTHER";
  stage: ModelStage;
  artifactChecksum: string | null;
  trainingRows: number;
  trainingWindow: { start: Date; end: Date };
  trainedAt: Date;
  promotedAt: Date | null;
  hyperparameters: JsonObject;
  featureSchema: JsonValue[];
  featureCount: number;
  trainingMetrics: ModelQualityMetrics;
  validationMetrics: ModelQualityMetrics;
  /**
   * Training macro-F1 minus validation macro-F1. A large positive gap is the
   * classic memorisation signature: the forest fits its own history far better
   * than the unseen period that decides promotion.
   */
  generalizationGap: number | null;
  leakageRisk: LeakageRisk;
  validationProtocol: ModelValidationProtocol;
  promotionAssessment: ModelPromotionAssessment;
  predictionActivity: ModelPredictionActivity;
}

export interface ListModelVersionsInput {
  modelKey?: string;
  algorithm?: string;
  stage?: ModelStage;
  limit: number;
}

export interface ModelPerformanceQueryRepository {
  list(input: ListModelVersionsInput): Promise<ModelVersionPerformance[]>;
}

const gradientBoostingAlgorithms = new Set([
  "xgboost-gradient-boosting-v1",
  "lightgbm-gradient-boosting-v1",
]);
const linearAlgorithms = new Set(["sklearn-logistic-regression-v1"]);

export function algorithmFamily(algorithm: string): ModelVersionPerformance["algorithmFamily"] {
  if (gradientBoostingAlgorithms.has(algorithm)) {
    return "GRADIENT_BOOSTING";
  }
  return linearAlgorithms.has(algorithm) ? "LINEAR" : "OTHER";
}

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asText(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readClassCounts(value: JsonValue | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [label, count] of Object.entries(asObject(value))) {
    const parsed = asNumber(count);
    if (parsed !== null) {
      counts[label] = parsed;
    }
  }
  return counts;
}

/** Parses one metrics block written by the Python trainer, tolerating older rows. */
export function readQualityMetrics(source: JsonValue | undefined): ModelQualityMetrics {
  const metrics = asObject(source);
  return {
    accuracy: asNumber(metrics.accuracy),
    balancedAccuracy: asNumber(metrics.balancedAccuracy),
    macroF1: asNumber(metrics.macroF1),
    directionalPredictions: asNumber(metrics.directionalPredictions),
    directionalHitRate: asNumber(metrics.directionalHitRate),
    coverage: asNumber(metrics.coverage),
    sampleCount: asNumber(metrics.sampleCount),
    classCounts: readClassCounts(metrics.classCounts),
  };
}

export function readValidationProtocol(source: JsonValue | undefined): ModelValidationProtocol {
  const protocol = asObject(source);
  return {
    method: asText(protocol.method),
    validationFraction: asNumber(protocol.validationFraction),
    purgeBars: asNumber(protocol.purgeBars),
    horizonBars: asNumber(protocol.horizonBars),
    neutralThresholdBps: asNumber(protocol.neutralThresholdBps),
    dataCutoffAt: asText(protocol.dataCutoffAt),
  };
}

export function readPromotionAssessment(source: JsonValue | undefined): ModelPromotionAssessment {
  const assessment = asObject(source);
  return {
    decision: asText(assessment.decision),
    metric: asText(assessment.metric),
    improvement: asNumber(assessment.improvement),
    incumbentMacroF1: asNumber(asObject(assessment.incumbent).macroF1),
    incumbentModelVersionId: asText(assessment.incumbentModelVersionId),
  };
}

export function emptyPredictionActivity(): ModelPredictionActivity {
  const labelCounts = Object.fromEntries(
    modelPredictionLabels.map((label) => [label, 0]),
  ) as Record<ModelPredictionLabel, number>;
  return {
    predictionCount: 0,
    averageConfidence: null,
    labelCounts,
    firstPredictionAt: null,
    lastPredictionAt: null,
  };
}

/**
 * Derives the training-to-validation macro-F1 gap.
 *
 * It stays null unless both partitions were recorded, because inventing a zero
 * gap for an older row would read as "generalises perfectly".
 */
export function generalizationGap(
  training: ModelQualityMetrics,
  validation: ModelQualityMetrics,
): number | null {
  if (training.macroF1 === null || validation.macroF1 === null) {
    return null;
  }
  return Number((training.macroF1 - validation.macroF1).toFixed(6));
}

/**
 * Builds the derived view of one persisted model version from its stored
 * `validation_metrics` envelope. The envelope is whatever the trainer wrote, so
 * every field is read defensively rather than trusted.
 */
export function buildModelVersionPerformance(input: {
  id: string;
  modelKey: string;
  version: number;
  algorithm: string;
  stage: ModelStage;
  artifactChecksum: string | null;
  trainingRows: number;
  trainingWindowStart: Date;
  trainingWindowEnd: Date;
  trainedAt: Date;
  promotedAt: Date | null;
  featureSchema: JsonValue[];
  storedMetrics: JsonObject;
  predictionActivity: ModelPredictionActivity;
}): ModelVersionPerformance {
  const trainingMetrics = readQualityMetrics(input.storedMetrics.trainingMetrics);
  const validationMetrics = readQualityMetrics(input.storedMetrics.validationMetrics);
  const gap = generalizationGap(trainingMetrics, validationMetrics);
  
  let leakageRisk: LeakageRisk = "NONE";
  if (validationMetrics.macroF1 !== null && validationMetrics.macroF1 > 0.60) {
    leakageRisk = "SUSPICIOUS_SCORE";
  } else if (gap !== null && gap < 0) {
    leakageRisk = "NEGATIVE_GAP";
  }

  return {
    researchOnly: true,
    id: input.id,
    modelKey: input.modelKey,
    version: input.version,
    algorithm: input.algorithm,
    algorithmFamily: algorithmFamily(input.algorithm),
    stage: input.stage,
    artifactChecksum: input.artifactChecksum,
    trainingRows: input.trainingRows,
    trainingWindow: { start: input.trainingWindowStart, end: input.trainingWindowEnd },
    trainedAt: input.trainedAt,
    promotedAt: input.promotedAt,
    hyperparameters: asObject(input.storedMetrics.hyperparameters),
    featureSchema: input.featureSchema,
    featureCount: input.featureSchema.length,
    trainingMetrics,
    validationMetrics,
    generalizationGap: gap,
    leakageRisk,
    validationProtocol: readValidationProtocol(input.storedMetrics.validationProtocol),
    promotionAssessment: readPromotionAssessment(input.storedMetrics.promotionAssessment),
    predictionActivity: input.predictionActivity,
  };
}
