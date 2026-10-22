import { describe, expect, it } from "vitest";
import {
  evaluateAsianSession,
  detectBarSweep,
  type AsianCandleLike,
  defaultAsianSessionConfig,
} from "./asian-session.js";

/** Generates synthetic completed candles for the Asian session [00:00, 06:00) UTC. */
function generateAsianSessionCandles(
  count: number,
  timeframeMinutes = 15,
  minLow = 2695,
  maxHigh = 2710,
): AsianCandleLike[] {
  const candles: AsianCandleLike[] = [];
  const startMs = new Date("2026-10-22T00:00:00Z").getTime();
  const stepMs = timeframeMinutes * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const openTime = new Date(startMs + i * stepMs);
    const closeTime = new Date(openTime.getTime() + stepMs);
    // Ensure the first and second bars set the high and low extremes
    const high = i === 1 ? maxHigh : 2705;
    const low = i === 2 ? minLow : 2698;
    candles.push({
      openTime,
      closeTime,
      open: 2700,
      high,
      low,
      close: 2702,
    });
  }
  return candles;
}

describe("evaluateAsianSession", () => {
  it("accumulates candles from 00:00 to 06:00 UTC and locks the range", () => {
    // 24 15-minute bars covers the full 6-hour window [00:00, 06:00)
    const asiaCandles = generateAsianSessionCandles(24, 15, 2695, 2710);
    const formingBar = asiaCandles[10]!; // around 02:30 UTC

    const snapAsia = evaluateAsianSession(asiaCandles.slice(0, 11), formingBar);
    expect(snapAsia.state).toBe("FORMING");
    expect(snapAsia.asiaHigh).toBe(2710);
    expect(snapAsia.asiaLow).toBe(2695);
    expect(snapAsia.asiaRange).toBe(15);
    expect(snapAsia.midpoint).toBe(2702.5);

    // Candle at 06:00 locks range
    const cLock: AsianCandleLike = {
      openTime: new Date("2026-10-22T06:00:00Z"),
      closeTime: new Date("2026-10-22T06:15:00Z"),
      open: 2706,
      high: 2708,
      low: 2705,
      close: 2707,
    };

    const snapLondon = evaluateAsianSession([...asiaCandles, cLock], cLock);
    expect(snapLondon.state).toBe("LOCKED");
    expect(snapLondon.asiaHigh).toBe(2710);
    expect(snapLondon.asiaLow).toBe(2695);
    expect(snapLondon.barCount).toBe(24);
    expect(snapLondon.expectedBars).toBe(24);
    expect(snapLondon.coveragePct).toBe(1.0);
    expect(snapLondon.isValid).toBe(true);
  });

  it("marks snapshot invalid when Asian window has insufficient coverage (< 90% expected bars)", () => {
    // Expected 24 bars for 15m; supply only 12 bars (50% coverage)
    const partialAsia = generateAsianSessionCandles(12, 15, 2695, 2710);
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T07:30:00Z"),
      closeTime: new Date("2026-10-22T07:45:00Z"),
      open: 2705,
      high: 2712.5,
      low: 2702.0,
      close: 2707.0,
    };

    const snap = evaluateAsianSession([...partialAsia, londonSweepBar], londonSweepBar);
    expect(snap.barCount).toBe(12);
    expect(snap.expectedBars).toBe(24);
    expect(snap.coveragePct).toBe(0.5);
    expect(snap.isValid).toBe(false);
    expect(snap.sweepEvent).toBeNull(); // No sweep may fire on invalid/incomplete Asian range
  });

  it("detects a bearish sweep of Asia High during London hours with complete Asian data", () => {
    const asiaCandles = generateAsianSessionCandles(24, 15, 2695, 2710);
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T07:30:00Z"),
      closeTime: new Date("2026-10-22T07:45:00Z"),
      open: 2705,
      high: 2712.5, // Pierces 2710 by 2.5 points (~9.2 bps)
      low: 2702.0,
      close: 2707.0, // Closes back inside (< 2710)
    };

    const snap = evaluateAsianSession([...asiaCandles, londonSweepBar], londonSweepBar);
    expect(snap.isValid).toBe(true);
    expect(snap.sweepEvent).not.toBeNull();
    expect(snap.sweepEvent?.type).toBe("BEARISH_SWEEP");
    expect(snap.sweepEvent?.level).toBe(2710);
    expect(snap.sweepEvent?.sweepExtreme).toBe(2712.5);
    expect(snap.sweepEvent?.penetrationBps).toBeGreaterThan(3.0);
  });

  it("detects a bullish sweep of Asia Low during London hours with complete Asian data", () => {
    const asiaCandles = generateAsianSessionCandles(24, 15, 2695, 2710);
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T08:15:00Z"),
      closeTime: new Date("2026-10-22T08:30:00Z"),
      open: 2694.0,
      high: 2698.0,
      low: 2692.0, // Dips below 2695 (~11 bps)
      close: 2697.5, // Closes back inside (> 2695)
    };

    const snap = evaluateAsianSession([...asiaCandles, londonSweepBar], londonSweepBar);
    expect(snap.isValid).toBe(true);
    expect(snap.sweepEvent).not.toBeNull();
    expect(snap.sweepEvent?.type).toBe("BULLISH_SWEEP");
    expect(snap.sweepEvent?.level).toBe(2695);
    expect(snap.sweepEvent?.sweepExtreme).toBe(2692.0);
  });

  it("does not fire a second sweep if a prior sweep already occurred today", () => {
    const asiaCandles = generateAsianSessionCandles(24, 15, 2695, 2710);
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

    const snap = evaluateAsianSession([...asiaCandles, firstSweepBar, secondSweepBar], secondSweepBar);
    expect(snap.sweepEvent).toBeNull();
  });

  it("excludes candle opened at 11:30 UTC from London sweep execution and marks COMPLETED", () => {
    const asiaCandles = generateAsianSessionCandles(24, 15, 2695, 2710);
    const barAt1130: AsianCandleLike = {
      openTime: new Date("2026-10-22T11:30:00Z"),
      closeTime: new Date("2026-10-22T11:45:00Z"),
      open: 2705,
      high: 2712.5,
      low: 2702.0,
      close: 2707.0,
    };

    const snap = evaluateAsianSession([...asiaCandles, barAt1130], barAt1130);
    expect(snap.state).toBe("COMPLETED");
    expect(snap.sweepEvent).toBeNull();
  });

  it("evaluates single bar sweep correctly through detectBarSweep", () => {
    const sweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T08:00:00Z"),
      closeTime: new Date("2026-10-22T08:05:00Z"),
      open: 2705,
      high: 2712.5,
      low: 2703,
      close: 2706,
    };

    const sweep = detectBarSweep(sweepBar, 2710, 2695, defaultAsianSessionConfig);
    expect(sweep).not.toBeNull();
    expect(sweep?.type).toBe("BEARISH_SWEEP");
    expect(sweep?.level).toBe(2710);
    expect(sweep?.penetrationBps).toBe(9.23);
  });
});
