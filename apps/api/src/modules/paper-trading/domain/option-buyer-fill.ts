import {
  nearestStrike,
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
  type OptionType,
} from "../../pricing/domain/black-scholes-engine.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

const DEFAULT_RISK_FREE_RATE = 0.07;

export interface OptionBuyerFillInput {
  /** Directional idea side: LONG → buy CE, SHORT → buy PE. */
  ideaSide: TradeSide;
  underlyingEntry: number;
  underlyingStop: number;
  underlyingTarget: number;
  impliedVolatility: number;
  expiryDate: Date;
  now?: Date;
  riskFreeRate?: number;
  /**
   * The instrument's strike interval, from `instruments.strike_step`.
   *
   * Required rather than inferred. This used to fall back to
   * `underlyingEntry >= 20000 ? 50 : 100`, and since both NIFTY and BANKNIFTY trade
   * above 20,000, BANKNIFTY received a 50-point step and produced strikes that do not
   * exist on the exchange. Two indices in the same price range cannot be separated by
   * a price threshold, so the caller supplies the contract specification.
   */
  strikeStep: number;
}

export interface OptionBuyerFill {
  optionType: OptionType;
  /** Paper trade side — always LONG for an option buyer. */
  side: "LONG";
  strike: number;
  fillPremium: number;
  stopPremium: number;
  targetPremium: number;
  entryGreeks: OptionGreeks;
  timeToExpiryYears: number;
}

/**
 * Maps an index directional idea onto an ATM option-buyer fill in premium space.
 * Stop/target are re-priced with the same strike/IV/expiry at the idea's
 * underlying stop and target levels so SL/TP evaluation stays in ₹ premium.
 */
export function mapIdeaToOptionBuyerFill(input: OptionBuyerFillInput): OptionBuyerFill {
  const now = input.now ?? new Date();
  const rate = input.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;
  const step = input.strikeStep;
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error("Strike step must be a positive number; read it from instruments.strike_step.");
  }
  const optionType: OptionType = input.ideaSide === "LONG" ? "CE" : "PE";
  const strike = nearestStrike(input.underlyingEntry, step);
  const T = yearsToExpiry(now, input.expiryDate);

  const entryGreeks = priceEuropeanOption({
    spot: input.underlyingEntry,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility: input.impliedVolatility,
    optionType,
  });
  const stopGreeks = priceEuropeanOption({
    spot: input.underlyingStop,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility: input.impliedVolatility,
    optionType,
  });
  const targetGreeks = priceEuropeanOption({
    spot: input.underlyingTarget,
    strike,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility: input.impliedVolatility,
    optionType,
  });

  const fillPremium = Math.max(0.05, entryGreeks.premium);
  let stopPremium = Math.max(0.05, stopGreeks.premium);
  let targetPremium = Math.max(0.05, targetGreeks.premium);

  // Guarantee LONG premium geometry even if IV surface quirks invert levels.
  if (!(stopPremium < fillPremium && fillPremium < targetPremium)) {
    const risk = Math.max(0.05, Math.abs(fillPremium - stopPremium) || fillPremium * 0.3);
    stopPremium = Math.max(0.05, roundMoney(fillPremium - risk));
    targetPremium = roundMoney(fillPremium + risk);
  }

  return {
    optionType,
    side: "LONG",
    strike,
    fillPremium: roundMoney(fillPremium),
    stopPremium: roundMoney(stopPremium),
    targetPremium: roundMoney(targetPremium),
    entryGreeks,
    timeToExpiryYears: T,
  };
}

/** Next weekly Thursday 15:30 IST approximated as UTC Thursday 10:00. */
export function defaultWeeklyExpiry(from: Date = new Date()): Date {
  const day = from.getUTCDay(); // 0 Sun … 4 Thu
  const daysUntilThu = (4 - day + 7) % 7 || 7;
  const expiry = new Date(Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate() + daysUntilThu,
    10,
    0,
    0,
    0,
  ));
  return expiry;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
