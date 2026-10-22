import { describe, expect, it } from "vitest";
import { GoldAsianSweepStrategy } from "./gold-asian-sweep-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { AsianRangeSnapshot } from "../../technical-analysis/domain/ict/asian-session.js";

function makeContext(params: {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  tickSize?: number;
  asianSessionContext?: AsianRangeSnapshot | null;
}): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1",
      instrumentId: "inst-gold",
      timeframe: "5m",
      openTime: new Date(params.openTime),
      closeTime: new Date(params.closeTime),
      open: params.open,
      high: params.high,
      low: params.low,
      close: params.close,
      volume: 1000,
      tickSize: params.tickSize ?? 0.01,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    asianSessionContext: params.asianSessionContext,
  };
}

describe("GoldAsianSweepStrategy (Stateless)", () => {
  it("generates a SHORT proposal when context carries a valid BEARISH_SWEEP", () => {
    // Brand new instance per call, identical to production
    const strategy = new GoldAsianSweepStrategy();

    const snapshot: AsianRangeSnapshot = {
      dateKey: "2026-10-22",
      state: "LOCKED",
      asiaHigh: 2710.0,
      asiaLow: 2695.0,
      asiaRange: 15.0,
      asiaRangeBps: 55.66,
      midpoint: 2702.5,
      isValid: true,
      sweepEvent: {
        type: "BEARISH_SWEEP",
        level: 2710.0,
        sweepExtreme: 2713.0,
        penetrationBps: 11.07,
        reclaimBps: 11.07,
        rejectionWickPct: 0.60,
        time: new Date("2026-10-22T07:30:00Z"),
      },
    };

    const context = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 2706.0,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
      asianSessionContext: snapshot,
    });

    const proposals = strategy.evaluate(context);

    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("SHORT");
    expect(p.entryPrice).toBe(2707.0);
    expect(p.stopLoss).toBe(2713.4); // 2713.0 + 0.40 buffer
    expect(p.targetPrice).toBe(2697.4); // 2707 - (6.4 * 1.5)
    expect(p.riskReward).toBe(1.5);
    expect(Array.isArray(p.reasoning)).toBe(true);
    expect(p.evidence).toHaveProperty("asianHigh", 2710.0);
    expect(p.evidenceItems).toBeDefined();
    expect(p.evidenceItems?.[0]?.sourceType).toBe("STRATEGY");
  });

  it("generates a LONG proposal when context carries a valid BULLISH_SWEEP", () => {
    const strategy = new GoldAsianSweepStrategy();

    const snapshot: AsianRangeSnapshot = {
      dateKey: "2026-10-22",
      state: "LOCKED",
      asiaHigh: 2710.0,
      asiaLow: 2695.0,
      asiaRange: 15.0,
      asiaRangeBps: 55.66,
      midpoint: 2702.5,
      isValid: true,
      sweepEvent: {
        type: "BULLISH_SWEEP",
        level: 2695.0,
        sweepExtreme: 2691.5,
        penetrationBps: 12.99,
        reclaimBps: 9.28,
        rejectionWickPct: 0.54,
        time: new Date("2026-10-22T08:00:00Z"),
      },
    };

    const context = makeContext({
      openTime: "2026-10-22T08:00:00Z",
      closeTime: "2026-10-22T08:05:00Z",
      open: 2694.0,
      high: 2698.0,
      low: 2691.5,
      close: 2697.5,
      asianSessionContext: snapshot,
    });

    const proposals = strategy.evaluate(context);

    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.side).toBe("LONG");
    expect(p.entryPrice).toBe(2697.5);
    expect(p.stopLoss).toBe(2691.1); // 2691.5 - 0.40 buffer
    expect(p.targetPrice).toBe(2707.1); // 2697.5 + (6.4 * 1.5)
    expect(p.riskReward).toBe(1.5);
  });

  it("rejects non-Gold instruments or contexts without asianSessionContext", () => {
    const strategy = new GoldAsianSweepStrategy();

    // Indian index candle (tickSize 0.05)
    const nseContext = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 24500,
      high: 24550,
      low: 24480,
      close: 24520,
      tickSize: 0.05,
      asianSessionContext: null,
    });

    expect(strategy.evaluate(nseContext)).toHaveLength(0);
  });
});
