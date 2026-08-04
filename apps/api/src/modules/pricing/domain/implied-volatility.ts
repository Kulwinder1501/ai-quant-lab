import { priceEuropeanOption, type OptionType } from "./black-scholes-engine.js";

/**
 * Recovers implied volatility from an observed option premium.
 *
 * The chain provider quotes prices but not IV, so it has to be solved for. This is a
 * derived quantity and is labelled as one everywhere it surfaces: it is the volatility
 * that *would* reproduce the observed premium under Black-Scholes, not a number the
 * exchange published.
 *
 * Every failure mode returns a reason rather than a number. An unsolvable premium is
 * common and informative — an expired contract, a one-sided market, a stale quote below
 * intrinsic — and substituting a plausible IV would put a fabricated volatility onto a
 * screen a trade decision reads.
 */

export type ImpliedVolatilityRefusal =
  | "EXPIRED_OR_ZERO_TIME"
  | "NO_PREMIUM"
  | "BELOW_INTRINSIC"
  | "ABOVE_UPPER_BOUND"
  | "EXTRINSIC_BELOW_PRICE_RESOLUTION"
  | "DID_NOT_CONVERGE";

export type ImpliedVolatilityResult =
  | { measurable: true; impliedVolatility: number; iterations: number }
  | { measurable: false; reason: ImpliedVolatilityRefusal; explanation: string };

export interface ImpliedVolatilityInput {
  spot: number;
  strike: number;
  timeToExpiryYears: number;
  riskFreeRate: number;
  optionType: OptionType;
  /** The observed premium to invert. Prefer the mid of a two-sided quote. */
  premium: number;
}

/** Widest band the solver will search: 0.01% to 500% annualised. */
const MINIMUM_VOLATILITY = 0.0001;
const MAXIMUM_VOLATILITY = 5.0;
const PRICE_TOLERANCE = 1e-6;
const MAXIMUM_ITERATIONS = 100;

/**
 * The smallest extrinsic value an IV can honestly be solved from.
 *
 * All volatility information in a premium lives in its extrinsic part, and quotes arrive
 * rounded — the pricing engine to 0.01, NSE itself to a 0.05 tick. Measured on a deep
 * in-the-money NIFTY strike: premium 6067.19, intrinsic 6067.1894, so extrinsic 0.0006
 * against a 0.01 quantum. The rounding is roughly seventeen times the whole signal, and
 * the solver still returned a confident-looking 0.2826 for a true 0.22.
 *
 * That is the dangerous failure: not a refusal, but a plausible number with nothing
 * behind it, rendered next to genuine IVs on a screen a trade decision reads. One tick is
 * the floor below which the premium simply does not resolve volatility.
 */
const MINIMUM_EXTRINSIC_FOR_IV = 0.05;

function refuse(reason: ImpliedVolatilityRefusal, explanation: string): ImpliedVolatilityResult {
  return { measurable: false, reason, explanation };
}

/**
 * No-arbitrage bounds for a European option.
 *
 * A premium outside them cannot be produced by any volatility, so the solver must not be
 * asked to find one. In practice this catches stale or crossed quotes rather than genuine
 * arbitrage, which is exactly why it is reported instead of clamped.
 */
function priceBounds(input: ImpliedVolatilityInput): { lower: number; upper: number } {
  const discountedStrike = input.strike * Math.exp(-input.riskFreeRate * input.timeToExpiryYears);
  return input.optionType === "CE"
    ? { lower: Math.max(0, input.spot - discountedStrike), upper: input.spot }
    : { lower: Math.max(0, discountedStrike - input.spot), upper: discountedStrike };
}

/**
 * Solves for volatility by Newton-Raphson on vega, falling back to bisection.
 *
 * Newton converges in a handful of steps near the money, where vega is large. It becomes
 * unreliable in the wings — vega there approaches zero, so a Newton step divides by
 * almost nothing and can leap out of the search band. Bisection is slower but cannot
 * diverge, so a bracketed bisection backs it up rather than reporting a wing contract as
 * unsolvable.
 */
export function impliedVolatilityFromPremium(input: ImpliedVolatilityInput): ImpliedVolatilityResult {
  const { spot, strike, timeToExpiryYears, riskFreeRate, optionType, premium } = input;

  if (!Number.isFinite(spot) || spot <= 0 || !Number.isFinite(strike) || strike <= 0) {
    return refuse("NO_PREMIUM", "Spot and strike must both be positive to invert a premium.");
  }
  // Time is floored to zero once expiry passes, and at T=0 an option is worth exactly its
  // intrinsic value for *every* volatility, so nothing is recoverable. Observed live: a
  // NIFTY chain still listed its same-day expiry nearly three hours after that expiry.
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) {
    return refuse(
      "EXPIRED_OR_ZERO_TIME",
      "The contract has expired or has no time left, so its premium is intrinsic value and no "
      + "volatility can be recovered from it.",
    );
  }
  if (!Number.isFinite(premium) || premium <= 0) {
    return refuse("NO_PREMIUM", "No positive premium was observed, so there is nothing to invert.");
  }

  const bounds = priceBounds(input);
  if (premium < bounds.lower - PRICE_TOLERANCE) {
    return refuse(
      "BELOW_INTRINSIC",
      `The premium ${premium.toFixed(4)} is below the no-arbitrage floor ${bounds.lower.toFixed(4)}, `
      + "which no volatility can produce. Usually a stale or crossed quote rather than arbitrage.",
    );
  }
  if (premium > bounds.upper + PRICE_TOLERANCE) {
    return refuse(
      "ABOVE_UPPER_BOUND",
      `The premium ${premium.toFixed(4)} exceeds the no-arbitrage ceiling ${bounds.upper.toFixed(4)}.`,
    );
  }

  // Guarded before any iteration: the solver would happily converge on a rounded price
  // and return a number that describes the rounding rather than the market.
  const extrinsic = premium - bounds.lower;
  if (extrinsic < MINIMUM_EXTRINSIC_FOR_IV) {
    return refuse(
      "EXTRINSIC_BELOW_PRICE_RESOLUTION",
      `Only ${extrinsic.toFixed(4)} of this ${premium.toFixed(2)} premium is extrinsic, below the `
      + `${MINIMUM_EXTRINSIC_FOR_IV} floor one price tick allows. All volatility information lives in `
      + "the extrinsic part, so a solved IV here would describe the price rounding, not the market.",
    );
  }

  const priceAt = (volatility: number): number => priceEuropeanOption({
    spot,
    strike,
    timeToExpiryYears,
    riskFreeRate,
    volatility,
    optionType,
  }).premium;

  // Bracket first: if the premium sits outside what the widest band can produce, no
  // amount of iterating will find it, and saying so beats returning a boundary value.
  const lowPrice = priceAt(MINIMUM_VOLATILITY);
  const highPrice = priceAt(MAXIMUM_VOLATILITY);
  if (premium < lowPrice - PRICE_TOLERANCE) {
    return refuse(
      "BELOW_INTRINSIC",
      `The premium implies a volatility under ${(MINIMUM_VOLATILITY * 100).toFixed(2)}%, below the `
      + "search band. Treated as unmeasurable rather than reported as the floor.",
    );
  }
  if (premium > highPrice + PRICE_TOLERANCE) {
    return refuse(
      "ABOVE_UPPER_BOUND",
      `The premium implies a volatility over ${(MAXIMUM_VOLATILITY * 100).toFixed(0)}%, above the `
      + "search band. Treated as unmeasurable rather than reported as the ceiling.",
    );
  }

  // Newton-Raphson, seeded by a Brenner-Subrahmanyam style ATM approximation.
  let volatility = Math.min(
    MAXIMUM_VOLATILITY,
    Math.max(MINIMUM_VOLATILITY, (premium / spot) * Math.sqrt((2 * Math.PI) / timeToExpiryYears)),
  );
  for (let iteration = 1; iteration <= MAXIMUM_ITERATIONS; iteration += 1) {
    const greeks = priceEuropeanOption({
      spot, strike, timeToExpiryYears, riskFreeRate, volatility, optionType,
    });
    const difference = greeks.premium - premium;
    if (Math.abs(difference) < PRICE_TOLERANCE) {
      return { measurable: true, impliedVolatility: volatility, iterations: iteration };
    }
    // `vega` is reported per 1% of IV, so it is scaled back to a per-unit derivative.
    const vegaPerUnit = greeks.vega * 100;
    if (!Number.isFinite(vegaPerUnit) || Math.abs(vegaPerUnit) < 1e-10) break;
    const next = volatility - difference / vegaPerUnit;
    if (!Number.isFinite(next) || next <= MINIMUM_VOLATILITY || next >= MAXIMUM_VOLATILITY) break;
    if (Math.abs(next - volatility) < 1e-12) {
      return { measurable: true, impliedVolatility: next, iterations: iteration };
    }
    volatility = next;
  }

  // Bisection fallback. Cannot diverge, and the bracket was already proven above.
  let low = MINIMUM_VOLATILITY;
  let high = MAXIMUM_VOLATILITY;
  for (let iteration = 1; iteration <= MAXIMUM_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    const difference = priceAt(middle) - premium;
    if (Math.abs(difference) < PRICE_TOLERANCE || high - low < 1e-9) {
      return { measurable: true, impliedVolatility: middle, iterations: MAXIMUM_ITERATIONS + iteration };
    }
    if (difference > 0) high = middle;
    else low = middle;
  }

  return refuse(
    "DID_NOT_CONVERGE",
    "Neither Newton-Raphson nor bisection reached the premium within the iteration budget.",
  );
}

/**
 * The mid of a two-sided quote, which is the price IV should be solved from.
 *
 * Returns null for a one-sided market instead of falling back to the last traded price.
 * A last price can be hours stale on an illiquid strike, and an IV derived from it would
 * look identical to one derived from a live market while describing a different moment.
 */
export function midPriceForIv(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null) return null;
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  if (bid <= 0 || ask <= 0 || ask < bid) return null;
  return (bid + ask) / 2;
}
