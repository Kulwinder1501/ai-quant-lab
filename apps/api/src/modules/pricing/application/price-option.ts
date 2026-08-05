import {
  priceEuropeanOption,
  yearsToExpiry,
  type OptionGreeks,
  type OptionType,
} from "@ai-quant-lab/pricing";

import { RISK_FREE_RATE } from "@ai-quant-lab/pricing";

export interface PriceOptionRequest {
  underlyingPrice: number;
  strikePrice: number;
  expiryDate: Date;
  optionType: OptionType;
  /** Implied vol as decimal (0.12) or percent (12); values > 1 are treated as percent. */
  impliedVolatility: number;
  riskFreeRate?: number;
  asOf?: Date;
}

export interface PriceOptionResult extends OptionGreeks {
  timeToExpiryYears: number;
  riskFreeRate: number;
  impliedVolatility: number;
  optionType: OptionType;
  strikePrice: number;
  underlyingPrice: number;
  expiryDate: string;
}

function normalizeIv(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("Implied volatility must be a positive finite number.");
  }
  return raw > 1 ? raw / 100 : raw;
}

/** Stateless options pricing use-case over the Black–Scholes engine. */
export function priceOption(input: PriceOptionRequest): PriceOptionResult {
  const asOf = input.asOf ?? new Date();
  const iv = normalizeIv(input.impliedVolatility);
  const rate = input.riskFreeRate ?? RISK_FREE_RATE;
  const T = yearsToExpiry(asOf, input.expiryDate);
  const greeks = priceEuropeanOption({
    spot: input.underlyingPrice,
    strike: input.strikePrice,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    volatility: iv,
    optionType: input.optionType,
  });
  return {
    ...greeks,
    timeToExpiryYears: T,
    riskFreeRate: rate,
    impliedVolatility: iv,
    optionType: input.optionType,
    strikePrice: input.strikePrice,
    underlyingPrice: input.underlyingPrice,
    expiryDate: input.expiryDate.toISOString(),
  };
}
