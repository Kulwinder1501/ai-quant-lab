import { describe, expect, it } from "vitest";
import {
  buildOiByStrike,
  changePct,
  OI_AXIS_UNIT_LABEL,
  OI_CHANGE_BASELINE_LABEL,
  type OiStrikeInput,
} from "./build-oi-by-strike";

function row(
  strikePrice: number,
  call: { openInterest: number | null; openInterestChange: number | null } | null,
  put: { openInterest: number | null; openInterestChange: number | null } | null,
): OiStrikeInput {
  return { strikePrice, call, put };
}

describe("changePct", () => {
  it("returns null when previous OI is zero or negative", () => {
    expect(changePct(100, 150)).toBeNull(); // previous = -50
    expect(changePct(100, 100)).toBeNull(); // previous = 0
  });

  it("returns percent when previous is positive", () => {
    expect(changePct(110, 10)).toBeCloseTo(10, 8);
  });
});

describe("buildOiByStrike", () => {
  it("keeps call-only and put-only sides as null on the missing leg", () => {
    const result = buildOiByStrike([
      row(100, { openInterest: 300, openInterestChange: 30 }, null),
      row(200, null, { openInterest: 450, openInterestChange: -45 }),
    ]);

    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toMatchObject({
      strike: 100,
      callOi: 300,
      putOi: null,
      callOiPlot: 300,
      putOiPlot: null,
    });
    expect(result.points[1]).toMatchObject({
      strike: 200,
      callOi: null,
      putOi: 450,
      callOiPlot: null,
      putOiPlot: -450,
    });
  });

  it("does not treat null openInterest as zero, and plots zero as 0 not -0", () => {
    const result = buildOiByStrike([
      row(100, { openInterest: null, openInterestChange: null }, { openInterest: 0, openInterestChange: 0 }),
    ]);

    const point = result.points[0]!;
    expect(point.callOi).toBeNull();
    expect(point.callOiPlot).toBeNull();
    expect(point.putOi).toBe(0);
    expect(point.putOiPlot).toBe(0);
    expect(Object.is(point.putOiPlot, -0)).toBe(false);
    expect(point.callChangeSign).toBe("missing");
    expect(point.putChangeSign).toBe("flat");
  });

  it("windows ±N strikes around ATM and clamps at the edges", () => {
    const strikes = [100, 110, 120, 130, 140, 150, 160].map((strikePrice) =>
      row(strikePrice, { openInterest: 10, openInterestChange: 1 }, { openInterest: 20, openInterestChange: 2 }),
    );

    const centred = buildOiByStrike(strikes, { atmStrike: 130, window: 2 });
    expect(centred.windowApplied).toBe(2);
    expect(centred.windowCenter).toBe("atm");
    expect(centred.points.map((p) => p.strike)).toEqual([110, 120, 130, 140, 150]);

    const nearLowEdge = buildOiByStrike(strikes, { atmStrike: 100, window: 2 });
    expect(nearLowEdge.points.map((p) => p.strike)).toEqual([100, 110, 120]);

    const nearHighEdge = buildOiByStrike(strikes, { atmStrike: 160, window: 2 });
    expect(nearHighEdge.points.map((p) => p.strike)).toEqual([140, 150, 160]);
  });

  it("centres the window on the median strike when atmStrike is null", () => {
    const strikes = [100, 110, 120, 130, 140, 150, 160].map((strikePrice) =>
      row(strikePrice, { openInterest: 10, openInterestChange: 1 }, null),
    );

    const result = buildOiByStrike(strikes, { atmStrike: null, window: 2 });
    expect(result.windowCenter).toBe("median");
    expect(result.windowApplied).toBe(2);
    // Median index of 7 strikes is 3 → strike 130
    expect(result.points.map((p) => p.strike)).toEqual([110, 120, 130, 140, 150]);
  });

  it("sorts unsorted strikes ascending", () => {
    const result = buildOiByStrike([
      row(300, { openInterest: 1, openInterestChange: 0 }, null),
      row(100, { openInterest: 2, openInterestChange: 0 }, null),
      row(200, { openInterest: 3, openInterestChange: 0 }, null),
    ]);

    expect(result.points.map((p) => p.strike)).toEqual([100, 200, 300]);
  });

  it("computes percent change vs prev close baseline and labels the unit", () => {
    const result = buildOiByStrike([
      row(100, { openInterest: 110, openInterestChange: 10 }, { openInterest: 80, openInterestChange: -20 }),
    ]);

    expect(result.unitLabel).toBe(OI_AXIS_UNIT_LABEL);
    expect(result.changeBaselineLabel).toBe(OI_CHANGE_BASELINE_LABEL);
    expect(result.points[0]!.callOiChangePct).toBeCloseTo(10, 8);
    expect(result.points[0]!.putOiChangePct).toBeCloseTo(-20, 8);
    expect(result.points[0]!.callChangeSign).toBe("up");
    expect(result.points[0]!.putChangeSign).toBe("down");
  });
});
