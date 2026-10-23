import { describe, expect, it } from "vitest";
import { hasVendorGreeks, parseVendorGreeks } from "./vendor-greeks.js";

describe("parseVendorGreeks", () => {
  it("reads a real Fyers greeks object as sent, keeping IV in percent", () => {
    // Recorded 2026-10-23 14:36 IST: NSE:SBIN26OCT960CE from /data/options-chain-v3?greeks=1.
    expect(parseVendorGreeks({ delta: 0.46, gamma: 0.021, theta: -0.93, vega: 0.4, iv: 18.74 })).toEqual({
      delta: 0.46,
      gamma: 0.021,
      theta: -0.93,
      vega: 0.4,
      impliedVolatilityPercent: 18.74,
    });
  });

  it("returns null when the provider sent no greeks, as distinct from an object of zeros", () => {
    expect(parseVendorGreeks(undefined)).toBeNull();
    expect(parseVendorGreeks(null)).toBeNull();
    expect(parseVendorGreeks("greeks")).toBeNull();
    expect(parseVendorGreeks([0.5, 0.01])).toBeNull();
    expect(parseVendorGreeks({})).toBeNull();
    expect(parseVendorGreeks({ delta: null, gamma: null, theta: null, vega: null, iv: null })).toBeNull();
  });

  it("keeps a reported zero as zero, because zero is a value and null is not", () => {
    const parsed = parseVendorGreeks({ delta: 0, gamma: 0, theta: 0, vega: 0, iv: 12 })!;
    expect(parsed.delta).toBe(0);
    expect(parsed.gamma).toBe(0);
    expect(parsed.theta).toBe(0);
    expect(parsed.vega).toBe(0);
  });

  it("drops a field that cannot be right without losing the others", () => {
    const parsed = parseVendorGreeks({ delta: 7, gamma: -0.001, theta: -12, vega: -3, iv: 0 })!;
    expect(parsed).toEqual({
      delta: null, // outside [-1, 1]
      gamma: null, // negative
      theta: -12,
      vega: null, // negative
      impliedVolatilityPercent: null, // zero or below
    });
  });

  it("accepts numeric strings but refuses blank, non-numeric and non-finite values", () => {
    expect(parseVendorGreeks({ delta: "0.5", iv: "15.3" })).toMatchObject({ delta: 0.5, impliedVolatilityPercent: 15.3 });
    const parsed = parseVendorGreeks({ delta: "", gamma: "abc", theta: Number.NaN, vega: Infinity, iv: 15 })!;
    expect(parsed).toEqual({ delta: null, gamma: null, theta: null, vega: null, impliedVolatilityPercent: 15 });
  });

  it("returns null when every field fails, so a fully malformed object is not stored as data", () => {
    expect(parseVendorGreeks({ delta: 9, gamma: -1, theta: "x", vega: -1, iv: -5 })).toBeNull();
  });
});

describe("hasVendorGreeks", () => {
  it("distinguishes none from some", () => {
    expect(hasVendorGreeks(null)).toBe(false);
    expect(hasVendorGreeks(undefined)).toBe(false);
    expect(hasVendorGreeks({ delta: null, gamma: null, theta: null, vega: null, impliedVolatilityPercent: null })).toBe(false);
    expect(hasVendorGreeks({ delta: 0, gamma: null, theta: null, vega: null, impliedVolatilityPercent: null })).toBe(true);
  });
});
