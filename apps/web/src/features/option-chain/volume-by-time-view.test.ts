import { describe, expect, it } from "vitest";
import {
  bucketAtFraction,
  buildTimeChart,
  dayVolumeSentence,
  describeBucket,
  formatAxisUnits,
  niceAxis,
  niceStep,
  volumeByTimeNotes,
  volumeByTimeQuery,
  type VolumeBucketView,
  type VolumeByTimeAvailable,
} from "./volume-by-time-view";

/** Synthetic payloads, hand-built for the rules below (not recorded from the API). Three 125-minute buckets cover the session. */
function bucket(index: number, overrides: Partial<VolumeBucketView> = {}): VolumeBucketView {
  const startMinute = 555 + index * 125;
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  return {
    from: clock(startMinute), to: clock(startMinute + 125), startMinute, endMinute: startMinute + 125,
    volume: 100, barsPresent: 125, expectedBars: 125, complete: true,
    baselineMedian: 100, baselineMean: 100, baselineSessions: 9, relative: 1,
    cumulative: 100 * (index + 1), baselineCumulativeMedian: 100 * (index + 1), baselineCumulativeSessions: 9, cumulativeRelative: 1,
    ...overrides,
  };
}

function payload(overrides: Partial<VolumeByTimeAvailable> = {}): VolumeByTimeAvailable {
  return {
    available: true,
    underlying: "BANKNIFTY",
    contract: { symbol: "BANKNIFTY26NOVFUT", providerSymbol: "NSE:BANKNIFTY26NOVFUT", expiryDate: "2026-11-24", lotSize: 30, daysToExpiry: 20 },
    sessionDate: "2026-10-28",
    inProgress: false,
    bucketMinutes: 125,
    bucketMinuteChoices: [5, 15, 30],
    baselineDayChoices: [5, 10, 20],
    observed: true,
    volumeUnit: "units",
    baseline: { requestedSessions: 10, sessions: 10, dates: [], stoppedAtRoll: false, perSession: [] },
    buckets: [bucket(0), bucket(1), bucket(2)],
    day: { total: 300, volumeSoFar: 300, complete: true, baselineMedianTotal: 300, baselineSessionsWithTotal: 9, relative: 1 },
    availableSessions: [],
    definitions: {},
    source: "candles",
    ...overrides,
  };
}

describe("volumeByTimeQuery", () => {
  it("sends only what was chosen", () => {
    expect(volumeByTimeQuery({ underlying: "BANKNIFTY", sessionDate: "", bucketMinutes: null, baselineDays: null })).toBe("underlying=BANKNIFTY");
    expect(volumeByTimeQuery({ underlying: "NIFTY50", sessionDate: "2026-10-22", bucketMinutes: 5, baselineDays: 20 })).toBe("underlying=NIFTY50&date=2026-10-22&bucket=5&days=20");
  });
});

describe("axes", () => {
  it("steps in 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(100)).toBe(50);
    expect(niceStep(40)).toBe(10);
    expect(niceStep(1_000_000)).toBe(500_000);
    expect(niceStep(0)).toBe(1);
  });

  it("runs the axis to the next step at or above the largest value, with a tick at each step from zero", () => {
    expect(niceAxis(100)).toEqual({ top: 100, ticks: [0, 50, 100] });
    expect(niceAxis(101)).toEqual({ top: 150, ticks: [0, 50, 100, 150] });
    expect(niceAxis(1_000_000)).toEqual({ top: 1_000_000, ticks: [0, 500_000, 1_000_000] });
  });

  it("labels thousands and millions briefly", () => {
    expect(formatAxisUnits(0)).toBe("0");
    expect(formatAxisUnits(950)).toBe("950");
    expect(formatAxisUnits(12_500)).toBe("12.5k");
    expect(formatAxisUnits(1_250_000)).toBe("1.25M");
  });
});

describe("buildTimeChart", () => {
  it("scales bars and baseline marks to one volume axis, and the cumulative lines to another", () => {
    const geometry = buildTimeChart(payload({
      buckets: [
        bucket(0, { volume: 100, baselineMedian: 80, cumulative: 100, baselineCumulativeMedian: 80 }),
        bucket(1, { volume: 50, baselineMedian: 100, cumulative: 150, baselineCumulativeMedian: 180 }),
        bucket(2, { volume: 100, baselineMedian: 100, cumulative: 250, baselineCumulativeMedian: 280 }),
      ],
    }));
    expect(geometry.volumeAxis).toEqual({ top: 100, ticks: [0, 50, 100] });
    expect(geometry.buckets.map((b) => b.height)).toEqual([1, 0.5, 1]);
    expect(geometry.buckets.map((b) => b.baselineHeight)).toEqual([0.8, 1, 1]);
    // Cumulative maximum 280: step 100, top 300.
    expect(geometry.cumulativeAxis.top).toBe(300);
    expect(geometry.cumulativeToday).toEqual([[{ x: 0, y: 0 }, { x: 125 / 375, y: 100 / 300 }, { x: 250 / 375, y: 150 / 300 }, { x: 1, y: 250 / 300 }]]);
    expect(geometry.cumulativeBaseline[0]![3]).toEqual({ x: 1, y: 280 / 300 });
  });

  it("places buckets on the session clock", () => {
    const [first, , last] = buildTimeChart(payload()).buckets;
    expect([first!.x0, first!.x1]).toEqual([0, 125 / 375]);
    expect([last!.x0, last!.x1]).toEqual([250 / 375, 1]);
  });

  it("draws an unknown bucket as nothing and cuts the cumulative line there, rather than carrying on", () => {
    const geometry = buildTimeChart(payload({
      buckets: [bucket(0), bucket(1, { volume: null, complete: false, barsPresent: 0, relative: null, cumulative: null, cumulativeRelative: null }), bucket(2, { cumulative: null, cumulativeRelative: null })],
    }));
    expect(geometry.buckets[1]).toMatchObject({ height: 0, known: false });
    expect(geometry.cumulativeToday).toHaveLength(1);
    expect(geometry.cumulativeToday[0]).toHaveLength(2);         // the origin and the first bucket
    // The baseline for the same buckets is still drawn.
    expect(geometry.cumulativeBaseline[0]).toHaveLength(4);
  });

  it("splits a line into separate runs where a value in the middle is unknown", () => {
    const geometry = buildTimeChart(payload({
      buckets: [bucket(0), bucket(1, { baselineCumulativeMedian: null }), bucket(2)],
    }));
    expect(geometry.cumulativeBaseline.map((run) => run.length)).toEqual([2, 1]);
  });

  it("keeps a bucket with no baseline without a baseline mark", () => {
    const geometry = buildTimeChart(payload({ buckets: [bucket(0, { baselineMedian: null, relative: null }), bucket(1), bucket(2)] }));
    expect(geometry.buckets[0]!.baselineHeight).toBeNull();
  });
});

describe("bucketAtFraction", () => {
  const buckets = buildTimeChart(payload()).buckets;
  it("finds the bucket under a horizontal position, and none outside the session", () => {
    expect(bucketAtFraction(buckets, 0)!.index).toBe(0);
    expect(bucketAtFraction(buckets, 0.5)!.index).toBe(1);
    expect(bucketAtFraction(buckets, 0.999)!.index).toBe(2);
    expect(bucketAtFraction(buckets, 1)).toBeNull();
    expect(bucketAtFraction(buckets, -0.01)).toBeNull();
  });
});

describe("describeBucket", () => {
  it("gives the volume, the ratio, the sessions it stands on, and the cumulative comparison", () => {
    expect(describeBucket(bucket(0, { volume: 12_345, baselineMedian: 6_800, relative: 12_345 / 6_800, baselineSessions: 9, cumulative: 140_000, baselineCumulativeMedian: 95_000, cumulativeRelative: 140_000 / 95_000 })))
      .toBe("09:15–11:20: 12,345 units; 1.82× the usual (median 6,800 over 9 sessions); since the open 1,40,000 vs 95,000 (1.47×, 9 sessions).");
  });

  it("says a bucket with missing minutes is a lower bound and has no ratio", () => {
    const text = describeBucket(bucket(0, { volume: 5_000, barsPresent: 100, complete: false, relative: null, cumulative: null, cumulativeRelative: null }));
    expect(text).toContain("at least 5,000 units (100 of 125 minutes stored, so a lower bound)");
    expect(text).toContain("no ratio for a bucket that is not complete");
    expect(text).not.toContain("since the open");
  });

  it("says unknown, not zero, for a bucket with no bar at all", () => {
    expect(describeBucket(bucket(1, { volume: null, barsPresent: 0, complete: false })))
      .toBe("11:20–13:25: no stored bar for any minute of it (unknown, not zero).");
  });

  it("says when there is nothing to compare with, and uses the singular for one session", () => {
    expect(describeBucket(bucket(0, { baselineMedian: null, relative: null, baselineSessions: 0, baselineCumulativeMedian: null, cumulativeRelative: null })))
      .toContain("no earlier session to compare with");
    expect(describeBucket(bucket(0, { baselineSessions: 1, relative: 2, volume: 200 }))).toContain("over 1 session)");
  });

  it("prints a ratio of ten or more without decimals", () => {
    expect(describeBucket(bucket(0, { volume: 1_200, baselineMedian: 100, relative: 12 }))).toContain("12× the usual");
  });
});

describe("volumeByTimeNotes", () => {
  it("is silent for a complete day against a full baseline, far from expiry", () => {
    expect(volumeByTimeNotes(payload())).toEqual([]);
  });

  it("says there is nothing to compare with when no earlier session is stored", () => {
    const [note] = volumeByTimeNotes(payload({ baseline: { requestedSessions: 10, sessions: 0, dates: [], stoppedAtRoll: false, perSession: [] } }));
    expect(note!.tone).toBe("warn");
    expect(note!.text).toContain("No earlier session of this contract is stored");
  });

  it("says a short baseline is short, and whether a roll ended it", () => {
    const base = { requestedSessions: 10, sessions: 4, dates: [], perSession: [] };
    expect(volumeByTimeNotes(payload({ baseline: { ...base, stoppedAtRoll: true } }))[0]!.text).toBe("The baseline has 4 of the 10 sessions asked for: the next older stored session is another contract, and a roll is not crossed.");
    expect(volumeByTimeNotes(payload({ baseline: { ...base, stoppedAtRoll: false } }))[0]!.text).toContain("that is all that is stored for this contract");
  });

  it("separates buckets with no bar (blank) from buckets missing minutes (outlined)", () => {
    const notes = volumeByTimeNotes(payload({
      buckets: [bucket(0), bucket(1, { volume: null, complete: false, barsPresent: 0 }), bucket(2, { complete: false, barsPresent: 100 })],
    })).map((note) => note.text);
    expect(notes).toEqual([
      "1 bucket has no stored bar at all, and is left blank, not drawn as zero. Cumulative volume stops at the first gap.",
      "1 bucket is missing minutes (outlined): its volume is a lower bound, and it has no ratio.",
    ]);
  });

  it("calls the empty buckets of a session in progress what they are", () => {
    const [note] = volumeByTimeNotes(payload({ inProgress: true, buckets: [bucket(0), bucket(1, { volume: null, complete: false, barsPresent: 0 }), bucket(2, { volume: null, complete: false, barsPresent: 0 })] }));
    expect(note!.text).toBe("Session in progress: buckets that have not happened yet are blank and are refetched every minute.");
  });

  it("cautions about migration in the last week before expiry, and not before", () => {
    const near = volumeByTimeNotes(payload({ contract: { ...payload().contract, daysToExpiry: 5 } }));
    expect(near[0]!.text).toContain("expires in 5 days");
    expect(near[0]!.text).toContain("migration");
    expect(volumeByTimeNotes(payload({ contract: { ...payload().contract, daysToExpiry: 1 } }))[0]!.text).toContain("expires in 1 day.");
    expect(volumeByTimeNotes(payload({ contract: { ...payload().contract, daysToExpiry: 8 } }))).toEqual([]);
  });
});

describe("dayVolumeSentence", () => {
  it("compares a complete day with the usual day, naming the sessions behind the median", () => {
    expect(dayVolumeSentence(payload({ day: { total: 600, volumeSoFar: 600, complete: true, baselineMedianTotal: 400, baselineSessionsWithTotal: 8, relative: 1.5 } })))
      .toBe("Whole day 600 units, 1.50× the usual day of 400 units (median of 8 complete sessions of the 10 compared).");
  });

  it("calls the figure for an unfinished day a lower bound", () => {
    expect(dayVolumeSentence(payload({ day: { total: null, volumeSoFar: 250, complete: false, baselineMedianTotal: 400, baselineSessionsWithTotal: 1, relative: null } })))
      .toBe("So far 250 units (a lower bound: the day is not complete). The usual whole day is 400 units (median of 1 complete session of the 10 compared).");
  });

  it("is null without a baseline total", () => {
    expect(dayVolumeSentence(payload({ day: { total: 300, volumeSoFar: 300, complete: true, baselineMedianTotal: null, baselineSessionsWithTotal: 0, relative: null } }))).toBeNull();
  });
});
