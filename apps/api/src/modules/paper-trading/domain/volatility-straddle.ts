import {
  nearestStrike,
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
  type OptionType,
} from "@ai-quant-lab/pricing";
import type { VolatilityLabel } from "../../model-predictions/domain/volatility-expansion-label.js";
import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";

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
  | "UNSUPPORTED_UNDERLYING"
  | "EXPIRY_UNLISTED"
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
   * The move the market prices over the option's *whole remaining life*,
   * `spot * sigma * sqrt(timeToExpiry)`. The ATM straddle costs roughly `0.8x` this, so it is the
   * benchmark the premium has to be judged against -- not the benchmark for the signal, which
   * reaches only as far as its own horizon. See `impliedMoveOverHorizon`.
   */
  impliedMove: number;
  /**
   * The same move re-scaled to the prediction's horizon, `spot * sigma * sqrt(horizon)`.
   *
   * This is what `predictedForwardRange` is comparable to, and comparing against `impliedMove`
   * instead is what kept the straddle permanently refused: a 15m/h5 prediction spans 75 minutes
   * and was being measured against an eight-day move.
   */
  impliedMoveOverHorizon: number;
  /** `trailingRange * (1 + band)` — the narrowest range the label's threshold implies, over the prediction horizon. */
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
  /**
   * Years to expiry still left when the prediction's horizon ends — the moment the signal's
   * information is spent and everything after it is an unforecast coin flip financed by theta.
   */
  timeToExpiryAtHorizonYears: number;
  /**
   * Premium lost to time alone over the horizon: the same straddle repriced `horizon` later with
   * the spot unchanged. This is what the position actually pays for the wait, and it is far
   * smaller than the tenor suggests — an eight-day option held seventy-five minutes pays
   * seventy-five minutes of decay, not eight days of it.
   */
  decayCostOverHorizon: number;
  /**
   * What the straddle is worth at the horizon if the conservative excursion happens: repriced at
   * `timeToExpiryAtHorizonYears` with the spot displaced by `conservativeExcursion`, averaged over
   * up and down. Mark-to-market, not the expiry payoff, because the position is closed on premium
   * barriers rather than carried to settlement.
   */
  horizonExitValue: number;
  /**
   * `horizonExitValue - totalPremium`. The signal's whole worth per underlying unit, before
   * transaction costs: gamma gain on the predicted move, less decay over the horizon.
   *
   * Positive here and negative under `requiredMove` is the normal case, and the gap between the
   * two is the tenor mismatch in rupees. `requiredMove` asks the underlying to travel the entire
   * premium, which is the right question only for a position held to expiry.
   */
  horizonNetPerUnit: number;
}

export interface ProposeStraddleInput {
  prediction: VolatilityLabel;
  underlyingSymbol: string;
  underlyingSpot: number;
  /** From the point-in-time IV source, as a decimal (0.14 for 14%). */
  impliedVolatility: number | null;
  expiryDate: Date;
  /** True if the expiry was confirmed against the provider's listed calendar. */
  isListedExpiry: boolean;
  strikeStep: number;
  lotSize: number;
  lots: number;
  /** The label's denominator: high-low envelope of the K bars ending at the signal bar. */
  trailingRange: number | null;
  /** The model's own `validationProtocol.expansionBand`, never a default. */
  expansionBand: number;
  /**
   * How far ahead the prediction reaches, in years: `horizonBars * barLength`.
   *
   * Required rather than optional, because the alternative was silently wrong.
   * `predictedForwardRange` is scaled to this horizon -- a 15m model at h5 predicts the next 75
   * minutes -- while an option's implied move covers its whole remaining life. Comparing the two
   * directly asks whether a 75-minute range beats an eight-day move, which nothing satisfies:
   * measured 2026-08-17, every live evaluation refused MARKET_ALREADY_PRICES_THE_MOVE at 43.44
   * against 408.18, a ratio that is horizon mismatch rather than market judgment. A default here
   * would let a caller reintroduce that silently.
   */
  predictionHorizonYears: number;
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
  | {
    actionable: false;
    reason: StraddleRefusalReason;
    explanation: string;
    /**
     * Present when the refusal came from the economics rather than from a missing input. A
     * verdict about money should be auditable as numbers, not only as prose: this is what lets a
     * caller log why the structure failed without re-deriving it from the sentence.
     */
    economics?: StraddleEconomics;
  };

function refuse(
  reason: StraddleRefusalReason,
  explanation: string,
  economics?: StraddleEconomics,
): StraddleProposal {
  return { actionable: false, reason, explanation, ...(economics ? { economics } : {}) };
}

function roundToTick(value: number): number {
  const snapped = Math.round(value / 0.05) * 0.05;
  return Math.round((snapped + Number.EPSILON) * 100) / 100;
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

  if (input.underlyingSymbol !== "NIFTY50") {
    return refuse(
      "UNSUPPORTED_UNDERLYING",
      "Straddles are currently only enabled for NIFTY50 until real settled evidence exists."
    );
  }

  // An unlisted expiry is refused: a plausible expiry is indistinguishable from a correct one,
  // and pricing against a contract that never traded yields correct-looking premium and greeks all
  // the way through.
  if (!input.isListedExpiry) {
    return refuse(
      "EXPIRY_UNLISTED",
      `The supplied expiry ${input.expiryDate.toISOString()} was not confirmed against `
      + `${input.underlyingSymbol}'s listed calendar. Pricing a contract that may never `
      + "have traded produces plausible premiums for a position that cannot be taken.",
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
  const riskFreeRate = input.riskFreeRate ?? RISK_FREE_RATE;
  const priceLeg = (optionType: OptionType): StraddleLeg => {
    const greeks = priceEuropeanOption({
      spot: input.underlyingSpot,
      strike,
      timeToExpiryYears,
      riskFreeRate,
      volatility: input.impliedVolatility as number,
      optionType,
    });
    return { optionType, strike, premium: greeks.premium, greeks };
  };
  /**
   * Both legs of the same strike repriced at an arbitrary spot and remaining life. Used to value
   * the position at the horizon, where it is actually closed, rather than at expiry.
   */
  const straddleValueAt = (spot: number, remainingYears: number): number => {
    const price = (optionType: OptionType): number => priceEuropeanOption({
      spot,
      strike,
      // Negative or zero remaining life returns intrinsic value, which is the correct payoff for
      // a horizon that reaches or overruns the expiry.
      timeToExpiryYears: Math.max(remainingYears, 0),
      riskFreeRate,
      volatility: input.impliedVolatility as number,
      optionType,
    }).premium;
    return price("CE") + price("PE");
  };
  // Same strike for both legs: a straddle, not a strangle. An ATM strike keeps the
  // structure as close to delta-neutral as a two-leg position gets, so the payoff depends
  // on the size of the move rather than its direction.
  const legs: [StraddleLeg, StraddleLeg] = [priceLeg("CE"), priceLeg("PE")];

  const totalPremium = roundToTick(legs[0].premium + legs[1].premium);
  const quantity = input.lotSize * input.lots;
  const predictedForwardRange = input.trailingRange * (1 + input.expansionBand);
  const impliedMove = input.underlyingSpot * input.impliedVolatility * Math.sqrt(timeToExpiryYears);
  /*
   * The same implied move re-scaled to the prediction's own horizon, which is what
   * `predictedForwardRange` measures. Both sides now describe the same span of time, so
   * "does realised beat implied" is a question the signal can actually answer.
   *
   * `impliedMove` above is kept and still reported: it is the move priced into the premium this
   * position pays, and the premium gates below are the ones that must reckon with holding an
   * eight-day option to express a seventy-five-minute view. Re-scaling the comparison does not
   * make that mismatch disappear -- it moves it to where it belongs, which is the economics.
   */
  const impliedMoveOverHorizon = input.underlyingSpot
    * input.impliedVolatility
    * Math.sqrt(input.predictionHorizonYears);

  /*
   * Mark-to-market at the horizon.
   *
   * The position is closed on premium barriers, so its holding period is the span over which the
   * signal says anything -- not the option's remaining life. Valuing it at expiry asks the
   * underlying to travel the whole premium; valuing it at the horizon asks only that gamma on the
   * predicted move beat decay over the same minutes. The second is the trade being taken.
   *
   * The excursion is applied to the spot rather than to the strike so that entry and exit share
   * one basis: the entry premium was priced at `underlyingSpot`, which sits within half a strike
   * step of `strike`.
   */
  const timeToExpiryAtHorizonYears = timeToExpiryYears - input.predictionHorizonYears;
  const excursion = predictedForwardRange / 2;
  const decayCostOverHorizon = totalPremium - straddleValueAt(input.underlyingSpot, timeToExpiryAtHorizonYears);
  const upValue = straddleValueAt(input.underlyingSpot + excursion, timeToExpiryAtHorizonYears);
  /*
   * The mean of the two directions, not the worse of them.
   *
   * A strike set at the spot is not delta-neutral -- the forward sits above it, so the pair carries
   * a small positive delta -- and at these excursions that linear term is several times the gamma
   * term. Taking the worse side would therefore report the cost of the strike's tilt rather than
   * the value of the predicted move, and it would do so on top of the halving that already made
   * this the conservative case: two helpings of caution stacked until the quantity the structure
   * actually monetises disappeared under them. A symmetric range around the strike lands either
   * side, the delta term cancels across the pair, and what remains is the convexity. That is also
   * the term the closed-form implied-move gate compares, which is why the two now agree.
   *
   * A downward excursion larger than the spot is not a price path, so the upward leg stands alone
   * there; the guard also keeps `priceEuropeanOption` from being handed a spot of zero.
   */
  const horizonExitValue = input.underlyingSpot - excursion > 0
    ? (upValue + straddleValueAt(input.underlyingSpot - excursion, timeToExpiryAtHorizonYears)) / 2
    : upValue;

  const economics: StraddleEconomics = {
    totalPremium,
    deployedCapital: totalPremium * quantity,
    breakevenUpper: strike + totalPremium,
    breakevenLower: strike - totalPremium,
    requiredMove: totalPremium,
    impliedMove,
    impliedMoveOverHorizon,
    predictedForwardRange,
    optimisticExcursion: predictedForwardRange,
    // A range of R around an at-the-money strike gives roughly R/2 of displacement in
    // either direction. Treating the whole range as favourable excursion assumes the
    // underlying travels it in one direction without retracing, which is the best case
    // rather than the expected one.
    conservativeExcursion: excursion,
    conservativeCoverage: excursion / totalPremium,
    timeToExpiryAtHorizonYears,
    decayCostOverHorizon,
    horizonExitValue,
    horizonNetPerUnit: horizonExitValue - totalPremium,
  };

  /*
   * The ATM straddle premium is the market's own forecast of the move. Predicting a range the
   * market has already priced is not an edge, however accurate it is.
   *
   * Both sides of this comparison are displacements now. `predictedForwardRange` is a high-low
   * envelope, so it counts movement in both directions, while `spot * sigma * sqrt(t)` is a
   * one-sided standard deviation; comparing them directly credited the signal with about twice
   * the move it claims. That is the same error as the tenor mismatch one scale down -- two
   * quantities that look comparable and are not -- and `conservativeExcursion` is the half-range
   * the rest of the module already uses for exactly this reason.
   *
   * The correction is not cosmetic: it is the condition the repriced mark-to-market independently
   * arrives at. Gamma gain over the horizon is about `0.5 * gamma * displacement^2` and decay is
   * about `premium * dt / (2 * T)`; for an at-the-money straddle those cross precisely where the
   * displacement equals `spot * sigma * sqrt(dt)`. So this gate and the sign of
   * `horizonNetPerUnit` are the same statement, one closed-form and one repriced, and the test
   * suite asserts they agree.
   */
  if (economics.conservativeExcursion <= impliedMoveOverHorizon) {
    return refuse(
      "MARKET_ALREADY_PRICES_THE_MOVE",
      `The predicted range ${predictedForwardRange.toFixed(2)} gives a half-range displacement of `
      + `${economics.conservativeExcursion.toFixed(2)}, which does not exceed the `
      + `${impliedMoveOverHorizon.toFixed(2)} the option chain prices over the same `
      + `${(input.predictionHorizonYears * 365 * 24 * 60).toFixed(0)} minutes (the full-life implied move to `
      + `expiry is ${impliedMove.toFixed(2)}). Buying premium here bets that realised volatility beats `
      + "implied volatility, and this signal does not claim that.",
      economics,
    );
  }

  /*
   * A range R around an at-the-money strike gives roughly R/2 of displacement in either
   * direction. The conservative (half-range) excursion must clear the total premium, or the
   * structure loses on a realistic outcome even when the signal is right.
   *
   * This is the hold-to-expiry constraint, and it binds because nothing closes the position at
   * the horizon: the exit evaluator only watches premium barriers, so the worst case is carrying
   * the contract to settlement and the gate has to price that. The refusal states the tenor
   * penalty explicitly, because the number is the whole objection: required move scales with the
   * square root of remaining life, so an eight-day contract expressing a seventy-five-minute view
   * needs about twelve times the move the signal predicts, and no listed contract is short enough
   * to close that gap. What closes it is aligning the two spans -- see `horizonNetPerUnit`, which
   * is what the same signal is worth when the position is released at the horizon instead.
   */
  if (economics.conservativeExcursion <= totalPremium) {
    // Exact while the horizon lies inside one session, where trading and calendar time coincide;
    // for a daily-bar horizon the elapsed calendar span is longer and the penalty smaller.
    const tenorPenalty = Math.sqrt(timeToExpiryYears / input.predictionHorizonYears);
    return refuse(
      "PREMIUM_EXCEEDS_PREDICTED_MOVE",
      `The two legs cost ${totalPremium.toFixed(2)} but the conservative half-range excursion is only `
      + `${economics.conservativeExcursion.toFixed(2)} (from a ${predictedForwardRange.toFixed(2)} predicted range). `
      + "The expected directional move does not reach breakeven, so this loses money when the signal is correct. "
      + `The contract has ${(timeToExpiryYears * 365).toFixed(1)} days left against a `
      + `${(input.predictionHorizonYears * 365 * 24 * 60).toFixed(0)}-minute prediction, which is a `
      + `${tenorPenalty.toFixed(1)}x tenor penalty on the required move. Released at the horizon the same `
      + `signal nets ${economics.horizonNetPerUnit.toFixed(2)} per unit `
      + `(${economics.horizonExitValue.toFixed(2)} exit value against ${totalPremium.toFixed(2)} paid, after `
      + `${economics.decayCostOverHorizon.toFixed(2)} of decay), so the refusal is the mismatch between the `
      + "signal's span and the contract's, not an absence of predicted movement.",
      economics,
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
      + `conservative coverage ${economics.conservativeCoverage.toFixed(2)}x. Released at the prediction `
      + `horizon the structure nets ${economics.horizonNetPerUnit.toFixed(2)} per unit after `
      + `${economics.decayCostOverHorizon.toFixed(2)} of decay.`,
  };
}
