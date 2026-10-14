import { describe, expect, it } from "vitest";
import type { PaperTrade } from "./paper-trading.js";
import { valuePaperTrade } from "./paper-trade-live-valuation.js";
import { RISK_FREE_RATE, priceEuropeanOption, yearsToExpiry } from "@ai-quant-lab/pricing";

function trade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: "e6913e2c-7cf0-4f03-b644-e2f17e34c9bc",
    accountId: "account-1",
    tradeIdeaId: "idea-1",
    instrumentId: "banknifty-id",
    instrumentSymbol: "BANKNIFTY",
    timeframe: "1d",
    side: "LONG",
    status: "OPEN",
    quantity: 30,
    remainingQuantity: 30,
    entryPrice: 154.99,
    stopLoss: 2.35,
    targetPrice: 1697.89,
    openedAt: new Date("2026-08-02T15:02:26.030Z"),
    closedAt: null,
    exitPrice: null,
    exitReason: null,
    realizedPnl: null,
    fees: 0,
    slippage: 0,
    notes: "Simulated LONG entry on BANKNIFTY",
    optionStrike: 57300,
    optionExpiry: new Date("2026-08-04T00:00:00.000Z"),
    optionType: "CE",
    underlyingSymbol: "BANKNIFTY",
    entryIv: 0.1176,
    ...overrides,
  };
}

describe("paper trade live valuation", () => {
  it("marks the reported BANKNIFTY position in option-premium space", () => {
    const position = trade();
    const valuation = valuePaperTrade({
      trade: position,
      livePrices: { BANKNIFTY: 57264.85 },
      asOf: position.openedAt,
      currentVolatility: 0.1176,
    });

    expect(valuation.status).toBe("AVAILABLE");
    expect(valuation.source).toBe("OPTION_MODEL");
    expect(valuation.underlyingPrice).toBe(57264.85);
    expect(valuation.markPrice).not.toBe(57264.85);
    expect(valuation.markPrice).toBeLessThan(1000);
    expect(valuation.unrealizedPnl).toBeCloseTo((valuation.markPrice! - 154.99) * 30, 8);
    expect(valuation.returnPercent).toBeCloseTo(
      (valuation.unrealizedPnl! / (154.99 * 30)) * 100,
      8,
    );
  });

  it("treats LONG as a long position rather than falling through to short logic", () => {
    const position = trade({
      optionStrike: null,
      optionExpiry: null,
      optionType: null,
      underlyingSymbol: null,
      entryIv: null,
      entryPrice: 100,
      quantity: 10,
    });
    const valuation = valuePaperTrade({
      trade: position,
      livePrices: { BANKNIFTY: 110 },
      asOf: new Date("2026-08-02T15:03:00.000Z"),
    });

    expect(valuation.source).toBe("UNDERLYING_SPOT");
    expect(valuation.unrealizedPnl).toBe(100);
    expect(valuation.returnPercent).toBe(10);
  });

  it("fails closed for partial option metadata instead of valuing it as spot", () => {
    const valuation = valuePaperTrade({
      trade: trade({ optionExpiry: null }),
      livePrices: { BANKNIFTY: 57264.85 },
      asOf: new Date("2026-08-02T15:03:00.000Z"),
      currentVolatility: 0.1176,
    });

    expect(valuation.status).toBe("UNAVAILABLE");
    expect(valuation.markPrice).toBeNull();
    expect(valuation.unrealizedPnl).toBeNull();
    expect(valuation.reason).toContain("incomplete");
  });

  it("uses persisted entry IV only when current India VIX is unavailable", () => {
    const valuation = valuePaperTrade({
      trade: trade(),
      livePrices: { BANKNIFTY: 57264.85 },
      asOf: new Date("2026-08-02T15:03:00.000Z"),
      currentVolatility: null,
    });

    expect(valuation.status).toBe("AVAILABLE");
    expect(valuation.volatility).toBe(0.1176);
    expect(valuation.volatilitySource).toBe("ENTRY_IV");
  });

  it("does not fabricate a mark when the underlying quote is unavailable", () => {
    const valuation = valuePaperTrade({
      trade: trade(),
      livePrices: {},
      asOf: new Date("2026-08-02T15:03:00.000Z"),
      currentVolatility: 0.1176,
    });

    expect(valuation.status).toBe("UNAVAILABLE");
    expect(valuation.markPrice).toBeNull();
    expect(valuation.reason).toContain("No live underlying price");
  });
});

describe("valuePaperTrade with an observed option-chain quote", () => {
  const asOf = new Date("2026-08-02T10:00:00.000Z");
  const optionTrade = () => trade({
    optionStrike: 57_300,
    optionExpiry: new Date("2026-08-25T10:00:00.000Z"),
    optionType: "CE",
    underlyingSymbol: "BANKNIFTY",
    entryPrice: 500,
    quantity: 15,
    entryIv: 0.12,
    openedAt: new Date(asOf.getTime() - 60 * 60 * 1000),
  });
  const prices = { BANKNIFTY: 57_907 };

  // An observed quote is a price someone was willing to trade at; the model is only an
  // estimate of one. The observed price must win.
  it("marks from the observed mid rather than the model", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: {
        mid: 888.5,
        bid: 886,
        ask: 891,
        observedAt: new Date(asOf.getTime() - 90 * 1000),
        impliedForward: 57_714,
      },
    });

    expect(result.source).toBe("OPTION_CHAIN_MID");
    expect(result.markPrice).toBeCloseTo(888.5, 6);
    // P&L follows the observed mark, not a model premium.
    expect(result.unrealizedPnl).toBeCloseTo((888.5 - 500) * 15, 4);
  });

  it("solves IV from the observed mid and reports greeks against it", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      observedQuote: {
        mid: 888.5, bid: 886, ask: 891,
        observedAt: asOf,
        impliedForward: 57_714,
      },
    });

    expect(result.volatilitySource).toBe("CHAIN_IMPLIED");
    expect(result.volatility).not.toBeNull();
    expect(result.greeks).not.toBeNull();
    // A call's delta sits strictly inside (0, 1); anything outside means the forward or
    // the inversion is wrong.
    expect(result.greeks!.delta).toBeGreaterThan(0);
    expect(result.greeks!.delta).toBeLessThan(1);
    // A long option pays theta.
    expect(result.greeks!.theta).toBeLessThan(0);
  });

  // The whole point of the change: the parity forward removes the carry error that put a
  // live BANKNIFTY forward 211 points above spot when the market priced it 193 below.
  it("produces a different delta with the parity forward than with spot", () => {
    const common = {
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      observedQuote: { mid: 888.5, bid: 886, ask: 891, observedAt: asOf },
    } as const;

    const withForward = valuePaperTrade({
      ...common,
      observedQuote: { ...common.observedQuote, impliedForward: 57_714 },
    });
    const withoutForward = valuePaperTrade({
      ...common,
      observedQuote: { ...common.observedQuote, impliedForward: null },
    });

    expect(withForward.greeks).not.toBeNull();
    expect(withoutForward.greeks).not.toBeNull();
    expect(withForward.greeks!.delta).not.toBeCloseTo(withoutForward.greeks!.delta, 3);
  });

  // A book from hours ago is not a mark. Falling back to the model is worse than a fresh
  // quote but better than pricing a live position off a stale one.
  it("falls back to the model when the quote is stale", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: {
        mid: 888.5, bid: 886, ask: 891,
        observedAt: new Date(asOf.getTime() - 3 * 60 * 60 * 1000),
        impliedForward: 57_714,
      },
    });

    expect(result.source).toBe("OPTION_MODEL");
  });

  // The reported defect: a call bought at the live ask of 575 at 12:02:42 was marked at 556.63, the mid of the
  // 11:53 snapshot -- older than the position -- and opened Rs 551 under water.
  it("does not mark a position from a quote older than the position itself", () => {
    const result = valuePaperTrade({
      trade: { ...optionTrade(), openedAt: new Date(asOf.getTime() - 30 * 1000) },
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: {
        mid: 556.63, bid: 556.05, ask: 557.2,
        observedAt: new Date(asOf.getTime() - 90 * 1000),
        impliedForward: 57_714,
      },
    });

    expect(result.source).toBe("OPTION_MODEL");
  });

  it("does not mark from a nine-minute-old snapshot, which the 40-minute limit used to accept", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: {
        mid: 556.63, bid: 556.05, ask: 557.2,
        observedAt: new Date(asOf.getTime() - 9 * 60 * 1000),
        impliedForward: 57_714,
      },
    });

    expect(result.source).toBe("OPTION_MODEL");
  });

  // After the close nothing is quoted, but the index is frozen at the last quote's level, so that quote is still the
  // price. The model at India VIX put a BANKNIFTY 55400 CE at 609 when its last quote was 653.
  describe("an old quote and the index", () => {
    const heldSinceYesterday = () => ({ ...optionTrade(), openedAt: new Date(asOf.getTime() - 19 * 60 * 60 * 1000) });
    const quotedAt = new Date(asOf.getTime() - 17 * 60 * 60 * 1000);
    const quotedIndex = 57_907;
    const quotedIv = 0.155;
    const quotedMid = priceEuropeanOption({
      spot: quotedIndex,
      strike: 57_300,
      timeToExpiryYears: yearsToExpiry(quotedAt, new Date("2026-08-25T10:00:00.000Z")),
      riskFreeRate: RISK_FREE_RATE,
      volatility: quotedIv,
      optionType: "CE",
    }).premium;
    const lastQuote = {
      mid: quotedMid, bid: quotedMid - 1, ask: quotedMid + 1,
      observedAt: quotedAt, impliedForward: null, underlyingValue: quotedIndex,
    };

    it("keeps the last quote as the mark while the index has not moved since", () => {
      const result = valuePaperTrade({
        trade: heldSinceYesterday(),
        livePrices: { BANKNIFTY: quotedIndex },
        asOf,
        currentVolatility: 0.1412,
        observedQuote: lastQuote,
      });

      expect(result.source).toBe("OPTION_CHAIN_MID");
      expect(result.markPrice).toBeCloseTo(quotedMid, 6);
      expect(result.reason).toContain("index is unchanged");
    });

    it("does not keep it once the index has moved, and prices the model at the volatility the quote implied", () => {
      const moved = quotedIndex * 1.005;
      const result = valuePaperTrade({
        trade: heldSinceYesterday(),
        livePrices: { BANKNIFTY: moved },
        asOf,
        currentVolatility: 0.1412,
        observedQuote: lastQuote,
      });

      expect(result.source).toBe("OPTION_MODEL");
      expect(result.volatilitySource).toBe("CHAIN_IMPLIED");
      expect(result.volatility).toBeCloseTo(quotedIv, 3);
      const expected = priceEuropeanOption({
        spot: moved,
        strike: 57_300,
        timeToExpiryYears: yearsToExpiry(asOf, new Date("2026-08-25T10:00:00.000Z")),
        riskFreeRate: RISK_FREE_RATE,
        volatility: quotedIv,
        optionType: "CE",
      }).premium;
      expect(result.markPrice!).toBeCloseTo(expected, 0);
    });

    it("falls back to India VIX only when there is no usable last quote", () => {
      const result = valuePaperTrade({
        trade: heldSinceYesterday(),
        livePrices: { BANKNIFTY: quotedIndex * 1.005 },
        asOf,
        currentVolatility: 0.1412,
        observedQuote: { ...lastQuote, underlyingValue: null },
      });

      expect(result.source).toBe("OPTION_MODEL");
      expect(result.volatilitySource).toBe("INDIA_VIX");
    });

    it("never anchors a quote from before the position was opened", () => {
      const result = valuePaperTrade({
        trade: { ...optionTrade(), openedAt: new Date(asOf.getTime() - 60 * 1000) },
        livePrices: { BANKNIFTY: quotedIndex },
        asOf,
        currentVolatility: 0.1412,
        observedQuote: lastQuote,
      });

      expect(result.source).toBe("OPTION_MODEL");
    });
  });

  it("falls back to the model when no quote is supplied", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: null,
    });

    expect(result.source).toBe("OPTION_MODEL");
  });

  // The live stream ticks several times a second, so a quote can land a moment after the request started. That
  // is a live quote, not a fault; refusing it flipped the mark between the market and the model.
  it("keeps the observed mark for a quote stamped a couple of seconds after the valuation instant", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: {
        mid: 888.5, bid: 886, ask: 891,
        observedAt: new Date(asOf.getTime() + 2 * 1000),
        impliedForward: 57_714,
      },
    });

    expect(result.source).toBe("OPTION_CHAIN_MID");
    expect(result.markPrice).toBeCloseTo(888.5, 6);
  });

  // A quote timestamped well after the valuation instant is a clock or data fault, and using
  // it would mark a position from the future.
  it("refuses a quote from the future", () => {
    const result = valuePaperTrade({
      trade: optionTrade(),
      livePrices: prices,
      asOf,
      currentVolatility: 0.12,
      observedQuote: {
        mid: 888.5, bid: 886, ask: 891,
        observedAt: new Date(asOf.getTime() + 60 * 1000),
        impliedForward: 57_714,
      },
    });

    expect(result.source).toBe("OPTION_MODEL");
  });

  // The mark is the market's price whether or not it can be inverted, so it stands even
  // when no greek can accompany it.
  it("keeps the observed mark when the mid cannot be inverted, with no greeks", () => {
    const expired = trade({
      optionStrike: 57_300,
      // Already expired at asOf, so no volatility can be recovered.
      optionExpiry: new Date("2026-08-01T10:00:00.000Z"),
      optionType: "CE",
      underlyingSymbol: "BANKNIFTY",
      entryPrice: 500,
      quantity: 15,
      openedAt: new Date(asOf.getTime() - 60 * 60 * 1000),
    });

    const result = valuePaperTrade({
      trade: expired,
      livePrices: prices,
      asOf,
      observedQuote: { mid: 610, bid: 608, ask: 612, observedAt: asOf, impliedForward: null },
    });

    expect(result.source).toBe("OPTION_CHAIN_MID");
    expect(result.markPrice).toBe(610);
    expect(result.greeks).toBeNull();
    expect(result.volatility).toBeNull();
    expect(result.reason).toMatch(/expired|intrinsic/i);
  });
});
