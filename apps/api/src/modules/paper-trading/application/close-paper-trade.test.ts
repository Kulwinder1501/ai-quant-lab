import { describe, expect, it } from "vitest";
import { ClosePaperTrade } from "./close-paper-trade.js";
import type { ClosePaperTradeInput, PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";

function optionTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "opt-1",
    accountId: "account-1",
    tradeIdeaId: "idea-1",
    instrumentId: "instrument-1",
    instrumentSymbol: "NIFTY50",
    timeframe: "1d",
    side: "LONG",
    status: "OPEN",
    quantity: 75,
    remainingQuantity: 75,
    entryPrice: 180,
    stopLoss: 120,
    targetPrice: 260,
    openedAt: new Date("2026-07-28T10:00:00.000Z"),
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    fees: 0,
    slippage: 0,
    notes: "",
    optionStrike: 24000,
    optionExpiry: new Date("2026-08-07T10:00:00.000Z"),
    optionType: "CE",
    underlyingSymbol: "NIFTY50",
    entryIv: 0.12,
    ...overrides,
  };
}

function stubRepo(trade: PaperTrade, closings: ClosePaperTradeInput[]): PaperTradeRepository {
  return {
    openFromTradeIdea: async () => { throw new Error("not used"); },
    findOpenById: async () => trade,
    listOpenByAccount: async () => [trade],
    listPendingByAccount: async () => [],
    fillPendingTrade: async () => { throw new Error("not used"); },
    close: async (input) => {
      closings.push(input);
      return {
        ...trade,
        status: "CLOSED",
        closedAt: input.closedAt,
        exitPrice: input.exitPrice,
        exitReason: input.exitReason,
        realizedPnl: 0,
      };
    },
    executeExitSlice: async () => { throw new Error("not used"); },
    listPartialExitsByTradeId: async () => [],
    findAccountPerformanceData: async () => null,
  };
}

describe("ClosePaperTrade", () => {
  it("threads a caller-supplied underlyingExitPrice through to the repository", async () => {
    // The UI's manual close resolves a live underlying spot via `valuePaperTrade` before calling
    // this use case. That observation must reach `underlying_exit_price`, not just sit in the
    // valuation-details blob the route also passes.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionTrade();

    await new ClosePaperTrade(stubRepo(trade, closings)).execute({
      paperTradeId: trade.id,
      exitPrice: 205,
      exitPriceSource: "SERVER_OPTION_MARK",
      underlyingExitPrice: 24_075,
    });

    expect(closings).toHaveLength(1);
    expect(closings[0]!.underlyingExitPrice).toBe(24_075);
  });

  it("leaves underlying_exit_price null on a bare manual close with no observation", async () => {
    // The CLI close script (and any caller that never resolved a live valuation) supplies no
    // underlying price at all -- inventing one here would be indistinguishable from a real
    // observation, exactly what migration 089/090 refuse to do.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionTrade();

    await new ClosePaperTrade(stubRepo(trade, closings)).execute({
      paperTradeId: trade.id,
      exitPrice: 205,
    });

    expect(closings).toHaveLength(1);
    expect(closings[0]!.underlyingExitPrice).toBeNull();
  });
});
