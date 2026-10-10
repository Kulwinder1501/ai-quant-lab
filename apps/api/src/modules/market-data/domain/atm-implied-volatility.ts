import {
  RISK_FREE_RATE,
  effectiveSpotForForward,
  impliedForwardFromParity,
  impliedVolatilityFromPremium,
  midPriceForIv,
  yearsToExpiry,
} from "@ai-quant-lab/pricing";

/**
 * The ATM implied volatility of ONE expiry from ONE option-chain snapshot, solved on the
 * put-call-parity forward.
 *
 * Why this exists as a single shared function: the IV percentile used to rank a *current* IV
 * solved on the parity forward against a *history* solved on raw spot. Spot and the parity
 * forward differ by carry and dividends (hundreds of points on an index), and that gap shows up
 * as a level shift in IV, so the two sides measured different quantities. Both the live reading
 * and every historical day now go through this one function, so the basis cannot diverge again.
 *
 * No spot fallback, deliberately. If parity cannot be evaluated (no strike with a two-sided call
 * AND put) the result is "not measurable": quietly substituting spot would reintroduce the mixed
 * basis for exactly the days that are hardest to audit.
 */

export interface AtmQuote {
  strikePrice: number;
  optionType: "CE" | "PE";
  bid: number | null;
  ask: number | null;
}

export type AtmImpliedVolatilityResult =
  | {
    measurable: true;
    impliedVolatility: number;
    atmStrike: number;
    /** The put-call-parity forward the IV was solved on. */
    impliedForward: number;
    /** Calendar-date distance from the observation's IST date to the expiry's IST date. */
    daysToExpiry: number;
  }
  | {
    measurable: false;
    reason: "EXPIRED" | "NO_PARITY_FORWARD" | "NO_ATM_IV";
    explanation: string;
  };

const IST_OFFSET_MS = 5.5 * 60 * 60_000;
const DAY_MS = 86_400_000;

function istDateKey(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Whole calendar days between the observation's IST date and the expiry's IST date.
 *
 * Date-based, not elapsed-hours-based: a snapshot taken at 15:31 the day before an expiry that
 * settles at 15:30 is 23.99 hours away and would otherwise fall out of "1 day to expiry" by a
 * minute. Trading days would need the holiday calendar; calendar dates are what the tenor
 * buckets below are defined on, and the difference is a weekend at most.
 */
export function calendarDaysToExpiry(observedAt: Date, expiryDate: Date): number {
  return Math.round((Date.parse(istDateKey(expiryDate)) - Date.parse(istDateKey(observedAt))) / DAY_MS);
}

export function atmImpliedVolatility(input: {
  observedAt: Date;
  expiryDate: Date;
  /** Quotes of the single expiry, any strikes; the function picks the ATM strike itself. */
  quotes: readonly AtmQuote[];
  riskFreeRate?: number;
}): AtmImpliedVolatilityResult {
  const riskFreeRate = input.riskFreeRate ?? RISK_FREE_RATE;
  const timeToExpiry = yearsToExpiry(input.observedAt, input.expiryDate);
  if (timeToExpiry <= 0) {
    return { measurable: false, reason: "EXPIRED", explanation: "The expiry is not after the observation." };
  }

  const midsByStrike = new Map<number, { callMid?: number; putMid?: number }>();
  for (const quote of input.quotes) {
    const mid = midPriceForIv(quote.bid, quote.ask);
    if (mid === null) continue;
    const slot = midsByStrike.get(quote.strikePrice) ?? {};
    if (quote.optionType === "CE") slot.callMid = mid;
    else slot.putMid = mid;
    midsByStrike.set(quote.strikePrice, slot);
  }

  const forward = impliedForwardFromParity(
    [...midsByStrike.entries()]
      .filter(([, slot]) => slot.callMid !== undefined && slot.putMid !== undefined)
      .map(([strike, slot]) => ({ strike, callMid: slot.callMid!, putMid: slot.putMid! })),
    riskFreeRate,
    timeToExpiry,
  );
  if (forward === null) {
    return {
      measurable: false,
      reason: "NO_PARITY_FORWARD",
      explanation: "No strike has a two-sided call and put, so the put-call-parity forward cannot be "
        + "evaluated. Falling back to spot would mix price bases, so the reading is refused.",
    };
  }

  // ATM against the forward the model is priced on, not against spot.
  const strikes = [...midsByStrike.keys()];
  const atmStrike = strikes.reduce((best, strike) =>
    Math.abs(strike - forward) < Math.abs(best - forward) ? strike : best);
  const pricingSpot = effectiveSpotForForward(forward, riskFreeRate, timeToExpiry);
  const solved: number[] = [];
  const slot = midsByStrike.get(atmStrike)!;
  for (const [optionType, premium] of [["CE", slot.callMid], ["PE", slot.putMid]] as const) {
    if (premium === undefined) continue;
    const result = impliedVolatilityFromPremium({
      spot: pricingSpot,
      strike: atmStrike,
      timeToExpiryYears: timeToExpiry,
      riskFreeRate,
      optionType,
      premium,
    });
    if (result.measurable) solved.push(result.impliedVolatility);
  }
  if (solved.length === 0) {
    return {
      measurable: false,
      reason: "NO_ATM_IV",
      explanation: `The ATM strike ${atmStrike} has no quote that inverts to a volatility.`,
    };
  }
  return {
    measurable: true,
    // Mean of the two sides when both solve: either alone carries the skew of its own side.
    impliedVolatility: solved.reduce((total, value) => total + value, 0) / solved.length,
    atmStrike,
    impliedForward: forward,
    daysToExpiry: calendarDaysToExpiry(input.observedAt, input.expiryDate),
  };
}
