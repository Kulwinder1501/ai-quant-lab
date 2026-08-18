import { describe, expect, it } from "vitest";
import type { CandleRepository, PersistedCandle } from "../../market-data/domain/candle.js";
import { EvaluateOpenPaperTrades } from "./evaluate-open-paper-trades.js";
import type { ClosePaperTradeInput, PaperTrade, PaperTradeRepository } from "../domain/paper-trading.js";
import { FixedImpliedVolatilitySource } from "../infrastructure/india-vix-implied-volatility-source.js";
import { priceOptionMark, priceOptionMarksAtOhlc } from "../domain/option-mark-to-market.js";
import type { CompletedPriceCandle } from "../domain/paper-trade-exit-policy.js";

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
    remainingQuantity: 10,
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
    executeExitSlice: async () => { throw new Error("not used"); },
    listPartialExitsByTradeId: async () => [],
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
    executeExitSlice: async () => { throw new Error("not used"); },
    listPartialExitsByTradeId: async () => [],
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

interface DenseSample {
  observedAt: Date;
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  underlyingValue: number | null;
}

function sample(observedAt: string, bid: number | null, underlyingValue: number | null = null): DenseSample {
  return {
    observedAt: new Date(observedAt),
    bid,
    ask: bid === null ? null : bid + 1.5,
    lastPrice: bid,
    underlyingValue,
  };
}

/**
 * A dense-reader stub.
 *
 * `series` defaults to empty so a test exercising only the point-in-time bid path does not
 * silently also exercise the barrier scan, which now runs ahead of it.
 */
function denseReader(latest: DenseSample | null, series: DenseSample[] = []) {
  return {
    latestForContract: async () => latest,
    listForContractBetween: async () => series,
  };
}

/** The same numeric view of a bar the evaluator builds internally, for asserting marks in a test. */
function toCandle(persisted: PersistedCandle): CompletedPriceCandle {
  return {
    id: persisted.id,
    openTime: persisted.openTime,
    closeTime: persisted.closeTime,
    open: Number(persisted.open),
    high: Number(persisted.high),
    low: Number(persisted.low),
    close: Number(persisted.close),
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
      executeExitSlice: async () => { throw new Error("not used"); },
      listPartialExitsByTradeId: async () => [],
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
    // Empty series, so this isolates the latest-bid path from the barrier scan above it.
    const densePremiums = denseReader(sample("2026-08-06T09:59:45.000Z", 145));

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


  it("lets a fresh bid govern HOLD, so the model cannot close what the real book keeps open", async () => {
    // Same fixture as the "closes on live BS mark" case: at this spot/time the theoretical mark
    // has crushed below the 150 stop, so the model path *would* close. But a fresh executable bid
    // of 200 sits above the stop and below the target -- the real market says hold. The model must
    // not override that. This is the `model-mark-flipped-pnl-sign` class of bug: a 179-point gap
    // between the model and the real quote once booked +Rs 2,032 on a losing position.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const spot = 24000;
    // Confirm the model really would have stopped out, so this test proves the override, not a
    // scenario where the model happened to agree.
    const mark = priceOptionMark({ trade, spot, asOf, volatility: 0.12 });
    expect(mark.premium).toBeLessThan(trade.stopLoss);

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    // The series holds too: every observed bid sits between the stop and the target.
    const densePremiums = denseReader(
      sample("2026-08-06T09:59:45.000Z", 200),
      [sample("2026-08-06T09:59:15.000Z", 198), sample("2026-08-06T09:59:45.000Z", 200)],
    );

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, livePrices: { NIFTY50: spot }, exitFees: 0 });

    // The fresh bid held, the model path was skipped, and nothing closed.
    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  it("lets a fresh bid govern HOLD against the completed-candle path too", async () => {
    // The regression. The HOLD test above passed while the bug was live, because its candle
    // repository is empty -- so the fresh bid only ever had to outrank the *live* model mark.
    // The completed-candle path below it was never gated, and it closes on the same kind of
    // theoretical premium.
    //
    // Measured on the AutoBot account 2026-08-13: a BANKNIFTY 57700 CE (entry 547.27, stop
    // 526.51, target 579.36) was booked STOP_LOSS at a theoretical 519.58 by
    // OPTION_COMPLETED_CANDLE_EVALUATOR while the dense book was bid 576-581 -- at the
    // position's own target. Same bar, both instruments: a NIFTY 24400 CE stopped by one paisa.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const spot = 24000;

    // A completed bar whose theoretical marks sit far below the stop, so this test proves the
    // gate rather than a scenario where the candle path happened to agree.
    const bar = candle("prior", "2026-08-05T09:15:00.000Z", "2026-08-05T10:00:00.000Z", spot, spot + 20, spot - 20, spot);
    const marks = priceOptionMarksAtOhlc({ trade, candle: toCandle(bar), volatility: 0.12 });
    expect(Math.min(marks.open, marks.high, marks.low, marks.close)).toBeLessThan(trade.stopLoss);

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [bar],
    };
    // Between the stop and the target, in the latest quote and across the whole series: the real
    // market says hold, so neither the barrier scan nor the point check may close this.
    const densePremiums = denseReader(
      sample("2026-08-06T09:59:45.000Z", 200, spot),
      [sample("2026-08-06T09:59:15.000Z", 198, spot), sample("2026-08-06T09:59:45.000Z", 200, spot)],
    );

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, livePrices: { NIFTY50: spot }, exitFees: 0 });

    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  it("closes on a barrier crossed between evaluations, at the observed bid and its own timestamp", async () => {
    // The gap the fresh-bid rule left open, now closed by observed data rather than by a model.
    // The premium dipped to 148 at 09:50 -- below the 150 stop -- and recovered to 200 by the time
    // this evaluator ran. A point-in-time reader sees only the 200 and holds forever, so the stop
    // never fires; the bot samples every five minutes against a book quoted twice a minute, so
    // most of the session is invisible to it.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const densePremiums = denseReader(sample("2026-08-06T09:59:45.000Z", 200), [
      sample("2026-08-06T09:49:30.000Z", 176),
      sample("2026-08-06T09:50:00.000Z", 148),
      sample("2026-08-06T09:55:00.000Z", 190),
      sample("2026-08-06T09:59:45.000Z", 200),
    ]);

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(1);
    expect(closings[0]).toMatchObject({
      exitReason: "STOP_LOSS",
      // The observed bid, not the 150 barrier: a resting order filling exactly at its trigger is
      // not available from a tick series, and claiming it would overstate the exit.
      exitPrice: 148,
      // The moment the barrier was crossed, not the moment the evaluator noticed.
      closedAt: new Date("2026-08-06T09:50:00.000Z"),
      details: expect.objectContaining({
        source: "OPTION_PREMIUM_TICK_SERIES",
        fillRule: "OBSERVED_TICK_STOP",
        samplesScanned: 4,
      }),
    });
  });

  it("takes the earliest barrier crossing when a later sample crosses the other way", async () => {
    // Ordering is the substance of the scan, not a detail. The premium stopped out at 09:50 and
    // only then ran to the target; closing on the target would invent a winning trade out of a
    // position that had already been stopped. Scanning newest-first, or taking the best price in
    // the window, both produce exactly that.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, targetPrice: 260, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const densePremiums = denseReader(sample("2026-08-06T09:59:45.000Z", 265), [
      sample("2026-08-06T09:50:00.000Z", 149),
      sample("2026-08-06T09:59:45.000Z", 265),
    ]);

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(closings[0]).toMatchObject({
      exitReason: "STOP_LOSS",
      exitPrice: 149,
      closedAt: new Date("2026-08-06T09:50:00.000Z"),
    });
  });

  it("does not read a missing bid as a premium worth nothing", async () => {
    // A null or zero bid means no buyer was quoted -- a collection gap, or a market with no
    // liquidity. Treating it as 0 would fire a stop on absent data, which is precisely the
    // fabrication an observed-price check exists to avoid.
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const densePremiums = denseReader(sample("2026-08-06T09:59:45.000Z", 200), [
      sample("2026-08-06T09:50:00.000Z", null),
      sample("2026-08-06T09:52:00.000Z", 0),
      sample("2026-08-06T09:59:45.000Z", 200),
    ]);

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  it("holds rather than inventing an exit when the production quote reader has no fresh bid", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const trade = optionBuyerTrade({ stopLoss: 150, entryPrice: 180 });
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const spot = 24000;
    const bar = candle("prior", "2026-08-05T09:15:00.000Z", "2026-08-05T10:00:00.000Z", spot, spot + 20, spot - 20, spot);

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [bar],
    };
    // A contract the dense collector never covered: no latest quote and no series at all.
    const densePremiums = denseReader(null);

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  it("never closes a new position from a quote observed before it opened", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const openedAt = new Date("2026-08-13T09:30:01.616Z");
    const trade = optionBuyerTrade({
      openedAt,
      optionExpiry: new Date("2026-08-18T10:00:00.000Z"),
      entryPrice: 124.65,
      stopLoss: 118.95,
      targetPrice: 133.54,
    });
    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    // The measured incident: this real bid was 34 seconds old and below the stop, but also
    // existed before the position. It cannot be an exit fill for a trade opened later.
    const densePremiums = denseReader(sample("2026-08-13T09:29:27.513Z", 65.65));

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf: openedAt, livePrices: { NIFTY50: 24_345.15 }, exitFees: 0 });

    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  it("isolates a trade it cannot evaluate instead of abandoning the rest of the batch", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const asOf = new Date("2026-08-06T10:00:00.000Z");
    const spot = 24000;

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

  it("exits with MOMENTUM_STALL on 5m timeframe if position has stalled for >= 20 mins and not reached +0.5R", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const openedAt = new Date("2026-08-06T09:15:00.000Z");
    const asOf = new Date("2026-08-06T09:36:00.000Z"); // 21 minutes later
    const trade = optionBuyerTrade({
      timeframe: "5m",
      openedAt,
      entryPrice: 180,
      stopLoss: 150, // Risk = 30; +0.5R threshold = 180 + 15 = 195
      // Reward 45 on risk 30 is 1.5R, inside the <= 1.6 band the stall applies to. This fixture
      // was 260 (2.67R), which the scalp gate excludes, so the test asserted a stall the
      // evaluator had deliberately stopped taking.
      targetPrice: 225,
    });

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    // Fresh bid of 185 (< 195 threshold)
    const densePremiums = denseReader(sample("2026-08-06T09:35:45.000Z", 185));

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(1);
    expect(closings[0]).toMatchObject({
      paperTradeId: "opt-1",
      exitReason: "MOMENTUM_STALL",
      exitPrice: 185,
      closedAt: asOf,
      details: expect.objectContaining({ source: "MOMENTUM_STALL_EVALUATOR" }),
    });
  });

  it("holds when position has run >= +0.5R even if elapsed time >= 20 mins", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const openedAt = new Date("2026-08-06T09:15:00.000Z");
    const asOf = new Date("2026-08-06T09:36:00.000Z"); // 21 minutes later
    const trade = optionBuyerTrade({
      timeframe: "5m",
      openedAt,
      entryPrice: 180,
      stopLoss: 150, // Risk = 30; +0.5R threshold = 195
      // 1.5R, so the scalp gate lets the stall apply and the +0.5R guard is what holds the
      // position. At the previous 2.67R this passed because the gate excluded the trade outright,
      // which meant it would have gone on passing even if the guard broke.
      targetPrice: 225,
    });

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    // Fresh bid of 200 (>= 195 threshold, and below the 225 target)
    const densePremiums = denseReader(sample("2026-08-06T09:35:45.000Z", 200));

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  // The scalp gate itself, which nothing asserted before. Its whole purpose is to let directional
  // setups sit through a flat twenty minutes, so without this the gate could be deleted and the
  // suite would stay green.
  it("does not stall out a directional setup, however flat it has gone", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const openedAt = new Date("2026-08-06T09:15:00.000Z");
    const asOf = new Date("2026-08-06T09:36:00.000Z"); // 21 minutes later
    const trade = optionBuyerTrade({
      timeframe: "5m",
      openedAt,
      entryPrice: 180,
      stopLoss: 150, // Risk = 30; +0.5R threshold = 195
      targetPrice: 260, // Reward 80 on risk 30 is 2.67R, outside the <= 1.6 scalp band
    });

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    // Same stalled conditions as the scalp case: 21 minutes elapsed and a bid short of +0.5R.
    const densePremiums = denseReader(sample("2026-08-06T09:35:45.000Z", 185));

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(0);
    expect(closings).toHaveLength(0);
  });

  // The band is inclusive, so exactly 1.6R is a scalp. Pins the comparison operator: with `<`
  // instead of `<=` this trade would be held and nothing else in the suite would notice.
  it("treats exactly 1.6R as a scalp and stalls it out", async () => {
    const closings: ClosePaperTradeInput[] = [];
    const openedAt = new Date("2026-08-06T09:15:00.000Z");
    const asOf = new Date("2026-08-06T09:36:00.000Z"); // 21 minutes later
    const trade = optionBuyerTrade({
      timeframe: "5m",
      openedAt,
      entryPrice: 180,
      stopLoss: 150, // Risk = 30; +0.5R threshold = 195
      targetPrice: 228, // Reward 48 on risk 30 is exactly 1.6R
    });

    const candleRepository: CandleRepository = {
      upsert: async () => { throw new Error("not used"); },
      findByKey: async () => null,
      listIncomplete: async () => [],
      listCompleted: async () => [],
    };
    const densePremiums = denseReader(sample("2026-08-06T09:35:45.000Z", 185));

    const result = await new EvaluateOpenPaperTrades(
      stubRepo(trade, closings),
      candleRepository,
      new FixedImpliedVolatilitySource(0.12),
      densePremiums,
    ).execute({ accountId: "account-1", asOf, exitFees: 0 });

    expect(result.tradesClosed).toBe(1);
    expect(closings[0]).toMatchObject({ exitReason: "MOMENTUM_STALL", exitPrice: 185 });
  });
});
