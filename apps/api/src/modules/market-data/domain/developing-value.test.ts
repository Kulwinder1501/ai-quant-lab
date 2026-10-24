import { describe, expect, it } from "vitest";
import { developingProfile } from "./developing-value.js";
import { buildSessionProfile, type FuturesBar } from "./session-volume-profile.js";

/** 2026-10-22; 09:15 IST = 03:45Z. Bars are synthetic, hand-built for the arithmetic (not recorded). */
const OPEN = Date.parse("2026-10-22T03:45:00.000Z");
const point = (minute: number, price: number, volume: number): FuturesBar => ({
  openTime: new Date(OPEN + minute * 60_000), open: price, high: price, low: price, close: price, volume,
});
const run = (from: number, to: number, price: number, volume: number): FuturesBar[] =>
  Array.from({ length: to - from }, (_, i) => point(from + i, price, volume));

describe("developingProfile", () => {
  // Fifteen minutes at 100 (10 each), then fifteen at 200 (30 each).
  const bars = [...run(0, 15, 100, 10), ...run(15, 30, 200, 30)];

  it("rebuilds the profile at each checkpoint from the bars that opened before it", () => {
    const [first, second] = developingProfile(bars, 10, 15);
    expect(first).toMatchObject({ atMinute: 570, barsUsed: 15, expectedBars: 15, newBars: 15, totalVolume: 150, poc: 105, val: 100, vah: 110, vwap: 100, lastClose: 100, complete: true });
    // 150 at 100-110 and 450 at 200-210: the POC moves to the heavier row, and 450 of 600 is already past 70%.
    expect(second).toMatchObject({ atMinute: 585, barsUsed: 30, newBars: 15, totalVolume: 600, poc: 205, val: 200, vah: 210, lastClose: 200 });
    expect(second!.vwap).toBe(175);   // (100 x 150 + 200 x 450) / 600
  });

  it("ends, for a complete session, on exactly the session's own profile", () => {
    const day = [...run(0, 120, 100, 30), ...run(120, 250, 130, 60), ...run(250, 375, 90, 30)];
    const points = developingProfile(day, 10, 15);
    const final = points[points.length - 1]!;
    const whole = buildSessionProfile(day, 10)!;
    expect(final).toMatchObject({ atMinute: 930, barsUsed: 375, complete: true, totalVolume: whole.totalVolume, poc: whole.poc, vah: whole.vah, val: whole.val, vwap: whole.vwap });
  });

  it("puts a checkpoint every step from the open, the last one at the close", () => {
    expect(developingProfile([], 10, 15).map((p) => p.atMinute)).toHaveLength(25);
    expect(developingProfile([], 10, 30)).toHaveLength(13);
    const hourly = developingProfile([], 10, 60).map((p) => p.atMinute);
    expect(hourly).toEqual([615, 675, 735, 795, 855, 915, 930]);   // the last step is only 15 minutes
  });

  it("reports no new bars, rather than a flat continuation, where the stored bars stop", () => {
    // A session in progress: bars only for the first 40 minutes.
    const points = developingProfile(run(0, 40, 100, 10), 10, 15);
    expect(points.slice(0, 3).map((p) => p.newBars)).toEqual([15, 15, 10]);
    expect(points[2]).toMatchObject({ barsUsed: 40, expectedBars: 45, complete: false });
    expect(points.slice(3).every((p) => p.newBars === 0 && !p.complete && p.barsUsed === 40)).toBe(true);
  });

  it("calls a checkpoint incomplete when a minute is missing, even though later minutes arrived", () => {
    const withHole = [...run(0, 10, 100, 10), ...run(11, 30, 100, 10)];
    const [first, second] = developingProfile(withHole, 10, 15);
    expect(first).toMatchObject({ barsUsed: 14, expectedBars: 15, complete: false });
    expect(second).toMatchObject({ barsUsed: 29, expectedBars: 30, complete: false });
  });

  it("counts a repeated minute once", () => {
    const doubled = [point(0, 100, 10), point(0, 100, 10), ...run(1, 15, 100, 10)];
    expect(developingProfile(doubled, 10, 15)[0]).toMatchObject({ barsUsed: 15, totalVolume: 150, complete: true });
  });

  it("has no levels, not zero levels, before anything has traded", () => {
    const quiet = developingProfile(run(0, 20, 100, 0), 10, 15);
    expect(quiet[0]).toMatchObject({ totalVolume: null, poc: null, vah: null, val: null, vwap: null, barsUsed: 15, complete: true });
    expect(developingProfile([], 10, 15)[0]).toMatchObject({ barsUsed: 0, totalVolume: null, lastClose: null, complete: false });
  });

  it("ignores bars outside the regular session and refuses a bad step", () => {
    const outside = [point(-5, 500, 999), point(380, 500, 999), ...run(0, 15, 100, 10)];
    expect(developingProfile(outside, 10, 15)[0]).toMatchObject({ barsUsed: 15, totalVolume: 150 });
    for (const step of [0, -15, 7.5, Number.NaN]) expect(() => developingProfile([], 10, step), String(step)).toThrow("positive whole number");
  });
});
