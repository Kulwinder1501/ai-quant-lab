import { describe, expect, it } from "vitest";
import {
  nearestStrike,
  priceEuropeanOption,
  yearsToExpiry,
} from "./black-scholes-engine.js";

describe("black-scholes-engine", () => {
  const base = {
    spot: 24000,
    strike: 24000,
    timeToExpiryYears: 7 / 365,
    riskFreeRate: 0.07,
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
      riskFreeRate: 0.07,
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
