import { describe, expect, it } from "vitest";
import { checkManualOptionGeometry, parseManualOptionBarriers } from "./manual-option-barriers.js";

describe("parseManualOptionBarriers", () => {
  it("accepts positive numbers, including numeric strings from a form", () => {
    expect(parseManualOptionBarriers(120, 260)).toEqual({ ok: true, stopLoss: 120, targetPrice: 260 });
    expect(parseManualOptionBarriers("120.5", "260")).toEqual({ ok: true, stopLoss: 120.5, targetPrice: 260 });
  });

  it("requires both -- a manual position with no exit is refused, not defaulted", () => {
    for (const [stop, target] of [[undefined, 260], [120, undefined], [null, null], ["", 260], [0, 260], [-1, 260], [120, Number.NaN]]) {
      expect(parseManualOptionBarriers(stop, target).ok, JSON.stringify([stop, target])).toBe(false);
    }
  });
});

describe("checkManualOptionGeometry", () => {
  const barriers = { stopLoss: 120, targetPrice: 260 };

  it("passes when the stop is below the fill and the target above it", () => {
    expect(checkManualOptionGeometry(barriers, 186)).toBeNull();
  });

  it("refuses a stop at or above the fill, which would exit on the first mark", () => {
    expect(checkManualOptionGeometry(barriers, 120)).toMatch(/stop loss/);
    expect(checkManualOptionGeometry(barriers, 100)).toMatch(/stop loss/);
  });

  it("refuses a target at or below the fill, which would book a win at once", () => {
    expect(checkManualOptionGeometry(barriers, 260)).toMatch(/target/);
    expect(checkManualOptionGeometry(barriers, 300)).toMatch(/target/);
  });
});
