import { describe, expect, it } from "vitest";
import { GoldAsianSweepStrategy, defaultGoldAsianSweepConfig } from "./gold-asian-sweep-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";

function makeContext(params: {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  timeframe?: string;
}): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1",
      instrumentId: "inst-gold",
      timeframe: params.timeframe ?? "15m",
      openTime: new Date(params.openTime),
      closeTime: new Date(params.closeTime),
      open: params.open,
      high: params.high,
      low: params.low,
      close: params.close,
      volume: 1000,
      tickSize: 0.01,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  };
}

describe("GoldAsianSweepStrategy", () => {
  it("generates a SHORT proposal when Asia High is swept and reclaimed in London", () => {
    const strategy = new GoldAsianSweepStrategy();

    // 1. Asian bar setting high at 2710
    strategy.evaluate(makeContext({
      openTime: "2026-10-22T02:00:00Z",
      closeTime: "2026-10-22T02:15:00Z",
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2705,
    }));

    // 2. Bar at 06:00 UTC locking the range
    strategy.evaluate(makeContext({
      openTime: "2026-10-22T06:00:00Z",
      closeTime: "2026-10-22T06:15:00Z",
      open: 2705,
      high: 2708,
      low: 2702,
      close: 2706,
    }));

    // 3. London bar at 07:30 UTC: sweeps to 2713 (> 2710) and reclaims to close at 2707 (< 2710)
    const proposals = strategy.evaluate(makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:45:00Z",
      open: 2706,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
    }));

    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("SHORT");
    expect(p.entryPrice).toBe(2707.0);
    expect(p.stopLoss).toBe(2713.4); // 2713.0 + 0.40 buffer
    expect(p.targetPrice).toBeLessThan(2707.0);
    expect(p.riskReward).toBeGreaterThanOrEqual(1.5);
    expect(p.reasoning).toHaveProperty("asianHigh", 2710);
    expect(p.reasoning).toHaveProperty("sweepExtreme", 2713.0);
  });

  it("generates a LONG proposal when Asia Low is swept and reclaimed in London", () => {
    const strategy = new GoldAsianSweepStrategy();

    strategy.evaluate(makeContext({
      openTime: "2026-10-22T02:00:00Z",
      closeTime: "2026-10-22T02:15:00Z",
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2705,
    }));

    strategy.evaluate(makeContext({
      openTime: "2026-10-22T06:00:00Z",
      closeTime: "2026-10-22T06:15:00Z",
      open: 2705,
      high: 2708,
      low: 2702,
      close: 2706,
    }));

    // London bar at 08:00 UTC: dips to 2691.5 (< 2695) and reclaims to close at 2697.5 (> 2695)
    const proposals = strategy.evaluate(makeContext({
      openTime: "2026-10-22T08:00:00Z",
      closeTime: "2026-10-22T08:15:00Z",
      open: 2694.0,
      high: 2698.0,
      low: 2691.5,
      close: 2697.5,
    }));

    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("LONG");
    expect(p.entryPrice).toBe(2697.5);
    expect(p.stopLoss).toBe(2691.1); // 2691.5 - 0.40 buffer
    expect(p.targetPrice).toBeGreaterThan(2697.5);
    expect(p.riskReward).toBeGreaterThanOrEqual(1.5);
  });

  it("does not emit proposals outside the London execution window", () => {
    const strategy = new GoldAsianSweepStrategy();

    // Asian setup
    strategy.evaluate(makeContext({
      openTime: "2026-10-22T02:00:00Z",
      closeTime: "2026-10-22T02:15:00Z",
      open: 2700,
      high: 2710,
      low: 2695,
      close: 2705,
    }));

    // Post-London bar (14:00 UTC)
    const proposals = strategy.evaluate(makeContext({
      openTime: "2026-10-22T14:00:00Z",
      closeTime: "2026-10-22T14:15:00Z",
      open: 2708,
      high: 2715,
      low: 2705,
      close: 2708,
    }));

    expect(proposals).toHaveLength(0);
  });
});
