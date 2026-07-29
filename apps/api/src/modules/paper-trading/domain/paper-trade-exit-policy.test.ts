import { describe, expect, it } from "vitest";
import { calculatePaperTradeNetPnl, decidePaperTradeExit, type CompletedPriceCandle } from "./paper-trade-exit-policy.js";
import type { PaperTrade } from "./paper-trading.js";

function openTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "trade-1",
    accountId: "account-1",
    tradeIdeaId: "idea-1",
    instrumentId: "instrument-1",
    timeframe: "1d",
    side: "LONG",
    status: "OPEN",
    quantity: 10,
    entryPrice: 100,
    stopLoss: 95,
    targetPrice: 110,
    openedAt: new Date("2026-07-24T15:30:00.000Z"),
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    fees: 0,
    slippage: 0,
    notes: "test trade",
    ...overrides,
  };
}

function candle(overrides: Partial<CompletedPriceCandle> = {}): CompletedPriceCandle {
  return {
    id: "candle-1",
    openTime: new Date("2026-07-25T09:15:00.000Z"),
    closeTime: new Date("2026-07-25T15:30:00.000Z"),
    open: 100,
    high: 104,
    low: 96,
    close: 101,
    ...overrides,
  };
}

describe("decidePaperTradeExit", () => {
  it("fills long stop and target gaps at the completed candle open", () => {
    const trade = openTrade();

    expect(decidePaperTradeExit(trade, candle({ id: "long-gap-stop", open: 93, high: 97, low: 92 }))).toMatchObject({
      reason: "STOP_LOSS",
      eventType: "STOP_LOSS_HIT",
      exitPrice: 93,
      fillRule: "OPEN_GAP_STOP",
      candleId: "long-gap-stop",
    });
    expect(decidePaperTradeExit(trade, candle({ id: "long-gap-target", open: 112, high: 113, low: 110 }))).toMatchObject({
      reason: "TARGET",
      eventType: "TARGET_HIT",
      exitPrice: 112,
      fillRule: "OPEN_GAP_TARGET",
      candleId: "long-gap-target",
    });
  });

  it("fills long intrabar stops and targets at their protective levels", () => {
    const trade = openTrade();

    expect(decidePaperTradeExit(trade, candle({ id: "long-intrabar-stop", high: 104, low: 94 }))).toMatchObject({
      reason: "STOP_LOSS",
      exitPrice: 95,
      fillRule: "INTRABAR_STOP",
      candleId: "long-intrabar-stop",
    });
    expect(decidePaperTradeExit(trade, candle({ id: "long-intrabar-target", high: 111, low: 96 }))).toMatchObject({
      reason: "TARGET",
      exitPrice: 110,
      fillRule: "INTRABAR_TARGET",
      candleId: "long-intrabar-target",
    });
  });

  it("applies the conservative stop-first policy when a long candle reaches both levels", () => {
    const result = decidePaperTradeExit(openTrade(), candle({ id: "long-both", high: 112, low: 94 }));

    expect(result).toEqual({
      reason: "STOP_LOSS",
      eventType: "STOP_LOSS_HIT",
      exitPrice: 95,
      fillRule: "CONSERVATIVE_STOP_FIRST",
      candleId: "long-both",
    });
  });

  it("applies symmetric gap and intrabar rules to short trades", () => {
    const trade = openTrade({ side: "SHORT", stopLoss: 105, targetPrice: 90 });

    expect(decidePaperTradeExit(trade, candle({ id: "short-gap-stop", open: 107, high: 108, low: 106 }))).toMatchObject({
      reason: "STOP_LOSS",
      exitPrice: 107,
      fillRule: "OPEN_GAP_STOP",
    });
    expect(decidePaperTradeExit(trade, candle({ id: "short-gap-target", open: 88, high: 89, low: 87 }))).toMatchObject({
      reason: "TARGET",
      exitPrice: 88,
      fillRule: "OPEN_GAP_TARGET",
    });
    expect(decidePaperTradeExit(trade, candle({ id: "short-intrabar-stop", high: 106, low: 96 }))).toMatchObject({
      reason: "STOP_LOSS",
      exitPrice: 105,
      fillRule: "INTRABAR_STOP",
    });
    expect(decidePaperTradeExit(trade, candle({ id: "short-intrabar-target", high: 104, low: 89 }))).toMatchObject({
      reason: "TARGET",
      exitPrice: 90,
      fillRule: "INTRABAR_TARGET",
    });
    expect(decidePaperTradeExit(trade, candle({ id: "short-both", high: 106, low: 89 }))).toMatchObject({
      reason: "STOP_LOSS",
      eventType: "STOP_LOSS_HIT",
      exitPrice: 105,
      fillRule: "CONSERVATIVE_STOP_FIRST",
      candleId: "short-both",
    });
  });
});

describe("calculatePaperTradeNetPnl", () => {
  it("deducts simulated fees and slippage from long and short gross P/L", () => {
    expect(calculatePaperTradeNetPnl({
      side: "LONG",
      entryPrice: 100,
      exitPrice: 110,
      quantity: 10,
      totalFees: 11,
      totalSlippage: 2.5,
    })).toBe(86.5);
    expect(calculatePaperTradeNetPnl({
      side: "SHORT",
      entryPrice: 100,
      exitPrice: 90,
      quantity: 10,
      totalFees: 10,
      totalSlippage: 3,
    })).toBe(87);
  });
});
