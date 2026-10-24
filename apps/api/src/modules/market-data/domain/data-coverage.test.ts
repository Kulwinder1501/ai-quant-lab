import { describe, expect, it } from "vitest";
import {
  FUTURES_COMPLETE_BARS,
  classifyDay,
  depthStatus,
  futuresStatus,
  istMinuteOfDay,
  sourcesNotCollected,
  snapshotStatus,
  typicalSnapshotMinutes,
  type CoverageDay,
} from "./data-coverage.js";

/** An IST wall-clock time on 2026-10-22, as an instant (IST is UTC+05:30). */
const at = (hour: number, minute: number) => new Date(Date.UTC(2026, 9, 22, hour, minute) - 330 * 60_000);

describe("istMinuteOfDay", () => {
  it("reads the minutes since midnight IST", () => {
    expect(istMinuteOfDay(at(9, 15))).toBe(555);
    expect(istMinuteOfDay(at(15, 30))).toBe(930);
    expect(istMinuteOfDay(at(0, 5))).toBe(5);
  });
});

describe("futuresStatus", () => {
  it("is complete from 96% of the 375 regular minutes, partial below, none at zero", () => {
    expect(FUTURES_COMPLETE_BARS).toBe(360);
    expect(futuresStatus(375)).toBe("complete");
    expect(futuresStatus(360)).toBe("complete");
    expect(futuresStatus(359)).toBe("partial");
    expect(futuresStatus(1)).toBe("partial");
    expect(futuresStatus(0)).toBe("none");
  });
});

describe("snapshotStatus", () => {
  const day = { inSessionMinutes: 22, firstAt: at(9, 23), lastAt: at(15, 23), typicalMinutes: 22 };

  it("is complete when the day starts by 10:00, ends at or after 15:00 and has at least 70% of the typical day's count", () => {
    expect(snapshotStatus(day)).toBe("complete");
    expect(snapshotStatus({ ...day, inSessionMinutes: 16 })).toBe("complete");     // 16 >= 0.7 x 22 = 15.4
    expect(snapshotStatus({ ...day, inSessionMinutes: 15 })).toBe("partial");      // 15 < 15.4
  });

  it("is partial when it starts after 10:00 or ends before 15:00, even with a normal count", () => {
    expect(snapshotStatus({ ...day, firstAt: at(10, 0) })).toBe("complete");       // by 10:00 inclusive
    expect(snapshotStatus({ ...day, firstAt: at(10, 11) })).toBe("partial");
    expect(snapshotStatus({ ...day, lastAt: at(15, 0) })).toBe("complete");
    expect(snapshotStatus({ ...day, lastAt: at(14, 53) })).toBe("partial");
  });

  it("is none with no in-session snapshot, and has no count rule when there is no typical day to compare with", () => {
    expect(snapshotStatus({ inSessionMinutes: 0, firstAt: null, lastAt: null, typicalMinutes: 22 })).toBe("none");
    expect(snapshotStatus({ ...day, inSessionMinutes: 3, typicalMinutes: null })).toBe("complete");
  });
});

describe("depthStatus", () => {
  const day = { framesCapped: 1000, capReached: true, firstAt: at(9, 0), lastAt: at(15, 29) };

  it("is complete when the first frame is by 09:30, the last at or after 15:15 and the cap was reached", () => {
    expect(depthStatus(day)).toBe("complete");
    expect(depthStatus({ ...day, firstAt: at(9, 30) })).toBe("complete");
    expect(depthStatus({ ...day, firstAt: at(9, 31) })).toBe("partial");
    expect(depthStatus({ ...day, lastAt: at(15, 14) })).toBe("partial");
    expect(depthStatus({ ...day, framesCapped: 400, capReached: false })).toBe("partial");
  });

  it("is none with no frames", () => {
    expect(depthStatus({ framesCapped: 0, capReached: false, firstAt: null, lastAt: null })).toBe("none");
  });
});

describe("typicalSnapshotMinutes", () => {
  it("is the median of the days that have any snapshots, ignoring empty days", () => {
    expect(typicalSnapshotMinutes([27, 27, 21, 0, 9, 0])).toBe(24);   // 9, 21, 27, 27
    expect(typicalSnapshotMinutes([5, 7, 9])).toBe(7);
    expect(typicalSnapshotMinutes([0, 0])).toBeNull();
    expect(typicalSnapshotMinutes([])).toBeNull();
  });
});

describe("classifyDay", () => {
  type Status = "complete" | "partial" | "none";
  const base = (futures: Status, snapshots: Status, depth: Status): Omit<CoverageDay, "probableHoliday" | "gapInSource"> => ({
    date: "2026-10-22",
    inProgress: false,
    futures: { symbol: "X", bars: 0, barsWithVolume: 0, firstAt: null, lastAt: null, status: futures },
    snapshots: { inSessionMinutes: 0, preOpenMinutes: 0, postCloseMinutes: 0, firstAt: null, lastAt: null, typicalMinutes: null, status: snapshots },
    depth: { symbol: null, framesCapped: 0, capReached: false, firstAt: null, lastAt: null, status: depth },
  });

  it("calls a day with nothing anywhere a probable holiday, not a gap", () => {
    expect(classifyDay(base("none", "none", "none"))).toMatchObject({ probableHoliday: true, gapInSource: false });
  });

  it("still calls it a holiday when the collectors wrote stray rows but the exchange bars are absent (2026-10-20)", () => {
    expect(classifyDay(base("none", "partial", "partial"))).toMatchObject({ probableHoliday: true, gapInSource: false });
    expect(classifyDay(base("none", "partial", "none"))).toMatchObject({ probableHoliday: true, gapInSource: false });
  });

  it("calls missing futures bars a real gap when a collector source has a whole day, since stray holiday rows are never a whole day", () => {
    expect(classifyDay(base("none", "complete", "complete"))).toMatchObject({ probableHoliday: false, gapInSource: true });
    expect(classifyDay(base("none", "complete", "partial"))).toMatchObject({ probableHoliday: false, gapInSource: true });
    expect(classifyDay(base("none", "partial", "complete"))).toMatchObject({ probableHoliday: false, gapInSource: true });
  });

  it("calls a source with nothing a gap on a day with futures bars, and a partial source is not a missing one", () => {
    expect(classifyDay(base("complete", "none", "complete"))).toMatchObject({ probableHoliday: false, gapInSource: true });
    expect(classifyDay(base("partial", "none", "none"))).toMatchObject({ probableHoliday: false, gapInSource: true });
    expect(classifyDay(base("partial", "partial", "partial"))).toMatchObject({ probableHoliday: false, gapInSource: false });
    expect(classifyDay(base("complete", "complete", "complete"))).toMatchObject({ probableHoliday: false, gapInSource: false });
  });
});

describe("sourcesNotCollected", () => {
  type Status = "complete" | "partial" | "none";
  const day = (futures: Status, snapshots: Status, depth: Status) => ({
    futures: { symbol: "X", bars: 0, barsWithVolume: 0, firstAt: null, lastAt: null, status: futures },
    snapshots: { inSessionMinutes: 0, preOpenMinutes: 0, postCloseMinutes: 0, firstAt: null, lastAt: null, typicalMinutes: null, status: snapshots },
    depth: { symbol: null, framesCapped: 0, capReached: false, firstAt: null, lastAt: null, status: depth },
  });

  it("names a source that has nothing on any day of the window", () => {
    expect(sourcesNotCollected([day("complete", "complete", "none"), day("complete", "partial", "none")])).toEqual(["depth"]);
  });

  it("does not name a source that has anything at all, even one thin day", () => {
    expect(sourcesNotCollected([day("complete", "complete", "none"), day("complete", "complete", "partial")])).toEqual([]);
  });

  it("names nothing for an empty window", () => {
    expect(sourcesNotCollected([])).toEqual([]);
  });

  it("keeps a source that was not collected out of the gap logic, so it is not a gap on every day", () => {
    const traded = { date: "2026-10-22", inProgress: false, ...day("complete", "complete", "none") };
    expect(classifyDay(traded)).toMatchObject({ gapInSource: true });                    // with no window knowledge, depth is missing
    expect(classifyDay(traded, ["depth"])).toMatchObject({ gapInSource: false, probableHoliday: false });
    // The other sources still count: a missing snapshot day is a gap even when depth is not collected.
    const noSnapshots = { date: "2026-10-21", inProgress: false, ...day("complete", "none", "none") };
    expect(classifyDay(noSnapshots, ["depth"])).toMatchObject({ gapInSource: true });
  });
});
