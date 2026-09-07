import { describe, expect, it } from "vitest";
import { aggregateBars } from "./bar-aggregation.js";
import { netOutcomeR, roundTripCostR } from "./round-trip-cost.js";
import { applyHolm, pairedDelta, summariseExpectancy, toDailyExpectancy } from "./expectancy-statistics.js";
import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";

/** 09:15 IST on the given date is 03:45 UTC. */
function bar(date: string, minuteOfSession: number, high: number, low: number): CompletedPriceCandle {
  const open = new Date(`${date}T03:45:00.000Z`).getTime() + minuteOfSession * 60_000;
  return {
    id: `${date}-${minuteOfSession}`,
    openTime: new Date(open),
    closeTime: new Date(open + 60_000),
    open: low,
    high,
    low,
    close: high,
  };
}

describe("aggregateBars", () => {
  it("folds three 1m bars into one 3m bar taking the extremes", () => {
    const [aggregated] = aggregateBars([
      bar("2026-08-19", 0, 101, 99),
      bar("2026-08-19", 1, 104, 100),
      bar("2026-08-19", 2, 102, 97),
    ], 3);
    expect(aggregated).toMatchObject({ high: 104, low: 97 });
    expect(aggregated!.openTime.toISOString()).toBe("2026-08-19T03:45:00.000Z");
    expect(aggregated!.closeTime.toISOString()).toBe("2026-08-19T03:48:00.000Z");
  });

  it("never lets a bucket straddle a session", () => {
    // Two bars on one day, one on the next. A bucket spanning the overnight gap would carry that gap
    // into its range and inflate every ATR reading it.
    const aggregated = aggregateBars([
      bar("2026-08-19", 0, 101, 99),
      bar("2026-08-19", 1, 102, 100),
      bar("2026-08-20", 0, 300, 290),
    ], 3);
    expect(aggregated).toHaveLength(0);
  });

  it("discards a partial bucket rather than publishing a short bar", () => {
    // Four 1m bars at 3m: one complete bucket, one bar left over. Publishing the remainder would feed
    // the strategy a bar with a third of a real bar's range.
    const aggregated = aggregateBars([
      bar("2026-08-19", 0, 101, 99),
      bar("2026-08-19", 1, 102, 100),
      bar("2026-08-19", 2, 103, 98),
      bar("2026-08-19", 3, 500, 400),
    ], 3);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]!.high).toBe(103);
  });

  it("passes 1m through untouched", () => {
    const bars = [bar("2026-08-19", 0, 101, 99), bar("2026-08-19", 1, 102, 100)];
    expect(aggregateBars(bars, 1)).toEqual(bars);
  });

  it("refuses out-of-order bars", () => {
    expect(() => aggregateBars([bar("2026-08-19", 5, 101, 99), bar("2026-08-19", 1, 102, 100)], 3))
      .toThrow(/chronological order/);
  });
});

describe("roundTripCostR", () => {
  it("charges the cost twice, once each way", () => {
    // 2 bps of 100 is 0.02 per side; 0.04 round trip against a risk of 1.0 is 0.04R.
    expect(roundTripCostR({ riskPerUnit: 1, entryPrice: 100, costBps: 2 })).toBeCloseTo(0.04, 9);
  });

  it("costs a tighter stop proportionally more, which is the experiment's whole mechanism", () => {
    // Identical bps and price; only the ATR-derived stop differs. A faster architecture pays more.
    const tight = roundTripCostR({ riskPerUnit: 0.5, entryPrice: 100, costBps: 2 });
    const wide = roundTripCostR({ riskPerUnit: 2.0, entryPrice: 100, costBps: 2 });
    expect(tight / wide).toBeCloseTo(4, 9);
  });

  it("nets the cost off the gross outcome", () => {
    expect(netOutcomeR({ grossR: 1.5, riskPerUnit: 1, entryPrice: 100, costBps: 2 })).toBeCloseTo(1.46, 9);
  });

  it("refuses inputs that would silently produce a free trade", () => {
    expect(() => roundTripCostR({ riskPerUnit: 0, entryPrice: 100, costBps: 2 })).toThrow(/risk per unit/);
    expect(() => roundTripCostR({ riskPerUnit: 1, entryPrice: 0, costBps: 2 })).toThrow(/entry price/);
    expect(() => roundTripCostR({ riskPerUnit: 1, entryPrice: 100, costBps: -1 })).toThrow(/basis-point/);
  });
});

describe("day-level statistics", () => {
  it("gives every session one vote regardless of how often it fired", () => {
    // Day A fires 4 times at +1R, day B once at -1R. Trade-weighted this is +0.6R; day-weighted it is
    // 0.0R. The protocol's criterion is the second, so a busy architecture cannot outvote a quiet one.
    const daily = toDailyExpectancy([
      { day: "A", netR: 1 }, { day: "A", netR: 1 }, { day: "A", netR: 1 }, { day: "A", netR: 1 },
      { day: "B", netR: -1 },
    ]);
    expect(summariseExpectancy(daily).meanDailyR).toBeCloseTo(0, 9);
    expect(summariseExpectancy(daily).trades).toBe(5);
  });

  it("reports no interval from a single session rather than a zero-width one", () => {
    const summary = summariseExpectancy(toDailyExpectancy([{ day: "A", netR: 1 }]));
    expect(summary.standardError).toBeNull();
    expect(summary.ci95).toBeNull();
  });

  it("pairs deltas on the session and ignores days only one arm traded", () => {
    const left = toDailyExpectancy([{ day: "A", netR: 1 }, { day: "B", netR: 2 }, { day: "C", netR: 9 }]);
    const right = toDailyExpectancy([{ day: "A", netR: 0 }, { day: "B", netR: 1 }]);
    const delta = pairedDelta("left-right", left, right);
    expect(delta.pairedDays).toBe(2);
    expect(delta.meanDelta).toBeCloseTo(1, 9);
  });

  it("declines significance when the interval contains zero, whatever the p", () => {
    // Two paired days with opposite signs: a wide interval straddling zero. The protocol's rule is the
    // interval, so this must not be reported as a winner.
    const left = toDailyExpectancy([{ day: "A", netR: 5 }, { day: "B", netR: -5 }]);
    const right = toDailyExpectancy([{ day: "A", netR: 0 }, { day: "B", netR: 0 }]);
    const [adjusted] = applyHolm([pairedDelta("wide", left, right)]);
    expect(adjusted!.significant).toBe(false);
  });

  it("makes Holm monotone across the family", () => {
    const strong = pairedDelta("strong",
      toDailyExpectancy([{ day: "A", netR: 1 }, { day: "B", netR: 1.05 }, { day: "C", netR: 0.95 }]),
      toDailyExpectancy([{ day: "A", netR: 0 }, { day: "B", netR: 0 }, { day: "C", netR: 0 }]));
    const weak = pairedDelta("weak",
      toDailyExpectancy([{ day: "A", netR: 1 }, { day: "B", netR: -0.5 }, { day: "C", netR: 0.2 }]),
      toDailyExpectancy([{ day: "A", netR: 0 }, { day: "B", netR: 0 }, { day: "C", netR: 0 }]));
    const adjusted = applyHolm([weak, strong]);
    const byLabel = new Map(adjusted.map((entry) => [entry.label, entry]));
    // The weaker contrast can never end up with a smaller adjusted p than the stronger one.
    expect(byLabel.get("weak")!.holmAdjustedP!).toBeGreaterThanOrEqual(byLabel.get("strong")!.holmAdjustedP!);
  });
});
