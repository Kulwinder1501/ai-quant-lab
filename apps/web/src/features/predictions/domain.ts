import type { JsonObject } from "../research/json";

export interface PredictionSummary {
  id: string;
  researchOnly: true;
  prediction: string;
  confidence: number | null;
  createdAt: string | null;
  evidenceCutoffAt: string | null;
  instrument: {
    symbol: string;
    displayName: string | null;
  };
  sourceCandle: {
    id: string | null;
    timeframe: string | null;
    openTime: string | null;
    closeTime: string | null;
    close: number | null;
  };
  model: {
    id: string | null;
    key: string | null;
    version: number | null;
    algorithm: string | null;
    currentStage: string | null;
    trainedAt: string | null;
    promotedAt: string | null;
    validationMetrics: JsonObject;
  };
}

export interface FeatureContribution {
  feature: string;
  category: string | null;
  rawValue: number | null;
  /** Only a linear model has a coefficient; a boosted forest reports null. */
  coefficient: number | null;
  contribution: number | null;
  /** How the contribution was derived: LINEAR_COEFFICIENT_V1 or TREE_SHAP_V1. */
  contributionMethod: string | null;
  supportsPredictedClass: boolean | null;
}

export interface ExplanationEntry {
  kind: string;
  summary: string;
  details: JsonObject;
}

export interface PredictionDetail extends PredictionSummary {
  featureContributions: FeatureContribution[];
  explanation: ExplanationEntry[];
}
