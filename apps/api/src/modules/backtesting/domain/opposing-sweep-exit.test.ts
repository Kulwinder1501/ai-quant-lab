import { describe, expect, it } from "vitest";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";
import { detectOpposingLiquiditySweep } from "./opposing-sweep-exit.js";

function context(indicators: StrategyMarketContext["indicators"] = []): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1",
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date("2026-09-21T03:59:00.000Z"),
      closeTime: new Date("2026-09-21T04:00:00.000Z"),
      open: 56453.75,
      high: 56510.95,
      low: 56453.75,
      close: 56498.5,
      volume: 0,
      tickSize: 0.05,
    },
    indicators,
    patterns: [],
    priceActionEvents: [],
  };
}

function sweep(type: "BULLISH_SWEEP" | "BEARISH_SWEEP") {
  return { code: "LIQUIDITY_SWEEP", algorithmVersion: "smc-v2", parameters: {}, values: { type, level: 56497.7 } } as unknown as
    StrategyMarketContext["indicators"][number];
}

describe("detectOpposingLiquiditySweep", () => {
  it("flags a LONG when a BEARISH_SWEEP is present on the bar", () => {
    expect(detectOpposingLiquiditySweep(context([sweep("BEARISH_SWEEP")]), "LONG")).toBe(true);
  });

  it("flags a SHORT when a BULLISH_SWEEP is present on the bar", () => {
    expect(detectOpposingLiquiditySweep(context([sweep("BULLISH_SWEEP")]), "SHORT")).toBe(true);
  });

  it("does not flag a LONG on a confirming BULLISH_SWEEP", () => {
    expect(detectOpposingLiquiditySweep(context([sweep("BULLISH_SWEEP")]), "LONG")).toBe(false);
  });

  it("does not flag a SHORT on a confirming BEARISH_SWEEP", () => {
    expect(detectOpposingLiquiditySweep(context([sweep("BEARISH_SWEEP")]), "SHORT")).toBe(false);
  });

  it("returns false when no LIQUIDITY_SWEEP indicator is present at all", () => {
    expect(detectOpposingLiquiditySweep(context([]), "LONG")).toBe(false);
  });

  it("ignores a LIQUIDITY_SWEEP from a different algorithm version", () => {
    const stale = { code: "LIQUIDITY_SWEEP", algorithmVersion: "smc-v1", parameters: {}, values: { type: "BEARISH_SWEEP", level: 1 } } as unknown as
      StrategyMarketContext["indicators"][number];
    expect(detectOpposingLiquiditySweep(context([stale]), "LONG")).toBe(false);
  });

  it("ignores indicators of a different code entirely", () => {
    const other = { code: "ORDER_BLOCK", algorithmVersion: "smc-v2", parameters: {}, values: { type: "BEARISH_OB", top: 1, bottom: 0 } } as unknown as
      StrategyMarketContext["indicators"][number];
    expect(detectOpposingLiquiditySweep(context([other]), "LONG")).toBe(false);
  });
});
