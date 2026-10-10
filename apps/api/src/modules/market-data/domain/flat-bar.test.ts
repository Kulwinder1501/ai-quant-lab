import { describe, expect, it } from "vitest";
import { flatShareOfWindow, isFlatBar, withoutFlatBars } from "./flat-bar.js";

describe("isFlatBar", () => {
  it("requires high == low AND volume == 0", () => {
    expect(isFlatBar({ high: 100, low: 100, volume: 0 })).toBe(true);
    // Traded at one price: real information, not a frozen feed.
    expect(isFlatBar({ high: 100, low: 100, volume: 5 })).toBe(false);
    // Index instruments report volume 0 on every bar; a real range means a live bar.
    expect(isFlatBar({ high: 101, low: 100, volume: 0 })).toBe(false);
  });

  it("never treats a missing volume as zero", () => {
    expect(isFlatBar({ high: 100, low: 100 })).toBe(false);
  });
});

describe("withoutFlatBars / flatShareOfWindow", () => {
  const bars = [
    { high: 101, low: 99, volume: 10 },
    { high: 100, low: 100, volume: 0 },
    { high: 100, low: 100, volume: 0 },
    { high: 102, low: 100, volume: 3 },
  ];

  it("drops flat bars and preserves order", () => {
    expect(withoutFlatBars(bars)).toEqual([bars[0], bars[3]]);
  });

  it("measures the flat share of a trailing window, shortened at the series start", () => {
    expect(flatShareOfWindow(bars, 2, 2)).toBe(1);
    expect(flatShareOfWindow(bars, 3, 4)).toBe(0.5);
    expect(flatShareOfWindow(bars, 0, 14)).toBe(0);
  });
});
