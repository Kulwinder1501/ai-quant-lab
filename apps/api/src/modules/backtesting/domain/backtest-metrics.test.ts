import { describe, expect, it } from "vitest";
import { calculateBacktestMetrics, calculateMonthlyPerformance, type BacktestCounters } from "./backtest-metrics.js";
import type { BacktestTrade } from "./backtesting.js";

const counters: BacktestCounters = {
  signalCount: 3,
  skippedSignalsNoNextCandle: 1,
  skippedSignalsWhilePositionOpen: 2,
  skippedSignalsInvalidGap: 1,
  skippedSignalsInsufficientCapital: 0,
  skippedSignalsUnsizable: 0,
};

function trade(overrides: Partial<BacktestTrade> = {}): BacktestTrade {
  return {
    instrumentId: "instrument-1",
    side: "LONG",
    entryTime: new Date("2026-01-05T09:15:00.000Z"),
    exitTime: new Date("2026-01-05T15:30:00.000Z"),
    entryPrice: 100,
    exitPrice: 100,
    quantity: 1,
    pnl: 0,
    returnPercent: 0,
    exitReason: "END_OF_DATA",
    reasoning: [],
    ...overrides,
  };
}

describe("backtest metrics", () => {
  it("uses persisted net trade P/L for performance, drawdown, and month buckets", () => {
    const trades = [
      trade({
        instrumentId: "instrument-b",
        entryTime: new Date("2026-01-10T09:15:00.000Z"),
        exitTime: new Date("2026-01-10T15:30:00.000Z"),
        pnl: 100,
      }),
      trade({
        instrumentId: "instrument-a",
        entryTime: new Date("2026-01-20T09:15:00.000Z"),
        exitTime: new Date("2026-01-20T15:30:00.000Z"),
        pnl: -50,
      }),
      trade({
        instrumentId: "instrument-c",
        entryTime: new Date("2026-02-02T09:15:00.000Z"),
        exitTime: new Date("2026-02-02T15:30:00.000Z"),
        pnl: 30,
      }),
    ];

    expect(calculateBacktestMetrics(trades, 1_000, counters)).toEqual({
      ...counters,
      tradeCount: 3,
      winningTradeCount: 2,
      losingTradeCount: 1,
      winRatePercent: 66.666667,
      accuracyPercent: 66.666667,
      grossProfit: 130,
      grossLoss: 50,
      netPnl: 80,
      profitFactor: 2.6,
      expectancy: 26.666667,
      maximumDrawdownPercent: 4.545455,
      endingEquity: 1_080,
    });

    expect(calculateMonthlyPerformance(trades, 1_000)).toEqual([
      {
        monthStart: new Date("2026-01-01T00:00:00.000Z"),
        tradeCount: 2,
        winningTradeCount: 1,
        grossProfit: 100,
        grossLoss: 50,
        netPnl: 50,
        maxDrawdownPercent: 4.545455,
      },
      {
        monthStart: new Date("2026-02-01T00:00:00.000Z"),
        tradeCount: 1,
        winningTradeCount: 1,
        grossProfit: 30,
        grossLoss: 0,
        netPnl: 30,
        maxDrawdownPercent: 0,
      },
    ]);
  });
});
