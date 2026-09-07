import { describe, expect, it } from "vitest";
import { extractHtfObservations } from "./momentum-scalp-research-htf.js";
import type { StrategyMarketContext } from "./strategy.js";

function baseContext(overrides: Partial<StrategyMarketContext> = {}): StrategyMarketContext {
  return {
    candle: {
      id: "c-1m", instrumentId: "i-1", timeframe: "1m",
      openTime: new Date("2026-09-03T04:00:00Z"), closeTime: new Date("2026-09-03T04:01:00Z"),
      open: 100, high: 101, low: 99, close: 100.5, volume: 1000, tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    ...overrides,
  };
}

function htfContext(): StrategyMarketContext {
  return {
    candle: {
      id: "c-5m", instrumentId: "i-1", timeframe: "5m",
      openTime: new Date("2026-09-03T03:55:00Z"), closeTime: new Date("2026-09-03T04:00:00Z"),
      open: 98, high: 102, low: 97, close: 100, volume: 5000, tickSize: 0.05,
    },
    indicators: [
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 55 } },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 3.2 } },
    ],
    patterns: [],
    priceActionEvents: [],
    regime: undefined,
  };
}

describe("extractHtfObservations", () => {
  it("records absence explicitly when no HTF context is attached", () => {
    const out = extractHtfObservations(baseContext()) as { htf5m: { present: boolean } };
    // present:false, not an omitted key or a zeroed feature -- absence is information, and an
    // estimator must be able to tell "no 5m bar had closed" from "the 5m bar said zero".
    expect(out.htf5m.present).toBe(false);
    expect(Object.keys(out.htf5m)).toEqual(["present"]);
  });

  it("records the full 5m slice, losslessly, when attached", () => {
    const context = baseContext({ higherTimeframeContexts: { "5m": htfContext() } });
    const out = extractHtfObservations(context) as { htf5m: Record<string, unknown> };
    expect(out.htf5m.present).toBe(true);
    expect(out.htf5m.timeframe).toBe("5m");
    const candle = out.htf5m.candle as { close: number; volume: number };
    expect(candle.close).toBe(100);
    expect(candle.volume).toBe(5000);
    // Every indicator carried through, not a hand-picked pair.
    const indicators = out.htf5m.indicators as Array<{ code: string; values: Record<string, unknown> }>;
    expect(indicators.map((i) => i.code)).toEqual(["RSI", "ATR"]);
    expect(indicators[1]!.values.value).toBe(3.2);
  });

  it("stamps the 5m bar's own dataThrough one tick before its close", () => {
    const context = baseContext({ higherTimeframeContexts: { "5m": htfContext() } });
    const out = extractHtfObservations(context) as { htf5m: { dataThrough: Date } };
    // The 5m close is 04:00:00; its knowable-through instant is one ms before, mirroring the 1m
    // featureDataThrough convention so a reader never treats the close as an intrabar value.
    expect(out.htf5m.dataThrough.getTime()).toBe(new Date("2026-09-03T04:00:00Z").getTime() - 1);
  });
});
