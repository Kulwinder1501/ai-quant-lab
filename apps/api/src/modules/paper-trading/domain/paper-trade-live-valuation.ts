import type { PaperTrade } from "./paper-trading.js";
import { isOptionBuyerTrade, priceOptionMark } from "./option-mark-to-market.js";
import { priceEuropeanOption, yearsToExpiry } from "@ai-quant-lab/pricing";
import {
  effectiveSpotForForward,
  impliedVolatilityFromPremium,
} from "@ai-quant-lab/pricing";

/**
 * How the mark was obtained, in descending order of authority.
 *
 * `OPTION_CHAIN_MID` is a price someone was actually quoting. `OPTION_MODEL` is this
 * project's opinion of what the contract is worth, which is a fallback and not an
 * improvement on an observed market.
 */
export type LiveValuationSource =
  | "OPTION_CHAIN_MID"
  | "OPTION_MODEL"
  | "UNDERLYING_SPOT"
  | "UNAVAILABLE";
/** `CHAIN_IMPLIED` is solved from the observed mid, so it needs no external vol input. */
export type LiveValuationVolatilitySource = "CHAIN_IMPLIED" | "INDIA_VIX" | "ENTRY_IV" | null;

/**
 * Position greeks, at the same volatility the mark was computed from.
 *
 * Null together with the mark, never independently. A greek derived from a different
 * volatility than the P&L beside it would describe a position the account does not hold,
 * and the two would disagree without saying so.
 *
 * Per contract, not per position: multiply by quantity for portfolio exposure. Reported
 * per-unit so a greek is comparable across positions of different size, which is the form
 * the option chain shows and the form a hedge ratio is read in.
 */
export interface PaperTradeGreeks {
  delta: number;
  gamma: number;
  /** Currency per calendar day, negative for a long option: the buyer pays theta. */
  theta: number;
  /** Per one absolute percentage point of IV. Positive for calls and puts alike. */
  vega: number;
}

export interface PaperTradeLiveValuation {
  status: "AVAILABLE" | "UNAVAILABLE";
  source: LiveValuationSource;
  markPrice: number | null;
  underlyingPrice: number | null;
  unrealizedPnl: number | null;
  returnPercent: number | null;
  asOf: string;
  volatility: number | null;
  volatilitySource: LiveValuationVolatilitySource;
  /** Present only for a model-marked option position; null for spot and unavailable. */
  greeks: PaperTradeGreeks | null;
  /** Days left on the contract, so theta has a horizon to be read against. */
  daysToExpiry: number | null;
  reason: string | null;
}

/**
 * A quote for this exact contract, read from a stored option-chain snapshot.
 *
 * When present and fresh this becomes the mark, because a price someone was quoting
 * beats a model's estimate of one. The model remains the fallback for contracts no
 * snapshot covers, which is most single-stock strikes and every expiry outside the
 * collected range.
 */
export interface ObservedOptionQuote {
  /** Mid of a two-sided quote. A one-sided market must not reach here. */
  mid: number;
  bid: number | null;
  ask: number | null;
  observedAt: Date;
  /**
   * Put-call parity forward for this expiry, when the snapshot could supply one.
   *
   * Without it the IV solved from the mid inherits the same carry error the chain route
   * had before it was fixed: assuming a forward of S*e^(rT) put a live BANKNIFTY forward
   * 211 points above spot when the market priced it 193 below, a 0.7% error landing
   * straight in the delta.
   */
  impliedForward: number | null;
  /**
   * The index level in the same observation. Lets an old quote keep standing as the mark while the index has not
   * moved (after the close, say), and lets the model be calibrated to the volatility this quote implied.
   */
  underlyingValue?: number | null;
}

export interface ValuePaperTradeInput {
  trade: PaperTrade;
  livePrices: Readonly<Record<string, number>>;
  asOf: Date;
  currentVolatility?: number | null;
  observedQuote?: ObservedOptionQuote | null;
  /**
   * How old an observed quote may be and still be a mark. Defaults to 2 minutes, the age a buy's fill quote
   * is held to. It was 40 minutes, which marked a call bought at the live ask of Rs 575 at the mid of a snapshot
   * taken before the buy (Rs 556.63) and opened it Rs 551 under water.
   */
  maxQuoteAgeMs?: number;
}

const DEFAULT_MAX_QUOTE_AGE_MS = 2 * 60 * 1000;
/** A quote older than the position itself cannot be its mark; this much slack covers clock skew between sources. */
const QUOTE_BEFORE_OPEN_SLACK_MS = 10 * 1000;
/**
 * A quote may be stamped a little after the valuation instant: the live stream ticks several times a second, so one
 * can land between a request starting and its mark being priced. That is the market moving, not a quote from the
 * future, and rejecting it sent the mark to the model (631 vs 574 on a 55400 CE, Rs 3,400 of P&L). A real clock
 * fault is minutes, not seconds.
 */
const QUOTE_AFTER_AS_OF_SLACK_MS = 5 * 1000;
/**
 * A quote past the freshness limit still stands as the mark while the index sits where it did when the quote was
 * taken: nothing that moves the premium has happened. 0.5 basis points is ~3 BANKNIFTY points, worth well under a
 * premium point. After the close the index is frozen at exactly the last quote's level, so the last price holds.
 */
const SPOT_ANCHOR_TOLERANCE = 0.00005;
/** Past this a quote is yesterday's, however still the index looks. */
const MAX_ANCHORED_QUOTE_AGE_MS = 20 * 60 * 60 * 1000;
import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";

function validPositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function hasAnyOptionContractField(trade: PaperTrade): boolean {
  return trade.optionStrike != null
    || trade.optionExpiry != null
    || trade.optionType != null
    || trade.underlyingSymbol != null
    || trade.entryIv != null;
}

export function resolvePaperTradeLiveSpot(
  trade: PaperTrade,
  livePrices: Readonly<Record<string, number>>,
): number | null {
  const keys = [
    trade.underlyingSymbol,
    trade.instrumentSymbol,
    trade.instrumentId,
  ].filter((key): key is string => typeof key === "string" && key.trim().length > 0);

  for (const key of keys) {
    const price = livePrices[key.toUpperCase()] ?? livePrices[key];
    if (validPositive(price)) return price;
  }
  return null;
}

function unavailable(
  asOf: Date,
  reason: string,
  underlyingPrice: number | null = null,
): PaperTradeLiveValuation {
  return {
    status: "UNAVAILABLE",
    source: "UNAVAILABLE",
    markPrice: null,
    underlyingPrice,
    unrealizedPnl: null,
    returnPercent: null,
    asOf: asOf.toISOString(),
    volatility: null,
    volatilitySource: null,
    greeks: null,
    daysToExpiry: null,
    reason,
  };
}

/**
 * The volatility the contract's own last quote implied, solved at that quote's index level and instant.
 *
 * When the index has moved since a quote was taken, the quote is no longer the mark -- but it is still the best
 * evidence of how the market prices this strike, which India VIX is not: it put a BANKNIFTY 55400 CE at Rs 609
 * when the market had it at Rs 653 (14.1% against ~15.5% implied), Rs 2,600 of phantom loss on 60 units.
 */
function volatilityFromLastQuote(
  trade: PaperTrade,
  observed: ObservedOptionQuote | null,
  asOf: Date,
): number | null {
  if (observed === null || !validPositive(observed.mid) || !validPositive(observed.underlyingValue)) return null;
  const ageMs = asOf.getTime() - observed.observedAt.getTime();
  if (ageMs > MAX_ANCHORED_QUOTE_AGE_MS || ageMs < -QUOTE_AFTER_AS_OF_SLACK_MS) return null;
  const timeToExpiry = yearsToExpiry(observed.observedAt, trade.optionExpiry as Date);
  if (!(timeToExpiry > 0)) return null;
  const solved = impliedVolatilityFromPremium({
    spot: observed.underlyingValue,
    strike: trade.optionStrike as number,
    timeToExpiryYears: timeToExpiry,
    riskFreeRate: RISK_FREE_RATE,
    optionType: trade.optionType as "CE" | "PE",
    premium: observed.mid,
  });
  return solved.measurable ? solved.impliedVolatility : null;
}

function pnlForMark(trade: PaperTrade, markPrice: number): { pnl: number; returnPercent: number } {
  const priceMove = trade.side === "LONG"
    ? markPrice - trade.entryPrice
    : trade.entryPrice - markPrice;
  const pnl = priceMove * trade.quantity;
  const deployedCapital = trade.entryPrice * trade.quantity;
  return {
    pnl,
    returnPercent: deployedCapital > 0 ? (pnl / deployedCapital) * 100 : 0,
  };
}

/**
 * Produces the one server-authoritative mark consumed by dashboards and manual exits.
 * Option positions are always valued in premium space; the underlying spot is context
 * only and can never become the option's exit price.
 */
export function valuePaperTrade(input: ValuePaperTradeInput): PaperTradeLiveValuation {
  const { trade, livePrices, asOf } = input;
  if (Number.isNaN(asOf.getTime())) {
    throw new Error("Live valuation as-of timestamp is invalid.");
  }

  const spot = resolvePaperTradeLiveSpot(trade, livePrices);

  if (hasAnyOptionContractField(trade)) {
    if (!isOptionBuyerTrade(trade)) {
      return unavailable(asOf, "Option contract metadata is incomplete.", spot);
    }
    if (spot === null) {
      return unavailable(asOf, `No live underlying price is available for ${trade.underlyingSymbol}.`);
    }

    // An observed two-sided quote outranks the model: it is a price someone was
    // willing to trade at, where the model is only an estimate of one.
    const observed = input.observedQuote ?? null;
    const quoteAgeMs = observed === null
      ? null
      : asOf.getTime() - observed.observedAt.getTime();
    const maxAge = input.maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE_MS;
    const predatesPosition = observed !== null
      && trade.openedAt instanceof Date
      && observed.observedAt.getTime() < trade.openedAt.getTime() - QUOTE_BEFORE_OPEN_SLACK_MS;
    const withinFreshness = quoteAgeMs !== null
      && quoteAgeMs >= -QUOTE_AFTER_AS_OF_SLACK_MS && quoteAgeMs <= maxAge;
    const anchoredToSpot = observed !== null && quoteAgeMs !== null
      && quoteAgeMs > maxAge && quoteAgeMs <= MAX_ANCHORED_QUOTE_AGE_MS
      && validPositive(observed.underlyingValue)
      && Math.abs(spot - observed.underlyingValue) / observed.underlyingValue <= SPOT_ANCHOR_TOLERANCE;
    if (observed !== null && !predatesPosition && validPositive(observed.mid) && (withinFreshness || anchoredToSpot)) {
      const timeToExpiry = yearsToExpiry(asOf, trade.optionExpiry as Date);
      // The forward the option market itself prices, when the snapshot could supply
      // it; spot only as a last resort, and the bias is then the known one.
      const pricingSpot = observed.impliedForward !== null && timeToExpiry > 0
        ? effectiveSpotForForward(observed.impliedForward, RISK_FREE_RATE, timeToExpiry)
        : spot;
      const solved = impliedVolatilityFromPremium({
        spot: pricingSpot,
        strike: trade.optionStrike as number,
        timeToExpiryYears: timeToExpiry,
        riskFreeRate: RISK_FREE_RATE,
        optionType: trade.optionType as "CE" | "PE",
        premium: observed.mid,
      });
      // Greeks require an IV. When the mid cannot be inverted the mark still stands --
      // it is the market's own price -- but no greek is invented to accompany it.
      const chainGreeks = solved.measurable
        ? priceEuropeanOption({
          spot: pricingSpot,
          strike: trade.optionStrike as number,
          timeToExpiryYears: timeToExpiry,
          riskFreeRate: RISK_FREE_RATE,
          volatility: solved.impliedVolatility,
          optionType: trade.optionType as "CE" | "PE",
        })
        : null;
      const chainResult = pnlForMark(trade, observed.mid);
      return {
        status: "AVAILABLE",
        source: "OPTION_CHAIN_MID",
        markPrice: observed.mid,
        underlyingPrice: spot,
        unrealizedPnl: chainResult.pnl,
        returnPercent: chainResult.returnPercent,
        asOf: asOf.toISOString(),
        volatility: solved.measurable ? solved.impliedVolatility : null,
        volatilitySource: solved.measurable ? "CHAIN_IMPLIED" : null,
        greeks: chainGreeks === null ? null : {
          delta: chainGreeks.delta,
          gamma: chainGreeks.gamma,
          theta: chainGreeks.theta,
          vega: chainGreeks.vega,
        },
        daysToExpiry: timeToExpiry > 0 ? timeToExpiry * 365 : 0,
        // Only populated when the greeks are missing, so the row can say why the mark
        // is trustworthy while the greeks are absent.
        reason: solved.measurable
          ? (anchoredToSpot
            ? `Last quote ${observed.observedAt.toISOString()}; the index is unchanged since, so it still stands.`
            : null)
          : solved.explanation,
      };
    }

    const calibratedVolatility = volatilityFromLastQuote(trade, observed, asOf);
    const currentVolatility = validPositive(input.currentVolatility)
      ? input.currentVolatility
      : null;
    const entryVolatility = validPositive(trade.entryIv) ? trade.entryIv : null;
    const volatility = calibratedVolatility ?? currentVolatility ?? entryVolatility;
    if (volatility === null) {
      return unavailable(asOf, "Neither a current India VIX value nor entry IV is available.", spot);
    }

    try {
      const mark = priceOptionMark({ trade, spot, asOf, volatility });
      const result = pnlForMark(trade, mark.premium);
      return {
        status: "AVAILABLE",
        source: "OPTION_MODEL",
        markPrice: mark.premium,
        underlyingPrice: spot,
        unrealizedPnl: result.pnl,
        returnPercent: result.returnPercent,
        asOf: asOf.toISOString(),
        volatility,
        volatilitySource: calibratedVolatility !== null
          ? "CHAIN_IMPLIED"
          : currentVolatility === null ? "ENTRY_IV" : "INDIA_VIX",
        // Straight from the mark, so the greeks and the P&L above describe one model
        // evaluation rather than two.
        greeks: {
          delta: mark.greeks.delta,
          gamma: mark.greeks.gamma,
          theta: mark.greeks.theta,
          vega: mark.greeks.vega,
        },
        daysToExpiry: mark.timeToExpiryYears > 0 ? mark.timeToExpiryYears * 365 : 0,
        reason: null,
      };
    } catch (error) {
      return unavailable(
        asOf,
        error instanceof Error ? error.message : "The option premium could not be marked.",
        spot,
      );
    }
  }

  if (spot === null) {
    return unavailable(asOf, `No live market price is available for ${trade.instrumentSymbol ?? trade.instrumentId}.`);
  }
  const result = pnlForMark(trade, spot);
  return {
    status: "AVAILABLE",
    source: "UNDERLYING_SPOT",
    markPrice: spot,
    underlyingPrice: spot,
    unrealizedPnl: result.pnl,
    returnPercent: result.returnPercent,
    asOf: asOf.toISOString(),
    volatility: null,
    volatilitySource: null,
    // A spot-marked position has no option contract, so it has no greeks. Reporting
    // delta 1 here would imply an option-like exposure the row does not represent.
    greeks: null,
    daysToExpiry: null,
    reason: null,
  };
}
