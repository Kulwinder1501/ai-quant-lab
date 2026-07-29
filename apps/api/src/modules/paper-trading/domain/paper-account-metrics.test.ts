import { describe, expect, it } from "vitest";
import { calculatePaperAccountMetrics } from "./paper-account-metrics.js";
import type { PaperAccountPerformanceData, PaperTrade } from "./paper-trading.js";

function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "trade-1",
    accountId: "account-1",
    tradeIdeaId: "idea-1",
    instrumentId: "instrument-1",
    timeframe: "1d",
    side: "LONG",
    status: "CLOSED",
    quantity: 10,
    entryPrice: 100,
    stopLoss: 90,
    targetPrice: 120,
    openedAt: new Date("2026-07-20T15:30:00.000Z"),
    closedAt: new Date("2026-07-21T15:30:00.000Z"),
    exitPrice: 110,
    exitReason: "TARGET",
    realizedPnl: 100,
    fees: 10,
    slippage: 1,
    notes: "test trade",
    ...overrides,
  };
}

describe("calculatePaperAccountMetrics", () => {
  it("reports win rate, average R, chronological drawdown, and cash capacity", () => {
    const data: PaperAccountPerformanceData = {
      account: {
        id: "account-1",
        name: "Phase 8 test account",
        openingBalance: 1000,
        currency: "INR",
        isActive: true,
      },
      closedTrades: [
        trade({ id: "winner-1", realizedPnl: 100, fees: 10, slippage: 1, closedAt: new Date("2026-07-21T15:30:00.000Z") }),
        trade({
          id: "loser-1",
          side: "SHORT",
          realizedPnl: -50,
          fees: 8,
          slippage: 2,
          closedAt: new Date("2026-07-22T15:30:00.000Z"),
          exitPrice: 105,
          exitReason: "STOP_LOSS",
        }),
        trade({ id: "winner-2", realizedPnl: 200, fees: 7, slippage: 3, closedAt: new Date("2026-07-23T15:30:00.000Z"), exitPrice: 120 }),
      ],
      openTrades: [trade({
        id: "open-1",
        status: "OPEN",
        closedAt: null,
        exitPrice: null,
        exitReason: null,
        realizedPnl: null,
        fees: 4,
        slippage: 0.5,
      })],
      availableCapital: 700,
    };

    expect(calculatePaperAccountMetrics(data)).toEqual({
      openingBalance: 1000,
      closedTradeCount: 3,
      openTradeCount: 1,
      winningTradeCount: 2,
      winRatePercent: 66.666667,
      realizedPnl: 250,
      totalFees: 29,
      totalSlippage: 6.5,
      averageReward: 0.833333,
      maximumDrawdownPercent: 4.545455,
      currentEquity: 1250,
      availableCapital: 700,
    });
  });
});
