import { describe, expect, it } from "vitest";
import { searchAnalogues, type AnalogueFeatureSnapshot } from "../domain/analogue-search.js";
import {
  assignRegime,
  classifyMacroRegimeFromNifty,
  classifyVolatilityRegime,
} from "../domain/regime-engine.js";
import type { CanonicalMarketBar } from "../domain/adapters.js";
import { invertMatrix, mahalanobisDistance } from "../domain/matrix.js";

function snapshot(overrides: Partial<AnalogueFeatureSnapshot> & Pick<AnalogueFeatureSnapshot, "instrumentId" | "asOf">): AnalogueFeatureSnapshot {
  return {
    values: { momentum_6m: 0.1, momentum_12m: 0.2, rsi_14d: 55 },
    regimeBucket: "expansion:low",
    eligible: true,
    ...overrides,
  };
}

function bar(instrumentId: string, day: string, close: string): CanonicalMarketBar {
  const openTime = new Date(`${day}T00:00:00.000Z`);
  return {
    instrumentId,
    openTime,
    closeTime: openTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: "1",
    publishedAt: openTime,
    effectiveAt: openTime,
    availableAt: openTime,
  };
}

function series(instrumentId: string, fromDay: string, count: number, closeAt: (index: number) => number): CanonicalMarketBar[] {
  const start = new Date(`${fromDay}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const day = new Date(start.getTime() + index * 86_400_000);
    return bar(instrumentId, day.toISOString().slice(0, 10), String(closeAt(index)));
  });
}

describe("regime engine", () => {
  it("buckets India VIX without using the trading HIGH_VOL/LOW_VOL labels", () => {
    expect(classifyVolatilityRegime(12)).toBe("low");
    expect(classifyVolatilityRegime(18)).toBe("normal");
    expect(classifyVolatilityRegime(25)).toBe("elevated");
    expect(classifyVolatilityRegime(40)).toBe("crisis");
  });

  it("classifies nifty expansion vs recession from return and drawdown", () => {
    expect(classifyMacroRegimeFromNifty(0.2, -0.05)).toBe("expansion");
    expect(classifyMacroRegimeFromNifty(0.1, -0.25)).toBe("recovery");
    expect(classifyMacroRegimeFromNifty(-0.1, -0.25)).toBe("recession");
    expect(classifyMacroRegimeFromNifty(-0.05, -0.05)).toBe("slowdown");
  });

  it("assigns a PIT bucket from nifty and vix bars and ignores a later vix print", () => {
    const nifty = series("nifty", "2015-01-01", 253, (index) => 100 + index * 0.2);
    const vix = [
      ...series("vix", "2015-01-01", 10, () => 12),
      bar("vix", "2016-06-01", "40"),
    ];
    const assignment = assignRegime({
      asOf: new Date("2015-12-31T23:59:59.999Z"),
      niftyBars: nifty,
      vixBars: vix,
    });
    expect(assignment?.volatility).toBe("low");
    expect(assignment?.bucket).toMatch(/^expansion:low$|^recovery:low$/);
    expect(assignment?.macroSource).toBe("nifty_price_proxy_v0.1");
  });
});

describe("analogue search", () => {
  it("excludes future snapshots, ineligible names, and the query itself", () => {
    const query = snapshot({ instrumentId: "q", asOf: "2018-06-30" });
    const result = searchAnalogues({
      query,
      horizon: "6M",
      candidates: [
        snapshot({ instrumentId: "a", asOf: "2016-06-30" }),
        snapshot({ instrumentId: "b", asOf: "2019-01-31" }),
        snapshot({ instrumentId: "c", asOf: "2016-06-30", eligible: false }),
        snapshot({ instrumentId: "q", asOf: "2018-06-30" }),
      ],
    });
    expect(result.nCandidates).toBe(1);
    expect(result.members[0]?.instrumentId).toBe("a");
    expect(result.investorFacing).toBe(false);
  });

  it("keeps same-regime neighbours and drops distant cross-regime names", () => {
    const query = snapshot({ instrumentId: "q", asOf: "2018-06-30" });
    const result = searchAnalogues({
      query,
      horizon: "12M",
      candidates: [
        snapshot({ instrumentId: "same", asOf: "2016-06-30" }),
        snapshot({
          instrumentId: "other",
          asOf: "2016-06-30",
          regimeBucket: "recession:crisis",
          values: { momentum_6m: 9, momentum_12m: 9, rsi_14d: 10 },
        }),
      ],
    });
    expect(result.nSameRegime).toBe(1);
    expect(result.nCrossRegime).toBe(0);
    expect(result.members.map((row) => row.instrumentId)).toEqual(["same"]);
  });

  it("reports investorFacing once effective sample size clears 50 unclustered neighbours", () => {
    const query = snapshot({ instrumentId: "q", asOf: "2020-12-31" });
    const candidates: AnalogueFeatureSnapshot[] = [];
    for (let year = 1968; year < 2018; year += 1) {
      candidates.push(snapshot({ instrumentId: `n${year}`, asOf: `${year}-06-30` }));
    }
    const result = searchAnalogues({ query, horizon: "6M", candidates });
    expect(result.nCandidates).toBe(50);
    expect(result.effectiveSampleSize).toBeGreaterThanOrEqual(50);
    expect(result.investorFacing).toBe(true);
  });

  it("falls back to Euclidean when candidates cannot invert a covariance", () => {
    const result = searchAnalogues({
      query: snapshot({ instrumentId: "q", asOf: "2018-06-30" }),
      horizon: "6M",
      candidates: [
        snapshot({ instrumentId: "a", asOf: "2016-06-30" }),
        snapshot({ instrumentId: "b", asOf: "2015-06-30" }),
      ],
    });
    expect(result.distanceMetric).toBe("euclidean");
    expect(result.nCandidates).toBe(2);
    expect(result.investorFacing).toBe(false);
  });

  it("downweights neighbours that share a 91-day temporal cluster", () => {
    const query = snapshot({ instrumentId: "q", asOf: "2018-06-30" });
    const clustered = searchAnalogues({
      query,
      horizon: "6M",
      candidates: [
        snapshot({ instrumentId: "a", asOf: "2016-06-30" }),
        snapshot({ instrumentId: "b", asOf: "2016-07-15" }),
      ],
    });
    const spread = searchAnalogues({
      query,
      horizon: "6M",
      candidates: [
        snapshot({ instrumentId: "a", asOf: "2014-06-30" }),
        snapshot({ instrumentId: "b", asOf: "2016-06-30" }),
      ],
    });
    expect(clustered.nCandidates).toBe(2);
    expect(spread.nCandidates).toBe(2);
    expect(clustered.effectiveSampleSize).toBeLessThan(spread.effectiveSampleSize);
  });

  it("does not change the analogue set when a post-cutoff snapshot is appended", () => {
    const query = snapshot({ instrumentId: "q", asOf: "2018-06-30" });
    const past = [snapshot({ instrumentId: "a", asOf: "2016-06-30" })];
    const leaked = [...past, snapshot({ instrumentId: "future", asOf: "2018-12-31", values: { momentum_6m: 99 } })];
    const baseline = searchAnalogues({ query, horizon: "6M", candidates: past });
    const injected = searchAnalogues({ query, horizon: "6M", candidates: leaked });
    expect(injected.members.map((row) => row.instrumentId)).toEqual(baseline.members.map((row) => row.instrumentId));
    expect(injected.effectiveSampleSize).toBe(baseline.effectiveSampleSize);
  });
});

describe("mahalanobis helper", () => {
  it("returns zero distance for identical points on an identity covariance", () => {
    const inverse = invertMatrix([[1, 0], [0, 1]]);
    expect(inverse).not.toBeNull();
    expect(mahalanobisDistance([1, 2], [1, 2], inverse!)).toBeCloseTo(0, 10);
    expect(mahalanobisDistance([1, 2], [2, 2], inverse!)).toBeCloseTo(1, 10);
  });
});
