import { describe, expect, it } from "vitest";
import type { GreeksStrikeInput, GreeksStrikeLegInput } from "./build-greeks-by-strike";
import {
  GAMMA_ROUNDING,
  coverageSentence,
  formatDifference,
  pairsForLeg,
  summariseAgreement,
  verdictText,
} from "./vendor-greeks-check";

/** Synthetic legs, hand-built for the arithmetic (not recorded from the API). */
const leg = (
  model: { iv: number | null; delta: number | null; gamma: number | null; theta: number | null; vega: number | null },
  vendor: { iv: number | null; delta: number | null; gamma: number | null; theta: number | null; vega: number | null } | null,
): GreeksStrikeLegInput => ({
  impliedVolatility: model.iv, impliedVolatilityRefusal: model.iv === null ? "BELOW_INTRINSIC" : null,
  delta: model.delta, gamma: model.gamma, theta: model.theta, vega: model.vega,
  vendorGreeks: vendor && { delta: vendor.delta, gamma: vendor.gamma, theta: vendor.theta, vega: vendor.vega, impliedVolatilityPercent: vendor.iv },
});

const strikes: GreeksStrikeInput[] = [
  { strikePrice: 54_000, call: leg({ iv: 0.16, delta: 0.7, gamma: 0.0004, theta: -50, vega: 30 }, { iv: 16.1, delta: 0.702, gamma: 0.0004, theta: -47, vega: 30.01 }), put: null },
  {
    strikePrice: 54_300,
    call: leg({ iv: 0.15, delta: 0.5, gamma: 0.000412, theta: -48, vega: 33 }, { iv: 15.05, delta: 0.502, gamma: 0.0004, theta: -46, vega: 33.02 }),
    put: leg({ iv: 0.15, delta: -0.5, gamma: 0.000412, theta: -52, vega: 33 }, { iv: 15.3, delta: -0.498, gamma: 0.0005, theta: -46, vega: 33 }),
  },
  { strikePrice: 54_600, call: null, put: leg({ iv: null, delta: null, gamma: null, theta: null, vega: null }, { iv: 14.9, delta: -0.3, gamma: 0.0004, theta: -40, vega: 28 }) },
  { strikePrice: 54_900, call: leg({ iv: 0.17, delta: 0.2, gamma: 0.0003, theta: -30, vega: 20 }, null), put: null },
];

const byMetric = (summary: ReturnType<typeof summariseAgreement>) => Object.fromEntries(summary.metrics.map((m) => [m.metric, m]));

describe("pairsForLeg", () => {
  it("lines the units up (model IV fraction against provider percent) and takes vendor minus model", () => {
    const pairs = pairsForLeg(54_000, "CE", strikes[0]!.call);
    expect(pairs.iv!.model).toBeCloseTo(16, 12);
    expect(pairs.iv!.vendor).toBe(16.1);
    expect(pairs.iv!.difference).toBeCloseTo(0.1, 9);
    expect(pairs.delta!.difference).toBeCloseTo(0.002, 12);
    expect(pairs.theta!.difference).toBeCloseTo(3, 12);
    expect(pairs.vega!.difference).toBeCloseTo(0.01, 12);
  });

  it("has no pair for a side where either value is missing, and none without provider Greeks", () => {
    expect(pairsForLeg(54_600, "PE", strikes[2]!.put)).toEqual({});       // model unsolved: the provider's value has nothing to be compared with
    expect(pairsForLeg(54_900, "CE", strikes[3]!.call)).toEqual({});      // no provider Greeks stored
    expect(pairsForLeg(54_000, "PE", null)).toEqual({});
  });
});

describe("summariseAgreement", () => {
  const summary = summariseAgreement(strikes);
  const m = byMetric(summary);

  it("counts the contracts and how many carry provider Greeks", () => {
    expect(summary).toMatchObject({ legs: 5, legsWithVendor: 4 });
  });

  it("gives the signed bias, the mean absolute difference and the worst difference with where it was (IV)", () => {
    // IV differences, vendor minus model, in volatility points: +0.10, +0.05, +0.30.
    expect(m.iv).toMatchObject({ compared: 3, worst: { strike: 54_300, side: "PE" } });
    expect(m.iv!.bias).toBeCloseTo(0.15, 9);
    expect(m.iv!.meanAbsolute).toBeCloseTo(0.15, 9);
    expect(m.iv!.worst!.difference).toBeCloseTo(0.3, 9);
  });

  it("judges IV and delta against the probe's range with margin, and says it is the probe's range", () => {
    // IV: bias 0.15 <= 0.24 and worst 0.30 <= 2 x 0.24. Delta: +0.002 each time.
    expect(m.iv!.verdict).toBe("within");
    expect(m.delta!.verdict).toBe("within");
    expect(m.delta!.bias).toBeCloseTo(0.002, 12);
    expect(verdictText(m.iv!)).toBe("within the range seen in the 2026-10-23 probe");
  });

  it("calls a larger gap beyond the range, and a small chain does not change the rule", () => {
    const wide = summariseAgreement([{ strikePrice: 54_300, call: leg({ iv: 0.15, delta: 0.5, gamma: null, theta: null, vega: null }, { iv: 16.2, delta: 0.52, gamma: null, theta: null, vega: null }), put: null }]);
    expect(byMetric(wide).iv!.verdict).toBe("beyond");           // +1.2 volatility points
    expect(byMetric(wide).delta!.verdict).toBe("beyond");        // +0.02 > 0.008
    expect(verdictText(byMetric(wide).iv!)).toBe("beyond the range seen in the 2026-10-23 probe");
  });

  it("counts gamma within the provider's four-decimal rounding instead of summarising its differences", () => {
    // Differences 0, -0.000012, +0.000088: two of three are within 0.00005.
    expect(GAMMA_ROUNDING).toBe(0.00005);
    expect(m.gamma).toMatchObject({ compared: 3, withinRounding: 2, verdict: "not-judged" });
    expect(verdictText(m.gamma!)).toBe("2 of 3 within the provider's rounding");
  });

  it("reports theta and vega without judging them, theta noting the missing carry term", () => {
    expect(m.theta).toMatchObject({ compared: 3, verdict: "not-judged", worst: { strike: 54_300, side: "PE" } });
    expect(m.theta!.bias).toBeCloseTo(11 / 3, 12);              // +3, +2, +6
    expect(verdictText(m.theta!)).toBe("differs by construction (no carry term); not judged");
    expect(m.vega!.bias).toBeCloseTo(0.01, 12);                 // +0.01, +0.02, 0
    expect(verdictText(m.vega!)).toBe("not judged");
  });

  it("has nothing for a chain with no provider Greeks", () => {
    const none = summariseAgreement([{ strikePrice: 54_900, call: strikes[3]!.call, put: null }]);
    expect(none).toMatchObject({ legs: 1, legsWithVendor: 0 });
    expect(none.metrics.every((metric) => metric.compared === 0 && metric.bias === null && metric.worst === null)).toBe(true);
    expect(verdictText(none.metrics[0]!)).toBe("no pair");
  });
});

describe("coverageSentence and formatDifference", () => {
  it("says what is stored, and says plainly when nothing is", () => {
    expect(coverageSentence(summariseAgreement(strikes))).toBe("Fyers' own Greeks are stored for 4 of 5 contracts (1 without: an unquoted contract, or one the provider sent none for).");
    expect(coverageSentence(summariseAgreement([{ strikePrice: 54_900, call: strikes[3]!.call, put: null }]))).toContain("nothing to compare");
    expect(coverageSentence(summariseAgreement([]))).toBe("The stored chain holds no contract.");
  });

  it("signs differences at each metric's own precision and prints zero without a sign", () => {
    expect(formatDifference("iv", 0.05)).toBe("+0.05");
    expect(formatDifference("delta", -0.0021)).toBe("−0.0021");
    expect(formatDifference("gamma", 0.000004)).toBe("0.00000");
    expect(formatDifference("theta", null)).toBe("–");
  });
});
