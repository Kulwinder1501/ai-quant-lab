import { describe, expect, it } from "vitest";
import type { CanonicalMarketBar } from "../domain/adapters.js";
import type { AnalogueMember, AnalogueSet } from "../domain/analogue-search.js";
import {
  applyCalibration,
  applyIsotonic,
  fitCalibration,
  fitIsotonic,
  isUsableTrainingObservation,
} from "../domain/calibration.js";
import type { CorporateActionRecord } from "../domain/canonical.js";
import { evaluateGate7 } from "../domain/gate7.js";
import {
  OutcomeModel12M,
  OutcomeModel6M,
  empiricalDistribution,
  horizonEndUtc,
  probabilityPositive,
  scenariosFromDistribution,
} from "../domain/outcome-model.js";
import { REPLAY_SURVIVORSHIP_LIMITATION } from "../domain/replay.js";
import { measureRealizedHorizon, realizeAnalogueMembers } from "./measure-realized-return.js";

function analogueSet(overrides: Partial<AnalogueSet> = {}): AnalogueSet {
  return {
    horizon: "6M",
    queryInstrumentId: "q",
    queryAsOf: "2018-01-31",
    regimeBucket: "expansion:low",
    distanceMetric: "euclidean",
    nCandidates: 0,
    nSameRegime: 0,
    nCrossRegime: 0,
    effectiveSampleSize: 0,
    similarityQuality: 0,
    investorFacing: false,
    industryPenaltyApplied: false,
    members: [],
    ...overrides,
  };
}

function member(instrumentId: string, asOf: string, similarity = 1): AnalogueMember {
  return {
    instrumentId,
    asOf,
    distance: 0,
    similarity,
    weight: similarity,
    sameRegime: true,
  };
}

function bar(instrumentId: string, day: string, close: string, availableAt = `${day}T00:00:00.000Z`): CanonicalMarketBar {
  const openTime = new Date(`${day}T00:00:00.000Z`);
  return {
    instrumentId,
    openTime,
    closeTime: new Date(availableAt),
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
    publishedAt: new Date(availableAt),
    effectiveAt: openTime,
    availableAt: new Date(availableAt),
  };
}

function monthlyPath(instrumentId: string, from: string, months: number, closeAt: (index: number) => number): CanonicalMarketBar[] {
  const start = new Date(`${from}T00:00:00.000Z`);
  return Array.from({ length: months }, (_, index) => {
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, start.getUTCDate()));
    const key = day.toISOString().slice(0, 10);
    return bar(instrumentId, key, String(closeAt(index)));
  });
}

describe("horizon calendar", () => {
  it("adds six months from a month-end without rolling into the next month", () => {
    const end = horizonEndUtc(new Date("2016-01-31T23:59:59.999Z"), "6M");
    expect(end.toISOString().slice(0, 10)).toBe("2016-07-31");
    expect(horizonEndUtc(new Date("2016-01-31T23:59:59.999Z"), "12M").toISOString().slice(0, 10)).toBe("2017-01-31");
  });
});

describe("outcome distribution", () => {
  it("builds weighted percentiles and scenarios that sum to 100%", () => {
    const samples = [-0.20, 0, 0.10, 0.20, 0.50].map((value) => ({ value, weight: 1 }));
    const distribution = empiricalDistribution(samples);
    expect(distribution.p50).toBeCloseTo(0.10, 8);
    expect(probabilityPositive(samples)).toBeCloseTo(0.6, 8);
    const scenarios = scenariosFromDistribution(distribution);
    expect(scenarios.bear.probability + scenarios.base.probability + scenarios.bull.probability).toBe(1);
    expect(scenarios.bear.threshold).toBe("lte_p25");
  });

  it("keeps OutcomeModel6M and OutcomeModel12M as separate named models", () => {
    const forecast = new OutcomeModel6M().predict({
      analogueSet: analogueSet(),
      realized: [],
      nDroppedIncomplete: 0,
      fundamentalCompleteness: 1,
      calibratedProbabilityPositiveReturn: null,
      calibrationSource: "none",
    });
    expect(forecast.horizon).toBe("6M");
    expect(forecast.investorFacing).toBe(false);
    expect(forecast.status).toBe("INSUFFICIENT_ANALOGUES");
    expect(new OutcomeModel12M().horizon).toBe("12M");
  });
});

describe("realized analogue returns", () => {
  it("drops analogues whose 6M horizon has not completed by the query asOf", () => {
    const measured = measureRealizedHorizon({
      predictionAsOf: new Date("2016-01-31T23:59:59.999Z"),
      horizon: "6M",
      evaluationCutoff: new Date("2016-03-31T23:59:59.999Z"),
      bars: monthlyPath("a", "2016-01-31", 8, () => 10),
      actions: [],
    });
    expect(measured).toEqual({ status: "DROPPED", reason: "HORIZON_NOT_COMPLETE" });
  });

  it("ignores a post-cutoff close when measuring a completed analogue horizon", () => {
    const path = [
      ...monthlyPath("a", "2016-01-31", 7, (index) => 100 + index),
      bar("a", "2017-06-01", "999", "2017-06-01T00:00:00.000Z"),
    ];
    const measured = measureRealizedHorizon({
      predictionAsOf: new Date("2016-01-31T23:59:59.999Z"),
      horizon: "6M",
      evaluationCutoff: new Date("2017-01-31T23:59:59.999Z"),
      bars: path,
      actions: [],
    });
    expect(measured.status).toBe("REALIZED");
    if (measured.status !== "REALIZED") return;
    expect(measured.outcome.totalReturn).toBeCloseTo(106 / 100 - 1, 8);
    expect(measured.outcome.totalReturn).toBeLessThan(1);
  });

  it("keeps a delisting analogue instead of dropping it from the sample", () => {
    const action: CorporateActionRecord = {
      actionId: "delist",
      instrumentId: "a",
      actionType: "DELISTING",
      exDate: "2016-04-01",
      details: {},
      publishedAt: new Date("2016-04-01T00:00:00.000Z"),
      effectiveAt: new Date("2016-04-01T00:00:00.000Z"),
      availableAt: new Date("2016-04-01T00:00:00.000Z"),
    };
    const { realized: rows, nDroppedIncomplete } = realizeAnalogueMembers({
      members: [member("a", "2016-01-31")],
      horizon: "6M",
      evaluationCutoff: new Date("2017-01-31T23:59:59.999Z"),
      barsFor: () => monthlyPath("a", "2016-01-31", 7, () => 50),
      actionsFor: () => [action],
    });
    expect(nDroppedIncomplete).toBe(0);
    expect(rows[0]?.outcomeType).toBe("DELISTED");
  });
});

describe("calibration", () => {
  it("fits isotonic so a chronically overconfident raw probability is pulled down", () => {
    const curve = fitIsotonic([
      { x: 0.2, y: 0 },
      { x: 0.9, y: 0 },
      { x: 0.9, y: 0 },
    ]);
    expect(applyIsotonic(0.9, curve)).toBeLessThan(0.5);
  });

  it("fits per regime bucket and falls back globally when the bucket is sparse", () => {
    const observations = [
      ...Array.from({ length: 30 }, (_, index) => ({
        asOf: `2012-${String((index % 12) + 1).padStart(2, "0")}-28`,
        instrumentId: `exp-${index}`,
        regimeBucket: "expansion:low",
        rawProbability: 0.9,
        actualPositive: false,
      })),
      ...Array.from({ length: 30 }, (_, index) => ({
        asOf: `2013-${String((index % 12) + 1).padStart(2, "0")}-28`,
        instrumentId: `rec-${index}`,
        regimeBucket: "recession:crisis",
        rawProbability: 0.9,
        actualPositive: true,
      })),
    ];
    const fitted = fitCalibration({
      horizon: "6M",
      queryAsOf: new Date("2018-01-31T23:59:59.999Z"),
      observations,
      minSamples: 20,
    });
    const expansion = applyCalibration({
      rawProbability: 0.9,
      regimeBucket: "expansion:low",
      fitted,
      minSamples: 20,
    });
    const sparse = applyCalibration({
      rawProbability: 0.9,
      regimeBucket: "recovery:normal",
      fitted,
      minSamples: 20,
    });
    expect(expansion.source).toBe("regime_fit");
    expect(expansion.calibratedProbability).toBeLessThan(0.5);
    expect(sparse.source).toBe("global_fallback");
  });

  it("does not train on a prediction whose asOf is in the future of the query", () => {
    expect(isUsableTrainingObservation(
      { asOf: "2019-01-31" },
      new Date("2018-01-31T23:59:59.999Z"),
      "6M",
      new Date("2010-01-31T00:00:00.000Z"),
    )).toBe(false);
    expect(isUsableTrainingObservation(
      { asOf: "2016-01-31" },
      new Date("2018-01-31T23:59:59.999Z"),
      "6M",
      new Date("2010-01-31T00:00:00.000Z"),
    )).toBe(true);
  });
});

describe("Gate 7 dry run", () => {
  it("fails honestly when the replay sample is censored by the current roster", () => {
    const report = evaluateGate7({
      evaluationAsOf: "2015-02-28",
      censorship: {
        jobId: "job-1",
        status: "COMPLETE",
        nSimulated: 2,
        nFullyEvaluated: 0,
        nCensored: 2,
        censoredPct: 1,
        censoredReasons: { MEMBERSHIP_NOT_YET_AVAILABLE: 2 },
        nPitPassed: 2,
        nPitFailed: 0,
        survivorshipLimitation: REPLAY_SURVIVORSHIP_LIMITATION,
      },
      forecasts: [],
    });
    expect(report.passed).toBe(false);
    expect(report.criteria.find((row) => row.id === 2)?.passed).toBe(false);
    expect(report.criteria.find((row) => row.id === 6)?.passed).toBe(false);
    expect(report.baselines.baseline3Evaluated).toBe(false);
    expect(report.censoredBiasAssessment).toContain("Delistings are kept");
    expect(report.enablement.eligible).toBe(false);
  });

  it("reports Baseline 1 when calibrated probabilities beat the unconditional Brier score", () => {
    const forecasts = [
      {
        instrumentId: "a",
        asOf: "2016-01-31",
        horizon: "6M" as const,
        pairStatus: "COMPLETE" as const,
        regimeBucket: "expansion:low",
        investorFacing: true,
        rawProbability: 0.8,
        calibratedProbability: 0.9,
        distribution: { p10: 0, p25: 0.05, p50: 0.2, p75: 0.3, p90: 0.4 },
        actualTotalReturn: 0.25,
        sameDateEligibleMedian: 0.01,
        sectorStable: false,
      },
      {
        instrumentId: "b",
        asOf: "2016-01-31",
        horizon: "6M" as const,
        pairStatus: "COMPLETE" as const,
        regimeBucket: "expansion:low",
        investorFacing: true,
        rawProbability: 0.2,
        calibratedProbability: 0.1,
        distribution: { p10: -0.2, p25: -0.1, p50: -0.05, p75: 0, p90: 0.02 },
        actualTotalReturn: -0.04,
        sameDateEligibleMedian: 0.01,
        sectorStable: false,
      },
    ];
    const report = evaluateGate7({
      evaluationAsOf: "2017-01-31",
      censorship: {
        jobId: "job-2",
        status: "COMPLETE",
        nSimulated: 2,
        nFullyEvaluated: 2,
        nCensored: 0,
        censoredPct: 0,
        censoredReasons: {},
        nPitPassed: 2,
        nPitFailed: 0,
        survivorshipLimitation: REPLAY_SURVIVORSHIP_LIMITATION,
      },
      forecasts,
    });
    expect(report.baselines.brierBeatsBaseline).toBe(true);
    expect(report.baselines.baseline2Beats).toBe(true);
    expect(report.criteria.find((row) => row.id === 2)?.passed).toBe(true);
  });
});
