import type { OptionChainSnapshot, OptionType } from "./option-chain.js";
import { priceEuropeanOption, yearsToExpiry } from "../../pricing/domain/black-scholes-engine.js";
import {
  effectiveSpotForForward,
  impliedForwardFromParity,
  impliedVolatilityFromPremium,
  midPriceForIv,
} from "../../pricing/domain/implied-volatility.js";
import { RISK_FREE_RATE } from "../../pricing/domain/constants.js";

/**
 * Greeks for one contract, solved from the observed chain.
 *
 * The provider returns no greeks, so a delta only exists after inverting an IV out of the
 * quoted mid. This exists so a caller that needs one number -- an entry gate screening for
 * far-OTM contracts, say -- does not reimplement the inversion and end up with a delta that
 * disagrees with the one the chain endpoint shows for the same strike.
 *
 * Returns null whenever the chain cannot support the solve: no two-sided quote, no spot, an
 * expired contract, or a mid that will not invert. A null delta means *unknown*, and callers
 * must not read it as "fine" -- that conflation is what let a validator report a contract as
 * screened when its delta had never been evaluated.
 */
export function solveContractGreeksFromChain(input: {
  snapshot: OptionChainSnapshot;
  strikePrice: number;
  optionType: OptionType;
}): { delta: number; gamma: number; theta: number; vega: number; impliedVolatility: number } | null {
  const { snapshot, strikePrice, optionType } = input;
  const quote = snapshot.quotes.find(
    (candidate) => candidate.strikePrice === strikePrice && candidate.optionType === optionType,
  );
  if (!quote) return null;

  const mid = midPriceForIv(quote.bid, quote.ask);
  if (mid === null) return null;

  const timeToExpiry = yearsToExpiry(snapshot.observedAt, quote.expiryDate);
  if (timeToExpiry <= 0) return null;

  // The forward the option market itself prices, taken from put-call parity across this
  // expiry's paired strikes. Discounting spot at r instead put a live BANKNIFTY forward 211
  // points above spot where the market had it 193 below -- a 0.7% error that lands straight
  // in the delta, which is the number being screened on here.
  const expiryKey = quote.expiryDate.toISOString().slice(0, 10);
  const pairs = new Map<number, { callMid?: number; putMid?: number }>();
  for (const candidate of snapshot.quotes) {
    if (candidate.expiryDate.toISOString().slice(0, 10) !== expiryKey) continue;
    const candidateMid = midPriceForIv(candidate.bid, candidate.ask);
    if (candidateMid === null) continue;
    const slot = pairs.get(candidate.strikePrice) ?? {};
    if (candidate.optionType === "CE") slot.callMid = candidateMid;
    else slot.putMid = candidateMid;
    pairs.set(candidate.strikePrice, slot);
  }
  const impliedForward = impliedForwardFromParity(
    [...pairs.entries()]
      .filter(([, slot]) => slot.callMid !== undefined && slot.putMid !== undefined)
      .map(([strike, slot]) => ({ strike, callMid: slot.callMid!, putMid: slot.putMid! })),
    RISK_FREE_RATE,
    timeToExpiry,
  );

  const pricingSpot = impliedForward !== null
    ? effectiveSpotForForward(impliedForward, RISK_FREE_RATE, timeToExpiry)
    : snapshot.underlyingValue;
  if (pricingSpot === null || !(pricingSpot > 0)) return null;

  const solved = impliedVolatilityFromPremium({
    spot: pricingSpot,
    strike: strikePrice,
    timeToExpiryYears: timeToExpiry,
    riskFreeRate: RISK_FREE_RATE,
    optionType,
    premium: mid,
  });
  if (!solved.measurable) return null;

  const priced = priceEuropeanOption({
    spot: pricingSpot,
    strike: strikePrice,
    timeToExpiryYears: timeToExpiry,
    riskFreeRate: RISK_FREE_RATE,
    volatility: solved.impliedVolatility,
    optionType,
  });

  return {
    delta: priced.delta,
    gamma: priced.gamma,
    theta: priced.theta,
    vega: priced.vega,
    impliedVolatility: solved.impliedVolatility,
  };
}
