import { describe, expect, it } from "vitest";
import {
  deriveTradeOutcome,
  summarizePaperTradeHistory,
  type PaperTradeHistoryRecord,
} from "./paper-trade-history.js";

function record(overrides: Partial<PaperTradeHistoryRecord> = {}): PaperTradeHistoryRecord {
  return {
    simulatedOnly: true,
    id: "trade-1",
    accountId: "account-1",
    accountName: "Research account",
    instrumentId: "instrument-1",
    instrumentSymbol: "NIFTY50",
    instrumentName: "NIFTY 50 Index",
    timeframe: "1d",
    tradeIdeaId: "idea-1",
    side: "LONG",
    status: "CLOSED",
    quantity: 10,
    entryPrice: 100,
    stopLoss: 90,
    targetPrice: 120,
    openedAt: new Date("2026-07-20T10:00:00.000Z"),
    closedAt: new Date("2026-07-20T12:00:00.000Z"),
    exitPrice: 110,
    exitReason: "TARGET",
    realizedPnl: 100,
    returnPercent: 10,
    rewardMultiple: 1,
    holdingMinutes: 120,
    fees: 5,
    slippage: 1,
    notes: "",
    // An index position rather than an option, which is what these summary figures are written
    // against. The option fields carry the contract identity the ledger renders.
    optionType: null,
    optionStrike: null,
    underlyingSymbol: null,
    ...overrides,
  };
}

describe("deriveTradeOutcome", () => {
  it("measures return on entry notional and reward against the risk taken at entry", () => {
    const outcome = deriveTradeOutcome({
      entryPrice: 100,
      stopLoss: 95,
      quantity: 10,
      realizedPnl: 150,
      openedAt: new Date("2026-07-20T09:15:00.000Z"),
      closedAt: new Date("2026-07-21T15:30:00.000Z"),
    });

    // 150 on a 1,000 notional; 150 against a 50 initial risk; 30h 15m held.
    expect(outcome.returnPercent).toBeCloseTo(15, 6);
    expect(outcome.rewardMultiple).toBeCloseTo(3, 6);
    expect(outcome.holdingMinutes).toBe(1815);
  });

  it("keeps an open position's realised figures null", () => {
    const outcome = deriveTradeOutcome({
      entryPrice: 100,
      stopLoss: 95,
      quantity: 10,
      realizedPnl: null,
      openedAt: new Date("2026-07-20T09:15:00.000Z"),
      closedAt: null,
    });

    expect(outcome.returnPercent).toBeNull();
    expect(outcome.rewardMultiple).toBeNull();
    expect(outcome.holdingMinutes).toBeNull();
  });

  it("reports a loss as a negative reward multiple", () => {
    const outcome = deriveTradeOutcome({
      entryPrice: 200,
      stopLoss: 210,
      quantity: 5,
      realizedPnl: -50,
      openedAt: new Date("2026-07-20T09:15:00.000Z"),
      closedAt: new Date("2026-07-20T09:45:00.000Z"),
    });

    expect(outcome.rewardMultiple).toBeCloseTo(-1, 6);
    expect(outcome.returnPercent).toBeCloseTo(-5, 6);
    expect(outcome.holdingMinutes).toBe(30);
  });

  it("leaves reward null when the stop sat at the entry price", () => {
    const outcome = deriveTradeOutcome({
      entryPrice: 100,
      stopLoss: 100,
      quantity: 10,
      realizedPnl: 40,
      openedAt: new Date("2026-07-20T09:15:00.000Z"),
      closedAt: new Date("2026-07-20T10:15:00.000Z"),
    });

    expect(outcome.rewardMultiple).toBeNull();
    expect(outcome.returnPercent).toBeCloseTo(4, 6);
  });
});

describe("summarizePaperTradeHistory", () => {
  it("reports realised aggregates from closed trades only", () => {
    const summary = summarizePaperTradeHistory([
      record({ id: "win-1", realizedPnl: 300, rewardMultiple: 3, holdingMinutes: 60, exitReason: "TARGET" }),
      record({ id: "loss-1", realizedPnl: -100, rewardMultiple: -1, holdingMinutes: 180, exitReason: "STOP_LOSS" }),
      record({
        id: "open-1",
        status: "OPEN",
        closedAt: null,
        exitPrice: null,
        exitReason: null,
        realizedPnl: null,
        returnPercent: null,
        rewardMultiple: null,
        holdingMinutes: null,
      }),
    ]);

    expect(summary.tradeCount).toBe(3);
    expect(summary.openTradeCount).toBe(1);
    expect(summary.closedTradeCount).toBe(2);
    expect(summary.winningTradeCount).toBe(1);
    expect(summary.losingTradeCount).toBe(1);
    expect(summary.winRatePercent).toBe(50);
    expect(summary.grossProfit).toBe(300);
    expect(summary.grossLoss).toBe(100);
    expect(summary.netRealizedPnl).toBe(200);
    expect(summary.profitFactor).toBe(3);
    expect(summary.expectancy).toBe(100);
    expect(summary.averageWin).toBe(300);
    expect(summary.averageLoss).toBe(-100);
    expect(summary.averageRewardMultiple).toBe(1);
    expect(summary.averageHoldingMinutes).toBe(120);
    expect(summary.largestWin).toBe(300);
    expect(summary.largestLoss).toBe(-100);
    // Every reason in the alphabet is reported, including those with no trades, so a
    // consumer can render a stable set of buckets. EXPIRED joined it with option
    // force-close at expiry.
    expect(summary.exitReasonCounts).toEqual({
      TARGET: 1,
      STOP_LOSS: 1,
      MANUAL: 0,
      CANCELLED: 0,
      EXPIRED: 0,
      TRAP_DETECTED: 0,
      T1_TARGET: 0,
      T2_TARGET: 0,
      RUNNER_TRAIL: 0,
      MOMENTUM_STALL: 0,
      SESSION_CLOSE: 0,
    });
  });

  it("walks the realised equity curve in exit order to find the drawdown", () => {
    // Deliberately supplied out of order: the summary must sort by exit time,
    // because a drawdown only exists along the real closing sequence.
    const summary = summarizePaperTradeHistory([
      record({ id: "third", realizedPnl: 50, closedAt: new Date("2026-07-23T10:00:00.000Z") }),
      record({ id: "first", realizedPnl: 400, closedAt: new Date("2026-07-21T10:00:00.000Z") }),
      record({ id: "second", realizedPnl: -250, closedAt: new Date("2026-07-22T10:00:00.000Z") }),
    ]);

    expect(summary.netRealizedPnl).toBe(200);
    expect(summary.maximumDrawdown).toBe(250);
  });

  it("leaves ratios null rather than implying a result with no data", () => {
    const empty = summarizePaperTradeHistory([]);

    expect(empty.tradeCount).toBe(0);
    expect(empty.winRatePercent).toBeNull();
    expect(empty.profitFactor).toBeNull();
    expect(empty.expectancy).toBeNull();
    expect(empty.averageWin).toBeNull();
    expect(empty.maximumDrawdown).toBe(0);
  });

  it("keeps profit factor null when nothing has been lost yet", () => {
    const summary = summarizePaperTradeHistory([record({ realizedPnl: 120 })]);

    expect(summary.grossLoss).toBe(0);
    expect(summary.profitFactor).toBeNull();
    expect(summary.winRatePercent).toBe(100);
  });

  it("counts a flat exit as neither a win nor a loss", () => {
    const summary = summarizePaperTradeHistory([record({ realizedPnl: 0, rewardMultiple: 0 })]);

    expect(summary.breakEvenTradeCount).toBe(1);
    expect(summary.winningTradeCount).toBe(0);
    expect(summary.losingTradeCount).toBe(0);
    expect(summary.winRatePercent).toBe(0);
  });
});
