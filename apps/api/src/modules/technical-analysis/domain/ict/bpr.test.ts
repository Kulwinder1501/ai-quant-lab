import { describe, expect, it } from "vitest";
import type { FairValueGap } from "./zones.js";
import { computeBalancedPriceRanges } from "./bpr.js";

function makeFvg(overrides: Partial<FairValueGap> & { id: string; type: "BULLISH" | "BEARISH"; top: number; bottom: number; createdAtBarIndex: number }): FairValueGap {
  return {
    midpoint: (overrides.top + overrides.bottom) / 2,
    createdAtBarTime: new Date(Date.UTC(2026, 0, 1, 9, 15 + overrides.createdAtBarIndex * 5)),
    candle1Index: overrides.createdAtBarIndex - 2,
    candle3Index: overrides.createdAtBarIndex,
    fillPercentage: 0,
    state: "FRESH",
    invertedAtBarIndex: null,
    isExtreme: false,
    isIdmAdjacent: false,
    ...overrides,
  };
}

describe("computeBalancedPriceRanges", () => {
  it("finds no BPR when there is only one gap, or no opposing-type gap", () => {
    const onlyBullish = [makeFvg({ id: "a", type: "BULLISH", top: 110, bottom: 100, createdAtBarIndex: 5 })];
    expect(computeBalancedPriceRanges(onlyBullish)).toHaveLength(0);

    const sameSide = [
      makeFvg({ id: "a", type: "BULLISH", top: 110, bottom: 100, createdAtBarIndex: 5 }),
      makeFvg({ id: "b", type: "BULLISH", top: 108, bottom: 98, createdAtBarIndex: 8 }),
    ];
    expect(computeBalancedPriceRanges(sameSide)).toHaveLength(0);
  });

  it("finds no BPR when opposing gaps merely touch at one price, not a genuine overlap", () => {
    const gaps = [
      makeFvg({ id: "a", type: "BULLISH", top: 105, bottom: 100, createdAtBarIndex: 5 }),
      makeFvg({ id: "b", type: "BEARISH", top: 100, bottom: 95, createdAtBarIndex: 8 }),
    ];
    expect(computeBalancedPriceRanges(gaps)).toHaveLength(0);
  });

  it("labels the BPR by the MORE RECENT gap's direction, not either gap's own type alone", () => {
    // Bullish gap formed first (bar 5), bearish gap cuts back through later (bar 8) -> BEARISH BPR.
    const gaps = [
      makeFvg({ id: "up-first", type: "BULLISH", top: 110, bottom: 100, createdAtBarIndex: 5 }),
      makeFvg({ id: "down-second", type: "BEARISH", top: 106, bottom: 98, createdAtBarIndex: 8 }),
    ];
    const results = computeBalancedPriceRanges(gaps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      type: "BEARISH",
      top: 106, // min(110, 106)
      bottom: 100, // max(100, 98)
      meanThreshold: 103,
      olderGapId: "up-first",
      newerGapId: "down-second",
      formedAtBarIndex: 8,
    });
  });

  it("mirrors: a bearish gap formed first, bullish cuts back through -> BULLISH BPR", () => {
    const gaps = [
      makeFvg({ id: "down-first", type: "BEARISH", top: 100, bottom: 90, createdAtBarIndex: 5 }),
      makeFvg({ id: "up-second", type: "BULLISH", top: 98, bottom: 92, createdAtBarIndex: 9 }),
    ];
    const results = computeBalancedPriceRanges(gaps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "BULLISH", top: 98, bottom: 92, olderGapId: "down-first", newerGapId: "up-second" });
  });

  it("reports every pairwise overlap independently when multiple gaps of both types are active", () => {
    const gaps = [
      makeFvg({ id: "b1", type: "BULLISH", top: 110, bottom: 100, createdAtBarIndex: 5 }),
      makeFvg({ id: "b2", type: "BULLISH", top: 109, bottom: 99, createdAtBarIndex: 6 }),
      makeFvg({ id: "r1", type: "BEARISH", top: 105, bottom: 95, createdAtBarIndex: 10 }),
    ];
    const results = computeBalancedPriceRanges(gaps);
    expect(results).toHaveLength(2); // r1 overlaps both b1 and b2
    expect(results.every((r) => r.type === "BEARISH")).toBe(true);
  });

  it("has no time-proximity requirement: a far-apart overlap still counts, no threshold is invented", () => {
    const gaps = [
      makeFvg({ id: "old", type: "BULLISH", top: 110, bottom: 100, createdAtBarIndex: 1 }),
      makeFvg({ id: "new", type: "BEARISH", top: 106, bottom: 98, createdAtBarIndex: 500 }),
    ];
    expect(computeBalancedPriceRanges(gaps)).toHaveLength(1);
  });

  it("silently disappears once a constituent gap leaves the active list -- no separate lifecycle to desync", () => {
    const gaps = [
      makeFvg({ id: "a", type: "BULLISH", top: 110, bottom: 100, createdAtBarIndex: 5 }),
      makeFvg({ id: "b", type: "BEARISH", top: 106, bottom: 98, createdAtBarIndex: 8 }),
    ];
    expect(computeBalancedPriceRanges(gaps)).toHaveLength(1);
    // "b" filled/invalidated and dropped from the active list on some later bar -- the caller simply
    // stops passing it, and the BPR vanishes with it, with no explicit cleanup on this module's side.
    expect(computeBalancedPriceRanges([gaps[0]])).toHaveLength(0);
  });
});
