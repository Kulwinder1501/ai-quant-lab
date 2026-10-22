import { describe, expect, it } from "vitest";
import { AsianSessionRangeTracker, type AsianRangeSnapshot } from "./asian-session.js";

describe("AsianSessionRangeTracker", () => {
  it("accumulates candles from 00:00 to 06:00 UTC and locks the range", () => {
    const tracker = new AsianSessionRangeTracker();

    // 00:00 UTC candle
    tracker.processCandle({
      openTime: new Date("2026-10-22T00:00:00Z"),
      closeTime: new Date("2026-10-22T00:15:00Z"),
      open: 2700,
      high: 2705,
      low: 2698,
      close: 2702,
    });

    // 03:00 UTC candle
    tracker.processCandle({
      openTime: new Date("2026-10-22T03:00:00Z"),
      closeTime: new Date("2026-10-22T03:15:00Z"),
      open: 2702,
      high: 2710, // New high
      low: 2695, // New low
      close: 2708,
    });

    // 05:45 UTC candle (last bar of Asian session)
    const snapAsia = tracker.processCandle({
      openTime: new Date("2026-10-22T05:45:00Z"),
      closeTime: new Date("2026-10-22T06:00:00Z"),
      open: 2708,
      high: 2709,
      low: 2704,
      close: 2706,
    });

    expect(snapAsia.state).toBe("FORMING");
    expect(snapAsia.asiaHigh).toBe(2710);
    expect(snapAsia.asiaLow).toBe(2695);
    expect(snapAsia.asiaRange).toBe(15);
    expect(snapAsia.midpoint).toBe(2702.5);

    // 06:00 UTC candle (London transition, range locks)
    const snapLondon = tracker.processCandle({
      openTime: new Date("2026-10-22T06:00:00Z"),
      closeTime: new Date("2026-10-22T06:15:00Z"),
      open: 2706,
      high: 2708,
      low: 2705,
      close: 2707,
    });

    expect(snapLondon.state).toBe("LOCKED");
    expect(snapLondon.asiaHigh).toBe(2710);
    expect(snapLondon.asiaLow).toBe(2695);
    expect(snapLondon.isValid).toBe(true);
  });

  it("detects a bearish sweep of Asia High during London hours", () => {
    const tracker = new AsianSessionRangeTracker();

    // Establish Asian range: High 2710, Low 2695
    tracker.processCandle({
      openTime: new Date("2026-10-22T01:00:00Z"),
      closeTime: new Date("2026-10-22T01:15:00Z"),
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2702,
    });

    // Bar at 06:00 locks range
    tracker.processCandle({
      openTime: new Date("2026-10-22T06:00:00Z"),
      closeTime: new Date("2026-10-22T06:15:00Z"),
      open: 2702,
      high: 2705,
      low: 2700,
      close: 2703,
    });

    // 07:30 UTC: London sweeps high (2712.50 > 2710) but closes at 2707 (< 2710)
    // Upper wick = 2712.50 - 2707 = 5.50 out of span (2712.50 - 2702 = 10.50) -> 52% wick
    const snapSweep = tracker.processCandle({
      openTime: new Date("2026-10-22T07:30:00Z"),
      closeTime: new Date("2026-10-22T07:45:00Z"),
      open: 2705,
      high: 2712.5,
      low: 2702.0,
      close: 2707.0,
    });

    expect(snapSweep.sweepEvent).not.toBeNull();
    expect(snapSweep.sweepEvent?.type).toBe("BEARISH_SWEEP");
    expect(snapSweep.sweepEvent?.level).toBe(2710);
    expect(snapSweep.sweepEvent?.sweepExtreme).toBe(2712.5);
    expect(snapSweep.sweepEvent?.penetrationBps).toBeGreaterThan(3.0);
  });

  it("detects a bullish sweep of Asia Low during London hours", () => {
    const tracker = new AsianSessionRangeTracker();

    // Asian range: High 2710, Low 2695
    tracker.processCandle({
      openTime: new Date("2026-10-22T01:00:00Z"),
      closeTime: new Date("2026-10-22T01:15:00Z"),
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2702,
    });

    tracker.processCandle({
      openTime: new Date("2026-10-22T06:00:00Z"),
      closeTime: new Date("2026-10-22T06:15:00Z"),
      open: 2702,
      high: 2705,
      low: 2700,
      close: 2703,
    });

    // 08:15 UTC: London dips to 2692.00 (< 2695) and reclaims to close at 2697.50 (> 2695)
    const snapSweep = tracker.processCandle({
      openTime: new Date("2026-10-22T08:15:00Z"),
      closeTime: new Date("2026-10-22T08:30:00Z"),
      open: 2694.0,
      high: 2698.0,
      low: 2692.0,
      close: 2697.5,
    });

    expect(snapSweep.sweepEvent).not.toBeNull();
    expect(snapSweep.sweepEvent?.type).toBe("BULLISH_SWEEP");
    expect(snapSweep.sweepEvent?.level).toBe(2695);
    expect(snapSweep.sweepEvent?.sweepExtreme).toBe(2692.0);
  });

  it("resets automatically when a new UTC date begins", () => {
    const tracker = new AsianSessionRangeTracker();

    tracker.processCandle({
      openTime: new Date("2026-10-22T01:00:00Z"),
      closeTime: new Date("2026-10-22T01:15:00Z"),
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2702,
    });

    // Next day candle
    const nextDaySnap = tracker.processCandle({
      openTime: new Date("2026-10-23T00:15:00Z"),
      closeTime: new Date("2026-10-23T00:30:00Z"),
      open: 2720,
      high: 2725,
      low: 2718,
      close: 2722,
    });

    expect(nextDaySnap.dateKey).toBe("2026-10-23");
    expect(nextDaySnap.asiaHigh).toBe(2725);
    expect(nextDaySnap.asiaLow).toBe(2718);
    expect(nextDaySnap.state).toBe("FORMING");
  });
});
