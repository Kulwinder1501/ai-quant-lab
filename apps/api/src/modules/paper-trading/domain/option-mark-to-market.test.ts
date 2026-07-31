import { describe, expect, it } from "vitest";
import {
  decideOptionBuyerExit,
  decideOptionBuyerLiveExit,
  isOptionBuyerTrade,
  priceOptionMark,
  priceOptionMarksAtOhlc,
} from "./option-mark-to-market.js";
import type { PaperTrade } from "./paper-trading.js";
import type { CompletedPriceCandle } from "./paper-trade-exit-policy.js";

function optionTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "t1",
    accountId: "a1",
    tradeIdeaId: "i1",
    instrumentId: "inst1",
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

describe("option-mark-to-market", () => {
  it("detects option-buyer trades only when contract fields are complete", () => {
    expect(isOptionBuyerTrade(optionTrade())).toBe(true);
    expect(isOptionBuyerTrade(optionTrade({ optionStrike: null }))).toBe(false);
  });

  it("drops premium as time to expiry shrinks with spot and IV fixed (theta)", () => {
    const trade = optionTrade();
    const early = priceOptionMark({
      trade,
      spot: 24000,
      asOf: new Date("2026-07-28T10:00:00.000Z"),
      volatility: 0.12,
    });
    const later = priceOptionMark({
      trade,
      spot: 24000,
      asOf: new Date("2026-08-05T10:00:00.000Z"),
      volatility: 0.12,
    });
    expect(later.premium).toBeLessThan(early.premium);
    expect(later.timeToExpiryYears).toBeLessThan(early.timeToExpiryYears);
  });

  it("drops premium when IV crushes with spot and T fixed (vega)", () => {
    const trade = optionTrade();
    const asOf = new Date("2026-07-30T10:00:00.000Z");
    const highIv = priceOptionMark({ trade, spot: 24000, asOf, volatility: 0.18 });
    const lowIv = priceOptionMark({ trade, spot: 24000, asOf, volatility: 0.08 });
    expect(lowIv.premium).toBeLessThan(highIv.premium);
  });

  it("returns intrinsic-only mark at and after expiry", () => {
    const trade = optionTrade({ optionExpiry: new Date("2026-08-01T10:00:00.000Z") });
    const mark = priceOptionMark({
      trade,
      spot: 24100,
      asOf: new Date("2026-08-01T10:00:00.000Z"),
      volatility: 0.12,
    });
    expect(mark.premium).toBe(100);
    expect(mark.greeks.timeValue).toBe(0);
    expect(mark.timeToExpiryYears).toBe(0);
  });

  it("fires premium stop from live mark without requiring spot move", () => {
    const trade = optionTrade({ stopLoss: 150, targetPrice: 300, entryPrice: 200 });
    expect(decideOptionBuyerLiveExit(trade, 140)).toMatchObject({
      reason: "STOP_LOSS",
      exitPrice: 140,
    });
    expect(decideOptionBuyerLiveExit(trade, 310)).toMatchObject({
      reason: "TARGET",
      exitPrice: 310,
    });
    expect(decideOptionBuyerLiveExit(trade, 180)).toBeNull();
  });

  it("uses conservative stop-first when OHLC marks touch both barriers", () => {
    const trade = optionTrade({ stopLoss: 100, targetPrice: 200, entryPrice: 150 });
    const candle: CompletedPriceCandle = {
      id: "c1",
      openTime: new Date("2026-07-29T03:45:00.000Z"),
      closeTime: new Date("2026-07-29T10:00:00.000Z"),
      open: 24000,
      high: 24200,
      low: 23800,
      close: 24100,
    };
    const decision = decideOptionBuyerExit(trade, candle, {
      open: 150,
      high: 210,
      low: 90,
      close: 160,
    });
    expect(decision).toMatchObject({
      reason: "STOP_LOSS",
      fillRule: "CONSERVATIVE_STOP_FIRST",
      exitPrice: 100,
    });
  });

  it("prices OHLC marks from the black-scholes engine", () => {
    const trade = optionTrade();
    const candle: CompletedPriceCandle = {
      id: "c1",
      openTime: new Date("2026-07-29T03:45:00.000Z"),
      closeTime: new Date("2026-07-29T10:00:00.000Z"),
      open: 24000,
      high: 24100,
      low: 23900,
      close: 24050,
    };
    const marks = priceOptionMarksAtOhlc({ trade, candle, volatility: 0.12 });
    expect(marks.high).toBeGreaterThan(marks.low);
    expect(marks.close).toBeGreaterThan(0);
  });
});
