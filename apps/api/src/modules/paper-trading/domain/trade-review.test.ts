import { describe, expect, it } from "vitest";
import { buildTradeReview, type TradeReviewInput } from "./trade-review.js";

/** A 1R-risk long: entry 100, stop 95, target 105, one unit. */
function longTrade(overrides: Partial<TradeReviewInput> = {}): TradeReviewInput {
  return {
    tradeId: "trade-1",
    side: "LONG",
    quantity: 1,
    entryPrice: 100,
    exitPrice: 105,
    stopLoss: 95,
    targetPrice: 105,
    realizedPnl: 5,
    exitReason: "TARGET",
    candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 106, low: 99 }],
    observedTimeframe: "1d",
    ...overrides,
  };
}

describe("buildTradeReview", () => {
  it("expresses the outcome in multiples of the trade's own initial risk", () => {
    const review = buildTradeReview(longTrade({ quantity: 10, realizedPnl: 50 }));

    // 5 points of risk on 10 units is 50 at risk, so +50 is exactly 1R.
    expect(review.riskPerUnit).toBe(5);
    expect(review.realizedR).toBe(1);
    expect(review.outcome).toBe("WIN");
  });

  it("measures excursions from candle extremes, on the side that matters", () => {
    const review = buildTradeReview(longTrade({
      candles: [
        { openTime: new Date("2026-01-05T09:15:00.000Z"), high: 103, low: 97 },
        { openTime: new Date("2026-01-06T09:15:00.000Z"), high: 107.5, low: 99 },
      ],
    }));

    // Best high 107.5 is +1.5R; worst low 97 is -0.6R against a 5-point risk.
    expect(review.maximumFavourableExcursion).toBe(7.5);
    expect(review.maximumFavourableExcursionR).toBe(1.5);
    expect(review.maximumAdverseExcursion).toBe(3);
    expect(review.maximumAdverseExcursionR).toBe(0.6);
  });

  it("mirrors the excursion sides for a short", () => {
    const review = buildTradeReview(longTrade({
      side: "SHORT",
      entryPrice: 100,
      stopLoss: 105,
      targetPrice: 95,
      exitPrice: 95,
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 102, low: 92 }],
    }));

    // Down is favourable for a short: 100 -> 92 is +1.6R, 100 -> 102 is -0.4R.
    expect(review.maximumFavourableExcursionR).toBe(1.6);
    expect(review.maximumAdverseExcursionR).toBe(0.4);
  });

  it("never reports a negative excursion when price only moved one way", () => {
    const review = buildTradeReview(longTrade({
      // Never traded below the entry, so there is no adverse excursion at all.
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 104, low: 100.5 }],
    }));

    expect(review.maximumAdverseExcursion).toBe(0);
    expect(review.maximumAdverseExcursionR).toBe(0);
  });

  it("states the recorded exit reason instead of inferring it from the P&L sign", () => {
    const review = buildTradeReview(longTrade({ exitReason: "MANUAL", realizedPnl: 3, exitPrice: 103 }));

    // The previous implementation called every profitable close "hit Target Profit",
    // which mislabelled all three of this database's profitable manual closes.
    expect(review.observations[0]).toContain("Closed MANUAL");
    expect(review.observations.join(" ")).not.toContain("Target Profit");
    expect(review.proposedResearchTags).toContain("EXIT_OUTSIDE_GEOMETRY");
  });

  it("flags a loser that was a winner first", () => {
    const review = buildTradeReview(longTrade({
      exitReason: "STOP_LOSS",
      exitPrice: 95,
      realizedPnl: -5,
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 106, low: 94 }],
    }));

    expect(review.maximumFavourableExcursionR).toBe(1.2);
    expect(review.proposedResearchTags).toContain("GAVE_BACK_FAVOURABLE_MOVE");
  });

  it("flags a winner that finished well below its favourable peak", () => {
    // Reached 3R, banked 2R. A real trade in this database did exactly this, and the
    // loser-only giveback check left it invisible.
    const review = buildTradeReview(longTrade({
      exitPrice: 110,
      realizedPnl: 10,
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 115, low: 100 }],
    }));

    expect(review.realizedR).toBe(2);
    expect(review.maximumFavourableExcursionR).toBe(3);
    expect(review.proposedResearchTags).toContain("EXITED_BELOW_PEAK");
  });

  it("does not flag a winner that banked most of its favourable move", () => {
    const review = buildTradeReview(longTrade({
      exitPrice: 105,
      realizedPnl: 5,
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 105.5, low: 100 }],
    }));

    expect(review.proposedResearchTags).not.toContain("EXITED_BELOW_PEAK");
  });

  it("flags a winner that nearly took the stop out first", () => {
    const review = buildTradeReview(longTrade({
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 106, low: 95.4 }],
    }));

    expect(review.maximumAdverseExcursionR).toBe(0.92);
    expect(review.proposedResearchTags).toContain("STOP_NEARLY_HIT");
  });

  it("flags a loss larger than the stop should have allowed", () => {
    // Gapped through the stop: 2R lost against a 1R stop.
    const review = buildTradeReview(longTrade({
      exitReason: "STOP_LOSS",
      exitPrice: 90,
      realizedPnl: -10,
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 100, low: 89 }],
    }));

    expect(review.realizedR).toBe(-2);
    expect(review.proposedResearchTags).toContain("LOSS_EXCEEDED_STOP");
  });

  it("does not call ordinary cost drag a violated stop", () => {
    // A clean stop fill minus fees is a touch worse than -1R and must stay unflagged.
    const review = buildTradeReview(longTrade({
      exitReason: "STOP_LOSS",
      exitPrice: 95,
      realizedPnl: -5.2,
      candles: [{ openTime: new Date("2026-01-05T09:15:00.000Z"), high: 100, low: 95 }],
    }));

    expect(review.realizedR).toBe(-1.04);
    expect(review.proposedResearchTags).not.toContain("LOSS_EXCEEDED_STOP");
  });

  it("reports honestly when no holding-period candles exist", () => {
    const review = buildTradeReview(longTrade({ candles: [], observedTimeframe: null }));

    expect(review.maximumAdverseExcursion).toBeNull();
    expect(review.maximumFavourableExcursionR).toBeNull();
    expect(review.candlesObserved).toBe(0);
    expect(review.proposedResearchTags).toContain("NO_HOLDING_PERIOD_DATA");
    // Absent data must not masquerade as a measured zero.
    expect(review.proposedResearchTags).not.toContain("NO_FOLLOW_THROUGH");
  });

  it("records the timeframe the excursions were read at, since it sets their precision", () => {
    const daily = buildTradeReview(longTrade({ observedTimeframe: "1d" }));
    const minute = buildTradeReview(longTrade({ observedTimeframe: "1m" }));

    expect(daily.observedTimeframe).toBe("1d");
    expect(minute.observations.join(" ")).toContain("1m candle(s)");
  });

  it("refuses a trade whose stop sits on its entry, which has no risk to measure against", () => {
    expect(() => buildTradeReview(longTrade({ stopLoss: 100 })))
      .toThrow(/stop loss different from the entry price/);
  });
});
