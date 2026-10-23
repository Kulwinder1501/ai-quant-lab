import { describe, expect, it } from "vitest";
import {
  buildProfileGeometry,
  describeResolution,
  describeRow,
  previousSessionSentence,
  priceFraction,
  profileSessionLabel,
  qualityNotes,
  rowAtFraction,
  volumeProfileQuery,
  type PreviousSessionView,
  type VolumeProfileAvailable,
} from "./volume-profile-view";

/** Synthetic payloads, hand-built for the rules below (not recorded from the API). 2026-10-22; 09:15 IST = 03:45Z. */
const OPEN = Date.parse("2026-10-22T03:45:00.000Z");

function payload(overrides: Partial<VolumeProfileAvailable> = {}): VolumeProfileAvailable {
  return {
    available: true,
    underlying: "BANKNIFTY",
    contract: { symbol: "BANKNIFTY26OCTFUT", providerSymbol: "NSE:BANKNIFTY26OCTFUT", expiryDate: "2026-10-27", lotSize: 30 },
    sessionDate: "2026-10-22",
    inProgress: false,
    rowPoints: 10,
    rowPointsChoices: [5, 10, 20],
    estimated: true,
    volumeUnit: "units",
    session: { open: 100, high: 130, low: 100, close: 120, firstBarAt: new Date(OPEN).toISOString(), lastBarAt: new Date(OPEN + 374 * 60_000).toISOString() },
    profile: {
      rowPoints: 10,
      totalVolume: 1000,
      poc: 115,
      vah: 130,
      val: 100,
      valueAreaShare: 0.8,
      vwap: 112.5,
      rows: [
        { low: 100, high: 110, volume: 200, inValueArea: true, isPoc: false },
        { low: 110, high: 120, volume: 500, inValueArea: true, isPoc: true },
        { low: 120, high: 130, volume: 100, inValueArea: true, isPoc: false },
        { low: 130, high: 140, volume: 200, inValueArea: false, isPoc: false },
      ],
    },
    quality: { expectedMinutes: 375, barsUsed: 375, barsWithVolume: 375, zeroVolumeBars: 0, missingMinutes: 0, outsideSessionBarsExcluded: 0, complete: true },
    sensitivity: { comparedWithBarMinutes: 5, agreement: 0.95, pocShiftPoints: 0, vahShiftPoints: 0, valShiftPoints: 0 },
    previousSession: null,
    closes: [[OPEN, 120], [OPEN + 187 * 60_000, 110], [OPEN + 374 * 60_000, 130]],
    availableSessions: [],
    definitions: {},
    source: "candles",
    ...overrides,
  };
}

describe("volumeProfileQuery", () => {
  it("sends only what was chosen, so the server picks the latest session and its own default row height", () => {
    expect(volumeProfileQuery({ underlying: "BANKNIFTY", sessionDate: "", rowPoints: null })).toBe("underlying=BANKNIFTY");
    expect(volumeProfileQuery({ underlying: "NIFTY50", sessionDate: "2026-10-22", rowPoints: 5 })).toBe("underlying=NIFTY50&date=2026-10-22&rowPoints=5");
  });
});

describe("buildProfileGeometry", () => {
  it("spans the rows' prices and puts the highest row on top, one row tall", () => {
    const geometry = buildProfileGeometry(payload());
    expect([geometry.priceLow, geometry.priceHigh]).toEqual([100, 140]);
    const top = geometry.rows.find((r) => r.low === 130)!;
    const bottom = geometry.rows.find((r) => r.low === 100)!;
    expect(top.y).toBe(0);
    expect(bottom.y).toBeCloseTo(0.75, 10);
    expect(top.height).toBeCloseTo(0.25, 10);
  });

  it("scales each bar against the largest row and gives each row its share of the session", () => {
    const rows = buildProfileGeometry(payload()).rows;
    expect(rows.find((r) => r.isPoc)!.width).toBe(1);
    expect(rows.find((r) => r.low === 120)!.width).toBeCloseTo(0.2, 10);
    expect(rows.find((r) => r.isPoc)!.share).toBe(0.5);
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 10);
  });

  it("places each close on the 09:15-15:30 session clock and on the price axis", () => {
    const line = buildProfileGeometry(payload()).closeLine;
    expect(line[0]).toEqual({ x: 0, y: 0.5 });                       // 09:15, close 120 of 100-140
    expect(line[1]!.x).toBeCloseTo(187 / 375, 10);                    // 12:22
    expect(line[2]!.x).toBeCloseTo(374 / 375, 10);                    // 15:29
    expect(line[2]!.y).toBeCloseTo(0.25, 10);                         // close 130
  });

  it("draws nothing for a profile with no rows instead of dividing by zero", () => {
    const geometry = buildProfileGeometry(payload({ profile: { ...payload().profile, rows: [], totalVolume: 0 } }));
    expect(geometry).toEqual({ priceLow: 0, priceHigh: 0, rows: [], closeLine: [] });
  });
});

describe("hit testing", () => {
  const geometry = buildProfileGeometry(payload());

  it("maps a price to a vertical position, and refuses a price outside the drawing", () => {
    expect(priceFraction(geometry, 140)).toBe(0);
    expect(priceFraction(geometry, 100)).toBe(1);
    expect(priceFraction(geometry, 120)).toBe(0.5);
    expect(priceFraction(geometry, 99.9)).toBeNull();
    expect(priceFraction(geometry, 140.1)).toBeNull();
  });

  it("finds the row under a position, highest on top, and none outside", () => {
    expect(rowAtFraction(geometry.rows, 0.01)!.low).toBe(130);
    expect(rowAtFraction(geometry.rows, 0.5)!.low).toBe(110);
    expect(rowAtFraction(geometry.rows, 0.99)!.low).toBe(100);
    expect(rowAtFraction(geometry.rows, 1)).toBeNull();
    expect(rowAtFraction(geometry.rows, -0.1)).toBeNull();
  });
});

describe("describeRow", () => {
  const rows = buildProfileGeometry(payload()).rows;

  it("calls its volume estimated and tags the point of control and the value area", () => {
    expect(describeRow(rows.find((r) => r.isPoc)!)).toBe("110–120: 500 units, 50.0% of the session (estimated), point of control, inside the value area.");
  });

  it("says nothing extra for a row outside the value area", () => {
    expect(describeRow(rows.find((r) => r.low === 130)!)).toBe("130–140: 200 units, 20.0% of the session (estimated).");
  });
});

describe("describeResolution", () => {
  it("is null when the comparison could not be built", () => {
    expect(describeResolution(null, 10)).toBeNull();
  });

  it("calls levels that hold across bar sizes fine, and says how little they move", () => {
    const note = describeResolution({ comparedWithBarMinutes: 5, agreement: 0.91, pocShiftPoints: 0, vahShiftPoints: 10, valShiftPoints: -10 }, 10)!;
    expect(note.tone).toBe("ok");
    expect(note.text).toContain("91% of the volume lands in the same rows");
    expect(note.text).toContain("POC does not move");
    expect(note.text).toContain("VAH moves +10 pts");
    expect(note.text).toContain("VAL moves −10 pts");
    expect(note.text).not.toContain("not well resolved");
  });

  it("warns, and says to read a level as a zone, when it moves more than two rows between bar sizes", () => {
    // The real 2026-10-22 BANKNIFTY result: POC -40 at 10-point rows, VAH and VAL steady.
    const note = describeResolution({ comparedWithBarMinutes: 5, agreement: 0.907, pocShiftPoints: -40, vahShiftPoints: 0, valShiftPoints: 0 }, 10)!;
    expect(note.tone).toBe("warn");
    expect(note.text).toContain("POC is not well resolved");
    expect(note.text).toContain("zone, not a price");
    expect(note.text).not.toContain("VAH is not");
  });

  it("names several loose levels together", () => {
    const note = describeResolution({ comparedWithBarMinutes: 5, agreement: 0.9, pocShiftPoints: 30, vahShiftPoints: -30, valShiftPoints: 0 }, 10)!;
    expect(note.text).toContain("POC and VAH are not well resolved");
    expect(note.text).toContain("read them as a zone");
  });

  it("warns on poor row agreement even if no level moved", () => {
    expect(describeResolution({ comparedWithBarMinutes: 5, agreement: 0.7, pocShiftPoints: 0, vahShiftPoints: 0, valShiftPoints: 0 }, 10)!.tone).toBe("warn");
  });

  it("scales the tolerance to the row height", () => {
    // 15 points is under two 10-point rows, but over two 5-point rows.
    const shift = { comparedWithBarMinutes: 5, agreement: 0.9, pocShiftPoints: 15, vahShiftPoints: 0, valShiftPoints: 0 };
    expect(describeResolution(shift, 10)!.tone).toBe("ok");
    expect(describeResolution(shift, 5)!.tone).toBe("warn");
  });
});

describe("qualityNotes", () => {
  it("is silent for a clean complete session", () => {
    expect(qualityNotes(payload())).toEqual([]);
  });

  it("warns that a partial session covers only the stored minutes, and that it will change while in progress", () => {
    const partial = payload({
      inProgress: true,
      quality: { expectedMinutes: 375, barsUsed: 329, barsWithVolume: 329, zeroVolumeBars: 0, missingMinutes: 46, outsideSessionBarsExcluded: 0, complete: false },
      session: { open: 1, high: 2, low: 1, close: 2, firstBarAt: new Date(OPEN).toISOString(), lastBarAt: "2026-10-23T09:13:00.000Z" },
    });
    const [note] = qualityNotes(partial);
    expect(note!.tone).toBe("warn");
    expect(note!.text).toContain("329 of 375");
    expect(note!.text).toContain("last bar 14:43 IST");
    expect(note!.text).toContain("will change as the session continues");
  });

  it("does not claim a finished partial day will change", () => {
    const done = payload({ quality: { ...payload().quality, barsUsed: 200, missingMinutes: 175, complete: false } });
    expect(qualityNotes(done)[0]!.text).not.toContain("will change");
  });

  it("counts missing minutes on an otherwise complete day, and separates them from the no-trade minutes", () => {
    const notes = qualityNotes(payload({ quality: { ...payload().quality, missingMinutes: 2, zeroVolumeBars: 3, outsideSessionBarsExcluded: 10 } }));
    expect(notes.map((n) => n.text)).toEqual([
      "2 regular minutes have no bar and add nothing to the profile.",
      "3 minutes traded nothing (flat, zero volume) and add nothing.",
      "10 bars outside 09:15–15:30 IST (the post-close minutes) were set aside.",
    ]);
  });

  it("uses the singular for one", () => {
    const notes = qualityNotes(payload({ quality: { ...payload().quality, missingMinutes: 1, zeroVolumeBars: 1, outsideSessionBarsExcluded: 0 } }));
    expect(notes.map((n) => n.text)).toEqual([
      "1 regular minute has no bar and adds nothing to the profile.",
      "1 minute traded nothing (flat, zero volume) and adds nothing.",
    ]);
  });
});

describe("previousSessionSentence and session labels", () => {
  const previous: PreviousSessionView = {
    sessionDate: "2026-10-21", symbol: "BANKNIFTY26OCTFUT", poc: 54_895, vah: 55_500, val: 54_810,
    high: 55_948, low: 54_810.2, close: 54_999, totalVolume: 720_030, complete: true,
  };

  it("is null without a previous session", () => {
    expect(previousSessionSentence(null)).toBeNull();
  });

  it("gives the previous POC, value area and range, and says it is estimated too", () => {
    expect(previousSessionSentence(previous)).toBe(
      "Previous session 2026-10-21 (BANKNIFTY26OCT future): POC 54,895, value area 54,810–55,500, range 54,810.2–55,948. Same row height; also estimated.",
    );
  });

  it("flags a partial previous day", () => {
    expect(previousSessionSentence({ ...previous, complete: false })).toContain("(partial day)");
  });

  it("labels a session with its IST span and marks a partial one", () => {
    const listing = { sessionDate: "2026-10-23", symbol: "x", bars: 329, barsWithVolume: 329, firstAt: "2026-10-23T03:45:00.000Z", lastAt: "2026-10-23T09:13:00.000Z", complete: false };
    expect(profileSessionLabel(listing)).toBe("2026-10-23 · 09:15–14:43 IST · partial");
    expect(profileSessionLabel({ ...listing, complete: true })).toBe("2026-10-23 · 09:15–14:43 IST");
  });
});
