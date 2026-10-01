import { describe, expect, it } from "vitest";
import { IctAtrTracker } from "./atr-tracker.js";
import { atrSeries } from "../../../pattern-recognition/domain/atr-series.js";
import type { PatternCandle } from "../../../pattern-recognition/domain/market-pattern.js";

function candle(i: number, high: number, low: number, close: number): PatternCandle {
  return { id: `c-${i}`, openTime: new Date(2026, 0, 1, 0, i), open: close, high, low, close, volume: 0 };
}

describe("IctAtrTracker", () => {
  it("returns null while warming up (fewer than `period` bars seen)", () => {
    const tracker = new IctAtrTracker(14);
    for (let i = 0; i < 13; i += 1) {
      expect(tracker.processCandle(candle(i, 100 + i, 90 + i, 95 + i))).toBeNull();
    }
  });

  it("matches atrSeries' Wilder ATR(14) bar-by-bar, fed incrementally instead of recomputed", () => {
    // A synthetic series with varying true ranges so the Wilder smoothing is actually exercised.
    const candles: PatternCandle[] = [];
    let price = 100;
    for (let i = 0; i < 40; i += 1) {
      const swing = 1 + (i % 5);
      const high = price + swing;
      const low = price - swing * 0.7;
      const close = price + (i % 2 === 0 ? swing * 0.3 : -swing * 0.2);
      candles.push(candle(i, high, low, close));
      price = close;
    }

    const reference = atrSeries(candles, 14);

    const tracker = new IctAtrTracker(14);
    const incremental = candles.map((c) => tracker.processCandle(c));

    for (let i = 0; i < candles.length; i += 1) {
      if (reference[i] === null) {
        expect(incremental[i]).toBeNull();
      } else {
        expect(incremental[i]).not.toBeNull();
        expect(incremental[i]!).toBeCloseTo(reference[i]!, 9);
      }
    }
  });

  it("treats the first bar's true range as its own high-low range (no prior close to compare against)", () => {
    const tracker = new IctAtrTracker(2);
    // First bar: TR = high - low = 10. Second bar seeds the average once period bars are seen.
    expect(tracker.processCandle(candle(0, 110, 100, 105))).toBeNull();
    const second = tracker.processCandle(candle(1, 108, 104, 106));
    // TR2 = max(108-104, |108-105|, |104-105|) = max(4, 3, 1) = 4. Seed avg = (10 + 4) / 2 = 7.
    expect(second).toBeCloseTo(7, 9);
  });
});
