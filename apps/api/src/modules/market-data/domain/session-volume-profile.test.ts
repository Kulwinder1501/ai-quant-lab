import { describe, expect, it } from "vitest";
import {
  aggregateBars,
  assessBarQuality,
  buildSessionProfile,
  EXPECTED_SESSION_MINUTES,
  formatClockMinute,
  FULL_SESSION_RANGE,
  isFullSession,
  parseClockMinute,
  profileSensitivity,
  rangeProblem,
  selectBarsInRange,
  selectRegularSessionBars,
  summariseSession,
  VALUE_AREA_FRACTION,
  type FuturesBar,
} from "./session-volume-profile.js";

/** 2026-10-22; 09:15 IST = 03:45Z. Bars here are synthetic, hand-built for the arithmetic (not recorded). */
const OPEN = Date.parse("2026-10-22T03:45:00.000Z");
const at = (minute: number) => new Date(OPEN + minute * 60_000);

function bar(minute: number, low: number, high: number, volume: number, close = high): FuturesBar {
  return { openTime: at(minute), open: low, high, low, close, volume };
}
/** A bar with no range: everything traded at one price. */
const point = (minute: number, price: number, volume: number) => bar(minute, price, price, volume, price);

const volumeByLow = (rows: ReadonlyArray<{ low: number; volume: number }>) => Object.fromEntries(rows.map((r) => [r.low, r.volume]));

describe("buildSessionProfile: where a bar's volume goes", () => {
  it("spreads a bar's volume across the rows it spans in proportion to the range in each", () => {
    // 105-125 is 20 points: 5 in [100,110), 10 in [110,120), 5 in [120,130).
    const profile = buildSessionProfile([bar(0, 105, 125, 200)], 10)!;
    expect(volumeByLow(profile.rows)).toMatchObject({ 100: 50, 110: 100, 120: 50 });
  });

  it("spreads a bar that exactly fills rows evenly, and leaves no volume in the row above its high", () => {
    const profile = buildSessionProfile([bar(0, 100, 130, 300)], 10)!;
    expect(volumeByLow(profile.rows)).toMatchObject({ 100: 100, 110: 100, 120: 100 });
    expect(profile.rows.filter((r) => r.volume > 0).map((r) => r.low)).toEqual([100, 110, 120]);
  });

  it("puts a bar with no range wholly in the row holding its price, whatever the row height", () => {
    const profile = buildSessionProfile([point(0, 117, 90)], 10)!;
    expect(profile.rows.filter((r) => r.volume > 0)).toMatchObject([{ low: 110, high: 120, volume: 90 }]);
    // A price exactly on a row edge belongs to the row it starts.
    expect(volumeByLow(buildSessionProfile([point(0, 120, 40)], 10)!.rows)[120]).toBe(40);
  });

  it("conserves the session's volume across the rows", () => {
    const bars = [bar(0, 100.2, 133.7, 12_345), point(1, 118.4, 600), bar(2, 90.05, 101.1, 777), bar(3, 120, 120.2, 31)];
    const profile = buildSessionProfile(bars, 10)!;
    const total = bars.reduce((sum, b) => sum + b.volume, 0);
    expect(profile.totalVolume).toBe(total);
    // Each row is rounded to two decimals for the wire, so allow half a hundredth per row.
    expect(Math.abs(profile.rows.reduce((sum, r) => sum + r.volume, 0) - total)).toBeLessThan(0.005 * profile.rows.length);
  });

  it("ignores bars that traded nothing, and returns null when nothing traded at all", () => {
    expect(buildSessionProfile([point(0, 100, 0), point(1, 105, 0)], 10)).toBeNull();
    expect(buildSessionProfile([], 10)).toBeNull();
    const profile = buildSessionProfile([point(0, 100, 0), point(1, 205, 50)], 10)!;
    expect(profile.rows[0]!.low).toBe(200); // the zero-volume bar at 100 does not stretch the profile
  });

  it("refuses a row height that is not positive", () => {
    expect(() => buildSessionProfile([point(0, 100, 10)], 0)).toThrow();
    expect(() => buildSessionProfile([point(0, 100, 10)], -5)).toThrow();
  });
});

describe("buildSessionProfile: point of control", () => {
  it("is the midpoint of the row with the most volume", () => {
    const profile = buildSessionProfile([point(0, 105, 10), point(1, 125, 60), point(2, 135, 30)], 10)!;
    expect(profile.poc).toBe(125);
    expect(profile.rows.filter((r) => r.isPoc).map((r) => r.low)).toEqual([120]);
  });

  it("breaks a tie toward the row nearest the session VWAP", () => {
    // Rows [100,110) and [130,140) both hold 100; the 50 at 125 pulls the VWAP to 121, nearer the 130-140 row (135).
    const profile = buildSessionProfile([point(0, 105, 100), point(1, 135, 100), point(2, 125, 50)], 10)!;
    expect(profile.vwap).toBe(121);
    expect(profile.poc).toBe(135);
  });
});

describe("buildSessionProfile: value area", () => {
  /** Volumes by row from 100: 10, 20, 60, 50, 15, 5. */
  const sixRows = [point(0, 105, 10), point(1, 115, 20), point(2, 125, 60), point(3, 135, 50), point(4, 145, 15), point(5, 155, 5)];

  it("grows from the POC by the heavier pair of neighbours until 70% of the volume is inside", () => {
    const profile = buildSessionProfile(sixRows, 10)!;
    // Total 160, target 112. POC 60 (row 120). Above: 50 + 15 = 65; below: 20 + 10 = 30 -> take the two above: 125.
    expect(profile.poc).toBe(125);
    expect(profile.val).toBe(120);
    expect(profile.vah).toBe(150);
    expect(profile.valueAreaShare).toBeCloseTo(125 / 160, 10);
    expect(profile.valueAreaShare).toBeGreaterThanOrEqual(VALUE_AREA_FRACTION);
    expect(profile.rows.filter((r) => r.inValueArea).map((r) => r.low)).toEqual([120, 130, 140]);
  });

  it("goes up on a tie", () => {
    // 10, 30, 60, 30, 10: both pairs hold 40; going up gives 100 of 140 (target 98).
    const profile = buildSessionProfile([point(0, 105, 10), point(1, 115, 30), point(2, 125, 60), point(3, 135, 30), point(4, 145, 10)], 10)!;
    expect(profile.val).toBe(120);
    expect(profile.vah).toBe(150);
  });

  it("goes the other way when the book of rows above is exhausted", () => {
    // The POC is the top row: only the pair below can be added.
    const profile = buildSessionProfile([point(0, 105, 10), point(1, 115, 20), point(2, 125, 30), point(3, 135, 100)], 10)!;
    expect(profile.poc).toBe(135);
    expect(profile.vah).toBe(140);
    expect(profile.val).toBe(110); // total 160, target 112: 100 + 30 + 20 = 150 (rows 110-130 added as a pair)
  });

  it("covers the whole profile when 70% is only reached by taking everything", () => {
    const profile = buildSessionProfile([point(0, 105, 50), point(1, 125, 50)], 10)!;
    expect(profile.val).toBe(100);
    expect(profile.vah).toBe(130);
    expect(profile.valueAreaShare).toBe(1);
  });
});

describe("buildSessionProfile: VWAP", () => {
  it("weights each bar's typical price (high + low + close) / 3 by its volume", () => {
    const profile = buildSessionProfile([
      { openTime: at(0), open: 100, high: 112, low: 100, close: 104, volume: 100 },   // typical 105.33
      { openTime: at(1), open: 120, high: 126, low: 120, close: 123, volume: 300 },   // typical 123
    ], 10)!;
    expect(profile.vwap).toBeCloseTo((105.3333333 * 100 + 123 * 300) / 400, 1);
  });
});

describe("selectRegularSessionBars and assessBarQuality", () => {
  it("keeps 09:15 up to 15:29 IST, drops the minute before the open and the post-close minutes, and sorts", () => {
    const ist = (hh: number, mm: number) => new Date(Date.parse(`2026-10-22T00:00:00.000Z`) + ((hh * 60 + mm) - 330) * 60_000);
    const mk = (time: Date) => ({ openTime: time, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const { regular, excluded } = selectRegularSessionBars([
      mk(ist(15, 29)), mk(ist(9, 14)), mk(ist(9, 15)), mk(ist(15, 30)), mk(ist(15, 39)),
    ]);
    expect(regular.map((b) => b.openTime.toISOString())).toEqual([ist(9, 15).toISOString(), ist(15, 29).toISOString()]);
    expect(excluded).toBe(3);
  });

  it("calls a full day of bars complete, with nothing missing", () => {
    const bars = Array.from({ length: EXPECTED_SESSION_MINUTES }, (_, i) => point(i, 100, i % 50 === 0 ? 0 : 10));
    const quality = assessBarQuality(bars, 10);
    expect(quality).toMatchObject({ barsUsed: 375, missingMinutes: 0, complete: true, outsideSessionBarsExcluded: 10, zeroVolumeBars: 8, barsWithVolume: 367 });
  });

  it("calls a partial day partial and counts the minutes that are missing, not the zero-volume ones", () => {
    const bars = Array.from({ length: 329 }, (_, i) => point(i, 100, 10));
    const quality = assessBarQuality(bars, 0);
    expect(quality).toMatchObject({ barsUsed: 329, missingMinutes: 46, complete: false, zeroVolumeBars: 0 });
  });

  it("counts a repeated minute once, so a duplicated row cannot hide a hole", () => {
    const quality = assessBarQuality([point(0, 100, 1), point(0, 100, 1), point(1, 100, 1)], 0);
    expect(quality.missingMinutes).toBe(373);
  });

  it("summarises the session: first open, extremes, last close, and when it started and ended", () => {
    const summary = summariseSession([
      { openTime: at(0), open: 100, high: 110, low: 99, close: 105, volume: 1 },
      { openTime: at(1), open: 105, high: 130, low: 104, close: 120, volume: 1 },
    ])!;
    expect(summary).toMatchObject({ open: 100, high: 130, low: 99, close: 120, firstBarAt: at(0).toISOString(), lastBarAt: at(1).toISOString() });
    expect(summariseSession([])).toBeNull();
  });
});

describe("aggregateBars", () => {
  it("rolls minutes up to epoch-aligned buckets with first open, extremes, last close and summed volume", () => {
    // 03:45Z is a 5-minute boundary, so minutes 0-4 form one bar and 5-6 the next.
    const bars = [
      { openTime: at(0), open: 100, high: 105, low: 99, close: 101, volume: 10 },
      { openTime: at(1), open: 101, high: 110, low: 100, close: 108, volume: 20 },
      { openTime: at(4), open: 108, high: 109, low: 95, close: 96, volume: 30 },
      { openTime: at(5), open: 96, high: 97, low: 94, close: 95, volume: 40 },
      { openTime: at(6), open: 95, high: 99, low: 95, close: 98, volume: 50 },
    ];
    const rolled = aggregateBars(bars, 5);
    expect(rolled).toHaveLength(2);
    expect(rolled[0]).toMatchObject({ open: 100, high: 110, low: 95, close: 96, volume: 60 });
    expect(rolled[1]).toMatchObject({ open: 96, high: 99, low: 94, close: 98, volume: 90 });
  });
});

describe("profileSensitivity", () => {
  it("reports full agreement and no shift when coarser bars change nothing", () => {
    const bars = [0, 1, 2, 3, 4].map((m) => bar(m, 100, 110, 10));
    const profile = buildSessionProfile(bars, 10)!;
    expect(profileSensitivity(bars, profile)).toMatchObject({ comparedWithBarMinutes: 5, agreement: 1, pocShiftPoints: 0, vahShiftPoints: 0, valShiftPoints: 0 });
  });

  it("shows how little the data resolves when a coarser bar smears two separate trades", () => {
    // Minute 0 traded 100 at 105, minute 1 traded 100 at 205: 50% of the volume in each of two rows. Built from one 5-minute
    // bar the 200 units are smeared evenly over 105-205 (10% a row, 5% in each end row), so only 5% + 5% of the volume
    // still lands where the minute bars put it: agreement 0.1.
    const bars = [point(0, 105, 100), point(1, 205, 100)];
    const profile = buildSessionProfile(bars, 10)!;
    const sensitivity = profileSensitivity(bars, profile)!;
    expect(sensitivity.agreement).toBeLessThan(0.15);
    expect(sensitivity.agreement).toBeGreaterThan(0.05);
  });

  it("is null when the coarser profile cannot be built", () => {
    const profile = buildSessionProfile([point(0, 100, 10)], 10)!;
    expect(profileSensitivity([point(0, 100, 0)], profile)).toBeNull();
  });
});

describe("session ranges", () => {
  it("reads HH:MM clock times and refuses anything else", () => {
    expect(parseClockMinute("09:15")).toBe(9 * 60 + 15);
    expect(parseClockMinute(" 15:30 ")).toBe(15 * 60 + 30);
    for (const bad of ["9:15", "09:60", "24:00", "0915", "09:15:00", "", "ab:cd"]) expect(parseClockMinute(bad), bad).toBeNull();
    expect(formatClockMinute(9 * 60 + 5)).toBe("09:05");
  });

  it("accepts a window inside the session on 5-minute marks, at least 15 minutes long", () => {
    expect(rangeProblem({ fromMinute: 9 * 60 + 15, toMinute: 10 * 60 + 15 })).toBeNull();
    expect(rangeProblem({ fromMinute: 14 * 60 + 15, toMinute: 14 * 60 + 30 })).toBeNull();
    expect(isFullSession(FULL_SESSION_RANGE)).toBe(true);
    expect(rangeProblem(FULL_SESSION_RANGE)).toBeNull();
  });

  it("refuses a window outside the session, off the 5-minute marks, too short, or backwards", () => {
    expect(rangeProblem({ fromMinute: 9 * 60, toMinute: 10 * 60 })).toContain("within the regular session");
    expect(rangeProblem({ fromMinute: 9 * 60 + 15, toMinute: 15 * 60 + 35 })).toContain("within the regular session");
    expect(rangeProblem({ fromMinute: 9 * 60 + 17, toMinute: 10 * 60 })).toContain("multiples of 5");
    expect(rangeProblem({ fromMinute: 10 * 60, toMinute: 10 * 60 + 10 })).toContain("at least 15 minutes");
    expect(rangeProblem({ fromMinute: 11 * 60, toMinute: 10 * 60 })).toContain("at least 15 minutes");
  });

  it("keeps the bars that opened from the start inclusive up to the end exclusive", () => {
    // 09:15 is minute 0 of OPEN; the range 09:30-09:45 holds minutes 15..29.
    const bars = Array.from({ length: 60 }, (_, minute) => point(minute, 100 + minute, 30));
    const kept = selectBarsInRange(bars, { fromMinute: 9 * 60 + 30, toMinute: 9 * 60 + 45 });
    expect(kept.map((b) => b.close)).toEqual(Array.from({ length: 15 }, (_, i) => 115 + i));
    expect(selectBarsInRange(bars, FULL_SESSION_RANGE)).toHaveLength(60);
  });

  it("builds a profile from the range alone: volume outside it is not in it", () => {
    const bars = [point(0, 100, 300), point(20, 200, 30), point(40, 300, 600)];
    const inside = selectBarsInRange(bars, { fromMinute: 9 * 60 + 30, toMinute: 9 * 60 + 45 });
    const profile = buildSessionProfile(inside, 10)!;
    expect(profile.totalVolume).toBe(30);
    expect(profile.poc).toBe(205);
    expect(profile.vwap).toBe(200);
  });

  it("judges quality against the length of the range, so an unfinished window reads as partial", () => {
    const bars = Array.from({ length: 30 }, (_, minute) => point(minute, 100, 30));
    expect(assessBarQuality(bars, 0, 60)).toMatchObject({ expectedMinutes: 60, barsUsed: 30, missingMinutes: 30, complete: false });
    expect(assessBarQuality(bars, 0, 30)).toMatchObject({ expectedMinutes: 30, missingMinutes: 0, complete: true });
    expect(assessBarQuality(bars, 0)).toMatchObject({ expectedMinutes: EXPECTED_SESSION_MINUTES });
  });
});
