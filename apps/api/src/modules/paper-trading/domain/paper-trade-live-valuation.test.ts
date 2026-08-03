import { describe, expect, it } from "vitest";
import type { PaperTrade } from "./paper-trading.js";
import { valuePaperTrade } from "./paper-trade-live-valuation.js";

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
