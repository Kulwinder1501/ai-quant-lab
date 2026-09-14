import { describe, expect, it } from "vitest";
import { displayedSnapshot, dueDecayMarks, overlayFromDrawdown, weeklyDecaySchedule } from "../domain/decay.js";
import { assemblePredictionSnapshot, scenariosWithPriceBands, snapshotIdentityKey } from "../domain/snapshot.js";
import { projectOutlook } from "../domain/consumer-context.js";
import type { AnalogueSet } from "../domain/analogue-search.js";
import type { HorizonForecast } from "../domain/outcome-model.js";
import { scenariosFromDistribution } from "../domain/outcome-model.js";

function analogue(overrides: Partial<AnalogueSet> = {}): AnalogueSet {
  return {
    horizon: "6M",
    queryInstrumentId: "q",
    queryAsOf: "2016-01-31",
    regimeBucket: "expansion:low",
    distanceMetric: "euclidean",
    nCandidates: 9,
    nSameRegime: 9,
    nCrossRegime: 0,
    effectiveSampleSize: 9,
    similarityQuality: 0.4,
    investorFacing: false,
    industryPenaltyApplied: false,
    members: [],
    ...overrides,
  };
}

function forecast(overrides: Partial<HorizonForecast> = {}): HorizonForecast {
  const distribution = { p10: -0.2, p25: -0.1, p50: 0.1, p75: 0.2, p90: 0.4 };
  return {
    horizon: "6M",
    outcomeModelVersion: "v0.1",
    nAnaloguesConsidered: 9,
    nAnaloguesUsed: 9,
    nAnaloguesDroppedIncomplete: 0,
    nDelistedKept: 0,
    distribution,
    scenarios: scenariosFromDistribution(distribution),
    rawProbabilityPositiveReturn: 0.6,
    calibratedProbabilityPositiveReturn: 0.55,
    calibrationSource: "none",
    status: "INSUFFICIENT_ANALOGUES",
    investorFacing: false,
    ...overrides,
  };
}

describe("prediction snapshots", () => {
  it("keeps scenario probabilities at 100% after converting return bands to prices", () => {
    const distribution = { p10: -0.2, p25: -0.1, p50: 0.1, p75: 0.2, p90: 0.4 };
    const priced = scenariosWithPriceBands(1000, scenariosFromDistribution(distribution));
    expect(priced.bear.probability + priced.base.probability + priced.bull.probability).toBe(1);
    expect(priced.bear.range).toEqual([800, 900]);
    expect(priced.bull.range[0]).toBe(1200);
  });

  it("is reproducible for the same instrument, as-of, horizon, and model versions", () => {
    const asOf = new Date("2016-01-31T23:59:59.999Z");
    const first = assemblePredictionSnapshot({
      instrumentId: "inst-1",
      asOf,
      forecast: forecast(),
      analogueSet: analogue(),
      dataQuality: { overall: 0.2, fundamentalCompleteness: 0, marketDataCompleteness: 0.4, documentCoverage: 0 },
      features: [],
      regimeBucket: "expansion:low",
      entryPrice: 1000,
    });
    const second = assemblePredictionSnapshot({
      instrumentId: "inst-1",
      asOf,
      forecast: forecast(),
      analogueSet: analogue(),
      dataQuality: { overall: 0.2, fundamentalCompleteness: 0, marketDataCompleteness: 0.4, documentCoverage: 0 },
      features: [],
      regimeBucket: "expansion:low",
      entryPrice: 1000,
    });
    expect(snapshotIdentityKey(first)).toBe(snapshotIdentityKey(second));
    expect(first.returnDistribution).toEqual(second.returnDistribution);
    expect(first.corporateActionAdjustment.entryPriceUnchanged).toBe(true);
  });

  it("overlays UNDER_REVIEW on display without rewriting the stored snapshot status", () => {
    const snapshot = assemblePredictionSnapshot({
      instrumentId: "inst-1",
      asOf: new Date("2016-01-31T23:59:59.999Z"),
      forecast: forecast({ status: "VALID", investorFacing: true }),
      analogueSet: analogue({ investorFacing: true, effectiveSampleSize: 80, nCandidates: 80 }),
      dataQuality: { overall: 0.9, fundamentalCompleteness: 0.9, marketDataCompleteness: 1, documentCoverage: 0.8 },
      features: [],
      regimeBucket: "expansion:low",
      entryPrice: 1000,
    });
    expect(snapshot.status).toBe("VALID");
    const displayed = displayedSnapshot(snapshot, [{ overlayStatus: "UNDER_REVIEW" }]);
    expect(displayed.status).toBe("UNDER_REVIEW");
    expect(displayed.investorFacing).toBe(false);
    expect(snapshot.status).toBe("VALID");
    expect(snapshot.investorFacing).toBe(true);
  });
});

describe("decay schedule", () => {
  it("emits weekly marks strictly before the horizon date", () => {
    const weekly = weeklyDecaySchedule(
      new Date("2016-01-31T23:59:59.999Z"),
      new Date("2016-07-31T23:59:59.999Z"),
    );
    expect(weekly.length).toBeGreaterThan(20);
    expect(weekly[0]?.toISOString().slice(0, 10)).toBe("2016-02-07");
    expect(weekly.every((day) => day.toISOString().slice(0, 10) < "2016-07-31")).toBe(true);
  });

  it("does not queue a weekly mark that is still in the future of asOf", () => {
    const due = dueDecayMarks({
      snapshot: { predictionAsOf: new Date("2016-01-31T23:59:59.999Z"), horizon: "6M" },
      asOf: new Date("2016-02-10T23:59:59.999Z"),
      existing: [],
    });
    expect(due.map((row) => row.asOf.toISOString().slice(0, 10))).toEqual(["2016-02-07"]);
  });

  it("flags a 25% drawdown as UNDER_REVIEW", () => {
    expect(overlayFromDrawdown(-0.26, -0.1)).toEqual({ overlayStatus: "UNDER_REVIEW", reviewFlag: true });
    expect(overlayFromDrawdown(-0.16, 0)).toEqual({ overlayStatus: null, reviewFlag: true });
    expect(overlayFromDrawdown(-0.05, 0.02)).toEqual({ overlayStatus: null, reviewFlag: false });
  });
});

describe("consumer contexts", () => {
  it("projects holdings overlay data onto an outlook without inventing a forecast", () => {
    const snapshot = {
      ...assemblePredictionSnapshot({
        instrumentId: "inst-1",
        asOf: new Date("2016-01-31T23:59:59.999Z"),
        forecast: forecast(),
        analogueSet: analogue(),
        dataQuality: { overall: 0.2, fundamentalCompleteness: 0, marketDataCompleteness: 0.4, documentCoverage: 0 },
        features: [],
        regimeBucket: null,
        entryPrice: 1000,
      }),
      snapshotId: "s1",
    };
    const view = projectOutlook({
      snapshot,
      displayed: displayedSnapshot(snapshot, []),
      context: "holdings",
      holding: { instrumentId: "inst-1", entryPrice: 980, quantity: 10, thesis: "core" },
    });
    expect(view.displayed.investorFacing).toBe(false);
    expect(view.holding?.thesis).toBe("core");
    expect(view.watchlist).toBeNull();
  });
});
