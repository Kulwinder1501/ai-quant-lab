import type { JsonObject } from "../research/json";

/** Read-only view types for the model registry served by GET /model-versions. */

export type ModelStage = "CANDIDATE" | "PRODUCTION" | "REJECTED" | "ARCHIVED";
export type AlgorithmFamily = "LINEAR" | "GRADIENT_BOOSTING" | "OTHER";

export type LeakageRisk = "NONE" | "SUSPICIOUS_SCORE" | "NEGATIVE_GAP";

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

export interface ModelValidationProtocol {
  method: string | null;
  validationFraction: number | null;
  purgeBars: number | null;
  horizonBars: number | null;
  neutralThresholdBps: number | null;
  dataCutoffAt: string | null;
}

export interface ModelPromotionAssessment {
  decision: string | null;
  metric: string | null;
  improvement: number | null;
  incumbentMacroF1: number | null;
  incumbentModelVersionId: string | null;
}

export interface ModelPredictionActivity {
  predictionCount: number;
  averageConfidence: number | null;
  labelCounts: Record<string, number>;
  firstPredictionAt: string | null;
  lastPredictionAt: string | null;
}

export interface ModelVersionPerformance {
  /** A registry inspection record; it is not a signal and cannot place an order. */
  researchOnly: true;
  id: string;
  modelKey: string;
  version: number;
  algorithm: string;
  algorithmFamily: AlgorithmFamily;
  stage: ModelStage;
  artifactChecksum: string | null;
  trainingRows: number | null;
  trainingWindow: { start: string | null; end: string | null };
  trainedAt: string | null;
  promotedAt: string | null;
  hyperparameters: JsonObject;
  featureCount: number | null;
  trainingMetrics: ModelQualityMetrics;
  validationMetrics: ModelQualityMetrics;
  generalizationGap: number | null;
  leakageRisk: LeakageRisk;
  validationProtocol: ModelValidationProtocol;
  promotionAssessment: ModelPromotionAssessment;
  predictionActivity: ModelPredictionActivity;
}

export interface ModelFamilySummary {
  modelKey: string;
  versionCount: number;
  algorithms: string[];
  latestVersion: number | null;
  productionVersionId: string | null;
  bestValidationMacroF1: number | null;
}

export interface ModelPerformancePage {
  records: ModelVersionPerformance[];
  families: ModelFamilySummary[];
  limit: number;
  truncated: boolean;
}

export interface ModelPerformanceFilters {
  stage: ModelStage | "ALL";
  algorithm: string | "ALL";
  modelKey: string | "ALL";
  limit: number;
}

export const defaultModelPerformanceFilters: ModelPerformanceFilters = {
  stage: "ALL",
  algorithm: "ALL",
  modelKey: "ALL",
  limit: 50,
};

export function modelVersionQuery(filters: ModelPerformanceFilters): string {
  const parameters = new URLSearchParams();
  if (filters.stage !== "ALL") parameters.set("stage", filters.stage);
  if (filters.algorithm !== "ALL") parameters.set("algorithm", filters.algorithm);
  if (filters.modelKey !== "ALL") parameters.set("modelKey", filters.modelKey);
  parameters.set("limit", String(filters.limit));
  return `/model-versions?${parameters.toString()}`;
}

/** A short, human label for a persisted algorithm identifier. */
export function algorithmLabel(algorithm: string): string {
  switch (algorithm) {
    case "sklearn-logistic-regression-v1":
      return "Logistic regression";
    case "xgboost-gradient-boosting-v1":
      return "XGBoost";
    case "lightgbm-gradient-boosting-v1":
      return "LightGBM";
    default:
      return algorithm;
  }
}

/** How a family's predictions are explained, which follows from the algorithm. */
export function explanationMethodLabel(family: AlgorithmFamily): string {
  if (family === "GRADIENT_BOOSTING") return "Exact TreeSHAP contributions";
  return family === "LINEAR" ? "Linear coefficient terms" : "No local explainer";
}

export function stageTone(stage: ModelStage): string {
  switch (stage) {
    case "PRODUCTION":
      return "border-emerald-300/35 bg-emerald-300/10 text-emerald-100";
    case "CANDIDATE":
      return "border-cyan-300/35 bg-cyan-300/10 text-cyan-100";
    case "REJECTED":
      return "border-rose-300/35 bg-rose-300/10 text-rose-100";
    default:
      return "border-slate-500/35 bg-slate-500/10 text-slate-200";
  }
}

/**
 * Reads the promotion decision as a short sentence.
 *
 * An unrecognised decision string is shown verbatim rather than being
 * reinterpreted, so a future trainer decision can never be mislabelled here.
 */
export function promotionDecisionLabel(decision: string | null): string {
  switch (decision) {
    case "CANDIDATE_OUTPERFORMS_INCUMBENT":
      return "Beat the incumbent on unseen data";
    case "CANDIDATE_DID_NOT_OUTPERFORM_INCUMBENT":
      return "Did not beat the incumbent";
    case "INITIAL_BASELINE_THRESHOLD_MET":
      return "Met the initial quality floor";
    case "INITIAL_BASELINE_THRESHOLD_NOT_MET":
      return "Missed the initial quality floor";
    case "INCUMBENT_NOT_EVALUABLE":
      return "Incumbent could not be re-scored safely";
    case null:
      return "No promotion gate recorded";
    default:
      return decision;
  }
}

/**
 * A plain-language reading of the training-to-validation macro-F1 gap.
 *
 * The thresholds are presentation heuristics for a research dashboard, not a
 * statistical test, so the wording stays descriptive.
 */
export function generalizationLabel(gap: number | null): { text: string; tone: string } {
  if (gap === null) return { text: "Not recorded", tone: "text-slate-400" };
  if (gap >= 0.25) return { text: "Fits its own history far better than unseen data", tone: "text-rose-300" };
  if (gap >= 0.1) return { text: "Noticeably better on training data", tone: "text-amber-200" };
  if (gap <= -0.05) return { text: "Scores higher on the holdout than on training", tone: "text-cyan-200" };
  return { text: "Training and holdout scores are close", tone: "text-emerald-300" };
}
