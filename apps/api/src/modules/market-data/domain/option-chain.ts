/**
 * Option-chain observations and the metrics a trade decision actually needs from them.
 *
 * The raw rows are stored as received; everything here is derived on read, so a change
 * to any definition re-scores history instead of invalidating it.
 *
 * Each derived metric answers a specific pre-trade question that previously had no data
 * behind it at all:
 *
 * * **spread** — is this contract liquid enough to trade? A straddle's measured edge was
 *   +0.117% of spot against a 2.70% premium, so it dies at roughly 1.09% cost per leg.
 *   The spread *is* that cost, and nothing in this project could see it before.
 * * **open interest and its change** — where positions are being built. Change matters
 *   more than level, and a falling OI is as informative as a rising one, so the figure
 *   is signed.
 * * **put/call ratio** — computed from OI and from volume separately, because they say
 *   different things: OI is positioning carried overnight, volume is today's activity.
 * * **implied volatility** — solved from the mid price, because the provider does not
 *   return it. Derived, and labelled as derived.
 * * **moneyness** — ITM/ATM/OTM per contract, so strike selection is explicit rather
 *   than implied by whichever strike happened to be nearest.
 */

import type { ListedExpiry } from "./option-expiry-calendar.js";

export type OptionType = "CE" | "PE";
export type ExpiryKind = "WEEKLY" | "MONTHLY";
export type Moneyness = "ITM" | "ATM" | "OTM";

import { impliedVolatilityFromPremium, midPriceForIv, yearsToExpiry, RISK_FREE_RATE } from "@ai-quant-lab/pricing";

/** One contract as the provider quoted it. Prices are nullable: an illiquid strike
 * genuinely has no bid, and a zero would claim someone bid nothing. */
export interface OptionChainQuote {
  expiryDate: Date;
  expiryKind: ExpiryKind;
  strikePrice: number;
  optionType: OptionType;
  providerSymbol: string;
  providerToken: string | null;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  previousOpenInterest: number | null;
  openInterestChange: number | null;
}

export interface OptionChainSnapshot {
  underlyingSymbol: string;
  provider: string;
  /** Receipt time. The provider returns no exchange clock in this payload. */
  observedAt: Date;
  underlyingValue: number | null;
  quotes: OptionChainQuote[];
  /**
   * Every expiry the provider lists for this underlying, not only the one these quotes
   * cover. A single chain request returns one expiry's book but the whole calendar in its
   * header, and that calendar is the only authority on which contracts exist.
   */
  listedExpiries: ListedExpiry[];
}

export class OptionChainError extends Error {}

function isFiniteNonNegative(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

/**
 * Bid-ask spread for one contract, absolute and as a share of the mid.
 *
 * Returns null rather than a number when either side is missing or the mid is
 * non-positive. A contract nobody is quoting has an *unknown* spread, not a zero one,
 * and treating it as zero would make the most illiquid strikes look the cheapest to
 * trade — the precise inversion that matters, since spread is the dominant cost.
 */
export function quoteSpread(quote: OptionChainQuote): {
  absolute: number;
  mid: number;
  percentOfMid: number;
} | null {
  if (!isFiniteNonNegative(quote.bid) || !isFiniteNonNegative(quote.ask)) return null;
  if (quote.ask < quote.bid) return null;
  const mid = (quote.bid + quote.ask) / 2;
  if (!(mid > 0)) return null;
  const absolute = quote.ask - quote.bid;
  return { absolute, mid, percentOfMid: (absolute / mid) * 100 };
}

/** ITM/ATM/OTM for one contract, with ATM meaning "the nearest listed strike". */
export function moneynessOf(
  quote: OptionChainQuote,
  underlyingValue: number,
  atmStrike: number,
): Moneyness {
  if (quote.strikePrice === atmStrike) return "ATM";
  if (quote.optionType === "CE") return quote.strikePrice < underlyingValue ? "ITM" : "OTM";
  return quote.strikePrice > underlyingValue ? "ITM" : "OTM";
}

/** The listed strike closest to spot. Not rounded to a step: the chain tells us which
 * strikes exist, so guessing a step is unnecessary and can name a strike that does not. */
export function atmStrikeOf(quotes: readonly OptionChainQuote[], underlyingValue: number): number | null {
  const strikes = [...new Set(quotes.map((quote) => quote.strikePrice))].filter((strike) => strike > 0);
  if (strikes.length === 0 || !Number.isFinite(underlyingValue)) return null;
  return strikes.reduce((best, strike) =>
    Math.abs(strike - underlyingValue) < Math.abs(best - underlyingValue) ? strike : best);
}

export interface PutCallRatios {
  /** Total put OI over total call OI. Null when call OI is zero — undefined, not infinite. */
  openInterestRatio: number | null;
  /** Same over traded volume: today's activity rather than carried positioning. */
  volumeRatio: number | null;
  callOpenInterest: number;
  putOpenInterest: number;
  callVolume: number;
  putVolume: number;
}

/**
 * Put/call ratios over a set of quotes.
 *
 * OI and volume are reported separately because they answer different questions:
 * open interest is positioning held overnight, volume is what changed hands today. A
 * single "PCR" that silently picks one is the more common presentation and the less
 * useful one.
 */
export function putCallRatios(quotes: readonly OptionChainQuote[]): PutCallRatios {
  let callOpenInterest = 0;
  let putOpenInterest = 0;
  let callVolume = 0;
  let putVolume = 0;

  for (const quote of quotes) {
    const openInterest = isFiniteNonNegative(quote.openInterest) ? quote.openInterest : 0;
    const volume = isFiniteNonNegative(quote.volume) ? quote.volume : 0;
    if (quote.optionType === "CE") {
      callOpenInterest += openInterest;
      callVolume += volume;
    } else {
      putOpenInterest += openInterest;
      putVolume += volume;
    }
  }

  return {
    // Division by zero is undefined, not infinite: a chain with no call OI has no ratio.
    openInterestRatio: callOpenInterest > 0 ? putOpenInterest / callOpenInterest : null,
    volumeRatio: callVolume > 0 ? putVolume / callVolume : null,
    callOpenInterest,
    putOpenInterest,
    callVolume,
    putVolume,
  };
}

/**
 * Strikes carrying the largest open interest, per side.
 *
 * Deliberately *not* called support or resistance. Phase 25 and every honest treatment
 * of this warn that a high-OI strike is where positions sit, not a level price must
 * respect; naming it "resistance" invites exactly the guaranteed-level reading the
 * user's own checklist cautions against.
 */
export function largestOpenInterestStrikes(quotes: readonly OptionChainQuote[]): {
  call: { strikePrice: number; openInterest: number } | null;
  put: { strikePrice: number; openInterest: number } | null;
} {
  const pick = (optionType: OptionType) => {
    const candidates = quotes
      .filter((quote) => quote.optionType === optionType && isFiniteNonNegative(quote.openInterest))
      .map((quote) => ({ strikePrice: quote.strikePrice, openInterest: quote.openInterest as number }));
    if (candidates.length === 0) return null;
    return candidates.reduce((best, current) => (current.openInterest > best.openInterest ? current : best));
  };
  return { call: pick("CE"), put: pick("PE") };
}

export interface ChainLiquiditySummary {
  contracts: number;
  /** Contracts with a usable two-sided quote. The rest cannot be costed at all. */
  quotedBothSides: number;
  medianSpreadPercent: number | null;
  /** Contracts whose spread is at or under the threshold a strategy can afford. */
  withinCostBudget: number;
  costBudgetPercent: number;
}

/**
 * How much of a chain is actually tradeable at a given cost budget.
 *
 * The default 1% of mid is not arbitrary: the straddle study measured the volatility
 * edge dying at roughly 1.09% cost per leg, so a contract wider than that cannot carry
 * the only strategy this project has evidence for.
 */
export function summariseLiquidity(
  quotes: readonly OptionChainQuote[],
  costBudgetPercent = 1.0,
): ChainLiquiditySummary {
  const spreads: number[] = [];
  for (const quote of quotes) {
    const spread = quoteSpread(quote);
    if (spread !== null) spreads.push(spread.percentOfMid);
  }
  spreads.sort((left, right) => left - right);
  const median = spreads.length === 0
    ? null
    : spreads.length % 2 === 1
      ? spreads[(spreads.length - 1) / 2]!
      : (spreads[spreads.length / 2 - 1]! + spreads[spreads.length / 2]!) / 2;

  return {
    contracts: quotes.length,
    quotedBothSides: spreads.length,
    medianSpreadPercent: median,
    withinCostBudget: spreads.filter((percent) => percent <= costBudgetPercent).length,
    costBudgetPercent,
  };
}

/**
 * Validates a snapshot before it is stored.
 *
 * Rejects rather than repairs. A chain with no quotes, a non-positive strike, or an
 * inverted market is a provider or parsing fault, and storing it would put a fault into
 * a table whose whole purpose is to be the raw record.
 */
export function assertSnapshotStorable(snapshot: OptionChainSnapshot): void {
  if (!snapshot.underlyingSymbol.trim()) {
    throw new OptionChainError("An option-chain snapshot needs an underlying symbol.");
  }
  if (Number.isNaN(snapshot.observedAt.getTime())) {
    throw new OptionChainError("An option-chain snapshot needs a valid observation time.");
  }
  if (snapshot.quotes.length === 0) {
    throw new OptionChainError(
      `The ${snapshot.underlyingSymbol} chain returned no contracts. An empty book is a provider `
      + "fault, not an observation, so it is refused rather than stored as a snapshot with no rows.",
    );
  }
  if (snapshot.listedExpiries.length === 0) {
    throw new OptionChainError(
      `The ${snapshot.underlyingSymbol} chain returned no expiry calendar. Storing the book \nwithout it would leave no record of which contracts exist, which is what let a phantom \nexpiry be traded.`,
    );
  }
  const seen = new Set<string>();
  for (const quote of snapshot.quotes) {
    if (!(quote.strikePrice > 0) || !Number.isFinite(quote.strikePrice)) {
      throw new OptionChainError(`A ${snapshot.underlyingSymbol} quote has a non-positive strike.`);
    }
    if (Number.isNaN(quote.expiryDate.getTime())) {
      throw new OptionChainError(`A ${snapshot.underlyingSymbol} quote has an invalid expiry.`);
    }
    if (isFiniteNonNegative(quote.bid) && isFiniteNonNegative(quote.ask) && quote.ask < quote.bid) {
      throw new OptionChainError(
        `A ${snapshot.underlyingSymbol} ${quote.strikePrice}${quote.optionType} quote has ask below bid, `
        + "which is not a market. Refusing the snapshot rather than storing an inverted book.",
      );
    }
    // The unique index enforces this too, but failing here names the contract instead of
    // surfacing a constraint violation from three layers down.
    const key = `${quote.expiryDate.toISOString().slice(0, 10)}|${quote.strikePrice}|${quote.optionType}`;
    if (seen.has(key)) {
      throw new OptionChainError(`The ${snapshot.underlyingSymbol} chain repeated contract ${key}.`);
    }
    seen.add(key);
  }
}

/** Distinct expiries in a snapshot, earliest first, with their kind. */
export function expiriesOf(snapshot: OptionChainSnapshot): Array<{ expiryDate: Date; expiryKind: ExpiryKind }> {
  const byDate = new Map<string, { expiryDate: Date; expiryKind: ExpiryKind }>();
  for (const quote of snapshot.quotes) {
    const key = quote.expiryDate.toISOString().slice(0, 10);
    if (!byDate.has(key)) byDate.set(key, { expiryDate: quote.expiryDate, expiryKind: quote.expiryKind });
  }
  return [...byDate.values()].sort((left, right) => left.expiryDate.getTime() - right.expiryDate.getTime());
}

export interface ImpliedVolatilitySkew {
  skew: number | null;
  putIv: number | null;
  callIv: number | null;
  putStrike: number | null;
  callStrike: number | null;
}

/**
 * Calculates the Implied Volatility (IV) skew from a set of quotes.
 * Skew is defined as the IV of an OTM Put minus the IV of an OTM Call.
 *
 * @param quotes A chain's quotes, possibly spanning multiple expiries -- only the
 *   nearest expiry present is used (see below).
 * @param underlyingValue The spot price of the underlying.
 * @param observedAt When the chain was observed, for time-to-expiry.
 * @param skewOffsetPercent How far out of the money to look (default 2%, i.e. 0.02).
 */
export function impliedVolatilitySkew(
  quotes: readonly OptionChainQuote[],
  underlyingValue: number,
  observedAt: Date,
  skewOffsetPercent = 0.02
): ImpliedVolatilitySkew {
  if (!Number.isFinite(underlyingValue) || quotes.length === 0) {
    return { skew: null, putIv: null, callIv: null, putStrike: null, callStrike: null };
  }

  // A chain fetched without an expiry filter spans every listed expiry. Averaging IV
  // across expiries would blend distinct term-structure points -- a weekly and a
  // monthly at the same strike price different amounts of time -- into one number
  // that describes neither, the same mistake `forwardByExpiry` exists to avoid
  // elsewhere in this file. Scoping to the nearest listed expiry keeps both legs, and
  // the skew itself, describing a single contract month.
  const nearestExpiryMs = Math.min(...quotes.map((q) => q.expiryDate.getTime()));
  const nearExpiryQuotes = quotes.filter((q) => q.expiryDate.getTime() === nearestExpiryMs);

  const targetPutStrike = underlyingValue * (1 - skewOffsetPercent);
  const targetCallStrike = underlyingValue * (1 + skewOffsetPercent);

  const strikes = [...new Set(nearExpiryQuotes.map((q) => q.strikePrice))].filter(s => s > 0);
  if (strikes.length === 0) {
    return { skew: null, putIv: null, callIv: null, putStrike: null, callStrike: null };
  }

  const putStrike = strikes.reduce((best, strike) =>
    Math.abs(strike - targetPutStrike) < Math.abs(best - targetPutStrike) ? strike : best
  );

  const callStrike = strikes.reduce((best, strike) =>
    Math.abs(strike - targetCallStrike) < Math.abs(best - targetCallStrike) ? strike : best
  );

  const solveIv = (strike: number, type: OptionType): number | null => {
    const candidates = nearExpiryQuotes.filter(q => q.strikePrice === strike && q.optionType === type);
    if (candidates.length === 0) return null;

    const ivs: number[] = [];
    for (const quote of candidates) {
      const mid = midPriceForIv(quote.bid, quote.ask);
      const time = yearsToExpiry(observedAt, quote.expiryDate);
      if (mid !== null && time > 0) {
        const result = impliedVolatilityFromPremium({
          spot: underlyingValue,
          strike: quote.strikePrice,
          timeToExpiryYears: time,
          riskFreeRate: RISK_FREE_RATE,
          optionType: quote.optionType,
          premium: mid,
        });
        if (result.measurable) {
          ivs.push(result.impliedVolatility);
        }
      }
    }
    return ivs.length > 0 ? ivs.reduce((total, iv) => total + iv, 0) / ivs.length : null;
  };

  const putIv = solveIv(putStrike, "PE");
  const callIv = solveIv(callStrike, "CE");
  const skew = (putIv !== null && callIv !== null) ? putIv - callIv : null;

  return { skew, putIv, callIv, putStrike, callStrike };
}
