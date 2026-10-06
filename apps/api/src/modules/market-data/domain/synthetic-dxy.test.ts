import { describe, expect, it } from "vitest";
import { aggregateOhlcBars, computeDxyLevel, computeSyntheticDxyBar, type TimestampedOhlc } from "./synthetic-dxy.js";

describe("computeDxyLevel", () => {
  it("matches a hand-computed value for known component rates", () => {
    // Rates spot-checked live against Twelve Data on 2026-10-06.
    const level = computeDxyLevel({
      eurUsd: 1.12447,
      usdJpy: 158.1963,
      gbpUsd: 1.32428,
      usdCad: 1.42705,
      usdSek: 10.00463,
      usdChf: 0.83214,
    });
    // 50.14348112 * 1.12447^-0.576 * 158.1963^0.136 * 1.32428^-0.119
    //            * 1.42705^0.091 * 10.00463^0.042 * 0.83214^0.036 = 102.0077308593173
    expect(level).toBeCloseTo(102.00773, 4);
  });

  it("is monotonic in the expected direction for each leg", () => {
    const base = { eurUsd: 1.1, usdJpy: 150, gbpUsd: 1.3, usdCad: 1.4, usdSek: 10, usdChf: 0.85 };
    const baseline = computeDxyLevel(base);
    // EUR/USD and GBP/USD rising (dollar weakens against them) should lower DXY.
    expect(computeDxyLevel({ ...base, eurUsd: base.eurUsd * 1.01 })).toBeLessThan(baseline);
    expect(computeDxyLevel({ ...base, gbpUsd: base.gbpUsd * 1.01 })).toBeLessThan(baseline);
    // USD/JPY rising (a dollar buys more yen, i.e. dollar strengthens) should raise DXY.
    expect(computeDxyLevel({ ...base, usdJpy: base.usdJpy * 1.01 })).toBeGreaterThan(baseline);
  });
});

describe("computeSyntheticDxyBar", () => {
  const flat = (value: number) => ({ open: value, high: value, low: value, close: value });

  it("sets high/low from open/close rather than per-leg extrema", () => {
    const bar = computeSyntheticDxyBar({
      eurUsd: { open: 1.10, high: 1.12, low: 1.08, close: 1.11 },
      usdJpy: flat(150),
      gbpUsd: flat(1.3),
      usdCad: flat(1.4),
      usdSek: flat(10),
      usdChf: flat(0.85),
    });
    expect(bar.high).toBe(Math.max(bar.open, bar.close));
    expect(bar.low).toBe(Math.min(bar.open, bar.close));
    expect(bar.high).toBeGreaterThanOrEqual(bar.open);
    expect(bar.high).toBeGreaterThanOrEqual(bar.close);
    expect(bar.low).toBeLessThanOrEqual(bar.open);
    expect(bar.low).toBeLessThanOrEqual(bar.close);
  });
});

describe("aggregateOhlcBars", () => {
  function minuteBar(minute: number, value: number): TimestampedOhlc {
    const openTime = new Date(Date.UTC(2026, 0, 1, 0, minute));
    return {
      openTime,
      closeTime: new Date(openTime.getTime() + 60_000),
      open: value,
      high: value + 1,
      low: value - 1,
      close: value + 0.5,
    };
  }

  it("rolls up a full bucket into one bar with real open/high/low/close", () => {
    const bars = [minuteBar(0, 100), minuteBar(1, 101), minuteBar(2, 102), minuteBar(3, 103), minuteBar(4, 104)];
    const result = aggregateOhlcBars(bars, 5);
    expect(result).toHaveLength(1);
    expect(result[0].open).toBe(bars[0].open);
    expect(result[0].close).toBe(bars[4].close);
    expect(result[0].high).toBe(Math.max(...bars.map((b) => b.high)));
    expect(result[0].low).toBe(Math.min(...bars.map((b) => b.low)));
  });

  it("drops a short trailing bucket instead of emitting it as a partial aggregate", () => {
    // Only 3 of the 5 minutes a 5m bucket needs -- the rolling collection window's trailing edge.
    const bars = [minuteBar(0, 100), minuteBar(1, 101), minuteBar(2, 102)];
    expect(aggregateOhlcBars(bars, 5)).toHaveLength(0);
  });
});
