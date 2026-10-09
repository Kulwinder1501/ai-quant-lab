import { describe, expect, it } from "vitest";
import { evaluateO1TradeExit } from "./o1-exit-state-machine.js";
import { DEFAULT_O1_EXIT_TIMINGS, resolveO1ExitTimings } from "./o1-exit-timings.js";

const OPENED_AT = new Date("2026-10-09T05:00:00.000Z");

/** A trade 20 minutes old that is 0.1R in profit: stalled by the legacy clock, normal for a 15m ICT trade. */
function stalledTradeAfter(minutes: number, timings: { timeStopMinutes?: number; premiumToleranceMinutes?: number }) {
  return evaluateO1TradeExit({
    side: "LONG",
    underlyingDirection: "SHORT",
    entryUnderlying: 22_551,
    invalidationLevelAtEntry: 22_650,
    initialRiskDistance: 100,
    entryOptionPrice: 200,
    openedAt: OPENED_AT,
    now: new Date(OPENED_AT.getTime() + minutes * 60_000),
    currentOptionPrice: 195,
    effectivePremiumStop: 120,
    effectivePremiumTarget: 400,
    currentUnderlyingPrice: 22_541, // 10 points in favour = 0.1R
    ...timings,
  });
}

describe("resolveO1ExitTimings", () => {
  it("leaves every other strategy on the legacy 15 minute clock", () => {
    expect(resolveO1ExitTimings("momentum-scalp-v1", "1m")).toEqual(DEFAULT_O1_EXIT_TIMINGS);
    expect(resolveO1ExitTimings(null, "15m")).toEqual(DEFAULT_O1_EXIT_TIMINGS);
    expect(resolveO1ExitTimings("ict-structure-v1", null)).toEqual(DEFAULT_O1_EXIT_TIMINGS);
    expect(resolveO1ExitTimings("ict-structure-v1", "weird")).toEqual(DEFAULT_O1_EXIT_TIMINGS);
  });

  it("gives ICT trades four bars of their own timeframe", () => {
    expect(resolveO1ExitTimings("ict-structure-v1", "15m").timeStopMinutes).toBe(60);
    expect(resolveO1ExitTimings("ict-structure-v1", "5m").timeStopMinutes).toBe(20);
  });

  it("never shortens the clock below the legacy value", () => {
    expect(resolveO1ExitTimings("ict-structure-v1", "1m").timeStopMinutes).toBe(15);
  });

  it("stretches the premium-tolerance window in the same proportion", () => {
    expect(resolveO1ExitTimings("ict-structure-v1", "15m").premiumToleranceMinutes).toBeCloseTo(40);
  });
});

describe("evaluateO1TradeExit timings", () => {
  it("legacy clock ends a 20 minute old stalled trade (regression: today's 15m ICT loss)", () => {
    expect(stalledTradeAfter(20, {}).exitReason).toBe("TIME_STOP");
  });

  it("the ICT clock lets the same trade keep running", () => {
    const timings = resolveO1ExitTimings("ict-structure-v1", "15m");
    expect(stalledTradeAfter(20, timings).shouldExit).toBe(false);
  });

  it("the ICT clock still ends a trade that has made no progress after four bars", () => {
    const timings = resolveO1ExitTimings("ict-structure-v1", "15m");
    expect(stalledTradeAfter(61, timings).exitReason).toBe("TIME_STOP");
  });
});
