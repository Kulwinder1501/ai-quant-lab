import { describe, expect, it } from "vitest";
import { priceEuropeanOption } from "./black-scholes-engine.js";
import { impliedVolatilityFromPremium, midPriceForIv } from "./implied-volatility.js";

const BASE = {
  spot: 24_000,
  strike: 24_000,
  timeToExpiryYears: 21 / 365,
  riskFreeRate: 0.065,
  optionType: "CE" as const,
};

/** Price at a known volatility, so the solver can be asked to recover it. */
function premiumAt(volatility: number, overrides: Partial<typeof BASE> = {}): number {
  return priceEuropeanOption({ ...BASE, ...overrides, volatility }).premium;
}

describe("impliedVolatilityFromPremium", () => {
  // The round trip is the only test that really matters: price at a known vol, then
  // recover it. Anything else could pass while the inversion is subtly wrong.
  it.each([0.08, 0.14, 0.25, 0.45, 0.9])("recovers a known volatility of %s", (volatility) => {
    const result = impliedVolatilityFromPremium({ ...BASE, premium: premiumAt(volatility) });

    expect(result.measurable).toBe(true);
    if (!result.measurable) return;
    expect(result.impliedVolatility).toBeCloseTo(volatility, 5);
  });

  it("recovers volatility for puts as well as calls", () => {
    const put = { ...BASE, optionType: "PE" as const };
    const result = impliedVolatilityFromPremium({
      ...put,
      premium: priceEuropeanOption({ ...put, volatility: 0.18 }).premium,
    });

    expect(result.measurable).toBe(true);
    if (result.measurable) expect(result.impliedVolatility).toBeCloseTo(0.18, 5);
  });

  // Vega collapses in the wings, so a Newton step there divides by almost nothing and can
  // leap out of the band. The bisection fallback exists for exactly these contracts.
  it.each([
    ["out of the money", 26_000],
    ["further out of the money", 28_000],
    ["in the money", 21_000],
  ])("recovers volatility for an %s strike where vega is small", (_label, strike) => {
    const result = impliedVolatilityFromPremium({
      ...BASE,
      strike,
      premium: premiumAt(0.22, { strike }),
    });

    expect(result.measurable).toBe(true);
    // Looser than the ATM cases: the premium is rounded to 0.01, so a small extrinsic
    // value limits how precisely the volatility behind it can be recovered.
    if (result.measurable) expect(result.impliedVolatility).toBeCloseTo(0.22, 2);
  });

  // The two genuine wing limits, both measured rather than assumed.
  it("refuses a strike whose premium rounds away to nothing", () => {
    // 24,000 spot, 30,000 strike, 21 days at 22%: the premium rounds to 0.00, so there is
    // no price to invert at all.
    const result = impliedVolatilityFromPremium({
      ...BASE,
      strike: 30_000,
      premium: premiumAt(0.22, { strike: 30_000 }),
    });

    expect(result).toMatchObject({ measurable: false, reason: "NO_PREMIUM" });
  });

  it("refuses a deep in-the-money strike whose extrinsic value is below one tick", () => {
    // Measured: premium 6067.19, intrinsic 6067.1894, extrinsic 0.0006 against a 0.01
    // rounding quantum. Before this guard the solver returned 0.2826 for a true 0.22 --
    // a plausible number describing the rounding rather than the market.
    const result = impliedVolatilityFromPremium({
      ...BASE,
      strike: 18_000,
      premium: premiumAt(0.22, { strike: 18_000 }),
    });

    expect(result).toMatchObject({ measurable: false, reason: "EXTRINSIC_BELOW_PRICE_RESOLUTION" });
    if (!result.measurable) expect(result.explanation).toMatch(/price rounding, not the market/);
  });

  describe("refusals", () => {
    // Observed live: a NIFTY chain still listed its same-day expiry nearly three hours
    // after that expiry had passed. At T=0 the premium is intrinsic for every volatility.
    it("refuses an expired contract instead of returning a number", () => {
      const result = impliedVolatilityFromPremium({ ...BASE, timeToExpiryYears: 0, premium: 120 });

      expect(result).toMatchObject({ measurable: false, reason: "EXPIRED_OR_ZERO_TIME" });
      if (!result.measurable) expect(result.explanation).toMatch(/intrinsic value/);
    });

    it.each([[0], [-5]])("refuses a premium of %s", (premium) => {
      expect(impliedVolatilityFromPremium({ ...BASE, premium }))
        .toMatchObject({ measurable: false, reason: "NO_PREMIUM" });
    });

    // A stale or crossed quote, not genuine arbitrage — reported rather than clamped so a
    // bad quote is visible instead of silently becoming a plausible IV.
    it("refuses a premium below the no-arbitrage floor", () => {
      // Intrinsic here is about 4,075, so 100 is far under the floor no volatility can
      // reach -- checked before the extrinsic-resolution guard, since a negative
      // extrinsic is a broken quote rather than a rounding limit.
      const result = impliedVolatilityFromPremium({ ...BASE, strike: 20_000, premium: 100 });

      expect(result).toMatchObject({ measurable: false, reason: "BELOW_INTRINSIC" });
    });

    it("refuses a premium above the no-arbitrage ceiling", () => {
      const result = impliedVolatilityFromPremium({ ...BASE, premium: BASE.spot * 1.5 });

      expect(result).toMatchObject({ measurable: false, reason: "ABOVE_UPPER_BOUND" });
    });

    it("refuses rather than reporting the edge of the search band", () => {
      // A premium implying well over 500% volatility must not come back as exactly 500%.
      const result = impliedVolatilityFromPremium({ ...BASE, premium: premiumAt(4.99) * 1.0 + 1e-9 });

      if (!result.measurable) {
        expect(result.reason).toBe("ABOVE_UPPER_BOUND");
      } else {
        // If it is inside the band it must be a real solution, not the ceiling.
        expect(result.impliedVolatility).toBeLessThan(5.0);
      }
    });

    it("refuses a non-positive spot or strike", () => {
      expect(impliedVolatilityFromPremium({ ...BASE, spot: 0, premium: 10 }))
        .toMatchObject({ measurable: false, reason: "NO_PREMIUM" });
      expect(impliedVolatilityFromPremium({ ...BASE, strike: -1, premium: 10 }))
        .toMatchObject({ measurable: false, reason: "NO_PREMIUM" });
    });
  });

  it("converges in few iterations near the money", () => {
    const result = impliedVolatilityFromPremium({ ...BASE, premium: premiumAt(0.15) });

    expect(result.measurable).toBe(true);
    // Newton should handle an ATM contract without needing the bisection fallback, which
    // starts numbering above the iteration budget.
    if (result.measurable) expect(result.iterations).toBeLessThan(20);
  });
});

describe("midPriceForIv", () => {
  it("returns the mid of a two-sided quote", () => {
    expect(midPriceForIv(99, 101)).toBeCloseTo(100, 10);
  });

  // A last traded price can be hours stale on an illiquid strike, and an IV derived from
  // it would look identical to one derived from a live market.
  it.each([
    ["no bid", null, 101],
    ["no ask", 99, null],
    ["zero bid", 0, 101],
    ["crossed", 101, 99],
  ])("returns null for %s rather than falling back to a stale price", (_label, bid, ask) => {
    expect(midPriceForIv(bid, ask)).toBeNull();
  });
});
