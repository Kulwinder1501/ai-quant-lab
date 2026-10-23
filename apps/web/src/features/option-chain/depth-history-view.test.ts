import { describe, expect, it } from "vitest";
import {
  buildDepthHistoryChart,
  dataAgeSeconds,
  depthHistoryQuery,
  formatIstClock,
  historyNotes,
  isIsolatedPoint,
  sessionOptionLabel,
  type DepthHistoryAvailable,
  type DepthHistoryBucket,
} from "./depth-history-view";

/** Synthetic payloads, hand-built for the rules below (not recorded from the API). 2026-10-22 04:30Z = 10:00 IST. */
const T0 = Date.parse("2026-10-22T04:30:00.000Z");
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function bucket(startSeconds: number, overrides: Partial<DepthHistoryBucket> = {}): DepthHistoryBucket {
  return {
    t: iso(startSeconds),
    frames: 120,
    levelFrames: 120,
    spreadMedianPoints: 20,
    spreadMaxPoints: 30,
    midMedian: 54_900,
    imbalanceL1: 0.1,
    imbalanceL5: -0.2,
    wholeBookFrames: 120,
    imbalanceWholeBook: 0.05,
    ...overrides,
  };
}

function payload(overrides: Partial<DepthHistoryAvailable> = {}): DepthHistoryAvailable {
  return {
    available: true,
    underlying: "BANKNIFTY",
    contract: { providerSymbol: "NSE:BANKNIFTY26OCTFUT", expiryDate: "2026-10-27" },
    sessionDate: "2026-10-22",
    sessionTimezone: "Asia/Kolkata",
    window: { from: "2026-10-22T03:30:00.000Z", to: "2026-10-22T10:00:00.000Z" },
    inProgress: false,
    bucketSeconds: 60,
    buckets: [bucket(0), bucket(60), bucket(120)],
    gaps: [],
    captureSessions: [{ captureSessionId: "a", frames: 360, firstAt: iso(0), lastAt: iso(180) }],
    concurrentWriters: [],
    counts: {
      framesRead: 360, framesInSession: 360, framesOutsideSession: 0,
      framesWithoutLevelMetrics: 0, framesWithoutWholeBook: 0, framesFlaggedDuplicate: 0,
    },
    availableSessions: [],
    definitions: {},
    source: "depth_frames",
    ...overrides,
  };
}

describe("depthHistoryQuery", () => {
  it("omits an empty session so the server picks the latest, and always sends the bucket size", () => {
    expect(depthHistoryQuery({ underlying: "BANKNIFTY", sessionDate: "", bucketSeconds: 60 }))
      .toBe("underlying=BANKNIFTY&bucketSeconds=60");
    expect(depthHistoryQuery({ underlying: "NIFTY50", sessionDate: "2026-10-22", bucketSeconds: 300 }))
      .toBe("underlying=NIFTY50&bucketSeconds=300&date=2026-10-22");
  });
});

describe("buildDepthHistoryChart: rows", () => {
  it("plots each bucket in the middle of the interval it summarises", () => {
    const { rows } = buildDepthHistoryChart(payload());
    expect(rows.map((r) => r.t)).toEqual([T0 + 30_000, T0 + 90_000, T0 + 150_000]);
    expect(rows[0]).toMatchObject({ bucketStart: T0, bucketSeconds: 60, isGapBreak: false, spreadMedian: 20, spreadMax: 30, mid: 54_900 });
  });

  it("cuts the line inside a hole with a null row, and shades it", () => {
    const model = buildDepthHistoryChart(payload({
      buckets: [bucket(0), bucket(60), bucket(600)],
      gaps: [{ from: iso(119), to: iso(600), seconds: 481 }],
    }));
    expect(model.gapAreas).toEqual([{ x1: T0 + 119_000, x2: T0 + 600_000, seconds: 481 }]);
    const breakRows = model.rows.filter((r) => r.isGapBreak);
    expect(breakRows).toHaveLength(1);
    expect(breakRows[0]).toMatchObject({
      imbalanceL1: null, imbalanceL5: null, imbalanceWholeBook: null, spreadMedian: null, spreadMax: null, mid: null, gapSeconds: 481,
    });
    // The break sits between the bucket before the hole and the one after it.
    const order = model.rows.map((r) => (r.isGapBreak ? "break" : "bucket"));
    expect(order).toEqual(["bucket", "bucket", "break", "bucket"]);
  });

  it("ignores a gap that is not a forward span instead of drawing nonsense", () => {
    const model = buildDepthHistoryChart(payload({
      gaps: [{ from: iso(100), to: iso(100), seconds: 0 }, { from: "not a date", to: iso(10), seconds: 5 }],
    }));
    expect(model.gapAreas).toEqual([]);
    expect(model.rows.every((r) => !r.isGapBreak)).toBe(true);
  });

  it("keeps a bucket with no usable frame as null values, never zero", () => {
    const model = buildDepthHistoryChart(payload({
      buckets: [bucket(0), bucket(60, {
        levelFrames: 0, spreadMedianPoints: null, spreadMaxPoints: null, midMedian: null, imbalanceL1: null, imbalanceL5: null,
      })],
    }));
    expect(model.rows[1]).toMatchObject({ spreadMedian: null, spreadMax: null, mid: null, imbalanceL1: null, imbalanceL5: null });
    // Its whole-book value is still there: the two are independent.
    expect(model.rows[1]!.imbalanceWholeBook).toBe(0.05);
  });

  it("reports the widest spread as the top of the spread axis", () => {
    const model = buildDepthHistoryChart(payload({ buckets: [bucket(0, { spreadMaxPoints: 12 }), bucket(60, { spreadMaxPoints: 77.4 })] }));
    expect(model.spreadMax).toBe(77.4);
  });
});

describe("buildDepthHistoryChart: why a chart is empty", () => {
  it("has no reason when everything is plotted", () => {
    expect(buildDepthHistoryChart(payload()).emptyReason).toEqual({ imbalance: null, wholeBook: null, spread: null, mid: null });
  });

  it("says no frame was stored when there are no buckets, for every chart", () => {
    const { emptyReason } = buildDepthHistoryChart(payload({ buckets: [] }));
    for (const reason of Object.values(emptyReason)) expect(reason).toContain("No frame was stored");
  });

  it("explains the old capture regime for the level charts and keeps the whole-book chart available", () => {
    const old = [bucket(0, {
      levelFrames: 0, spreadMedianPoints: null, spreadMaxPoints: null, midMedian: null, imbalanceL1: null, imbalanceL5: null,
    })];
    const { emptyReason } = buildDepthHistoryChart(payload({ buckets: old }));
    expect(emptyReason.imbalance).toContain("2026-09-07");
    expect(emptyReason.spread).toContain("2026-09-07");
    expect(emptyReason.wholeBook).toBeNull();
  });

  it("explains a session with no usable whole-book total, while the level charts stand", () => {
    const { emptyReason } = buildDepthHistoryChart(payload({
      buckets: [bucket(0, { wholeBookFrames: 0, imbalanceWholeBook: null })],
    }));
    expect(emptyReason.wholeBook).toContain("2026-09-17");
    expect(emptyReason.imbalance).toBeNull();
  });
});

describe("isIsolatedPoint", () => {
  const rowsOf = (values: Array<number | null>) =>
    buildDepthHistoryChart(payload({
      buckets: values.map((value, i) => bucket(i * 60, { imbalanceL5: value })),
    })).rows;
  const pick = (row: { imbalanceL5: number | null }) => row.imbalanceL5;

  it("is true for a value whose neighbours are both missing, so it can be drawn as a dot", () => {
    const rows = rowsOf([null, 0.2, null]);
    expect(isIsolatedPoint(rows, 1, pick)).toBe(true);
  });

  it("is true for a lone first or last point", () => {
    expect(isIsolatedPoint(rowsOf([0.2, null, 0.1]), 0, pick)).toBe(true);
    expect(isIsolatedPoint(rowsOf([0.2, null, 0.1]), 2, pick)).toBe(true);
    expect(isIsolatedPoint(rowsOf([0.2]), 0, pick)).toBe(true);
  });

  it("is false for a point a line reaches, on either side", () => {
    const rows = rowsOf([0.1, 0.2, null, 0.3]);
    expect(isIsolatedPoint(rows, 0, pick)).toBe(false);
    expect(isIsolatedPoint(rows, 1, pick)).toBe(false);
    expect(isIsolatedPoint(rows, 3, pick)).toBe(true);
  });

  it("is false for a missing value and for an index outside the rows", () => {
    const rows = rowsOf([null, null]);
    expect(isIsolatedPoint(rows, 0, pick)).toBe(false);
    expect(isIsolatedPoint(rows, 9, pick)).toBe(false);
  });

  it("treats the break row inside a hole as a missing neighbour, so a point beside a hole is isolated", () => {
    const model = buildDepthHistoryChart(payload({
      buckets: [bucket(0), bucket(600)],
      gaps: [{ from: iso(60), to: iso(600), seconds: 540 }],
    }));
    expect(model.rows.map((r) => r.isGapBreak)).toEqual([false, true, false]);
    expect(isIsolatedPoint(model.rows, 0, (r) => r.spreadMedian)).toBe(true);
    expect(isIsolatedPoint(model.rows, 2, (r) => r.spreadMedian)).toBe(true);
  });
});

describe("historyNotes", () => {
  it("is silent for a clean session", () => {
    expect(historyNotes(payload())).toEqual([]);
  });

  it("counts the frames left out, with a share, and says what they were left out of", () => {
    const notes = historyNotes(payload({
      counts: {
        framesRead: 1000, framesInSession: 1000, framesOutsideSession: 0,
        framesWithoutLevelMetrics: 25, framesWithoutWholeBook: 13, framesFlaggedDuplicate: 0,
      },
    }));
    expect(notes).toHaveLength(2);
    expect(notes[0]!.text).toContain("25 of 1,000 frames (2.5%)");
    expect(notes[0]!.text).toContain("left out of the spread, mid and level imbalances");
    expect(notes[1]!.text).toContain("13 frames (1.3%)");
    expect(notes[1]!.text).toContain("feed dropout");
  });

  it("puts a doubled stream first, as a warning with the span in IST", () => {
    const notes = historyNotes(payload({
      concurrentWriters: [{ a: "a", b: "b", overlapFrom: iso(0), overlapTo: iso(50), overlapSeconds: 50 }],
      counts: {
        framesRead: 10, framesInSession: 10, framesOutsideSession: 2,
        framesWithoutLevelMetrics: 0, framesWithoutWholeBook: 0, framesFlaggedDuplicate: 3,
      },
    }));
    expect(notes[0]).toMatchObject({ tone: "warn" });
    expect(notes[0]!.text).toContain("for 50 s");
    expect(notes[0]!.text).toContain("10:00:00–10:00:50 IST");
    expect(notes.slice(1).map((n) => n.tone)).toEqual(["info", "info"]);
    expect(notes[2]!.text).toContain("cannot be used to filter");
  });
});

describe("small formatting helpers", () => {
  it("writes an instant as HH:MM:SS on the IST clock", () => {
    expect(formatIstClock(Date.parse("2026-10-22T04:30:07.000Z"))).toBe("10:00:07");
    expect(formatIstClock(Number.NaN)).toBe("—");
  });

  it("labels a session with its IST span and warns when it is sparse", () => {
    const full = { sessionDate: "2026-10-22", providerSymbol: "x", firstAt: "2026-10-22T03:39:00.000Z", lastAt: "2026-10-22T09:59:59.000Z", framesCapped: 1000, sparse: false };
    expect(sessionOptionLabel(full)).toBe("2026-10-22 · 09:09–15:29 IST");
    expect(sessionOptionLabel({ ...full, framesCapped: 4, sparse: true })).toBe("2026-10-22 · 09:09–15:29 IST · sparse (under 1,000 frames)");
  });

  it("measures the age of the data on screen, never negative", () => {
    expect(dataAgeSeconds(10_000, 70_000)).toBe(60);
    expect(dataAgeSeconds(10_000, 5_000)).toBe(0);
  });
});
