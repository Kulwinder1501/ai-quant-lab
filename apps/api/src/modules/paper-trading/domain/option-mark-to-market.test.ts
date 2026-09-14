import { describe, expect, it } from "vitest";
import {
  TRAP_PREMIUM_TOLERANCE_FRACTION,
  decideOptionBuyerExit,
  decideOptionBuyerLiveExit,
  decideOptionBuyerObservedExit,
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

  it("does not apply a tightened stop to observations from before it became active", () => {
    const trade = optionTrade({ stopLoss: 170, targetPrice: 260, entryPrice: 180 });
    const stopLossEffectiveAt = new Date("2026-07-28T10:10:00.000Z");
    const decision = decideOptionBuyerObservedExit(trade, [
      { observedAt: new Date("2026-07-28T10:05:00.000Z"), bid: 160 },
      { observedAt: new Date("2026-07-28T10:11:00.000Z"), bid: 175 },
    ], { stopLossEffectiveAt });

    expect(decision).toBeNull();
  });

  it("still detects a target reached before the current stop became active", () => {
    const trade = optionTrade({ stopLoss: 170, targetPrice: 260, entryPrice: 180 });
    const decision = decideOptionBuyerObservedExit(trade, [
      { observedAt: new Date("2026-07-28T10:05:00.000Z"), bid: 265 },
    ], { stopLossEffectiveAt: new Date("2026-07-28T10:10:00.000Z") });

    expect(decision).toMatchObject({ reason: "TARGET", exitPrice: 265 });
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


/**
 * Trap detection: exit when the underlying moved the right way but the premium did not follow.
 *
 * Written after a review found the feature firing on the wrong things. Both defects were
 * invisible because no test exercised the trap branch at all.
 */
describe("trap detection", () => {
  // 24,000 spot, so the 0.05% gate is 12 points.
  const ENTRY_SPOT = 24_000;
  function trapTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
    return optionTrade({ entryPrice: 180, underlyingEntryPrice: ENTRY_SPOT, ...overrides });
  }

  it("fires when the underlying moved favourably and the premium fell", () => {
    // +20 points, past the 12-point gate, with the premium well below the entry floor.
    const decision = decideOptionBuyerLiveExit(trapTrade(), 150, ENTRY_SPOT + 20);

    expect(decision?.reason).toBe("TRAP_DETECTED");
    expect(decision?.exitPrice).toBe(150);
  });

  it("does not fire on a move too small to be a move", () => {
    expect(decideOptionBuyerLiveExit(trapTrade(), 150, ENTRY_SPOT + 5)).toBeNull();
  });

  it("does not fire when the premium rose with the underlying", () => {
    expect(decideOptionBuyerLiveExit(trapTrade(), 210, ENTRY_SPOT + 20)).toBeNull();
  });

  // The defect: an option buyer fills at the ask and is marked at the mid, so a fresh
  // position sits below its entry with nothing having happened -- measured 752.75 against
  // 748.25 on a live BANKNIFTY 57700 CE. `mark <= entry` made that read as "premium failed
  // to rise", so the trap rested entirely on the favourable-move test and closed positions
  // that had merely been opened.
  it("does not fire on the half-spread a position starts with", () => {
    const entryPrice = 752.75;
    const markAtEntryMid = 748.25;
    const trade = trapTrade({ entryPrice, stopLoss: 600, targetPrice: 1_100 });

    expect(decideOptionBuyerLiveExit(trade, markAtEntryMid, ENTRY_SPOT + 20)).toBeNull();
    // And a mark below that floor still trips it, so the guard has not disabled the feature.
    const belowFloor = entryPrice * (1 - TRAP_PREMIUM_TOLERANCE_FRACTION) - 0.01;
    expect(decideOptionBuyerLiveExit(trade, belowFloor, ENTRY_SPOT + 20)?.reason)
      .toBe("TRAP_DETECTED");
  });

  it("accepts a caller-supplied tolerance", () => {
    const trade = trapTrade({ entryPrice: 200, stopLoss: 100, targetPrice: 400 });

    // 10% tolerance: 185 is inside it, 175 is past it.
    expect(decideOptionBuyerLiveExit(trade, 185, ENTRY_SPOT + 20, {
      premiumToleranceFraction: 0.1,
    })).toBeNull();
    expect(decideOptionBuyerLiveExit(trade, 175, ENTRY_SPOT + 20, {
      premiumToleranceFraction: 0.1,
    })?.reason).toBe("TRAP_DETECTED");
  });

  // The other half of the same defect. `open-manual-option` set the anchor to the strike, so
  // an ITM contract read as though the underlying had already moved hundreds of points in its
  // favour and the trap fired on the first evaluation.
  it("does not treat an in-the-money strike as a favourable move that already happened", () => {
    const spot = 24_440;
    const anchoredOnSpot = trapTrade({ optionStrike: 24_000, underlyingEntryPrice: spot });

    // Nothing has moved: spot is exactly where it was at entry.
    expect(decideOptionBuyerLiveExit(anchoredOnSpot, 150, spot)).toBeNull();
  });

  it("skips trap detection entirely when no anchor was recorded", () => {
    // Preferred to guessing one: the position keeps its ordinary stop and target.
    const noAnchor = optionTrade({ entryPrice: 180, underlyingEntryPrice: null });

    // Mark kept above the 120 stop, so only the trap could have fired.
    expect(decideOptionBuyerLiveExit(noAnchor, 150, 24_500)).toBeNull();
  });

  it("applies the same rule at candle close", () => {
    const trade = trapTrade();
    const candle: CompletedPriceCandle = {
      id: "c-trap",
      openTime: new Date("2026-07-29T03:45:00.000Z"),
      closeTime: new Date("2026-07-29T04:00:00.000Z"),
      open: ENTRY_SPOT, high: ENTRY_SPOT + 25, low: ENTRY_SPOT - 5, close: ENTRY_SPOT + 20,
    };
    const marks = { open: 180, high: 185, low: 150, close: 150 };

    expect(decideOptionBuyerExit(trade, candle, marks)?.reason).toBe("TRAP_DETECTED");
    // Same candle, a close above the floor: not a trap.
    expect(decideOptionBuyerExit(trade, candle, { ...marks, close: 179 })).toBeNull();
  });

  it("still prefers a stop-loss over a trap when both would fire", () => {
    // The stop is the tighter statement: it names a price the trade was already committed to.
    const trade = trapTrade({ stopLoss: 160 });

    expect(decideOptionBuyerLiveExit(trade, 150, ENTRY_SPOT + 20)?.reason).toBe("STOP_LOSS");
  });
});
