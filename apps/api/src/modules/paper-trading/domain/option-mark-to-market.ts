import {
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
} from "@ai-quant-lab/pricing";
import { floorLivePremiumToTick } from "../../pricing/domain/option-tick.js";
import type { CompletedPriceCandle, ExitFillRule, PaperTradeExitDecision } from "./paper-trade-exit-policy.js";
import type { PaperTrade, PaperTradeEventType, PaperTradeExitReason } from "./paper-trading.js";

import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";

export interface OptionMarkInput {
  trade: PaperTrade;
  spot: number;
  asOf: Date;
  volatility: number;
  riskFreeRate?: number;
}

export interface OptionMark {
  /**
   * The tradable mark: the model premium floored to the 0.05 tick while the contract is
   * live, and the raw settlement value at or after expiry.
   *
   * Differs from `greeks.premium` only when the model price falls below one tick.
   * `greeks.premium` is the unmodified Black-Scholes output and is kept as such so the
   * model and the quote it implies stay separable.
   */
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
    riskFreeRate: input.riskFreeRate ?? RISK_FREE_RATE,
    volatility: input.volatility,
    optionType: input.trade.optionType!,
  });

  return {
    premium: floorLivePremiumToTick(greeks.premium, timeToExpiryYears),
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

/** One dense observation of the contract's sellable price. */
export interface ObservedPremiumSample {
  observedAt: Date;
  /** The bid. A long option is exited by selling into it, so it is the executable price. */
  bid: number | null;
  /**
   * The underlying's level as published alongside this quote, or null when the provider sent none.
   *
   * Carried so an exit can record where the underlying stood at the instant the barrier was crossed
   * -- the counterpart to `underlying_entry_price`, which had none. Reading it from the crossing
   * sample is what makes it point-in-time correct: the alternative, the underlying's 1m candle close
   * around the exit, is a future value mid-bar.
   */
  underlyingValue?: number | null;
}

export interface ObservedPremiumExitDecision {
  reason: Extract<PaperTradeExitReason, "STOP_LOSS" | "TARGET">;
  eventType: Extract<PaperTradeEventType, "STOP_LOSS_HIT" | "TARGET_HIT">;
  /** The observed bid itself, not the barrier level. See the note below on gapping. */
  exitPrice: number;
  fillRule: Extract<ExitFillRule, "OBSERVED_TICK_STOP" | "OBSERVED_TICK_TARGET">;
  observedAt: Date;
  /**
   * The underlying's level on the crossing sample, or null when the provider published none.
   *
   * Returned rather than looked up again by the caller, because "the sample that crossed" is decided
   * here and re-finding it by timestamp would be a second, separately-fallible answer to a question
   * this function has already settled.
   */
  underlyingValue: number | null;
}

/**
 * The first observed premium to cross a protective level, scanning oldest to newest.
 *
 * This is the answer to "was the barrier traded through between two evaluations?", using prices
 * the provider actually published. It replaces the job that
 * `priceOptionMarksAtOhlc` + `decideOptionBuyerExit` were doing badly: those reprice the
 * *underlying's* OHLC through Black-Scholes and were measured ~10% below the real book on a stop
 * sitting 4% from entry, so their error exceeded the distance being resolved.
 *
 * **Oldest-first is the whole point.** A position exits at the first moment a barrier was
 * reached, not at the most recent sample -- taking the latest tick would let a level that was
 * touched and recovered from go unrecorded, which is how a stop silently fails to fire.
 *
 * **Exits at the observed bid, not the barrier level.** `decideOptionBuyerExit` returns
 * `trade.stopLoss` for an intrabar stop, which models a resting order filling exactly at its
 * trigger. That is not available here and pretending otherwise would overstate the exit: when a
 * premium gaps from above the stop straight to well below it, the sellable price is the printed
 * bid. Reporting the bid keeps the fill honest in the direction that costs the account money.
 *
 * Samples without a positive bid are skipped rather than treated as a zero. A missing or
 * zero-sized bid means no buyer was quoted -- a data gap, or a market with no liquidity at all --
 * and reading it as "the premium is worth nothing" would fire a stop on absent data, which is the
 * opposite of what an observed-price check is for.
 */
export function decideOptionBuyerObservedExit(
  trade: PaperTrade,
  samples: readonly ObservedPremiumSample[],
  options: { stopLossEffectiveAt?: Date } = {},
): ObservedPremiumExitDecision | null {
  if (trade.status !== "OPEN") {
    throw new Error("Only open paper trades can be evaluated for exits.");
  }
  if (trade.side !== "LONG") {
    throw new Error("Option-buyer dynamic evaluation only supports LONG premium positions.");
  }
  if (options.stopLossEffectiveAt !== undefined
    && Number.isNaN(options.stopLossEffectiveAt.getTime())) {
    throw new Error("Stop-loss effective timestamp is invalid.");
  }

  for (const sample of samples) {
    const bid = sample.bid;
    if (bid === null || !Number.isFinite(bid) || bid <= 0) continue;
    // A tightened stop must not be projected backward over old observations. Targets are not
    // mutable, so they remain active for the position's whole lifetime and are still checked on
    // samples before the current stop's effective time.
    const stopWasActive = options.stopLossEffectiveAt === undefined
      || sample.observedAt.getTime() >= options.stopLossEffectiveAt.getTime();
    if (stopWasActive && bid <= trade.stopLoss) {
      return {
        reason: "STOP_LOSS",
        eventType: "STOP_LOSS_HIT",
        exitPrice: bid,
        fillRule: "OBSERVED_TICK_STOP",
        observedAt: sample.observedAt,
        underlyingValue: sample.underlyingValue ?? null,
      };
    }
    if (bid >= trade.targetPrice) {
      return {
        reason: "TARGET",
        eventType: "TARGET_HIT",
        exitPrice: bid,
        fillRule: "OBSERVED_TICK_TARGET",
        observedAt: sample.observedAt,
        underlyingValue: sample.underlyingValue ?? null,
      };
    }
  }
  return null;
}

/**
 * Option-buyer exits compare live premium marks to entry-time ₹ premium SL/TP.
 * Conservative when both stop and target are touched in the same bar: stop wins.
 */
export function decideOptionBuyerExit(
  trade: PaperTrade,
  candle: CompletedPriceCandle,
  marks: OptionCandleMarks,
  options?: { premiumToleranceFraction?: number },
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

  // Trap Detection at candle close
  if (trade.underlyingEntryPrice) {
    const favorableMove = trade.optionType === "CE"
      ? candle.close - trade.underlyingEntryPrice
      : trade.underlyingEntryPrice - candle.close;
    
    const minFavorableMove = trade.underlyingEntryPrice * 0.0005;
    
    if (favorableMove >= minFavorableMove
      && marks.close < trapPremiumFloor(trade.entryPrice, options?.premiumToleranceFraction)) {
      return {
        reason: "TRAP_DETECTED",
        eventType: "TRAP_DETECTED",
        exitPrice: marks.close,
        fillRule: "TRAP_DETECTED",
        candleId: candle.id,
      };
    }
  }

  return null;
}

/**
 * How far below the entry premium a mark must sit before it counts as "failed to rise".
 *
 * An option buyer fills at the **ask** and the position is marked at the **mid**, so a fresh
 * position is already below its entry by half the spread with nothing having happened --
 * measured on a live BANKNIFTY 57700 CE, entry 752.75 against a mark of 748.25, or 0.6%.
 * Comparing `mark <= entry` therefore reported "premium failed to rise" on the very first
 * evaluation of every trade, leaving the trap resting entirely on the favourable-move test.
 *
 * 1% of the entry premium is a deliberate approximation of that asymmetry, sized from the
 * measurement: that book was bid 743.75 / ask 752.75, a 1.20% spread and so a 0.60% half. A
 * first attempt at 0.5% did not even cover its own example. Observed half-spreads range from
 * about 0.12% (NIFTY ATM intraday) to well over 1% (BANKNIFTY after the close), so no single
 * number fits: 1% errs toward firing *late*, which is the safer direction for a check whose
 * failure mode was closing positions that had merely been opened.
 *
 * The exact fix is to persist the mark taken at entry and compare against that. Until a trade
 * carries one, this keeps the trigger off the spread alone; callers holding a real spread can
 * override it.
 */
export const TRAP_PREMIUM_TOLERANCE_FRACTION = 0.01;

/** The premium a mark must fall strictly below before the trap treats it as not rising. */
export function trapPremiumFloor(entryPrice: number, toleranceFraction?: number): number {
  const fraction = toleranceFraction ?? TRAP_PREMIUM_TOLERANCE_FRACTION;
  return entryPrice * (1 - Math.max(0, fraction));
}

/** Live single-print check against premium SL/TP, and Trap Detection. */
export function decideOptionBuyerLiveExit(
  trade: PaperTrade,
  markPremium: number,
  liveSpot?: number,
  options?: { premiumToleranceFraction?: number },
): { reason: "STOP_LOSS" | "TARGET" | "TRAP_DETECTED"; eventType: "STOP_LOSS_HIT" | "TARGET_HIT" | "TRAP_DETECTED"; exitPrice: number } | null {
  if (trade.side !== "LONG") {
    throw new Error("Option-buyer dynamic evaluation only supports LONG premium positions.");
  }
  if (markPremium <= trade.stopLoss) {
    return { reason: "STOP_LOSS", eventType: "STOP_LOSS_HIT", exitPrice: markPremium };
  }
  if (markPremium >= trade.targetPrice) {
    return { reason: "TARGET", eventType: "TARGET_HIT", exitPrice: markPremium };
  }

  // Trap Detection: Divergence between underlying movement and option premium
  if (liveSpot !== undefined && trade.underlyingEntryPrice) {
    const favorableMove = trade.optionType === "CE"
      ? liveSpot - trade.underlyingEntryPrice
      : trade.underlyingEntryPrice - liveSpot;
    
    // Require at least a 0.05% favorable move in the underlying
    const minFavorableMove = trade.underlyingEntryPrice * 0.0005;
    
    // Strictly below the floor, so a mark sitting exactly at the entry mid -- which is where
    // every position starts -- is not read as a premium that failed to rise.
    if (favorableMove >= minFavorableMove
      && markPremium < trapPremiumFloor(trade.entryPrice, options?.premiumToleranceFraction)) {
      return { reason: "TRAP_DETECTED", eventType: "TRAP_DETECTED", exitPrice: markPremium };
    }
  }

  return null;
}
