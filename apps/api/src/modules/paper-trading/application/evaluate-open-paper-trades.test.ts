import { describe, expect, it } from "vitest";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { EvaluateOpenPaperTrades } from "./evaluate-open-paper-trades.js";
import type { ClosePaperTradeInput, PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";

function openTrade(): PaperTrade {
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
    openedAt: new Date("2026-07-25T15:30:00.000Z"),
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    fees: 1,
    slippage: 0,
    notes: "",
  };
}

function candle(id: string, openTime: string, closeTime: string, open: number, high: number, low: number, close: number): PersistedCandle {
  return {
    id,
    instrumentId: "instrument-1",
    timeframe: "1d",
    openTime: new Date(openTime),
    closeTime: new Date(closeTime),
    open: String(open),
    high: String(high),
    low: String(low),
    close: String(close),
    volume: "1000",
    isComplete: true,
    source: "test",
    ingestionId: null,
    sourceMetadata: {},
  };
}

describe("EvaluateOpenPaperTrades", () => {
  it("skips the source bar and closes on the first later completed candle under the conservative policy", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const trade = openTrade();
    const paperTradeRepository: PaperTradeRepository = {
      openFromTradeIdea: async () => { throw new Error("not used"); },
      findOpenById: async () => trade,
      listOpenByAccount: async () => [trade],
      close: async (input) => {
        closings.push(input);
        return { ...trade, status: "CLOSED", closedAt: input.closedAt, exitPrice: input.exitPrice, exitReason: input.exitReason, realizedPnl: -53 };
      },
      findAccountPerformanceData: async () => null,
    };
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [
        candle("source", "2026-07-25T09:15:00.000Z", "2026-07-25T15:30:00.000Z", 100, 112, 94, 103),
        candle("later", "2026-07-26T09:15:00.000Z", "2026-07-26T15:30:00.000Z", 100, 112, 94, 103),
      ],
    };

    const result = await new EvaluateOpenPaperTrades(paperTradeRepository, candleRepository).execute({
      accountId: "account-1",
      asOf: new Date("2026-07-26T15:30:00.000Z"),
      exitFees: 2,
      exitSlippage: 0.5,
    });

    expect(result).toEqual({
      openTradesRead: 1,
      eligibleCandlesRead: 1,
      tradesClosed: 1,
      closedTradeIds: ["trade-1"],
      skippedWithoutTimeframe: 0,
    });
    expect(closings[0]).toMatchObject({
      paperTradeId: "trade-1",
      exitReason: "STOP_LOSS",
      exitPrice: 95,
      closedAt: new Date("2026-07-26T15:30:00.000Z"),
      exitFees: 2,
      exitSlippage: 0.5,
      details: expect.objectContaining({ candleId: "later", fillRule: "CONSERVATIVE_STOP_FIRST" }),
    });
  });
});
