import { describe, expect, it } from "vitest";
import {
  classifyOpeningGap,
  isOpeningGapClassifierInstrument,
  OPENING_GAP_THRESHOLD_PCT,
} from "./opening-gap-classifier.js";

describe("classifyOpeningGap", () => {
  it("classifies a change past the threshold as GAP_UP", () => {
    expect(classifyOpeningGap(0.4, 0.25)).toBe("GAP_UP");
  });

  it("classifies a change past the threshold as GAP_DOWN", () => {
    expect(classifyOpeningGap(-0.4, 0.25)).toBe("GAP_DOWN");
  });

  it("classifies a change inside the band as FLAT", () => {
    expect(classifyOpeningGap(0.1, 0.25)).toBe("FLAT");
    expect(classifyOpeningGap(-0.1, 0.25)).toBe("FLAT");
    expect(classifyOpeningGap(0, 0.25)).toBe("FLAT");
  });

  it("is inclusive of the threshold itself, matching the target table's >= rule", () => {
    expect(classifyOpeningGap(0.25, 0.25)).toBe("GAP_UP");
    expect(classifyOpeningGap(-0.25, 0.25)).toBe("GAP_DOWN");
  });

  it("rejects a non-finite change", () => {
    expect(() => classifyOpeningGap(Number.NaN, 0.25)).toThrow(/finite/);
    expect(() => classifyOpeningGap(Number.POSITIVE_INFINITY, 0.25)).toThrow(/finite/);
  });

  it("rejects a non-positive threshold", () => {
    expect(() => classifyOpeningGap(0.1, 0)).toThrow(/positive/);
    expect(() => classifyOpeningGap(0.1, -0.25)).toThrow(/positive/);
  });
});

describe("isOpeningGapClassifierInstrument", () => {
  it("accepts the two instruments this classifier covers", () => {
    expect(isOpeningGapClassifierInstrument("NIFTY50")).toBe(true);
    expect(isOpeningGapClassifierInstrument("BANKNIFTY")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isOpeningGapClassifierInstrument("SENSEX")).toBe(false);
    expect(isOpeningGapClassifierInstrument("")).toBe(false);
  });
});

describe("OPENING_GAP_THRESHOLD_PCT", () => {
  it("carries the per-instrument thresholds from the research plan", () => {
    expect(OPENING_GAP_THRESHOLD_PCT.NIFTY50).toBe(0.25);
    expect(OPENING_GAP_THRESHOLD_PCT.BANKNIFTY).toBe(0.35);
  });
});
