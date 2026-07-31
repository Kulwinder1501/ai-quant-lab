import {
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
} from "../../pricing/domain/black-scholes-engine.js";
import type { CompletedPriceCandle, PaperTradeExitDecision } from "./paper-trade-exit-policy.js";
import type { PaperTrade } from "./paper-trading.js";

const DEFAULT_RISK_FREE_RATE = 0.07;

export interface OptionMarkInput {
  trade: PaperTrade;
  spot: number;
  asOf: Date;
  volatility: number;
  riskFreeRate?: number;
}

export interface OptionMark {
  premium: number;
  greeks: OptionGreeks;
  timeToExpiryYears: number;
  spot: number;
  volatility: number;
  asOf: Date;
}

/** True when the trade carries a complete option-buyer contract for live repricing. */
export function isOptionBuyerTrade(trade: PaperTrade): boolean {
  return trade.optionStrike != null
    && trade.optionExpiry instanceof Date
    && !Number.isNaN(trade.optionExpiry.getTime())
    && (trade.optionType === "CE" || trade.optionType === "PE")
    && typeof trade.underlyingSymbol === "string"
    && trade.underlyingSymbol.length > 0;
}

/**
 * Black–Scholes mark of an open option-buyer position at a point in time.
 * Shrinking `T` and changing IV are what produce theta decay / IV crush.
 */
export function priceOptionMark(input: OptionMarkInput): OptionMark {
  if (!isOptionBuyerTrade(input.trade)) {
    throw new Error("Cannot mark a paper trade that has no option contract fields.");
  }
  if (!Number.isFinite(input.spot) || input.spot <= 0) {
    throw new Error("Spot must be a positive finite number.");
  }
  if (!Number.isFinite(input.volatility) || input.volatility <= 0) {
    throw new Error("Volatility must be a positive finite number.");
  }

  const timeToExpiryYears = yearsToExpiry(input.asOf, input.trade.optionExpiry!);
  const greeks = priceEuropeanOption({
    spot: input.spot,
    strike: input.trade.optionStrike!,
    timeToExpiryYears,
    riskFreeRate: input.riskFreeRate ?? DEFAULT_RISK_FREE_RATE,
    volatility: input.volatility,
    optionType: input.trade.optionType!,
  });

  return {
    premium: greeks.premium,
    greeks,
    timeToExpiryYears,
    spot: input.spot,
    volatility: input.volatility,
    asOf: input.asOf,
  };
}

export interface OptionCandleMarks {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Price the contract at each OHLC print of the underlying, sharing one as-of
 * (candle close) for T and one IV. Intrabar time path is unknowable from OHLC alone.
 *
 * **This biases every mark low, and the bias is not symmetric in its effect.** All four
 * prints are valued at the candle's *close*, but the high and the low were touched
 * somewhere inside the bar, when the option still held more time value. Valuing them at
 * the close therefore strips time value that genuinely existed at the moment the
 * underlying reached those extremes.
 *
 * For a long option that understates the premium throughout, which makes the stop easier
 * to reach and the target harder — conservative in both directions, and deliberately so,
 * matching `decidePaperTradeExit`'s stop-first convention. The consequence to remember
 * when reading results: **paper and backtest runs will overstate stop-outs and understate
 * targets relative to live trading.** Removing the bias needs intrabar ticks, not a
 * different formula, so it is documented rather than fixed.
 */
export function priceOptionMarksAtOhlc(input: {
  trade: PaperTrade;
  candle: CompletedPriceCandle;
  volatility: number;
  riskFreeRate?: number;
}): OptionCandleMarks {
  const asOf = input.candle.closeTime;
  const mark = (spot: number) => priceOptionMark({
    trade: input.trade,
    spot,
    asOf,
    volatility: input.volatility,
    riskFreeRate: input.riskFreeRate,
  }).premium;

  return {
    open: mark(input.candle.open),
    high: mark(input.candle.high),
    low: mark(input.candle.low),
    close: mark(input.candle.close),
  };
}

/**
 * Option-buyer exits compare live premium marks to entry-time ₹ premium SL/TP.
 * Conservative when both stop and target are touched in the same bar: stop wins.
 */
export function decideOptionBuyerExit(
  trade: PaperTrade,
  candle: CompletedPriceCandle,
  marks: OptionCandleMarks,
): PaperTradeExitDecision | null {
  if (trade.status !== "OPEN") {
    throw new Error("Only open paper trades can be evaluated for exits.");
  }
  if (trade.side !== "LONG") {
    throw new Error("Option-buyer dynamic evaluation only supports LONG premium positions.");
  }

  if (marks.open <= trade.stopLoss) {
    return {
      reason: "STOP_LOSS",
      eventType: "STOP_LOSS_HIT",
      exitPrice: marks.open,
      fillRule: "OPEN_GAP_STOP",
      candleId: candle.id,
    };
  }
  if (marks.open >= trade.targetPrice) {
    return {
      reason: "TARGET",
      eventType: "TARGET_HIT",
      exitPrice: marks.open,
      fillRule: "OPEN_GAP_TARGET",
      candleId: candle.id,
    };
  }

  const worst = Math.min(marks.open, marks.high, marks.low, marks.close);
  const best = Math.max(marks.open, marks.high, marks.low, marks.close);
  const hitStop = worst <= trade.stopLoss;
  const hitTarget = best >= trade.targetPrice;

  if (hitStop && hitTarget) {
    return {
      reason: "STOP_LOSS",
      eventType: "STOP_LOSS_HIT",
      exitPrice: trade.stopLoss,
      fillRule: "CONSERVATIVE_STOP_FIRST",
      candleId: candle.id,
    };
  }
  if (hitStop) {
    return {
      reason: "STOP_LOSS",
      eventType: "STOP_LOSS_HIT",
      exitPrice: trade.stopLoss,
      fillRule: "INTRABAR_STOP",
      candleId: candle.id,
    };
  }
  if (hitTarget) {
    return {
      reason: "TARGET",
      eventType: "TARGET_HIT",
      exitPrice: trade.targetPrice,
      fillRule: "INTRABAR_TARGET",
      candleId: candle.id,
    };
  }
  return null;
}

/** Live single-print check against premium SL/TP. */
export function decideOptionBuyerLiveExit(
  trade: PaperTrade,
  markPremium: number,
): { reason: "STOP_LOSS" | "TARGET"; eventType: "STOP_LOSS_HIT" | "TARGET_HIT"; exitPrice: number } | null {
  if (trade.side !== "LONG") {
    throw new Error("Option-buyer dynamic evaluation only supports LONG premium positions.");
  }
  if (markPremium <= trade.stopLoss) {
    return { reason: "STOP_LOSS", eventType: "STOP_LOSS_HIT", exitPrice: markPremium };
  }
  if (markPremium >= trade.targetPrice) {
    return { reason: "TARGET", eventType: "TARGET_HIT", exitPrice: markPremium };
  }
  return null;
}
