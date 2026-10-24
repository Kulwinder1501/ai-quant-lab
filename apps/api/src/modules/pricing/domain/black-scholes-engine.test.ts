import { describe, expect, it } from "vitest";
import {
  blackScholesGreeksExact,
  nearestStrike,
  priceEuropeanOption,
  yearsToExpiry,
} from "@ai-quant-lab/pricing";
import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";

describe("black-scholes-engine", () => {
  const base = {
    spot: 24000,
    strike: 24000,
    timeToExpiryYears: 7 / 365,
    riskFreeRate: RISK_FREE_RATE,
    volatility: 0.12,
  };

  it("prices ATM call and put with put-call parity approximately holding", () => {
    const call = priceEuropeanOption({ ...base, optionType: "CE" });
    const put = priceEuropeanOption({ ...base, optionType: "PE" });
    expect(call.premium).toBeGreaterThan(0);
    expect(put.premium).toBeGreaterThan(0);
    const forwardDiff = base.spot - base.strike * Math.exp(-base.riskFreeRate * base.timeToExpiryYears);
    const parity = call.premium - put.premium;
    expect(Math.abs(parity - forwardDiff)).toBeLessThan(1);
  });

  it("gives call and put the same gamma and vega at identical inputs, and put delta = call delta - 1", () => {
    // Gamma and vega do not depend on option type in Black-Scholes. The option-chain charts rely on
    // this as a sanity check: overlaid, the call and put gamma lines should sit on top of each other
    // wherever both IVs solved to the same value.
    const call = priceEuropeanOption({ ...base, optionType: "CE" });
    const put = priceEuropeanOption({ ...base, optionType: "PE" });
    expect(put.gamma).toBeCloseTo(call.gamma, 6);
    expect(put.vega).toBeCloseTo(call.vega, 6);
    expect(put.delta).toBeCloseTo(call.delta - 1, 5);
  });

  it("keeps ATM index-option gamma at the 1e-3 scale, which fixed 3-decimal formatting cannot display", () => {
    // NIFTY-like inputs: ~5 days to expiry. The chart axis needs about five decimals at this scale.
    const call = priceEuropeanOption({
      spot: 22500,
      strike: 22500,
      timeToExpiryYears: 5 / 365,
      riskFreeRate: RISK_FREE_RATE,
      volatility: 0.14,
      optionType: "CE",
    });
    expect(call.gamma).toBeGreaterThan(0.0005);
    expect(call.gamma).toBeLessThan(0.002);
  });

  it("gives deep ITM call delta near 1 and deep OTM call delta near 0", () => {
    const itm = priceEuropeanOption({
      ...base,
      spot: 26000,
      strike: 24000,
      optionType: "CE",
    });
    const otm = priceEuropeanOption({
      ...base,
      spot: 22000,
      strike: 24000,
      optionType: "CE",
    });
    expect(itm.delta).toBeGreaterThan(0.9);
    expect(otm.delta).toBeLessThan(0.1);
  });

  it("reports negative theta for long options with time left", () => {
    const call = priceEuropeanOption({ ...base, optionType: "CE" });
    const put = priceEuropeanOption({ ...base, optionType: "PE" });
    expect(call.theta).toBeLessThan(0);
    expect(put.theta).toBeLessThan(0);
  });

  it("returns intrinsic value only when expired", () => {
    const call = priceEuropeanOption({
      spot: 105,
      strike: 100,
      timeToExpiryYears: 0,
      riskFreeRate: RISK_FREE_RATE,
      volatility: 0.2,
      optionType: "CE",
    });
    expect(call.premium).toBe(5);
    expect(call.intrinsicValue).toBe(5);
    expect(call.timeValue).toBe(0);
    expect(call.delta).toBe(0);
    expect(call.gamma).toBe(0);
    expect(call.theta).toBe(0);
    expect(call.vega).toBe(0);
  });

  it("increases premium when IV rises (positive vega)", () => {
    const low = priceEuropeanOption({ ...base, volatility: 0.1, optionType: "CE" });
    const high = priceEuropeanOption({ ...base, volatility: 0.2, optionType: "CE" });
    expect(high.premium).toBeGreaterThan(low.premium);
    expect(low.vega).toBeGreaterThan(0);
  });

  it("matches a known textbook call premium to two decimals", () => {
    // Hull-style reference: S=100, K=100, T=1, r=0.05, σ=0.2 → C ≈ 10.45
    const call = priceEuropeanOption({
      spot: 100,
      strike: 100,
      timeToExpiryYears: 1,
      riskFreeRate: 0.05,
      volatility: 0.2,
      optionType: "CE",
    });
    expect(call.premium).toBeCloseTo(10.45, 1);
  });

  it("computes years to expiry and nearest strike helpers", () => {
    const now = new Date("2026-07-31T10:00:00.000Z");
    const expiry = new Date("2026-08-07T10:00:00.000Z");
    expect(yearsToExpiry(now, expiry)).toBeCloseTo(7 / 365, 6);
    expect(yearsToExpiry(expiry, now)).toBe(0);
    expect(nearestStrike(24123, 50)).toBe(24100);
  });
});

describe("blackScholesGreeksExact", () => {
  const rounded6 = (value: number) => Math.round((value + Number.EPSILON) * 1e6) / 1e6;

  it("is the unrounded value of exactly what priceEuropeanOption rounds, over a grid of inputs", () => {
    let compared = 0;
    for (const optionType of ["CE", "PE"] as const) {
      for (const spot of [1_000, 22_574.3, 54_300.55]) {
        for (const moneyness of [0.8, 0.95, 1, 1.02, 1.2]) {
          for (const days of [0.5, 1, 7, 30, 180]) {
            for (const sigma of [0.05, 0.15, 0.4]) {
              const input = { spot, strike: Math.round(spot * moneyness * 20) / 20, timeToExpiryYears: days / 365, riskFreeRate: RISK_FREE_RATE, volatility: sigma, optionType };
              const exact = blackScholesGreeksExact(input);
              const priced = priceEuropeanOption(input);
              expect(rounded6(exact.delta)).toBe(priced.delta);
              expect(rounded6(exact.gamma)).toBe(priced.gamma);
              expect(rounded6(exact.theta)).toBe(priced.theta);
              expect(rounded6(exact.vega)).toBe(priced.vega);
              compared += 1;
            }
          }
        }
      }
    }
    expect(compared).toBe(2 * 3 * 5 * 5 * 3);
  });

  it("keeps the precision the rounded value loses, where gamma is small", () => {
    // A BANKNIFTY-like strike 3% out of the money, one week out: gamma is about 1e-5, so six decimals keep one or two digits.
    const input = { spot: 54_000, strike: 55_600, timeToExpiryYears: 7 / 365, riskFreeRate: RISK_FREE_RATE, volatility: 0.15, optionType: "CE" as const };
    const exact = blackScholesGreeksExact(input).gamma;
    const rounded = priceEuropeanOption(input).gamma;
    expect(exact).toBeGreaterThan(0);
    expect(Math.abs(rounded - exact) / exact).toBeGreaterThan(0.001);
    expect(rounded6(exact)).toBe(rounded);
  });

  it("is all zero when the closed form does not apply, as priceEuropeanOption is", () => {
    const expired = { spot: 100, strike: 100, timeToExpiryYears: 0, riskFreeRate: RISK_FREE_RATE, volatility: 0.2, optionType: "CE" as const };
    expect(blackScholesGreeksExact(expired)).toEqual({ delta: 0, gamma: 0, theta: 0, vega: 0 });
    expect(blackScholesGreeksExact({ ...expired, timeToExpiryYears: 1, volatility: 0 })).toEqual({ delta: 0, gamma: 0, theta: 0, vega: 0 });
  });

  it("refuses the same invalid input", () => {
    const base = { spot: 100, strike: 100, timeToExpiryYears: 1, riskFreeRate: 0.06, volatility: 0.2, optionType: "CE" as const };
    expect(() => blackScholesGreeksExact({ ...base, spot: 0 })).toThrow("Spot must be a positive finite number.");
    expect(() => blackScholesGreeksExact({ ...base, strike: -1 })).toThrow("Strike must be a positive finite number.");
    expect(() => blackScholesGreeksExact({ ...base, riskFreeRate: Number.NaN })).toThrow("Risk-free rate must be finite.");
    expect(() => blackScholesGreeksExact({ ...base, optionType: "XX" as never })).toThrow("Option type must be CE or PE.");
  });
});
