import { asNumber, asObject, asString, objectAt } from "../research/json";
import type {
  AlgorithmFamily,
  ModelFamilySummary,
  ModelPerformancePage,
  ModelPredictionActivity,
  ModelPromotionAssessment,
  ModelQualityMetrics,
  ModelStage,
  ModelValidationProtocol,
  ModelVersionPerformance,
  LeakageRisk,
} from "./domain";

const stages: readonly ModelStage[] = ["CANDIDATE", "PRODUCTION", "REJECTED", "ARCHIVED"];
const families: readonly AlgorithmFamily[] = ["LINEAR", "GRADIENT_BOOSTING", "OTHER"];
const leakageRisks: readonly LeakageRisk[] = ["NONE", "SUSPICIOUS_SCORE", "NEGATIVE_GAP"];

function member<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const text = asString(value);
  return text && (allowed as readonly string[]).includes(text) ? text as T : fallback;
}

function countMap(value: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(asObject(value) ?? {})) {
    const parsed = asNumber(count);
    if (parsed !== null) counts[key] = parsed;
  }
  return counts;
}

function parseMetrics(value: unknown): ModelQualityMetrics {
  const metrics = asObject(value) ?? {};
  return {
    accuracy: asNumber(metrics.accuracy),
    balancedAccuracy: asNumber(metrics.balancedAccuracy),
    macroF1: asNumber(metrics.macroF1),
    // Absent on rows written before directional metrics existed, so these stay
    // null rather than being defaulted to a misleading zero.
    directionalPredictions: asNumber(metrics.directionalPredictions),
    directionalHitRate: asNumber(metrics.directionalHitRate),
    coverage: asNumber(metrics.coverage),
    sampleCount: asNumber(metrics.sampleCount),
    classCounts: countMap(metrics.classCounts),
  };
}

function parseProtocol(value: unknown): ModelValidationProtocol {
  const protocol = asObject(value) ?? {};
  return {
    method: asString(protocol.method),
    validationFraction: asNumber(protocol.validationFraction),
    purgeBars: asNumber(protocol.purgeBars),
    horizonBars: asNumber(protocol.horizonBars),
    neutralThresholdBps: asNumber(protocol.neutralThresholdBps),
    dataCutoffAt: asString(protocol.dataCutoffAt),
  };
}

function parseAssessment(value: unknown): ModelPromotionAssessment {
  const assessment = asObject(value) ?? {};
  return {
    decision: asString(assessment.decision),
    metric: asString(assessment.metric),
    improvement: asNumber(assessment.improvement),
    incumbentMacroF1: asNumber(assessment.incumbentMacroF1),
    incumbentModelVersionId: asString(assessment.incumbentModelVersionId),
  };
}

function parseActivity(value: unknown): ModelPredictionActivity {
  const activity = asObject(value) ?? {};
  return {
    predictionCount: asNumber(activity.predictionCount) ?? 0,
    averageConfidence: asNumber(activity.averageConfidence),
    labelCounts: countMap(activity.labelCounts),
    firstPredictionAt: asString(activity.firstPredictionAt),
    lastPredictionAt: asString(activity.lastPredictionAt),
  };
}

export function parseModelVersionPerformance(value: unknown): ModelVersionPerformance | null {
  const record = asObject(value);
  if (!record) return null;
  const id = asString(record.id);
  const modelKey = asString(record.modelKey);
  const algorithm = asString(record.algorithm);
  const version = asNumber(record.version);
  // Only a record that declares itself research-only is rendered.
  if (!id || !modelKey || !algorithm || version === null || record.researchOnly !== true) return null;

  const trainingWindow = objectAt(record, "trainingWindow");
  return {
    researchOnly: true,
    id,
    modelKey,
    version,
    algorithm,
    algorithmFamily: member(record.algorithmFamily, families, "OTHER"),
    stage: member(record.stage, stages, "CANDIDATE"),
    // An unrecognised or absent risk reads as NONE: the badge should only appear
    // when the API positively asserts a risk, never on a parsing gap.
    leakageRisk: member(record.leakageRisk, leakageRisks, "NONE"),
    artifactChecksum: asString(record.artifactChecksum),
    trainingRows: asNumber(record.trainingRows),
    trainingWindow: {
      start: asString(trainingWindow.start),
      end: asString(trainingWindow.end),
    },
    trainedAt: asString(record.trainedAt),
    promotedAt: asString(record.promotedAt),
    hyperparameters: objectAt(record, "hyperparameters"),
    featureCount: asNumber(record.featureCount),
    trainingMetrics: parseMetrics(record.trainingMetrics),
    validationMetrics: parseMetrics(record.validationMetrics),
    generalizationGap: asNumber(record.generalizationGap),
    validationProtocol: parseProtocol(record.validationProtocol),
    promotionAssessment: parseAssessment(record.promotionAssessment),
    predictionActivity: parseActivity(record.predictionActivity),
  };
}

function parseFamily(value: unknown): ModelFamilySummary | null {
  const family = asObject(value);
  const modelKey = family && asString(family.modelKey);
  if (!family || !modelKey) return null;
  return {
    modelKey,
    versionCount: asNumber(family.versionCount) ?? 0,
    algorithms: Array.isArray(family.algorithms)
      ? family.algorithms.map(asString).filter((item): item is string => item !== null)
      : [],
    latestVersion: asNumber(family.latestVersion),
    productionVersionId: asString(family.productionVersionId),
    bestValidationMacroF1: asNumber(family.bestValidationMacroF1),
  };
}

export function parseModelPerformanceEnvelope(value: unknown): ModelPerformancePage {
  const payload = asObject(value) ?? {};
  const page = objectAt(payload, "page");
  return {
    records: Array.isArray(payload.data)
      ? payload.data
        .map(parseModelVersionPerformance)
        .filter((record): record is ModelVersionPerformance => record !== null)
      : [],
    families: Array.isArray(payload.families)
      ? payload.families.map(parseFamily).filter((family): family is ModelFamilySummary => family !== null)
      : [],
    limit: asNumber(page.limit) ?? 0,
    truncated: page.truncated === true,
  };
}
