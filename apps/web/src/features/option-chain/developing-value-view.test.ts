import { describe, expect, it } from "vitest";
import {
  buildDevelopingChart,
  checkpointNearFraction,
  describePoint,
  developingNotes,
  developingQuery,
  developingRows,
  pocShift,
  RESOLUTION_ROWS,
  THIN_BARS,
  type DevelopingAvailable,
  type DevelopingPointView,
} from "./developing-value-view";

/** Synthetic payloads, hand-built for the rules below (not recorded from the API). 2026-10-22; 09:15 IST = 03:45Z. */
const OPEN = Date.parse("2026-10-22T03:45:00.000Z");

function point(overrides: Partial<DevelopingPointView> & { at: string; atMinute: number }): DevelopingPointView {
  return {
    barsUsed: 30, expectedBars: 30, newBars: 15, totalVolume: 3000, poc: 125, vah: 130, val: 100, vwap: 115, lastClose: 120, complete: true,
    ...overrides,
  };
}

/** Four checkpoints: a thin first, a normal second, a blank third (no new bar, with levels that must not be drawn), a fourth. */
const POINTS: DevelopingPointView[] = [
  point({ at: "09:30", atMinute: 570, barsUsed: 15, expectedBars: 15, newBars: 15, totalVolume: 1500, poc: 105, vah: 110, val: 100, vwap: 104, lastClose: 100 }),
  point({ at: "10:00", atMinute: 600, barsUsed: 30, expectedBars: 45, newBars: 15, complete: false }),
  point({ at: "10:15", atMinute: 615, barsUsed: 30, expectedBars: 60, newBars: 0, complete: false, poc: 999, vah: 999, val: 999, vwap: 999 }),
  point({ at: "10:30", atMinute: 630, barsUsed: 45, expectedBars: 75, newBars: 15, complete: false, poc: 135, vah: 140, val: 120, vwap: 130, lastClose: 140 }),
];

function payload(overrides: Partial<DevelopingAvailable> = {}): DevelopingAvailable {
  return {
    available: true,
    underlying: "BANKNIFTY",
    contract: { symbol: "BANKNIFTY26OCTFUT", providerSymbol: "NSE:BANKNIFTY26OCTFUT", expiryDate: "2026-10-27", lotSize: 30 },
    sessionDate: "2026-10-22",
    inProgress: false,
    rowPoints: 10,
    rowPointsChoices: [5, 10, 20],
    stepMinutes: 15,
    stepChoices: [15, 30, 60],
    estimated: true,
    volumeUnit: "units",
    session: null,
    quality: { expectedMinutes: 375, barsUsed: 375, missingMinutes: 0, complete: true },
    points: POINTS,
    closes: [[OPEN, 100], [OPEN + 74 * 60_000, 140]],
    availableSessions: [],
    definitions: {},
    source: "candles",
    ...overrides,
  };
}

describe("developingQuery", () => {
  it("sends only what was chosen", () => {
    expect(developingQuery({ underlying: "BANKNIFTY", sessionDate: "", rowPoints: null, stepMinutes: null })).toBe("underlying=BANKNIFTY");
    expect(developingQuery({ underlying: "NIFTY50", sessionDate: "2026-10-22", rowPoints: 5, stepMinutes: 60 })).toBe("underlying=NIFTY50&date=2026-10-22&rowPoints=5&step=60");
  });
});

describe("buildDevelopingChart", () => {
  const geometry = buildDevelopingChart(payload());

  it("spans the closes and the levels of checkpoints that have something new, and ignores the levels of a blank one", () => {
    // Lowest 100, highest 140, padded by one row (10) because 4% of 40 is less: 90 to 150.
    expect([geometry.priceLow, geometry.priceHigh]).toEqual([90, 150]);
  });

  it("draws the POC, value area and VWAP of each checkpoint as a fraction of the price range, highest on top", () => {
    const first = geometry.checkpoints[0]!;
    expect(first).toMatchObject({ index: 0, x: 15 / 375, thin: true });
    expect(first.poc).toBeCloseTo((150 - 105) / 60, 12);
    expect(first.vah).toBeCloseTo((150 - 110) / 60, 12);
    expect(first.val).toBeCloseTo((150 - 100) / 60, 12);
    expect(first.vwap).toBeCloseTo((150 - 104) / 60, 12);
    expect(geometry.checkpoints[1]).toMatchObject({ index: 1, x: 45 / 375, thin: false });
  });

  it("leaves a checkpoint with no new bar out, and cuts the line there", () => {
    expect(geometry.checkpoints.map((c) => c.index)).toEqual([0, 1, 3]);
    expect(geometry.runs.map((run) => run.map((c) => c.index))).toEqual([[0, 1], [3]]);
  });

  it("places each close on the session clock and on the price axis", () => {
    expect(geometry.closeLine[0]).toEqual({ x: 0, y: (150 - 100) / 60 });
    expect(geometry.closeLine[1]!.x).toBeCloseTo(74 / 375, 12);
    expect(geometry.closeLine[1]!.y).toBeCloseTo((150 - 140) / 60, 12);
  });

  it("draws nothing for a payload with no data instead of dividing by zero", () => {
    expect(buildDevelopingChart(payload({ points: [], closes: [] }))).toEqual({ priceLow: 0, priceHigh: 0, checkpoints: [], runs: [], closeLine: [] });
  });
});

describe("checkpointNearFraction", () => {
  const { checkpoints } = buildDevelopingChart(payload());
  it("finds the nearest drawn checkpoint, and none when the pointer is far from all of them", () => {
    expect(checkpointNearFraction(checkpoints, 0.05)!.index).toBe(0);
    expect(checkpointNearFraction(checkpoints, 0.13)!.index).toBe(1);
    expect(checkpointNearFraction(checkpoints, 0.9)).toBeNull();
    expect(checkpointNearFraction([], 0.1)).toBeNull();
  });
});

describe("pocShift", () => {
  it("is the POC change from the previous checkpoint, null for the first and across a gap in the data", () => {
    expect(pocShift(POINTS, 0)).toBeNull();
    expect(pocShift(POINTS, 1)).toBe(20);        // 125 - 105
    expect(pocShift(POINTS, 3)).toBeNull();      // the checkpoint before it has no new bar: the shift across it is not measured
  });
});

describe("describePoint", () => {
  it("gives the levels and calls a shift of two rows within the resolution", () => {
    expect(describePoint(POINTS, 1, 10)).toBe(
      "10:00: POC 125, POC +20 pts since the previous checkpoint (within the ~20 pt resolution); value area 100–130, VWAP 115; estimated from 30 bars, 3,000 units (15 minutes missing).",
    );
  });

  it("calls a shift of more than two rows beyond it, and scales the resolution to the row height", () => {
    expect(describePoint(POINTS, 1, 5)).toContain("beyond the ~10 pt resolution");
    expect(describePoint(POINTS, 1, 20)).toContain("within the ~40 pt resolution");
    expect(RESOLUTION_ROWS).toBe(2);
  });

  it("calls an early checkpoint thin and has no shift to report for the first", () => {
    expect(describePoint(POINTS, 0, 10)).toBe("09:30: POC 105; value area 100–110, VWAP 104; estimated from 15 bars, 1,500 units (thin: few minutes of bars).");
    expect(THIN_BARS).toBe(30);
  });

  it("says a checkpoint with no new bar has nothing new, rather than repeating levels", () => {
    expect(describePoint(POINTS, 2, 10)).toBe("10:15: no new bar since the previous checkpoint (30 of 60 minutes stored), so nothing new to show.");
  });

  it("says nothing had traded when there are no levels", () => {
    const none = [point({ at: "09:30", atMinute: 570, poc: null, vah: null, val: null, vwap: null, totalVolume: null })];
    expect(describePoint(none, 0, 10)).toBe("09:30: nothing had traded by then (estimated profile unavailable).");
  });
});

describe("developingNotes", () => {
  it("names the thin checkpoints and the blank ones", () => {
    expect(developingNotes(payload()).map((note) => note.text)).toEqual([
      "The first checkpoint is thin (hollow, under 30 bars): they show what those few minutes did, not where the day's volume will sit.",
      "1 checkpoint has no new bar since the one before and is left blank: the stored bars have a hole or end early.",
    ]);
  });

  it("says a session in progress has blank later checkpoints because their bars have not arrived", () => {
    const notes = developingNotes(payload({ inProgress: true }));
    expect(notes.map((note) => note.text)).toContain("Session in progress: later checkpoints are blank until their bars arrive, and the page refetches every minute.");
    expect(notes.some((note) => note.text.includes("hole"))).toBe(false);
  });

  it("flags a partial finished session, and is silent for a clean complete one", () => {
    const partial = developingNotes(payload({ quality: { expectedMinutes: 375, barsUsed: 300, missingMinutes: 75, complete: false } }));
    expect(partial.map((note) => note.text)).toContain("Partial session: 300 of 375 regular minutes are stored.");
    const clean = payload({ points: [point({ at: "10:00", atMinute: 600 }), point({ at: "10:30", atMinute: 630 })] });
    expect(developingNotes(clean)).toEqual([]);
  });

  it("uses the plural for several thin checkpoints", () => {
    const thin = payload({ points: [point({ at: "09:30", atMinute: 570, barsUsed: 15 }), point({ at: "09:45", atMinute: 585, barsUsed: 20 }), point({ at: "10:30", atMinute: 630 })] });
    expect(developingNotes(thin)[0]!.text).toContain("The first 2 checkpoints are thin");
  });
});

describe("developingRows", () => {
  const rows = developingRows(payload());

  it("lists each checkpoint with its levels and the shift against the resolution", () => {
    expect(rows[1]).toMatchObject({ at: "10:00", poc: 125, valueArea: "100–130", vwap: 115, close: 120, shift: 20, withinResolution: true, barsUsed: 30, thin: false, blank: false });
    expect(rows[0]).toMatchObject({ shift: null, withinResolution: null, thin: true });
  });

  it("lists a checkpoint with no new bar as blank, with no levels", () => {
    expect(rows[2]).toMatchObject({ at: "10:15", blank: true, poc: null, valueArea: null, vwap: null, close: null, shift: null });
  });

  it("gives no shift across a gap", () => {
    expect(rows[3]).toMatchObject({ poc: 135, shift: null, withinResolution: null });
  });
});
