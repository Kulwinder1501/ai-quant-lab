import { describe, expect, it } from "vitest";
import {
  BASELINE3_NOT_SCORED_REASON,
  combineGate7Reports,
  enablementDecision,
  evaluateGate7,
  scenarioBucket,
  type Gate7ForecastRow,
} from "../domain/gate7.js";
import { REPLAY_SURVIVORSHIP_LIMITATION } from "../domain/replay.js";
import { stockIntelligenceVersions } from "../domain/versions.js";

function completeCensorship(n: number) {
  return {
    jobId: "job-pass",
    status: "COMPLETE" as const,
    nSimulated: n,
    nFullyEvaluated: n,
    nCensored: 0,
    censoredPct: 0,
    censoredReasons: {},
    nPitPassed: n,
    nPitFailed: 0,
    survivorshipLimitation: REPLAY_SURVIVORSHIP_LIMITATION,
  };
}

function row(overrides: Partial<Gate7ForecastRow> & Pick<Gate7ForecastRow, "instrumentId" | "actualTotalReturn" | "calibratedProbability" | "distribution">): Gate7ForecastRow {
  return {
    asOf: "2016-01-31",
    horizon: "6M",
    pairStatus: "COMPLETE",
    regimeBucket: "expansion:low",
    investorFacing: true,
    rawProbability: overrides.calibratedProbability,
    sameDateEligibleMedian: 0.01,
    sectorStable: true,
    sectorIndexReturn: 0,
    predictedBeatSector: overrides.calibratedProbability,
    ...overrides,
  };
}

describe("Gate 7 formal scoring", () => {
  it("assigns bear/base/bull from the predicted percentile bands", () => {
    const distribution = { p10: -0.2, p25: -0.1, p50: 0.05, p75: 0.1, p90: 0.3 };
    expect(scenarioBucket(-0.15, distribution)).toBe("bear");
    expect(scenarioBucket(0.05, distribution)).toBe("base");
    expect(scenarioBucket(0.2, distribution)).toBe("bull");
  });

  it("refuses enablement when any criterion fails, including Baseline 3 without a sector-relative model", () => {
    const report = evaluateGate7({
      evaluationAsOf: "2017-01-31",
      censorship: completeCensorship(2),
      forecasts: [
        row({
          instrumentId: "a",
          calibratedProbability: 0.9,
          distribution: { p10: 0, p25: 0.05, p50: 0.2, p75: 0.3, p90: 0.4 },
          actualTotalReturn: 0.25,
          sectorStable: false,
          sectorIndexReturn: null,
          predictedBeatSector: null,
        }),
        row({
          instrumentId: "b",
          calibratedProbability: 0.1,
          distribution: { p10: -0.2, p25: -0.1, p50: -0.05, p75: 0, p90: 0.02 },
          actualTotalReturn: -0.04,
          sectorStable: false,
          sectorIndexReturn: null,
          predictedBeatSector: null,
        }),
      ],
    });
    expect(report.criteria.find((item) => item.id === 6)?.passed).toBe(false);
    expect(report.baselines.baseline3SkipReason).toBe(BASELINE3_NOT_SCORED_REASON);
    expect(report.enablement.eligible).toBe(false);
    expect(enablementDecision(false).eligible).toBe(false);
  });

  it("passes scenario, tail, regime, and sector-relative checks on a balanced COMPLETE sample", () => {
    const bearDist = { p10: -0.2, p25: -0.1, p50: -0.05, p75: 0.05, p90: 0.1 };
    const baseDist = { p10: -0.08, p25: -0.04, p50: 0.02, p75: 0.08, p90: 0.12 };
    const bullDist = { p10: 0.05, p25: 0.1, p50: 0.2, p75: 0.25, p90: 0.35 };
    const forecasts: Gate7ForecastRow[] = [];
    let bearCount = 0;
    for (let index = 0; index < 40; index += 1) {
      const regimeBucket = index < 20 ? "expansion:low" : "slowdown:normal";
      const asOf = index < 20 ? "2016-01-31" : "2016-07-31";
      if (index % 4 === 0) {
        bearCount += 1;
        forecasts.push(row({
          instrumentId: `bear-${index}`,
          asOf,
          regimeBucket,
          calibratedProbability: 0.1,
          distribution: bearDist,
          actualTotalReturn: bearCount <= 4 ? -0.2 : -0.15,
          sameDateEligibleMedian: 0.02,
        }));
      } else if (index % 4 === 3) {
        forecasts.push(row({
          instrumentId: `bull-${index}`,
          asOf,
          regimeBucket,
          calibratedProbability: 0.9,
          distribution: bullDist,
          actualTotalReturn: 0.27,
          sameDateEligibleMedian: 0.02,
        }));
      } else {
        const negativeBase = index % 4 === 1;
        forecasts.push(row({
          instrumentId: `base-${index}`,
          asOf,
          regimeBucket,
          calibratedProbability: 0.5,
          distribution: baseDist,
          actualTotalReturn: negativeBase ? -0.02 : 0.03,
          sameDateEligibleMedian: 0.02,
        }));
      }
    }

    const report = evaluateGate7({
      evaluationAsOf: "2017-01-31",
      censorship: completeCensorship(40),
      forecasts,
      horizon: "6M",
      pipelineVersions: stockIntelligenceVersions,
    });

    expect(report.criteria.find((item) => item.id === 1)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 2)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 3)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 4)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 5)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 6)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 7)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 8)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 9)?.passed).toBe(true);
    expect(report.criteria.find((item) => item.id === 10)?.passed).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.enablement.eligible).toBe(true);

    const twelve = evaluateGate7({
      evaluationAsOf: "2017-01-31",
      censorship: completeCensorship(40),
      forecasts: forecasts.map((item) => ({ ...item, horizon: "12M" as const })),
      horizon: "12M",
      pipelineVersions: stockIntelligenceVersions,
    });
    const acceptance = combineGate7Reports([report, twelve]);
    expect(acceptance.passed).toBe(true);
    expect(acceptance.enablement.eligible).toBe(true);
    expect(acceptance.enablement.reason).toContain("does not write those flags");
  });
});
