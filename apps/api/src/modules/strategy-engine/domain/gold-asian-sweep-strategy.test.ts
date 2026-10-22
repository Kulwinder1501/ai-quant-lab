import { describe, expect, it } from "vitest";
import { GoldAsianSweepStrategy } from "./gold-asian-sweep-strategy.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { AsianCandleLike } from "../../technical-analysis/domain/ict/asian-session.js";

/** Builds a 72-bar Asian session covering 00:00 to 06:00 UTC at 5m cadence. */
function buildAsianSessionCandles(minLow = 2695.0, maxHigh = 2710.0): AsianCandleLike[] {
  const candles: AsianCandleLike[] = [];
  for (let i = 0; i < 72; i++) {
    const openTime = new Date(Date.UTC(2026, 9, 22, 0, i * 5));
    const closeTime = new Date(openTime.getTime() + 5 * 60_000);
    const high = i === 10 ? maxHigh : 2705.0;
    const low = i === 20 ? minLow : 2698.0;
    candles.push({ openTime, closeTime, open: 2700, high, low, close: 2702 });
  }
  return candles;
}

function makeContext(params: {
  openTime: string;
  closeTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  symbol?: string;
  tickSize?: number;
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
      symbol: params.symbol,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
    dayCandles: params.dayCandles,
  };
}

describe("GoldAsianSweepStrategy (Stateless & Strict)", () => {
  it("generates a SHORT proposal when dayCandles forms a valid BEARISH_SWEEP in London window", () => {
    const strategy = new GoldAsianSweepStrategy();
    const dayCandles = buildAsianSessionCandles(2695.0, 2710.0);

    // Candle at 07:30 UTC sweeps Asia High (2710) up to 2713.0 and closes at 2707.0 (reclaim, 60% upper wick)
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T07:30:00Z"),
      closeTime: new Date("2026-10-22T07:35:00Z"),
      open: 2706.0,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
    };
    dayCandles.push(londonSweepBar);

    const context = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 2706.0,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
      symbol: "XAU_USD",
      dayCandles,
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

  it("generates a LONG proposal when dayCandles forms a valid BULLISH_SWEEP in London window", () => {
    const strategy = new GoldAsianSweepStrategy();
    const dayCandles = buildAsianSessionCandles(2695.0, 2710.0);

    // Candle at 08:00 UTC sweeps Asia Low (2695) down to 2691.5 and closes at 2697.5 (reclaim, 54% lower wick)
    const londonSweepBar: AsianCandleLike = {
      openTime: new Date("2026-10-22T08:00:00Z"),
      closeTime: new Date("2026-10-22T08:05:00Z"),
      open: 2694.0,
      high: 2698.0,
      low: 2691.5,
      close: 2697.5,
    };
    dayCandles.push(londonSweepBar);

    const context = makeContext({
      openTime: "2026-10-22T08:00:00Z",
      closeTime: "2026-10-22T08:05:00Z",
      open: 2694.0,
      high: 2698.0,
      low: 2691.5,
      close: 2697.5,
      symbol: "XAU_USD",
      dayCandles,
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

  it("evaluates dayCandles using versioned configuration thresholds & session hours", () => {
    const strategy = new GoldAsianSweepStrategy();
    const dayCandles = buildAsianSessionCandles(2695.0, 2710.0);

    const londonSweepBar: AsianCandleLike = {
      openTime: new Date(Date.UTC(2026, 9, 22, 7, 30)),
      closeTime: new Date(Date.UTC(2026, 9, 22, 7, 35)),
      open: 2705.0,
      high: 2712.5, // 9.2 bps penetration
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
      symbol: "XAU_USD",
      dayCandles,
    });

    // 1. Default config (minPenetrationBps: 3.0, londonStartHourUtc: 6.5) -> passes
    const defaultProposals = strategy.evaluate(context);
    expect(defaultProposals).toHaveLength(1);

    // 2. Strict threshold override (minPenetrationBps: 15.0) -> rejected
    const strictProposals = strategy.evaluate(context, { minPenetrationBps: 15.0 });
    expect(strictProposals).toHaveLength(0);

    // 3. Strict session hour override (londonStartHourUtc: 8.0) -> rejected as bar is at 07:30 UTC
    const lateLondonProposals = strategy.evaluate(context, { londonStartHourUtc: 8.0 });
    expect(lateLondonProposals).toHaveLength(0);
  });

  it("strictly enforces fail-closed symbol guard (missing symbol or non-XAU_USD rejected)", () => {
    const strategy = new GoldAsianSweepStrategy();
    const dayCandles = buildAsianSessionCandles(2695.0, 2710.0);

    // 1. Missing symbol entirely -> strictly rejected (fail-closed)
    const missingSymbolContext = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 2706.0,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
      dayCandles,
    });
    expect(strategy.evaluate(missingSymbolContext)).toHaveLength(0);

    // 2. Colliding instrument symbol with 0.01 tickSize (e.g. NIFTYBEES) -> strictly rejected
    const collidingNseContext = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 260.0,
      high: 265.0,
      low: 259.0,
      close: 261.0,
      symbol: "NIFTYBEES",
      tickSize: 0.01,
      dayCandles,
    });
    expect(strategy.evaluate(collidingNseContext)).toHaveLength(0);

    // 3. Wrong tickSize on XAU_USD -> strictly rejected
    const wrongTickSizeContext = makeContext({
      openTime: "2026-10-22T07:30:00Z",
      closeTime: "2026-10-22T07:35:00Z",
      open: 2706.0,
      high: 2713.0,
      low: 2703.0,
      close: 2707.0,
      symbol: "XAU_USD",
      tickSize: 0.05,
      dayCandles,
    });
    expect(strategy.evaluate(wrongTickSizeContext)).toHaveLength(0);
  });
});
