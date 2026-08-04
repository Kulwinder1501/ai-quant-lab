import {
  nearestStrike,
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
  type OptionType,
} from "../../pricing/domain/black-scholes-engine.js";
import type { VolatilityLabel } from "../../model-predictions/domain/volatility-expansion-label.js";
import type { WeeklyExpirySource } from "../../market-data/domain/weekly-expiry.js";

/**
 * Turns a volatility-regime prediction into a costed long-straddle proposal.
 *
 * This is the only structure that monetises a non-directional signal without needing a
 * directional edge — which matters, because every directional target measured on this
 * data lost to the trivial predictor. A predicted EXPANSION is long premium on both
 * sides: it profits from a large move either way.
 *
 * **It proposes; it does not trade.** The output carries the economics that decide
 * whether the trade is worth taking, and the answer is frequently no. That is the point
 * of the module.
 *
 * ## Why an expansion signal is not automatically a long-volatility edge
 *
 * The label says `forward_range / trailing_range >= 1 + band`: the next K bars' high-low
 * envelope is at least 25% wider than the last K bars'. That is a statement about range
 * *relative to its own recent history*.
 *
 * A straddle's breakeven is absolute and set by implied volatility. An ATM straddle's
 * premium *is* approximately the market's own forecast of the coming move, so buying one
 * is a bet that realised movement exceeds **implied** movement. Those are different
 * claims, and the second is much stronger. A range can widen 25% against a quiet
 * trailing window while still falling far short of a breakeven priced off an already
 * elevated India VIX.
 *
 * So this module computes both and compares them. If the market already prices a move
 * larger than the signal predicts, there is no edge and the proposal says so.
 *
 * ## Why only EXPANSION is actionable
 *
 * CONTRACTION is the profitable side of a *short* straddle, and
 * `023-option-contract-requires-long` makes a short option row impossible at the
 * database level — deliberately, because short premium has inverted barriers and
 * unbounded risk that none of the sizing, fee, or exit logic models. Half the signal is
 * therefore unusable, and that is the correct trade rather than a gap to close.
 */

export type StraddleRefusalReason =
  | "NOT_AN_EXPANSION_SIGNAL"
  | "CONTRACTION_NEEDS_SHORT_PREMIUM"
  | "EXPIRY_WEEKDAY_UNCONFIRMED"
  | "NO_IMPLIED_VOLATILITY"
  | "EXPIRY_NOT_IN_FUTURE"
  | "TRAILING_RANGE_UNMEASURABLE"
  | "PREMIUM_EXCEEDS_PREDICTED_MOVE"
  | "MARKET_ALREADY_PRICES_THE_MOVE";

export interface StraddleLeg {
  optionType: OptionType;
  strike: number;
  premium: number;
  greeks: OptionGreeks;
}

export interface StraddleEconomics {
  /** Combined premium per unit of the underlying. The cost, and the breakeven width. */
  totalPremium: number;
  /** Total rupee cost for the sized position, before fees. */
  deployedCapital: number;
  breakevenUpper: number;
  breakevenLower: number;
  /**
   * Absolute move from the strike needed to break even at expiry. Equals
   * `totalPremium`, restated so callers do not have to know that.
   */
  requiredMove: number;
  /**
   * The move the market is pricing over the horizon, `spot * sigma * sqrt(T)`. The ATM
   * straddle costs roughly `0.8x` this, so it is the benchmark the signal has to beat
   * rather than a number to compare premium against directly.
   */
  impliedMove: number;
  /** `trailingRange * (1 + band)` — the narrowest range the label's threshold implies. */
  predictedForwardRange: number;
  /**
   * Best-case favourable excursion from an ATM strike: the underlying travelling the
   * whole predicted range in one direction. An upper bound, not an expectation.
   */
  optimisticExcursion: number;
  /**
   * Excursion if the range straddles the strike symmetrically, which is the more
   * representative case for a strike set at the money.
   */
  conservativeExcursion: number;
  /** conservativeExcursion / requiredMove. Above 1 means the conservative case pays. */
  conservativeCoverage: number;
}

export interface ProposeStraddleInput {
  prediction: VolatilityLabel;
  underlyingSymbol: string;
  underlyingSpot: number;
  /** From the point-in-time IV source, as a decimal (0.14 for 14%). */
  impliedVolatility: number | null;
  expiryDate: Date;
  /** An ASSUMED weekly expiry is refused; a contract that never traded prices nothing. */
  expirySource: WeeklyExpirySource | null;
  strikeStep: number;
  lotSize: number;
  lots: number;
  /** The label's denominator: high-low envelope of the K bars ending at the signal bar. */
  trailingRange: number | null;
  /** The model's own `validationProtocol.expansionBand`, never a default. */
  expansionBand: number;
  now?: Date;
  riskFreeRate?: number;
}

export type StraddleProposal =
  | {
    actionable: true;
    legs: [StraddleLeg, StraddleLeg];
    economics: StraddleEconomics;
    quantity: number;
    expiryDate: Date;
    timeToExpiryYears: number;
    rationale: string;
  }
  | { actionable: false; reason: StraddleRefusalReason; explanation: string };

function refuse(reason: StraddleRefusalReason, explanation: string): StraddleProposal {
  return { actionable: false, reason, explanation };
}

/**
 * Proposes a long straddle for an EXPANSION prediction, or explains the refusal.
 *
 * Every refusal path is a real condition rather than defensive noise, and each is tested.
 */
export function proposeVolatilityStraddle(input: ProposeStraddleInput): StraddleProposal {
  const now = input.now ?? new Date();

  if (input.prediction === "CONTRACTION") {
    return refuse(
      "CONTRACTION_NEEDS_SHORT_PREMIUM",
      "A predicted contraction pays only a short-premium structure, which "
      + "023-option-contract-requires-long makes impossible by design: short options carry "
      + "inverted barriers and unbounded risk that the sizing, fee, and exit logic do not model.",
    );
  }
  if (input.prediction !== "EXPANSION") {
    return refuse(
      "NOT_AN_EXPANSION_SIGNAL",
      `${input.prediction} is the abstain class. It is the model declining to call a change in `
      + "range, not a reason to buy premium on both sides.",
    );
  }

  // An ASSUMED expiry weekday is refused for the same reason resolveWeeklyExpiryWeekday
  // refuses it: a plausible expiry is indistinguishable from a correct one, and pricing
  // against a contract that never traded yields correct-looking premium and greeks all
  // the way through.
  if (input.expirySource !== "CONFIRMED") {
    return refuse(
      "EXPIRY_WEEKDAY_UNCONFIRMED",
      `${input.underlyingSymbol}'s weekly expiry is recorded as ${input.expirySource ?? "absent"} `
      + "rather than CONFIRMED. Pricing a contract that may never have traded produces "
      + "plausible premiums for a position that cannot be taken.",
    );
  }
  if (input.impliedVolatility === null || !Number.isFinite(input.impliedVolatility) || input.impliedVolatility <= 0) {
    return refuse(
      "NO_IMPLIED_VOLATILITY",
      "No point-in-time implied volatility is available, so both legs are unpriceable. "
      + "Missing IV stays missing rather than being replaced with a house number.",
    );
  }
  if (input.trailingRange === null || !Number.isFinite(input.trailingRange) || input.trailingRange <= 0) {
    return refuse(
      "TRAILING_RANGE_UNMEASURABLE",
      "The signal's trailing range is not positive, so the expansion it predicts has no scale "
      + "and the required move cannot be compared against anything.",
    );
  }

  const timeToExpiryYears = yearsToExpiry(now, input.expiryDate);
  if (!Number.isFinite(timeToExpiryYears) || timeToExpiryYears <= 0) {
    return refuse(
      "EXPIRY_NOT_IN_FUTURE",
      `The supplied expiry ${input.expiryDate.toISOString()} is not after ${now.toISOString()}.`,
    );
  }

  const strike = nearestStrike(input.underlyingSpot, input.strikeStep);
  const priceLeg = (optionType: OptionType): StraddleLeg => {
    const greeks = priceEuropeanOption({
      spot: input.underlyingSpot,
      strike,
      timeToExpiryYears,
      riskFreeRate: input.riskFreeRate ?? 0.065,
      volatility: input.impliedVolatility as number,
      optionType,
    });
    return { optionType, strike, premium: greeks.premium, greeks };
  };
  // Same strike for both legs: a straddle, not a strangle. An ATM strike keeps the
  // structure as close to delta-neutral as a two-leg position gets, so the payoff depends
  // on the size of the move rather than its direction.
  const legs: [StraddleLeg, StraddleLeg] = [priceLeg("CE"), priceLeg("PE")];

  const totalPremium = legs[0].premium + legs[1].premium;
  const quantity = input.lotSize * input.lots;
  const predictedForwardRange = input.trailingRange * (1 + input.expansionBand);
  const impliedMove = input.underlyingSpot * input.impliedVolatility * Math.sqrt(timeToExpiryYears);

  const economics: StraddleEconomics = {
    totalPremium,
    deployedCapital: totalPremium * quantity,
    breakevenUpper: strike + totalPremium,
    breakevenLower: strike - totalPremium,
    requiredMove: totalPremium,
    impliedMove,
    predictedForwardRange,
    optimisticExcursion: predictedForwardRange,
    // A range of R around an at-the-money strike gives roughly R/2 of displacement in
    // either direction. Treating the whole range as favourable excursion assumes the
    // underlying travels it in one direction without retracing, which is the best case
    // rather than the expected one.
    conservativeExcursion: predictedForwardRange / 2,
    conservativeCoverage: predictedForwardRange / 2 / totalPremium,
  };

  // Even the best case must clear the breakeven. If the full predicted range cannot pay
  // for both legs, the structure loses on the signal being *right*.
  if (economics.optimisticExcursion <= totalPremium) {
    return refuse(
      "PREMIUM_EXCEEDS_PREDICTED_MOVE",
      `The two legs cost ${totalPremium.toFixed(2)} but the predicted forward range is only `
      + `${predictedForwardRange.toFixed(2)}. Even the underlying travelling the whole range in one `
      + "direction would not reach breakeven, so this loses money when the signal is correct.",
    );
  }

  // The ATM straddle premium is the market's own forecast of the move. Predicting a
  // range the market has already priced is not an edge, however accurate it is.
  if (predictedForwardRange <= impliedMove) {
    return refuse(
      "MARKET_ALREADY_PRICES_THE_MOVE",
      `The predicted forward range ${predictedForwardRange.toFixed(2)} does not exceed the implied `
      + `move ${impliedMove.toFixed(2)} the option chain is already pricing. Buying premium here bets `
      + "that realised volatility beats implied volatility, and this signal does not claim that.",
    );
  }

  return {
    actionable: true,
    legs,
    economics,
    quantity,
    expiryDate: input.expiryDate,
    timeToExpiryYears,
    rationale:
      `EXPANSION predicted on ${input.underlyingSymbol}. Long ${input.lots} lot(s) of the `
      + `${strike} straddle at ${totalPremium.toFixed(2)} combined premium; breakeven outside `
      + `${economics.breakevenLower.toFixed(2)}-${economics.breakevenUpper.toFixed(2)}. Predicted `
      + `range ${predictedForwardRange.toFixed(2)} against an implied move of ${impliedMove.toFixed(2)}, `
      + `conservative coverage ${economics.conservativeCoverage.toFixed(2)}x.`,
  };
}
