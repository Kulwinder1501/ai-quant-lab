import { describe, expect, it } from "vitest";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { EvaluateOpenPaperTrades } from "./evaluate-open-paper-trades.js";
import type { ClosePaperTradeInput, PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";
import { FixedImpliedVolatilitySource } from "../infrastructure/india-vix-implied-volatility-source.js";
import { priceOptionMark } from "../domain/option-mark-to-market.js";

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

function optionBuyerTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
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

function stubRepoMany(trades: PaperTrade[], closings: ClosePaperTradeInput[]): PaperTradeRepository {
  return {
    openFromTradeIdea: async () => { throw new Error("not used"); },
    findOpenById: async () => trades[0],
    listOpenByAccount: async () => trades,
    listPendingByAccount: async () => [],
    fillPendingTrade: async () => { throw new Error("not used"); },
    close: async (input) => {
      closings.push(input);
      const match = trades.find((trade) => trade.id === input.paperTradeId)!;
      return {
        ...match,
        status: "CLOSED",
        closedAt: input.closedAt,
        exitPrice: input.exitPrice,
        exitReason: input.exitReason,
        realizedPnl: 0,
      };
    },
    findAccountPerformanceData: async () => null,
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
    findAccountPerformanceData: async () => null,
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
      listPendingByAccount: async () => [],
      fillPendingTrade: async () => { throw new Error("not used"); },
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
      pendingTradesRead: 0,
      eligibleCandlesRead: 1,
      tradesClosed: 1,
      closedTradeIds: ["trade-1"],
      pendingTradesFilled: 0,
      filledTradeIds: [],
      pendingTradesCancelled: 0,
      cancelledTradeIds: [],
      skippedWithoutTimeframe: 0,
      // A clean run reports no failures. Asserted as part of the exact shape so a trade
      // that silently could not be evaluated would fail this test.
      evaluationFailures: [],
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

  it("closes an option-buyer trade on live BS mark when theta/IV crush hits premium SL", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({
      // Tight stop so unchanged spot + elapsed time can breach it.
      stopLoss: 150,
      entryPrice: 180,
    });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const spot = 24000;
    const mark = priceOptionMark({
      trade,
      spot,
      asOf,
      volatility: 0.12,
    });
    expect(mark.premium).toBeLessThan(trade.stopLoss);

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
    ).execute({
      accountId: "account-1",
      asOf,
      livePrices: { NIFTY50: spot },
      exitFees: 0,
    });

    expect(result.tradesClosed).toBe(1);
    expect(closings[0]).toMatchObject({
      paperTradeId: "opt-1",
      exitReason: "STOP_LOSS",
      exitPrice: mark.premium,
      details: expect.objectContaining({ source: "OPTION_LIVE_MARK_EVALUATOR" }),
    });
  });

  it("prefers a fresh dense bid for option stops and exits at that sellable price", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const densePremiums = {
      latestForContract: async () => ({
        observedAt: new Date(asOf.getTime() - 15_000),
        bid: 145,
        ask: 147,
        lastPrice: 146,
        underlyingValue: null,
      }),
    };

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(1);
    expect(closings[0]).toMatchObject({
      exitPrice: 145,
      exitReason: "STOP_LOSS",
      details: expect.objectContaining({ source: "OPTION_PREMIUM_TICK_BID" }),
    });
  });


  it("isolates a trade it cannot evaluate instead of abandoning the rest of the batch", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const spot = 24000;

    // A SHORT carrying option columns is a contract the buyer-only path cannot model, so
    // it throws. The database now forbids the row (migration 023), but the evaluator must
    // still survive one: before this, the throw aborted the loop and every later trade
    // went unevaluated, leaving live stops unenforced while looking like an outage.
    const unmodellable = optionBuyerTrade({ id: "opt-bad", side: "SHORT" });
    const healthy = optionBuyerTrade({ id: "opt-good", stopLoss: 150, entryPrice: 180 });

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };

    const result = await new EvaluateOpenPaperTrades(
      stubRepoMany([unmodellable, healthy], closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
    ).execute({ accountId: "account-1", asOf, livePrices: { NIFTY50: spot }, exitFees: 0 });

    // The bad row is reported, not swallowed: an unevaluated trade has an unenforced stop.
    expect(result.evaluationFailures).toHaveLength(1);
    expect(result.evaluationFailures[0]).toMatchObject({ tradeId: "opt-bad" });
    expect(result.evaluationFailures[0].message).toMatch(/only supports LONG/);

    // And the trade after it was still evaluated and closed.
    expect(result.tradesClosed).toBe(1);
    expect(result.closedTradeIds).toEqual(["opt-good"]);
  });

  it("force-closes option-buyer trades at expiry settlement", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const expiry = new Date("2026-08-07T10:00:00.000Z");
    const trade = optionBuyerTrade({ optionExpiry: expiry, optionStrike: 24000 });
    const asOf = new Date("2026-08-07T10:05:00.000Z");

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
    ).execute({
      accountId: "account-1",
      asOf,
      livePrices: { NIFTY50: 23900 },
      exitFees: 0,
    });

    expect(result.tradesClosed).toBe(1);
    expect(closings[0]).toMatchObject({
      paperTradeId: "opt-1",
      exitReason: "EXPIRED",
      exitPrice: 0,
      details: expect.objectContaining({ source: "OPTION_EXPIRY_SETTLEMENT", eventType: "EXPIRED" }),
    });
  });
});
