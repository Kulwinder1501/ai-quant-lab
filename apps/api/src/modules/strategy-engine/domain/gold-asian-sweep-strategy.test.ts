import { describe, expect, it } from "vitest";
import { GoldAsianSweepStrategy } from "./gold-asian-sweep-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { AsianCandleLike, AsianRangeSnapshot } from "../../technical-analysis/domain/ict/asian-session.js";

function makeContext(params: {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  symbol?: string;
  tickSize?: number;
  asianSessionContext?: AsianRangeSnapshot | null;
  dayCandles?: AsianCandleLike[];
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
      symbol: params.symbol ?? "XAU_USD",
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    asianSessionContext: params.asianSessionContext,
    dayCandles: params.dayCandles,
  };
}

describe("GoldAsianSweepStrategy (Stateless)", () => {
  it("generates a SHORT proposal when context carries a valid BEARISH_SWEEP snapshot", () => {
    const strategy = new GoldAsianSweepStrategy();

    const snapshot: AsianRangeSnapshot = {
      dateKey: "2026-10-22",
      state: "LOCKED",
      asiaHigh: 2710.0,
      asiaLow: 2695.0,
      asiaRange: 15.0,
      asiaRangeBps: 55.66,
      midpoint: 2702.5,
      barCount: 72,
      expectedBars: 72,
      coveragePct: 1.0,
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

  it("generates a LONG proposal when context carries a valid BULLISH_SWEEP snapshot", () => {
    const strategy = new GoldAsianSweepStrategy();

    const snapshot: AsianRangeSnapshot = {
      dateKey: "2026-10-22",
      state: "LOCKED",
      asiaHigh: 2710.0,
      asiaLow: 2695.0,
      asiaRange: 15.0,
      asiaRangeBps: 55.66,
      midpoint: 2702.5,
      barCount: 72,
      expectedBars: 72,
      coveragePct: 1.0,
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

  it("evaluates dayCandles with its own versioned configuration (Fix 1 verification)", () => {
    const strategy = new GoldAsianSweepStrategy();

    // Build 72 5m candles covering 00:00 to 06:00 UTC
    const dayCandles: AsianCandleLike[] = [];
    for (let i = 0; i < 72; i++) {
      const openTime = new Date(Date.UTC(2026, 9, 22, 0, i * 5));
      const closeTime = new Date(openTime.getTime() + 5 * 60_000);
      const high = i === 10 ? 2710.0 : 2705.0;
      const low = i === 20 ? 2695.0 : 2698.0;
      dayCandles.push({ openTime, closeTime, open: 2700, high, low, close: 2702 });
    }

    // London sweep bar at 07:30 UTC: High 2712.5 (penetration ~9.2 bps, rejection wick 60%)
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date(Date.UTC(2026, 9, 22, 7, 30)),
      closeTime: new Date(Date.UTC(2026, 9, 22, 7, 35)),
      open: 2705.0,
      high: 2712.5,
      low: 2703.0,
      close: 2706.0,
    };
    dayCandles.push(londonSweepBar);

    const context = makeContext({
      openTime: londonSweepBar.openTime.toISOString(),
      closeTime: londonSweepBar.closeTime.toISOString(),
      open: londonSweepBar.open,
      high: londonSweepBar.high,
      low: londonSweepBar.low,
      close: londonSweepBar.close,
      dayCandles,
    });

    // 1. With standard config (minPenetrationBps: 3.0), penetration of 9.2 bps passes
    const defaultProposals = strategy.evaluate(context);
    expect(defaultProposals).toHaveLength(1);
    expect(defaultProposals[0]?.side).toBe("SHORT");

    // 2. With customized versioned config (minPenetrationBps: 15.0), the 9.2 bps penetration is rejected
    const strictProposals = strategy.evaluate(context, { minPenetrationBps: 15.0 });
    expect(strictProposals).toHaveLength(0);
  });

  it("strictly enforces symbol guard against colliding ETFs with tickSize 0.01 (Fix 2 verification)", () => {
    const strategy = new GoldAsianSweepStrategy();

    // NIFTYBEES has tickSize 0.01 in the database, but is NOT XAU_USD
    const collidingNseContext = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 260.0,
      high: 265.0,
      low: 259.0,
      close: 261.0,
      symbol: "NIFTYBEES",
      tickSize: 0.01,
      asianSessionContext: null,
    });

    expect(strategy.evaluate(collidingNseContext)).toHaveLength(0);

    // Instrument with non-0.01 tickSize is also rejected
    const wrongTickSizeContext = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 2706.0,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
      symbol: "XAU_USD",
      tickSize: 0.05,
    });
    expect(strategy.evaluate(wrongTickSizeContext)).toHaveLength(0);
  });
});
