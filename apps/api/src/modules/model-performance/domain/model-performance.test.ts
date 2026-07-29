import { describe, expect, it } from "vitest";
import {
  algorithmFamily,
  buildModelVersionPerformance,
  emptyPredictionActivity,
  generalizationGap,
  readPromotionAssessment,
  readQualityMetrics,
  readValidationProtocol,
} from "./model-performance.js";

function storedMetrics() {
  return {
    algorithm: "xgboost-gradient-boosting-v1",
    hyperparameters: { nEstimators: 300, maxDepth: 3 },
    trainingRows: 480,
    validationRows: 120,
    trainingMetrics: {
      accuracy: 0.81,
      balancedAccuracy: 0.79,
      macroF1: 0.78,
      sampleCount: 480,
      classCounts: { BEARISH: 150, NEUTRAL: 180, BULLISH: 150 },
    },
    validationMetrics: {
      accuracy: 0.58,
      balancedAccuracy: 0.55,
      macroF1: 0.54,
      sampleCount: 120,
      classCounts: { BEARISH: 40, NEUTRAL: 40, BULLISH: 40 },
    },
    validationProtocol: {
      method: "PURGED_CHRONOLOGICAL_V1",
      validationFraction: 0.2,
      purgeBars: 5,
      horizonBars: 5,
      neutralThresholdBps: 50,
      dataCutoffAt: "2026-07-01T00:00:00+00:00",
    },
    promotionAssessment: {
      metric: "macroF1",
      decision: "CANDIDATE_OUTPERFORMS_INCUMBENT",
      improvement: 0.04,
      incumbentModelVersionId: "model-version-0",
      incumbent: { macroF1: 0.5 },
    },
  };
}

describe("algorithmFamily", () => {
  it("separates the boosted forests from the linear baseline", () => {
    expect(algorithmFamily("sklearn-logistic-regression-v1")).toBe("LINEAR");
    expect(algorithmFamily("xgboost-gradient-boosting-v1")).toBe("GRADIENT_BOOSTING");
    expect(algorithmFamily("lightgbm-gradient-boosting-v1")).toBe("GRADIENT_BOOSTING");
    expect(algorithmFamily("pytorch-transformer-v9")).toBe("OTHER");
  });
});

describe("generalizationGap", () => {
  it("measures how much better a model fits its own history than unseen data", () => {
    const gap = generalizationGap(
      readQualityMetrics(storedMetrics().trainingMetrics),
      readQualityMetrics(storedMetrics().validationMetrics),
    );

    expect(gap).toBeCloseTo(0.24, 6);
  });

  it("stays null when either partition was never recorded", () => {
    const recorded = readQualityMetrics(storedMetrics().validationMetrics);
    const missing = readQualityMetrics(undefined);

    expect(generalizationGap(missing, recorded)).toBeNull();
    expect(generalizationGap(recorded, missing)).toBeNull();
  });
});

describe("reading a stored metrics envelope", () => {
  it("parses metrics, protocol, and the promotion decision", () => {
    const metrics = readQualityMetrics(storedMetrics().validationMetrics);
    const protocol = readValidationProtocol(storedMetrics().validationProtocol);
    const assessment = readPromotionAssessment(storedMetrics().promotionAssessment);

    expect(metrics.macroF1).toBe(0.54);
    expect(metrics.sampleCount).toBe(120);
    expect(metrics.classCounts).toEqual({ BEARISH: 40, NEUTRAL: 40, BULLISH: 40 });
    expect(protocol.method).toBe("PURGED_CHRONOLOGICAL_V1");
    expect(protocol.purgeBars).toBe(5);
    expect(assessment.decision).toBe("CANDIDATE_OUTPERFORMS_INCUMBENT");
    expect(assessment.improvement).toBe(0.04);
    expect(assessment.incumbentMacroF1).toBe(0.5);
  });

  it("tolerates an envelope written before these fields existed", () => {
    const metrics = readQualityMetrics({ macroF1: "not a number" });
    const protocol = readValidationProtocol(undefined);
    const assessment = readPromotionAssessment({});

    expect(metrics.macroF1).toBeNull();
    expect(metrics.classCounts).toEqual({});
    expect(protocol.horizonBars).toBeNull();
    expect(assessment.decision).toBeNull();
    expect(assessment.incumbentMacroF1).toBeNull();
  });
});

describe("buildModelVersionPerformance", () => {
  it("derives the full registry view without exposing an artifact path", () => {
    const performance = buildModelVersionPerformance({
      id: "model-version-1",
      modelKey: "market-direction-xgboost--NIFTY50--1d--h5--neutral-50bps--ml-feature-v1",
      version: 2,
      algorithm: "xgboost-gradient-boosting-v1",
      stage: "PRODUCTION",
      artifactChecksum: "a".repeat(64),
      trainingRows: 480,
      trainingWindowStart: new Date("2024-01-02T00:00:00.000Z"),
      trainingWindowEnd: new Date("2025-12-31T00:00:00.000Z"),
      trainedAt: new Date("2026-07-01T09:00:00.000Z"),
      promotedAt: new Date("2026-07-01T09:05:00.000Z"),
      featureSchema: [{ name: "indicator.rsi_14" }, { name: "pattern.hammer" }],
      storedMetrics: storedMetrics(),
      predictionActivity: emptyPredictionActivity(),
    });

    expect(performance.researchOnly).toBe(true);
    expect(performance.algorithmFamily).toBe("GRADIENT_BOOSTING");
    expect(performance.featureCount).toBe(2);
    expect(performance.hyperparameters).toEqual({ nEstimators: 300, maxDepth: 3 });
    expect(performance.validationMetrics.macroF1).toBe(0.54);
    expect(performance.generalizationGap).toBeCloseTo(0.24, 6);
    expect(performance.promotionAssessment.decision).toBe("CANDIDATE_OUTPERFORMS_INCUMBENT");
    expect(performance.predictionActivity.predictionCount).toBe(0);
    expect(Object.keys(performance)).not.toContain("artifactUri");
  });

  it("gives every version its own prediction-activity counters", () => {
    const first = emptyPredictionActivity();
    const second = emptyPredictionActivity();

    first.labelCounts.BULLISH += 3;

    expect(second.labelCounts.BULLISH).toBe(0);
  });
});
