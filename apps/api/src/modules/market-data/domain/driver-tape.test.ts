import { describe, expect, it } from "vitest";
import {
  DRIVER_TAPE_MIN_COVERAGE,
  computeDriverTapeMetrics,
  driverTapeBias,
} from "./driver-tape.js";

describe("computeDriverTapeMetrics", () => {
  it("measures advance share, decline share, and top-3 concentration", () => {
    const metrics = computeDriverTapeMetrics(
      [
        { weightPct: 10, estPts: 40 },
        { weightPct: 8, estPts: 30 },
        { weightPct: 6, estPts: 20 },
        { weightPct: 5, estPts: -5 },
        { weightPct: 4, estPts: -3 },
      ],
      5,
    );
    expect(metrics).not.toBeNull();
    expect(metrics!.advanceShare).toBeCloseTo(0.6, 5);
    expect(metrics!.declineShare).toBeCloseTo(0.4, 5);
    expect(metrics!.concentration).toBeCloseTo(90 / 98, 5);
    expect(metrics!.coverage).toBe(1);
    expect(metrics!.estNetPts).toBe(82);
  });

  it("reflects missing quotes in coverage against the full roster", () => {
    const metrics = computeDriverTapeMetrics(
      [{ weightPct: 10, estPts: 5 }],
      10,
    );
    expect(metrics!.coverage).toBeCloseTo(0.1, 5);
    expect(metrics!.quotedCount).toBe(1);
    expect(metrics!.rosterCount).toBe(10);
  });

  it("returns null when nothing quoted", () => {
    expect(computeDriverTapeMetrics([], 50)).toBeNull();
  });
});

describe("driverTapeBias", () => {
  const broadLong = computeDriverTapeMetrics(
    [
      { weightPct: 10, estPts: 12 },
      { weightPct: 9, estPts: 10 },
      { weightPct: 8, estPts: 8 },
      { weightPct: 7, estPts: 6 },
      { weightPct: 6, estPts: 4 },
      { weightPct: 5, estPts: -2 },
      { weightPct: 4, estPts: -1 },
      { weightPct: 3, estPts: 3 },
      { weightPct: 2, estPts: 2 },
      { weightPct: 1, estPts: 1 },
    ],
    10,
  )!;

  it("rewards broad agreeing tape", () => {
    const long = driverTapeBias("LONG", broadLong);
    expect(long.adjustment).toBe(8);
    expect(long.reasoning).toMatch(/supports LONG/);
  });

  it("penalises narrow opposing tape more when top-heavy", () => {
    const narrow = computeDriverTapeMetrics(
      [
        { weightPct: 30, estPts: 50 },
        { weightPct: 20, estPts: 40 },
        { weightPct: 15, estPts: 30 },
        { weightPct: 10, estPts: -2 },
        { weightPct: 8, estPts: -2 },
        { weightPct: 7, estPts: -1 },
        { weightPct: 5, estPts: -1 },
        { weightPct: 3, estPts: -1 },
        { weightPct: 1, estPts: -1 },
        { weightPct: 1, estPts: -1 },
      ],
      10,
    )!;
    // Only 3/10 advances → 0.3 breadth for LONG, high concentration
    expect(narrow.advanceShare).toBe(0.3);
    expect(narrow.concentration).toBeGreaterThan(0.65);
    const long = driverTapeBias("LONG", narrow);
    expect(long.adjustment).toBe(-18);
  });

  it("stays unchecked below the coverage floor", () => {
    const thin = computeDriverTapeMetrics(
      [{ weightPct: 10, estPts: 5 }],
      Math.ceil(1 / (DRIVER_TAPE_MIN_COVERAGE - 0.01)),
    );
    // coverage of 1/N where N is chosen so coverage < 0.7
    expect(thin!.coverage).toBeLessThan(DRIVER_TAPE_MIN_COVERAGE);
    expect(driverTapeBias("LONG", thin).reasoning).toBeNull();
    expect(driverTapeBias("LONG", thin).adjustment).toBe(0);
  });

  it("mirrors: weak long breadth is strong short breadth", () => {
    const mostlyDown = computeDriverTapeMetrics(
      [
        { weightPct: 10, estPts: -8 },
        { weightPct: 9, estPts: -7 },
        { weightPct: 8, estPts: -6 },
        { weightPct: 7, estPts: -5 },
        { weightPct: 6, estPts: -4 },
        { weightPct: 5, estPts: -3 },
        { weightPct: 4, estPts: 2 },
        { weightPct: 3, estPts: 1 },
        { weightPct: 2, estPts: -2 },
        { weightPct: 1, estPts: -1 },
      ],
      10,
    )!;
    expect(driverTapeBias("SHORT", mostlyDown).adjustment).toBe(8);
    expect(driverTapeBias("LONG", mostlyDown).adjustment).toBeLessThan(0);
  });
});
