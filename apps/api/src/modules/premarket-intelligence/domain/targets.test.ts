import { describe, expect, it } from "vitest";
import {
  classifyReturn,
  returnPercent,
  TARGET_THRESHOLD_PCT,
  toMeasuredOutcome,
  volumeWeightedAveragePrice,
  type MinuteBar,
} from "./targets.js";

const bar = (high: number, low: number, close: number, volume: number | null): MinuteBar => ({
  openTime: new Date("2026-10-12T09:30:00Z"), open: close, high, low, close, volume,
});

describe("pre-registered thresholds", () => {
  it("match the research contract exactly", () => {
    expect(TARGET_THRESHOLD_PCT.OPENING_GAP).toEqual({ NIFTY50: 0.25, BANKNIFTY: 0.35 });
    expect(TARGET_THRESHOLD_PCT.FIRST_60_MINUTES).toEqual({ NIFTY50: 0.2, BANKNIFTY: 0.2 });
    expect(TARGET_THRESHOLD_PCT.FULL_SESSION).toEqual({ NIFTY50: 0.3, BANKNIFTY: 0.3 });
  });
});

describe("classifyReturn", () => {
  it("is inclusive at the threshold and FLAT inside it", () => {
    expect(classifyReturn(0.2, 0.2)).toBe("UP");
    expect(classifyReturn(-0.2, 0.2)).toBe("DOWN");
    expect(classifyReturn(0.199, 0.2)).toBe("FLAT");
  });
  it("rejects non-finite input and non-positive thresholds", () => {
    expect(() => classifyReturn(Number.NaN, 0.2)).toThrow(/finite/);
    expect(() => classifyReturn(0.1, 0)).toThrow(/positive/);
  });
});

describe("returnPercent", () => {
  it("measures against the base", () => {
    expect(returnPercent(22000, 22044)).toBeCloseTo(0.2, 10);
  });
  it("refuses a non-positive base", () => {
    expect(() => returnPercent(0, 10)).toThrow();
  });
});

describe("volumeWeightedAveragePrice", () => {
  it("weights typical price by volume", () => {
    // typical prices 100 and 110, volumes 1 and 3 -> (100 + 330) / 4
    expect(volumeWeightedAveragePrice([bar(100, 100, 100, 1), bar(110, 110, 110, 3)])).toBeCloseTo(107.5, 10);
  });
  it("skips bars with no volume instead of weighting them as zero-price", () => {
    expect(volumeWeightedAveragePrice([bar(100, 100, 100, 2), bar(999, 999, 999, null), bar(999, 999, 999, 0)])).toBe(100);
  });
  it("returns null rather than an unweighted mean when no bar has volume", () => {
    expect(volumeWeightedAveragePrice([bar(100, 100, 100, null), bar(110, 110, 110, 0)])).toBeNull();
    expect(volumeWeightedAveragePrice([])).toBeNull();
  });
});

describe("toMeasuredOutcome", () => {
  it("maps directional words and treats UNCERTAIN as an abstention, not FLAT", () => {
    expect(toMeasuredOutcome("GAP_UP")).toBe("UP");
    expect(toMeasuredOutcome("BEARISH")).toBe("DOWN");
    expect(toMeasuredOutcome("NEUTRAL")).toBe("FLAT");
    expect(toMeasuredOutcome("FLAT")).toBe("FLAT");
    expect(toMeasuredOutcome("UNCERTAIN")).toBeNull();
    expect(toMeasuredOutcome("whatever")).toBeNull();
  });
});
