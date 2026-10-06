import { describe, expect, it } from "vitest";
import { computeOte } from "./ote.js";
import type { DealingRange } from "./bias.js";

function makeDealingRange(rangeLow: number, rangeHigh: number): DealingRange {
  const equilibrium = (rangeLow + rangeHigh) / 2;
  return {
    rangeLow,
    rangeHigh,
    equilibrium,
    isPremium: (price: number) => price >= equilibrium,
    isDiscount: (price: number) => price < equilibrium,
  };
}

describe("computeOte", () => {
  it("returns null when there is no dealing range", () => {
    expect(computeOte(null, "BULLISH", 100)).toBeNull();
  });

  it("returns null when the trend is NEUTRAL, even with a dealing range", () => {
    const range = makeDealingRange(100, 200);
    expect(computeOte(range, "NEUTRAL", 130)).toBeNull();
  });

  it("returns null when the range is degenerate (high <= low)", () => {
    const degenerate: DealingRange = {
      rangeLow: 150,
      rangeHigh: 150,
      equilibrium: 150,
      isPremium: () => true,
      isDiscount: () => false,
    };
    expect(computeOte(degenerate, "BULLISH", 150)).toBeNull();
  });

  it("places the bullish OTE band at 21-38% up from the range low (the doctrine's discount-side retracement)", () => {
    const range = makeDealingRange(100, 200); // span 100
    const feature = computeOte(range, "BULLISH", 130);
    expect(feature).not.toBeNull();
    expect(feature!.side).toBe("BULLISH");
    expect(feature!.oteBandLow).toBeCloseTo(121, 10); // 100 + 100*0.21
    expect(feature!.oteBandHigh).toBeCloseTo(138, 10); // 100 + 100*0.38
  });

  it("places the bearish OTE band at 62-79% up from the range low (the mirrored premium-side retracement)", () => {
    const range = makeDealingRange(100, 200); // span 100
    const feature = computeOte(range, "BEARISH", 170);
    expect(feature).not.toBeNull();
    expect(feature!.side).toBe("BEARISH");
    expect(feature!.oteBandLow).toBeCloseTo(162, 10); // 100 + 100*0.62
    expect(feature!.oteBandHigh).toBeCloseTo(179, 10); // 100 + 100*0.79
  });

  it("reports isWithinOte true and distanceToOteBand 0 when price sits inside the band", () => {
    const range = makeDealingRange(100, 200);
    const feature = computeOte(range, "BULLISH", 130); // band is [121, 138]
    expect(feature!.isWithinOte).toBe(true);
    expect(feature!.distanceToOteBand).toBe(0);
  });

  it("reports isWithinOte false and the unsigned distance to the nearer edge when price is below the band", () => {
    const range = makeDealingRange(100, 200); // bullish band [121, 138]
    const feature = computeOte(range, "BULLISH", 110);
    expect(feature!.isWithinOte).toBe(false);
    expect(feature!.distanceToOteBand).toBeCloseTo(11, 10); // |110 - 121|
  });

  it("reports isWithinOte false and the unsigned distance to the nearer edge when price is above the band", () => {
    const range = makeDealingRange(100, 200); // bullish band [121, 138]
    const feature = computeOte(range, "BULLISH", 150);
    expect(feature!.isWithinOte).toBe(false);
    expect(feature!.distanceToOteBand).toBeCloseTo(12, 10); // |150 - 138|
  });

  it("is symmetric with the bullish case for a bearish trend on the same range", () => {
    // Bearish band [162, 179] mirrors the bullish band [121, 138] around the range's own midpoint
    // structure: 21% from one end equals 79% from the other, 38% from one end equals 62% from the other.
    const range = makeDealingRange(100, 200);
    const bullish = computeOte(range, "BULLISH", 130)!;
    const bearish = computeOte(range, "BEARISH", 170)!;
    expect(bearish.oteBandLow).toBeCloseTo(range.rangeHigh - (bullish.oteBandHigh - range.rangeLow), 10);
    expect(bearish.oteBandHigh).toBeCloseTo(range.rangeHigh - (bullish.oteBandLow - range.rangeLow), 10);
  });

  it("always orders oteBandLow <= oteBandHigh regardless of side", () => {
    const range = makeDealingRange(50, 75);
    const bullish = computeOte(range, "BULLISH", 60)!;
    const bearish = computeOte(range, "BEARISH", 60)!;
    expect(bullish.oteBandLow).toBeLessThanOrEqual(bullish.oteBandHigh);
    expect(bearish.oteBandLow).toBeLessThanOrEqual(bearish.oteBandHigh);
  });

  it("is a pure function of its inputs: identical inputs twice give identical output", () => {
    const range = makeDealingRange(24000, 24200);
    expect(computeOte(range, "BULLISH", 24050)).toEqual(computeOte(range, "BULLISH", 24050));
  });
});
