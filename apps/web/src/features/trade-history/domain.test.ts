import { describe, expect, it } from "vitest";
import {
  isTradeInMode,
  isTradeInTimeframe,
  isTradeOnDate,
  listTradeHistoryTimeframes,
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
  it("puts scalp trades in Scalp, swing in Swing, and all in All", () => {
    const swing = record({ timeframe: "1d" });
    const scalp1m = record({ timeframe: " 1M " });
    const scalp5m = record({ timeframe: "5m" });
    const scalp10m = record({ timeframe: "10m" });
    const swing30m = record({ timeframe: "30m" });
    const legacy = record({ timeframe: null });

    expect(isTradeInMode(swing, "swing")).toBe(true);
    expect(isTradeInMode(swing, "scalp")).toBe(false);
    expect(isTradeInMode(swing, "all")).toBe(true);

    expect(isTradeInMode(scalp1m, "scalp")).toBe(true);
    expect(isTradeInMode(scalp1m, "swing")).toBe(false);
    expect(isTradeInMode(scalp1m, "all")).toBe(true);

    expect(isTradeInMode(scalp5m, "scalp")).toBe(true);
    expect(isTradeInMode(scalp5m, "swing")).toBe(false);
    expect(isTradeInMode(scalp10m, "scalp")).toBe(true);
    expect(isTradeInMode(swing30m, "swing")).toBe(true);
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
      MOMENTUM_STALL: 0,
      RUNNER_TRAIL: 0,
      T1_TARGET: 0,
      T2_TARGET: 0,
      TRAP_DETECTED: 0,
      EXPIRED: 0,
    });
  });

  it("filters trades accurately by single date (isTradeOnDate)", () => {
    const trade = record({ openedAt: "2026-08-19T05:20:01.016Z", closedAt: "2026-08-19T05:25:13.009Z" });
    const older = record({ openedAt: "2026-08-18T10:00:00.000Z", closedAt: "2026-08-18T10:30:00.000Z" });

    expect(isTradeOnDate(trade, "")).toBe(true);
    expect(isTradeOnDate(trade, "2026-08-19")).toBe(true);
    expect(isTradeOnDate(trade, "2026-08-18")).toBe(false);
    expect(isTradeOnDate(older, "2026-08-18")).toBe(true);

    const crossesUtcMidnight = record({
      openedAt: "2026-08-18T20:00:00.000Z",
      closedAt: "2026-08-19T02:00:00.000Z",
    });
    expect(isTradeOnDate(crossesUtcMidnight, "2026-08-19")).toBe(true);
    expect(isTradeOnDate(crossesUtcMidnight, "2026-08-18")).toBe(false);
  });

  it("filters trades accurately by timeframe (isTradeInTimeframe)", () => {
    const t1m = record({ timeframe: "1m" });
    const t5m = record({ timeframe: "5m" });

    expect(isTradeInTimeframe(t1m, "ALL")).toBe(true);
    expect(isTradeInTimeframe(t1m, "1m")).toBe(true);
    expect(isTradeInTimeframe(t1m, "5m")).toBe(false);
    expect(isTradeInTimeframe(t5m, "5m")).toBe(true);
  });

  it("offers every supported timeframe and retains legacy values found in records", () => {
    const options = listTradeHistoryTimeframes([record({ timeframe: "2h" })]);

    expect(options).toEqual(["1m", "3m", "5m", "10m", "15m", "30m", "60m", "2h", "1d"]);
  });
});
