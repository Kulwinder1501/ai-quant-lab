import { describe, expect, it } from "vitest";
import { evaluateAsianSession, type AsianCandleLike } from "./asian-session.js";

describe("evaluateAsianSession", () => {
  it("accumulates candles from 00:00 to 06:00 UTC and locks the range", () => {
    const c1: AsianCandleLike = {
      openTime: new Date("2026-10-22T00:00:00Z"),
      closeTime: new Date("2026-10-22T00:15:00Z"),
      open: 2700,
      high: 2705,
      low: 2698,
      close: 2702,
    };
    const c2: AsianCandleLike = {
      openTime: new Date("2026-10-22T03:00:00Z"),
      closeTime: new Date("2026-10-22T03:15:00Z"),
      open: 2702,
      high: 2710,
      low: 2695,
      close: 2708,
    };
    const c3: AsianCandleLike = {
      openTime: new Date("2026-10-22T05:45:00Z"),
      closeTime: new Date("2026-10-22T06:00:00Z"),
      open: 2708,
      high: 2709,
      low: 2704,
      close: 2706,
    };

    const snapAsia = evaluateAsianSession([c1, c2, c3], c3);
    expect(snapAsia.state).toBe("FORMING");
    expect(snapAsia.asiaHigh).toBe(2710);
    expect(snapAsia.asiaLow).toBe(2695);
    expect(snapAsia.asiaRange).toBe(15);
    expect(snapAsia.midpoint).toBe(2702.5);

    // Candle at 06:00 locks range
    const c4: AsianCandleLike = {
      openTime: new Date("2026-10-22T06:00:00Z"),
      closeTime: new Date("2026-10-22T06:15:00Z"),
      open: 2706,
      high: 2708,
      low: 2705,
      close: 2707,
    };

    const snapLondon = evaluateAsianSession([c1, c2, c3, c4], c4);
    expect(snapLondon.state).toBe("LOCKED");
    expect(snapLondon.asiaHigh).toBe(2710);
    expect(snapLondon.asiaLow).toBe(2695);
    expect(snapLondon.isValid).toBe(true);
  });

  it("detects a bearish sweep of Asia High during London hours", () => {
    const asiaBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T01:00:00Z"),
      closeTime: new Date("2026-10-22T01:15:00Z"),
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2702,
    };
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T07:30:00Z"),
      closeTime: new Date("2026-10-22T07:45:00Z"),
      open: 2705,
      high: 2712.5, // Pierces 2710 by 2.5 points (~9.2 bps)
      low: 2702.0,
      close: 2707.0, // Closes back inside (< 2710)
    };

    const snap = evaluateAsianSession([asiaBar, londonSweepBar], londonSweepBar);
    expect(snap.sweepEvent).not.toBeNull();
    expect(snap.sweepEvent?.type).toBe("BEARISH_SWEEP");
    expect(snap.sweepEvent?.level).toBe(2710);
    expect(snap.sweepEvent?.sweepExtreme).toBe(2712.5);
    expect(snap.sweepEvent?.penetrationBps).toBeGreaterThan(3.0);
  });

  it("detects a bullish sweep of Asia Low during London hours", () => {
    const asiaBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T01:00:00Z"),
      closeTime: new Date("2026-10-22T01:15:00Z"),
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2702,
    };
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T08:15:00Z"),
      closeTime: new Date("2026-10-22T08:30:00Z"),
      open: 2694.0,
      high: 2698.0,
      low: 2692.0, // Dips below 2695 (~11 bps)
      close: 2697.5, // Closes back inside (> 2695)
    };

    const snap = evaluateAsianSession([asiaBar, londonSweepBar], londonSweepBar);
    expect(snap.sweepEvent).not.toBeNull();
    expect(snap.sweepEvent?.type).toBe("BULLISH_SWEEP");
    expect(snap.sweepEvent?.level).toBe(2695);
    expect(snap.sweepEvent?.sweepExtreme).toBe(2692.0);
  });

  it("does not fire a second sweep if a prior sweep already occurred today", () => {
    const asiaBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T01:00:00Z"),
      closeTime: new Date("2026-10-22T01:15:00Z"),
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2702,
    };
    const firstSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T07:30:00Z"),
      closeTime: new Date("2026-10-22T07:45:00Z"),
      open: 2705,
      high: 2712.5,
      low: 2702.0,
      close: 2707.0,
    };
    const secondSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T08:00:00Z"),
      closeTime: new Date("2026-10-22T08:15:00Z"),
      open: 2707,
      high: 2713.0,
      low: 2704.0,
      close: 2708.0,
    };

    const snap = evaluateAsianSession([asiaBar, firstSweepBar, secondSweepBar], secondSweepBar);
    expect(snap.sweepEvent).toBeNull();
  });
});
