import type { PaperTrade } from "./paper-trading.js";
import { isOptionBuyerTrade, priceOptionMark } from "./option-mark-to-market.js";

export type LiveValuationSource = "OPTION_MODEL" | "UNDERLYING_SPOT" | "UNAVAILABLE";
export type LiveValuationVolatilitySource = "INDIA_VIX" | "ENTRY_IV" | null;

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
  reason: string | null;
}

export interface ValuePaperTradeInput {
  trade: PaperTrade;
  livePrices: Readonly<Record<string, number>>;
  asOf: Date;
  currentVolatility?: number | null;
}

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
    reason,
  };
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

    const currentVolatility = validPositive(input.currentVolatility)
      ? input.currentVolatility
      : null;
    const entryVolatility = validPositive(trade.entryIv) ? trade.entryIv : null;
    const volatility = currentVolatility ?? entryVolatility;
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
        volatilitySource: currentVolatility === null ? "ENTRY_IV" : "INDIA_VIX",
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
    reason: null,
  };
}
