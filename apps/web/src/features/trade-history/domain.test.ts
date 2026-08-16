import { describe, expect, it } from "vitest";
import {
  isTradeInMode,
  summarizeTradeHistory,
  type TradeHistoryRecord,
} from "./domain";

function record(overrides: Partial<TradeHistoryRecord> = {}): TradeHistoryRecord {
  return {
    simulatedOnly: true,
    id: "trade-1",
    accountId: "account-1",
    accountName: "Paper account",
    instrumentSymbol: "NIFTY50",
    instrumentName: "Nifty 50",
    timeframe: "1d",
    tradeIdeaId: "idea-1",
    side: "LONG",
    status: "CLOSED",
    quantity: 1,
    entryPrice: 100,
    stopLoss: 90,
    targetPrice: 120,
    openedAt: "2026-01-01T09:00:00.000Z",
    closedAt: "2026-01-01T10:00:00.000Z",
    exitPrice: 120,
    exitReason: "TARGET",
    realizedPnl: 200,
    returnPercent: 2,
    rewardMultiple: 2,
    holdingMinutes: 60,
    fees: 5,
    slippage: 1,
    notes: "",
    // These cases exercise timeframe-based mode grouping, not contract rendering.
    optionType: null,
    optionStrike: null,
    underlyingSymbol: null,
    ...overrides,
  };
}

describe("trade history modes", () => {
  it("puts only 1m trades in Scalp and keeps legacy records in Swing", () => {
    const swing = record({ timeframe: "1d" });
    const scalp = record({ timeframe: " 1M " });
    const legacy = record({ timeframe: null });

    expect(isTradeInMode(swing, "swing")).toBe(true);
    expect(isTradeInMode(swing, "scalp")).toBe(false);
    expect(isTradeInMode(scalp, "scalp")).toBe(true);
    expect(isTradeInMode(scalp, "swing")).toBe(false);
    expect(isTradeInMode(legacy, "swing")).toBe(true);
  });

  it("calculates summary cards from only the supplied tab records", () => {
    const summary = summarizeTradeHistory([
      record({ id: "win", realizedPnl: 200, rewardMultiple: 2, fees: 5, slippage: 1 }),
      record({
        id: "loss",
        closedAt: "2026-01-02T10:00:00.000Z",
        exitReason: "STOP_LOSS",
        realizedPnl: -100,
        rewardMultiple: -1,
        fees: 3,
        slippage: 2,
      }),
    ]);

    expect(summary).toMatchObject({
      tradeCount: 2,
      closedTradeCount: 2,
      winningTradeCount: 1,
      losingTradeCount: 1,
      winRatePercent: 50,
      netRealizedPnl: 100,
      profitFactor: 2,
      expectancy: 50,
      averageRewardMultiple: 0.5,
      totalFees: 8,
      totalSlippage: 3,
      maximumDrawdown: 100,
    });
    expect(summary.exitReasonCounts).toEqual({
      STOP_LOSS: 1,
      TARGET: 1,
      MANUAL: 0,
      CANCELLED: 0,
    });
  });

  it("returns an empty, non-misleading summary for an empty tab", () => {
    expect(summarizeTradeHistory([])).toMatchObject({
      tradeCount: 0,
      winRatePercent: null,
      profitFactor: null,
      expectancy: null,
      averageHoldingMinutes: null,
      maximumDrawdown: 0,
    });
  });
});
