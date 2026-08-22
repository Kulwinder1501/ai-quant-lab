import { describe, expect, it } from "vitest";
import type { SessionCandle } from "../domain/session-calendar.js";
import { generateDirectionalDataset } from "./generate-directional-dataset.js";
import { extractMinimalFeaturesForSample, MINIMAL_FEATURE_NAMES } from "./feature-engine.js";
import { createPurgedWalkForwardSplits, fitFoldScaler } from "./purged-walk-forward-cv.js";
import {
  MultinomialLogisticRegression,
  BinaryLogisticRegression,
  RidgeRegression,
  TimeOfDayPrior,
  computeDecileMonotonicity,
} from "./learnability-baselines.js";
import { runD1LearnabilityStudy } from "./run-d1-learnability-study.js";
import { auditDirectionalCandles } from "./audit-directional-candles.js";
import { createStandardNseSession } from "../domain/session-calendar.js";
import { phase29ExcludedSpecialSessionMap } from "../domain/excluded-special-sessions.js";
import {
  phase29DataQualityCandleExclusionMap,
  phase29DataQualitySessionExclusionMap,
} from "../domain/data-quality-exclusions.js";

function generateSyntheticSessionCandles(sessionDate: string, numCandles = 375, trend = 0.0001): SessionCandle[] {
  const openAt = new Date(`${sessionDate}T09:15:00+05:30`);
  const startMs = openAt.getTime();
  const candles: SessionCandle[] = [];
  let curPrice = 100.0;

  for (let i = 0; i < numCandles; i += 1) {
    const cOpen = new Date(startMs + i * 60_000);
    const priceChange = curPrice * (trend + (Math.sin(i / 10) * 0.0005));
    const open = curPrice;
    const close = curPrice + priceChange;
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.05;
    const volume = 1000 + Math.floor(Math.sin(i / 5) * 200);

    candles.push({
      openTime: cOpen,
      closeTime: new Date(cOpen.getTime() + 60_000),
      open,
      high,
      low,
      close,
      volume,
    });
    curPrice = close;
  }
  return candles;
}

describe("Directional Intelligence V2 - Application Tests", () => {
  describe("generateDirectionalDataset", () => {
    it("generates samples with all 6 label families across sessions", () => {
      const candles: SessionCandle[] = [
        ...generateSyntheticSessionCandles("2026-01-02", 100),
        ...generateSyntheticSessionCandles("2026-01-05", 100),
      ];

      const dataset = generateDirectionalDataset("NIFTYBEES", candles);
      expect(dataset.instrument).toBe("NIFTYBEES");
      expect(dataset.sessions.length).toBe(2);
      expect(dataset.samples.length).toBeGreaterThan(0);

      const sample = dataset.samples[0]!;
      expect(sample.adaptive15).toBeDefined();
      expect(sample.tb15).toBeDefined();
      expect(sample.pathEff15).toBeDefined();
      expect(sample.continuous15).toBeDefined();
      expect(sample.moveSide15).toBeDefined();

      expect(dataset.overlapByHorizon.get(15)).toBeDefined();
    });

    it("advances ex-ante EWMA through returns observable before each intraday decision", () => {
      const openAt = new Date("2026-01-02T09:15:00+05:30");
      let price = 100;
      const candles: SessionCandle[] = [];
      for (let index = 0; index < 30; index += 1) {
        const open = price;
        price = index < 5 ? price : price * 1.003;
        const openTime = new Date(openAt.getTime() + index * 60_000);
        candles.push({
          openTime,
          closeTime: new Date(openTime.getTime() + 60_000),
          open,
          high: Math.max(open, price),
          low: Math.min(open, price),
          close: price,
          volume: 1_000,
        });
      }
      const dataset = generateDirectionalDataset("NIFTYBEES", candles);
      const atFive = dataset.samples.find((sample) => sample.minuteOfDay === 5)!;
      const atTen = dataset.samples.find((sample) => sample.minuteOfDay === 10)!;
      expect(atTen.volatility.ewmaStateBps).toBeGreaterThan(atFive.volatility.ewmaStateBps);
    });
  });

  describe("Feature Engine", () => {
    it("enforces intraday warmup and extracts 7 minimal scale-free features", () => {
      const sessionCandles = generateSyntheticSessionCandles("2026-01-02", 50);
      const dataset = generateDirectionalDataset("NIFTYBEES", sessionCandles);

      // Early sample (09:20, 5 bars in session) -> not eligible
      const earlySample = dataset.samples.find((s) => s.minuteOfDay === 5)!;
      const earlyFv = extractMinimalFeaturesForSample(earlySample, sessionCandles);
      expect(earlyFv.isEligible).toBe(false);

      // Warm sample (09:35, 20 bars in session) -> eligible
      const warmSample = dataset.samples.find((s) => s.minuteOfDay === 20)!;
      const warmFv = extractMinimalFeaturesForSample(warmSample, sessionCandles);
      expect(warmFv.isEligible).toBe(true);
      expect(warmFv.features.length).toBe(MINIMAL_FEATURE_NAMES.length);

      for (const feat of warmFv.features) {
        expect(Number.isFinite(feat)).toBe(true);
      }

      const fifteenBarSample = dataset.samples.find((s) => s.minuteOfDay === 15)!;
      expect(extractMinimalFeaturesForSample(fifteenBarSample, sessionCandles).isEligible).toBe(false);
    });
  });

  describe("Strict Candle Audit", () => {
    it("rejects an unexplained missing minute", () => {
      const session = createStandardNseSession("2026-01-02");
      const candles = generateSyntheticSessionCandles("2026-01-02").filter((_, index) => index !== 100);
      const audit = auditDirectionalCandles("NIFTYBEES", candles, [session]);
      expect(audit.ready).toBe(false);
      expect(audit.issues.some((issue) => issue.code === "MISSING_MINUTE")).toBe(true);
    });

    it("accepts one complete, aligned regular session", () => {
      const session = createStandardNseSession("2026-01-02");
      const audit = auditDirectionalCandles(
        "NIFTYBEES",
        generateSyntheticSessionCandles("2026-01-02"),
        [session],
      );
      expect(audit.ready).toBe(true);
      expect(audit.issues).toEqual([]);
    });

    it("reports a configured special session as an explicit exclusion", () => {
      const audit = auditDirectionalCandles(
        "NIFTYBEES",
        [
          ...generateSyntheticSessionCandles("2026-01-30"),
          ...generateSyntheticSessionCandles("2026-02-01"),
        ],
        [createStandardNseSession("2026-01-30")],
        { excludedSpecialSessions: phase29ExcludedSpecialSessionMap() },
      );
      expect(audit.ready).toBe(true);
      expect(audit.excludedSpecialSessionCount).toBe(1);
      expect(audit.excludedSpecialCandleCount).toBe(375);
      expect(audit.issues).toEqual([]);
    });

    it("drops a whole provider-corrupt session instead of accepting a partial path", () => {
      const corruptSession = generateSyntheticSessionCandles("2023-09-21").slice(1);
      const audit = auditDirectionalCandles(
        "NIFTYBEES",
        [...corruptSession, ...generateSyntheticSessionCandles("2023-09-22")],
        [createStandardNseSession("2023-09-22")],
        { excludedDataQualitySessions: phase29DataQualitySessionExclusionMap("NIFTYBEES") },
      );
      expect(audit.ready).toBe(true);
      expect(audit.excludedDataQualitySessionCount).toBe(1);
      expect(audit.excludedDataQualityCandleCount).toBe(374);
    });

    it("excludes only the frozen closing print while retaining its regular session", () => {
      const regular = generateSyntheticSessionCandles("2023-06-27");
      const closingPrint: SessionCandle = {
        ...regular.at(-1)!,
        openTime: new Date("2023-06-27T10:00:00.000Z"),
        closeTime: new Date("2023-06-27T10:01:00.000Z"),
      };
      const audit = auditDirectionalCandles(
        "NIFTYBEES",
        [...regular, closingPrint],
        [createStandardNseSession("2023-06-27")],
        { excludedCandleOpens: phase29DataQualityCandleExclusionMap("NIFTYBEES") },
      );
      expect(audit.ready).toBe(true);
      expect(audit.excludedDataQualitySessionCount).toBe(0);
      expect(audit.excludedDataQualityCandleCount).toBe(1);
    });
  });

  describe("Purged Walk-Forward CV & Fold Scaler", () => {
    it("fits scaler on train and transforms valid fold locally", () => {
      const trainX = [
        [10, 100],
        [20, 200],
        [30, 300],
      ];
      const scaler = fitFoldScaler(trainX);
      expect(scaler.means[0]).toBe(20);
      expect(scaler.means[1]).toBe(200);

      const transformed = scaler.transform([20, 200]);
      expect(transformed[0]).toBeCloseTo(0, 5);
      expect(transformed[1]).toBeCloseTo(0, 5);
    });

    it("creates walk-forward splits with purging of overlapping label spans", () => {
      const sessions = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06", "2026-01-07"];
      const allCandles: SessionCandle[] = [];
      for (const d of sessions) {
        allCandles.push(...generateSyntheticSessionCandles(d, 60));
      }

      const dataset = generateDirectionalDataset("NIFTYBEES", allCandles);
      const splits = createPurgedWalkForwardSplits(dataset.samples, 15, { numFolds: 3, minTrainSessions: 2 });

      expect(splits.length).toBe(3);
      for (const split of splits) {
        expect(split.trainIndices.length).toBeGreaterThan(0);
        expect(split.validIndices.length).toBeGreaterThan(0);
        // Ensure no train sample date is in validSessions
        const validSet = new Set(split.validSessions);
        for (const tIdx of split.trainIndices) {
          const sample = dataset.samples[tIdx]!;
          expect(validSet.has(sample.sessionDate)).toBe(false);
        }
      }
    });
  });

  describe("Baseline Learners & Diagnostics", () => {
    it("fits Binary and Multinomial Logistic Regression", () => {
      const X = [
        [-2, -2],
        [-1, -1],
        [1, 1],
        [2, 2],
      ];
      const yBinary = [0, 0, 1, 1];
      const binModel = new BinaryLogisticRegression();
      binModel.fit(X, yBinary, undefined, 1e-4, 0.1, 100);

      expect(binModel.predictProba([3, 3])).toBeGreaterThan(0.7);
      expect(binModel.predictProba([-3, -3])).toBeLessThan(0.3);

      const yMulti = [2, 2, 0, 0]; // 0 = UP, 2 = DOWN
      const multiModel = new MultinomialLogisticRegression();
      multiModel.fit(X, yMulti, 3, undefined, 1e-4, 0.1, 100);
      const probs = multiModel.predictProbas([3, 3]);
      expect(probs[0]).toBeGreaterThan(probs[2]!); // pUp > pDown
    });

    it("fits Ridge Regression and Time-of-Day Prior", () => {
      const X = [
        [1],
        [2],
        [3],
        [4],
      ];
      const y = [10, 20, 30, 40];
      const ridge = new RidgeRegression();
      ridge.fit(X, y, undefined, 0.1, 0.05, 200);
      expect(ridge.predict([5])).toBeGreaterThan(40);

      const tod = new TimeOfDayPrior();
      tod.fit([5, 5, 10, 10], [10, 20, 100, 200]);
      expect(tod.predict(5)).toBe(15);
      expect(tod.predict(10)).toBe(150);
    });

    it("computes decile monotonicity correctly", () => {
      const scores = Array.from({ length: 100 }, (_, i) => i);
      const returns = Array.from({ length: 100 }, (_, i) => (i - 50) * 2);

      const deciles = computeDecileMonotonicity(scores, returns, 10);
      expect(deciles.length).toBe(10);
      expect(deciles[0]!.meanRealizedReturnBps).toBeLessThan(deciles[9]!.meanRealizedReturnBps);
      expect(deciles[0]!.hitRate).toBeLessThan(deciles[9]!.hitRate);
    });
  });

  describe("runD1LearnabilityStudy", () => {
    it("executes full D1 pipeline and produces OOF evaluations", () => {
      const sessions = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05", "2026-01-06"];
      const allCandles: SessionCandle[] = [];
      for (const d of sessions) {
        allCandles.push(...generateSyntheticSessionCandles(d, 80));
      }

      const dataset = generateDirectionalDataset("NIFTYBEES", allCandles);
      const d1Result = runD1LearnabilityStudy(dataset, allCandles, { numFolds: 2, minTrainSessions: 2 });

      expect(d1Result.instrument).toBe("NIFTYBEES");
      expect(d1Result.totalEligibleSamples).toBeGreaterThan(0);
      expect(d1Result.evaluations.length).toBeGreaterThan(0);
      expect(d1Result.evaluations.some((evaluation) => evaluation.targetName === "D0-D2 Vol-Normalized")).toBe(true);
      expect(d1Result.evaluations.some((evaluation) => evaluation.modelType === "HuberRegression")).toBe(true);
      expect(d1Result.evaluations.some((evaluation) => evaluation.modelType.startsWith("QuantileRegression"))).toBe(true);

      for (const ev of d1Result.evaluations) {
        expect(ev.sampleCount).toBeGreaterThan(0);
        expect(ev.oofSpearmanIc).toBeDefined();
        expect(ev.oofResidualIc).toBeDefined();
        expect(ev.deciles.length).toBe(10);
        expect(ev.falsificationSuite?.verdict).not.toBe("FAIL_LOOKAHEAD");
      }
    });
  });
});
