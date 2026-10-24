import { describe, expect, it } from "vitest";
import {
  ageText,
  cellTone,
  coverageNotes,
  dataCoverageQuery,
  depthFramesText,
  istClock,
  istSpan,
  snapshotCountText,
  type CoverageRowView,
  type CoverageStatus,
  type DepthCoverageView,
  type SnapshotCoverageView,
} from "./data-coverage-view";

/** Synthetic rows, hand-built for the wording rules (not recorded from the API). */
function row(date: string, futures: CoverageStatus, snapshots: CoverageStatus, depth: CoverageStatus, overrides: Partial<CoverageRowView> = {}): CoverageRowView {
  const holiday = futures === "none" && snapshots !== "complete" && depth !== "complete";
  return {
    date,
    futures: { symbol: "BANKNIFTY26OCTFUT", bars: 0, barsWithVolume: 0, firstAt: null, lastAt: null, status: futures },
    snapshots: { inSessionMinutes: 0, preOpenMinutes: 0, postCloseMinutes: 0, firstAt: null, lastAt: null, typicalMinutes: 24, status: snapshots },
    depth: { symbol: null, framesCapped: 0, capReached: false, firstAt: null, lastAt: null, status: depth },
    inProgress: false,
    probableHoliday: holiday,
    gapInSource: !holiday && [futures, snapshots, depth].includes("none"),
    ...overrides,
  };
}

describe("dataCoverageQuery", () => {
  it("sends the number of days only when one was chosen", () => {
    expect(dataCoverageQuery({ underlying: "BANKNIFTY", days: null })).toBe("underlying=BANKNIFTY");
    expect(dataCoverageQuery({ underlying: "NIFTY50", days: 40 })).toBe("underlying=NIFTY50&days=40");
  });
});

describe("clock and spans", () => {
  it("shows UTC instants as IST wall-clock times", () => {
    expect(istClock("2026-10-22T03:45:00.000Z")).toBe("09:15");
    expect(istClock("2026-10-22T09:53:00.000Z")).toBe("15:23");
    expect(istClock(null)).toBe("–");
    expect(istSpan("2026-10-22T03:53:00.000Z", "2026-10-22T09:53:00.000Z")).toBe("09:23–15:23");
    expect(istSpan(null, "2026-10-22T09:53:00.000Z")).toBe("–");
  });
});

describe("cellTone", () => {
  it("colours complete good, partial a warning, and a missing source bad, except on a probable holiday", () => {
    expect(cellTone("complete", false)).toBe("good");
    expect(cellTone("partial", false)).toBe("warn");
    expect(cellTone("none", false)).toBe("bad");
    expect(cellTone("none", true)).toBe("neutral");
    expect(cellTone("partial", true)).toBe("warn");
  });

  it("shows a source that is not collected at all as neutral, not as a failure", () => {
    expect(cellTone("none", false, true)).toBe("neutral");
    expect(cellTone("complete", false, true)).toBe("good");
  });
});

describe("count wording", () => {
  const depth = (overrides: Partial<DepthCoverageView>): DepthCoverageView => ({ symbol: null, framesCapped: 0, capReached: false, firstAt: null, lastAt: null, status: "none", ...overrides });
  const snaps = (overrides: Partial<SnapshotCoverageView>): SnapshotCoverageView => ({
    inSessionMinutes: 0, preOpenMinutes: 0, postCloseMinutes: 0, firstAt: null, lastAt: null, typicalMinutes: 24, status: "none", ...overrides,
  });

  it("prints a capped depth count as at least, since it is not the day's total", () => {
    expect(depthFramesText(depth({ framesCapped: 1000, capReached: true }))).toBe("≥ 1,000");
    expect(depthFramesText(depth({ framesCapped: 4 }))).toBe("4");
    expect(depthFramesText(depth({}))).toBe("0");
  });

  it("prints the snapshot count against the typical day, and bare when there is nothing to compare with", () => {
    expect(snapshotCountText(snaps({ inSessionMinutes: 20 }))).toBe("20 of a typical 24");
    expect(snapshotCountText(snaps({ inSessionMinutes: 9, typicalMinutes: 17.5 }))).toBe("9 of a typical 17.5");
    expect(snapshotCountText(snaps({ inSessionMinutes: 9, typicalMinutes: null }))).toBe("9");
    expect(snapshotCountText(snaps({}))).toBe("0");
  });
});

describe("ageText", () => {
  const now = Date.parse("2026-10-24T06:00:00.000Z");
  it("says how long ago, in the unit that reads best", () => {
    expect(ageText("2026-10-24T05:59:30.000Z", now)).toBe("30 s ago");
    expect(ageText("2026-10-24T05:40:00.000Z", now)).toBe("20 min ago");
    expect(ageText("2026-10-24T01:00:00.000Z", now)).toBe("5 h ago");
    expect(ageText("2026-10-20T06:00:00.000Z", now)).toBe("4 days ago");
    expect(ageText(null, now)).toBe("never");
  });
});

describe("coverageNotes", () => {
  it("names a gap day and what is missing on it", () => {
    const notes = coverageNotes({ rows: [row("2026-10-19", "complete", "none", "none")] });
    expect(notes[0]).toEqual({ tone: "warn", text: "2026-10-19: no chain snapshots and no depth frames stored on a day the market traded." });
  });

  it("names missing futures bars on a day a collector source was whole", () => {
    const notes = coverageNotes({ rows: [row("2026-10-21", "none", "complete", "complete")] });
    expect(notes[0]!.text).toBe("2026-10-21: no futures bars stored on a day the market traded.");
  });

  it("lists the probable holidays once, as an inference", () => {
    const notes = coverageNotes({ rows: [row("2026-10-20", "none", "partial", "partial"), row("2026-10-16", "none", "none", "none")] });
    const text = notes.find((note) => note.tone === "info")!.text;
    expect(text).toContain("2 weekdays are a probable exchange holiday (2026-10-20, 2026-10-16)");
    expect(text).toContain("This is an inference");
    expect(notes.some((note) => note.tone === "warn")).toBe(false);
  });

  it("uses the singular for one holiday, and does not call a holiday a gap", () => {
    const notes = coverageNotes({ rows: [row("2026-10-20", "none", "none", "none")] });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("1 weekday is a probable exchange holiday");
  });

  it("mentions traded days with a partial source, and leaves a day still in progress out of the gaps", () => {
    const notes = coverageNotes({ rows: [row("2026-10-21", "complete", "partial", "complete"), row("2026-10-23", "partial", "none", "none", { inProgress: true })] });
    expect(notes.map((note) => note.text)).toEqual(["1 traded day has a partial source (amber): 2026-10-21."]);
  });

  it("is silent when every day is complete", () => {
    expect(coverageNotes({ rows: [row("2026-10-22", "complete", "complete", "complete"), row("2026-10-21", "complete", "complete", "complete")] })).toEqual([]);
  });
});

describe("coverageNotes: a source that is not collected", () => {
  it("says so once, with the reason for depth, instead of a gap on every day", () => {
    const rows = [row("2026-10-22", "complete", "complete", "none", { gapInSource: false }), row("2026-10-21", "complete", "complete", "none", { gapInSource: false })];
    const notes = coverageNotes({ rows, sourcesNotCollected: ["depth"] });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.tone).toBe("info");
    expect(notes[0]!.text).toContain("No depth frames are stored for any day in this window");
    expect(notes[0]!.text).toContain("the depth collector follows one symbol at a time");
    expect(notes[0]!.text).toContain("not as a gap on every day");
  });

  it("leaves the uncollected source out of the missing list of a real gap on another source", () => {
    const rows = [row("2026-10-19", "complete", "none", "none", { gapInSource: true })];
    const gap = coverageNotes({ rows, sourcesNotCollected: ["depth"] }).find((note) => note.tone === "warn")!;
    expect(gap.text).toBe("2026-10-19: no chain snapshots stored on a day the market traded.");
  });
});
