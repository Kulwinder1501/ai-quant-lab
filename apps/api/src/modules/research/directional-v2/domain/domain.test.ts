import { describe, expect, it } from "vitest";
import { createStandardNseSession, groupCandlesBySession, isLabelWithinSession, type SessionCandle } from "./session-calendar.js";
import { buildDecisionGridForSession } from "./decision-grid.js";
import { RobustAbsEwmaVolatilityEstimator, buildExpandingTodProfile, candleReturnBps } from "./ex-ante-volatility.js";
import { buildForwardPathForDecision } from "./forward-path.js";
import {
  labelAdaptiveFixedHorizon,
  labelTripleBarrier,
  labelPathEfficiency,
  labelContinuousReturn,
  labelMoveThenSide,
  reconstructMoveSideProbabilities,
} from "./label-families.js";
import { computeConcurrencyAndUniqueness } from "./concurrency-uniqueness.js";
import { generateD0QualityReport } from "./label-quality-report.js";

function makeCandle(openTimeStr: string, open: number, high: number, low: number, close: number, volume = 1000): SessionCandle {
  const openTime = new Date(openTimeStr);
  const closeTime = new Date(openTime.getTime() + 60_000);
  return { openTime, closeTime, open, high, low, close, volume };
}

describe("Directional Intelligence V2 - Domain Tests", () => {
  describe("Session Calendar & Invariants", () => {
    it("creates standard NSE session with 09:15 open and 15:30 close", () => {
      const session = createStandardNseSession("2026-01-02");
      expect(session.sessionId).toBe("2026-01-02");
      expect(session.openAt.toISOString()).toContain("T03:45:00"); // 09:15 IST = 03:45 UTC
      expect(session.closeAt.toISOString()).toContain("T10:00:00"); // 15:30 IST = 10:00 UTC
      expect(session.isSpecialSession).toBe(false);
    });

    it("enforces session boundaries for forward labels", () => {
      const session = createStandardNseSession("2026-01-02");
      const within = new Date(session.closeAt.getTime() - 5 * 60_000);
      const afterClose = new Date(session.closeAt.getTime() + 60_000);

      expect(isLabelWithinSession(within, session)).toBe(true);
      expect(isLabelWithinSession(session.closeAt, session)).toBe(true);
      expect(isLabelWithinSession(afterClose, session)).toBe(false);
    });

    it("groups candles into sessions and discards out-of-session bars", () => {
      const session = createStandardNseSession("2026-01-02");
      const candles: SessionCandle[] = [
        // Out of session: 09:00 IST
        makeCandle("2026-01-02T09:00:00+05:30", 100, 101, 99, 100),
        // In session: 09:15 IST
        makeCandle("2026-01-02T09:15:00+05:30", 100, 102, 99, 101),
        // In session: 15:29 IST
        makeCandle("2026-01-02T15:29:00+05:30", 101, 103, 100, 102),
        // Out of session: 15:31 IST
        makeCandle("2026-01-02T15:31:00+05:30", 102, 102, 101, 101),
      ];

      const grouped = groupCandlesBySession(candles, [session]);
      const sessionEntry = grouped.get("2026-01-02");
      expect(sessionEntry).toBeDefined();
      expect(sessionEntry!.candles.length).toBe(2);
      expect(sessionEntry!.candles[0]!.openTime.toISOString()).toBe(candles[1]!.openTime.toISOString());
    });

    it("treats a supplied point-in-time calendar as authoritative", () => {
      const allowed = createStandardNseSession("2026-01-02");
      const candles = [
        makeCandle("2026-01-02T09:15:00+05:30", 100, 101, 99, 100),
        makeCandle("2026-01-05T09:15:00+05:30", 100, 101, 99, 100),
      ];
      const grouped = groupCandlesBySession(candles, [allowed]);
      expect([...grouped.keys()]).toEqual(["2026-01-02"]);
    });
  });

  describe("5m Decision Grid", () => {
    it("anchors decision grid to 09:15 and enforces dataThrough semantics", () => {
      const session = createStandardNseSession("2026-01-02");
      const candles: SessionCandle[] = [];
      const startMs = session.openAt.getTime();
      // Generate 1m candles for 1 hour
      for (let i = 0; i < 60; i += 1) {
        const cOpen = new Date(startMs + i * 60_000);
        candles.push({
          openTime: cOpen,
          closeTime: new Date(cOpen.getTime() + 60_000),
          open: 100 + i * 0.1,
          high: 100.5 + i * 0.1,
          low: 99.5 + i * 0.1,
          close: 100.2 + i * 0.1,
          volume: 1000,
        });
      }

      const grid = buildDecisionGridForSession("NIFTYBEES", session, candles);
      expect(grid.length).toBeGreaterThan(0);

      // First decision point is 09:20 (minuteOfDay = 5) because 09:15 has no completed intraday bar
      const firstDecision = grid[0]!;
      expect(firstDecision.minuteOfDay).toBe(5);
      expect(firstDecision.sampleId).toContain("--0920");
      expect(firstDecision.dataThrough.getTime()).toBe(firstDecision.decisionAt.getTime() - 1);
      expect(firstDecision.referenceCandle.closeTime.getTime()).toBeLessThanOrEqual(firstDecision.decisionAt.getTime());
      expect(firstDecision.trailingSessionCandles.length).toBe(5); // candles 09:15 to 09:19
    });
  });

  describe("Ex-Ante Volatility Estimator", () => {
    it("updates robust absolute EWMA and computes horizon expected vol", () => {
      const estimator = new RobustAbsEwmaVolatilityEstimator(10.0, 0.94);
      const updated = estimator.update(15.0);
      expect(updated).toBeGreaterThan(0);

      const session = createStandardNseSession("2026-01-02");
      const candles = [
        makeCandle("2026-01-02T09:15:00+05:30", 100, 101, 99, 100),
        makeCandle("2026-01-02T09:16:00+05:30", 100, 101, 99, 100.5),
        makeCandle("2026-01-02T09:17:00+05:30", 100.5, 101, 100, 100.8),
        makeCandle("2026-01-02T09:18:00+05:30", 100.8, 102, 100, 101),
        makeCandle("2026-01-02T09:19:00+05:30", 101, 102, 100, 101.2),
      ];

      const grid = buildDecisionGridForSession("NIFTYBEES", session, candles);
      const decision = grid[0]!;
      const context = estimator.estimateForDecision(decision);

      expect(context.estimatorVersion).toBe("robust-abs-ewma-v1");
      expect(context.base1mExpectedVolBps).toBeGreaterThanOrEqual(2.0);
      expect(context.expectedVol15mBps).toBeCloseTo(context.base1mExpectedVolBps * Math.sqrt(15), 5);
      expect(context.expectedVol30mBps).toBeCloseTo(context.base1mExpectedVolBps * Math.sqrt(30), 5);
      expect(context.expectedVol60mBps).toBeCloseTo(context.base1mExpectedVolBps * Math.sqrt(60), 5);
    });

    it("detects extreme 1m shock without blowing up the background regime", () => {
      const estimator = new RobustAbsEwmaVolatilityEstimator(10.0, 0.94);
      const session = createStandardNseSession("2026-01-02");
      const candles = [
        makeCandle("2026-01-02T09:15:00+05:30", 100, 100.1, 99.9, 100),
        makeCandle("2026-01-02T09:16:00+05:30", 100, 100.1, 99.9, 100),
        makeCandle("2026-01-02T09:17:00+05:30", 100, 100.1, 99.9, 100),
        makeCandle("2026-01-02T09:18:00+05:30", 100, 100.1, 99.9, 100),
        // Giant shock candle +60 bps (100 -> 100.6)
        makeCandle("2026-01-02T09:19:00+05:30", 100, 100.8, 100, 100.6),
      ];

      const grid = buildDecisionGridForSession("NIFTYBEES", session, candles);
      const context = estimator.estimateForDecision(grid[0]!);

      expect(context.shockFlag).toBe(true);
      expect(context.shockMagnitude).toBeGreaterThan(4.0);
    });
  });

  describe("Forward Path & Independent Horizons", () => {
    it("builds independent segments and computes exact log returns", () => {
      const session = createStandardNseSession("2026-01-02");
      const startMs = session.openAt.getTime();
      const candles: SessionCandle[] = [];
      // Generate 75 candles (09:15 to 10:30)
      for (let i = 0; i < 75; i += 1) {
        const cOpen = new Date(startMs + i * 60_000);
        const price = 100 * (1 + i * 0.0005); // upward trend
        candles.push({
          openTime: cOpen,
          closeTime: new Date(cOpen.getTime() + 60_000),
          open: price,
          high: price * 1.001,
          low: price * 0.999,
          close: price,
          volume: 1000,
        });
      }

      const grid = buildDecisionGridForSession("NIFTYBEES", session, candles);
      const decision = grid[0]!; // 09:20
      const path = buildForwardPathForDecision(decision, candles);

      expect(path.horizon15).toBeDefined();
      expect(path.horizon30).toBeDefined();
      expect(path.horizon60).toBeDefined();

      expect(path.horizon15!.cumulativeReturnBps).toBeGreaterThan(0);
      expect(path.horizon30!.cumulativeReturnBps).toBeGreaterThan(path.horizon15!.cumulativeReturnBps);
      expect(path.horizon60!.cumulativeReturnBps).toBeGreaterThan(path.horizon30!.cumulativeReturnBps);
      expect(path.horizon30!.incrementalReturnBps).toBeCloseTo(
        path.horizon30!.cumulativeReturnBps - path.horizon15!.cumulativeReturnBps,
        5,
      );
    });

    it("drops horizon60 near the session close while keeping horizon15 and horizon30 valid", () => {
      const session = createStandardNseSession("2026-01-02");
      const startMs = session.openAt.getTime();
      const candles: SessionCandle[] = [];
      // Generate full session candles (375 bars: 09:15 to 15:30)
      for (let i = 0; i < 375; i += 1) {
        const cOpen = new Date(startMs + i * 60_000);
        candles.push({
          openTime: cOpen,
          closeTime: new Date(cOpen.getTime() + 60_000),
          open: 100,
          high: 101,
          low: 99,
          close: 100,
          volume: 1000,
        });
      }

      const grid = buildDecisionGridForSession("NIFTYBEES", session, candles);
      // Find decision at 15:00 (minuteOfDay = 345)
      const decision1500 = grid.find((d) => d.minuteOfDay === 345)!;
      expect(decision1500).toBeDefined();

      const path = buildForwardPathForDecision(decision1500, candles);
      // At 15:00, 15m (15:15) and 30m (15:30) are valid, but 60m (16:00) is past session close!
      expect(path.horizon15).toBeDefined();
      expect(path.horizon30).toBeDefined();
      expect(path.horizon60).toBeUndefined();
    });

    it("rejects a horizon with a missing interior minute instead of shortening the label", () => {
      const session = createStandardNseSession("2026-01-02");
      const startMs = session.openAt.getTime();
      const candles: SessionCandle[] = [];
      for (let i = 0; i < 30; i += 1) {
        if (i === 10) continue;
        const openTime = new Date(startMs + i * 60_000);
        candles.push({ openTime, closeTime: new Date(openTime.getTime() + 60_000), open: 100, high: 101, low: 99, close: 100, volume: 1 });
      }
      const decision = buildDecisionGridForSession("NIFTYBEES", session, candles)[0]!;
      expect(buildForwardPathForDecision(decision, candles).horizon15).toBeUndefined();
    });
  });

  describe("Label Families", () => {
    it("labels Adaptive Fixed Horizon (D0-A) correctly in vol units", () => {
      const session = createStandardNseSession("2026-01-02");
      const segment = {
        horizonMinutes: 15 as const,
        futurePrice: 100.2,
        cumulativeReturnBps: 20.0,
        incrementalReturnBps: 20.0,
        maxForwardReturnBps: 25.0,
        minForwardReturnBps: 0.0,
        labelStartAt: session.openAt,
        labelEndAt: new Date(session.openAt.getTime() + 15 * 60_000),
      };

      const upOutcome = labelAdaptiveFixedHorizon(segment, 25.0, 0.5); // 20 / 25 = 0.8 >= 0.5 -> UP
      expect(upOutcome.label).toBe("UP");

      const neutralOutcome = labelAdaptiveFixedHorizon(segment, 50.0, 0.5); // 20 / 50 = 0.4 < 0.5 -> NEUTRAL
      expect(neutralOutcome.label).toBe("NEUTRAL");
    });

    it("labels Triple Barrier (D0-B) and handles ambiguity", () => {
      const session = createStandardNseSession("2026-01-02");
      const decisionAt = session.openAt;
      const refCandle = makeCandle("2026-01-02T09:15:00+05:30", 100, 100, 100, 100);

      const path: any = {
        referencePrice: 100,
        forward1mCandles: [
          makeCandle("2026-01-02T09:16:00+05:30", 100, 100.2, 99.95, 100.1), // touches upper (+20bps) but low stays above -15bps
        ],
      };
      const segment: any = {
        horizonMinutes: 15,
        labelStartAt: decisionAt,
        labelEndAt: new Date(decisionAt.getTime() + 15 * 60_000),
      };

      const upperOutcome = labelTripleBarrier(path, segment, 15.0, 1.0);
      expect(upperOutcome.barrierOutcome).toBe("UPPER");
      expect(upperOutcome.isAmbiguous).toBe(false);

      // Ambiguous case: single candle touches both +20bps and -20bps
      const ambPath: any = {
        referencePrice: 100,
        forward1mCandles: [
          makeCandle("2026-01-02T09:16:00+05:30", 100, 100.3, 99.7, 100),
        ],
      };
      const ambOutcome = labelTripleBarrier(ambPath, segment, 15.0, 1.0);
      expect(ambOutcome.barrierOutcome).toBe("AMBIGUOUS");
      expect(ambOutcome.isAmbiguous).toBe(true);
    });

    it("calculates Signed Path Efficiency (D0-C) and clamps between -1 and +1", () => {
      const session = createStandardNseSession("2026-01-02");
      const decisionAt = session.openAt;

      // Clean trend: 100 -> 101 -> 102 -> 103
      const cleanPath: any = {
        referencePrice: 100,
        forward1mCandles: [
          makeCandle("2026-01-02T09:16:00+05:30", 100, 101, 100, 101),
          makeCandle("2026-01-02T09:17:00+05:30", 101, 102, 101, 102),
          makeCandle("2026-01-02T09:18:00+05:30", 102, 103, 102, 103),
        ],
      };
      const segment: any = {
        horizonMinutes: 15,
        cumulativeReturnBps: 10_000 * Math.log(103 / 100),
        labelStartAt: decisionAt,
        labelEndAt: new Date(decisionAt.getTime() + 15 * 60_000),
      };

      const outcome = labelPathEfficiency(cleanPath, segment);
      expect(outcome.signedPathEfficiency).toBeCloseTo(1.0, 5);
      expect(outcome.absolutePathEfficiency).toBeCloseTo(1.0, 5);

      // Motionless path protected by PATH_FLOOR_BPS
      const flatPath: any = {
        referencePrice: 100,
        forward1mCandles: [
          makeCandle("2026-01-02T09:16:00+05:30", 100, 100, 100, 100),
        ],
      };
      const flatSegment: any = {
        horizonMinutes: 15,
        cumulativeReturnBps: 0,
        labelStartAt: decisionAt,
        labelEndAt: new Date(decisionAt.getTime() + 15 * 60_000),
      };
      const flatOutcome = labelPathEfficiency(flatPath, flatSegment);
      expect(flatOutcome.signedPathEfficiency).toBe(0);
    });

    it("labels Move-then-Side (D0-E) and reconstructs unconditional probabilities", () => {
      const session = createStandardNseSession("2026-01-02");
      const segment: any = {
        horizonMinutes: 15,
        cumulativeReturnBps: 25.0,
        labelStartAt: session.openAt,
        labelEndAt: new Date(session.openAt.getTime() + 15 * 60_000),
      };

      const outcome = labelMoveThenSide(segment, 20.0, 0.5); // 25 / 20 = 1.25 >= 0.5
      expect(outcome.moveLabel).toBe(1);
      expect(outcome.sideLabel).toBe("UP");

      const probs = reconstructMoveSideProbabilities(0.8, 0.75);
      expect(probs.pUp).toBeCloseTo(0.6, 5); // 0.8 * 0.75
      expect(probs.pDown).toBeCloseTo(0.2, 5); // 0.8 * 0.25
      expect(probs.pNeutral).toBeCloseTo(0.2, 5); // 1 - 0.8
      expect(probs.directionalScore).toBeCloseTo(0.4, 5); // 0.6 - 0.2
    });
  });

  describe("Concurrency & Uniqueness", () => {
    it("computes uniqueness weight and overlap-adjusted sample count", () => {
      const now = new Date("2026-01-02T09:15:00+05:30");
      // 3 overlapping 15m samples on a 5m grid
      const samples = [
        { sampleId: "s1", labelStartAt: now, labelEndAt: new Date(now.getTime() + 15 * 60_000) },
        { sampleId: "s2", labelStartAt: new Date(now.getTime() + 5 * 60_000), labelEndAt: new Date(now.getTime() + 20 * 60_000) },
        { sampleId: "s3", labelStartAt: new Date(now.getTime() + 10 * 60_000), labelEndAt: new Date(now.getTime() + 25 * 60_000) },
      ];

      const result = computeConcurrencyAndUniqueness(samples);
      expect(result.summary.rawSampleCount).toBe(3);
      expect(result.summary.averageConcurrency).toBeGreaterThan(1);
      expect(result.summary.averageUniqueness).toBeLessThan(1);
      expect(result.summary.overlapAdjustedSampleCount).toBeLessThan(3);
    });

    it("does not count touching interval endpoints as an overlapping minute", () => {
      const start = new Date("2026-01-02T09:15:00+05:30");
      const result = computeConcurrencyAndUniqueness([
        { sampleId: "left", labelStartAt: start, labelEndAt: new Date(start.getTime() + 5 * 60_000) },
        { sampleId: "right", labelStartAt: new Date(start.getTime() + 5 * 60_000), labelEndAt: new Date(start.getTime() + 10 * 60_000) },
      ]);
      expect(result.summary.averageConcurrency).toBe(1);
      expect(result.summary.overlapAdjustedSampleCount).toBe(2);
    });
  });
});
