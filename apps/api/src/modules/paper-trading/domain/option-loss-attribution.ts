import type { OptionType } from "../../market-data/domain/option-chain.js";
import { priceEuropeanOption, yearsToExpiry, RISK_FREE_RATE } from "@ai-quant-lab/pricing";

export const MAX_RESEARCH_MARK_DELAY_MS = 60_000;

export interface OptionLossAttributionInput {
  side: "LONG" | "SHORT";
  quantity: number;
  optionType: OptionType;
  optionStrike: number;
  optionExpiry: Date;
  openedAt: Date;
  closedAt: Date;
  actualEntryPrice: number;
  actualExitPrice: number;
  entryFees: number;
  exitFees: number;
  underlyingEntryPrice: number | null;
  underlyingExitPrice: number | null;
  entryIv: number | null;
  exitIv: number | null;
  researchEntryOptionPrice: number | null;
  researchExitOptionPrice: number | null;
  researchEntryBarTime?: Date | null;
  researchExitBarTime?: Date | null;
}

export interface OptionLossAttributionResult {
  attributionStatus: "COMPLETED" | "RESEARCH_MARK_UNAVAILABLE";
  researchEntryBarTime: Date | null;
  researchExitBarTime: Date | null;
  deltaPResearch: number | null;
  deltaPModel: number | null;
  attributionResidual: number | null;
  deltaPSpot: number | null;
  deltaPTime: number | null;
  deltaPVol: number | null;
  deltaPActual: number;
  contractMultiplier: number;
  realizedGrossPnL: number;
  realizedNetPnL: number;
}

function bsPrice(
  spot: number,
  strike: number,
  iv: number,
  timeToExpiryYears: number,
  optionType: OptionType,
): number {
  return priceEuropeanOption({
    spot,
    strike,
    volatility: iv,
    timeToExpiryYears,
    riskFreeRate: RISK_FREE_RATE,
    optionType,
  }).premium;
}

export function computeOptionLossAttribution(
  input: OptionLossAttributionInput,
): OptionLossAttributionResult {
  const contractMultiplier = 1;
  const deltaPActual = input.actualExitPrice - input.actualEntryPrice;
  const realizedGrossPnL = input.quantity * contractMultiplier * deltaPActual;
  const realizedNetPnL = realizedGrossPnL - (input.entryFees + input.exitFees);

  const hasResearchMarks =
    input.researchEntryOptionPrice !== null &&
    input.researchExitOptionPrice !== null &&
    Number.isFinite(input.researchEntryOptionPrice) &&
    Number.isFinite(input.researchExitOptionPrice);

  if (!hasResearchMarks) {
    return {
      attributionStatus: "RESEARCH_MARK_UNAVAILABLE",
      researchEntryBarTime: null,
      researchExitBarTime: null,
      deltaPResearch: null,
      deltaPModel: null,
      attributionResidual: null,
      deltaPSpot: null,
      deltaPTime: null,
      deltaPVol: null,
      deltaPActual,
      contractMultiplier,
      realizedGrossPnL,
      realizedNetPnL,
    };
  }

  const S0 = input.underlyingEntryPrice;
  const S1 = input.underlyingExitPrice;
  const IV0 = input.entryIv;
  const IV1 = input.exitIv;
  const K = input.optionStrike;
  const bsType = input.optionType;

  const T0 = yearsToExpiry(input.openedAt, input.optionExpiry);
  const T1 = yearsToExpiry(input.closedAt, input.optionExpiry);

  const canDecompose =
    S0 !== null &&
    S1 !== null &&
    IV0 !== null &&
    IV1 !== null &&
    Number.isFinite(S0) && S0 > 0 &&
    Number.isFinite(S1) && S1 > 0 &&
    Number.isFinite(IV0) && IV0 > 0 &&
    Number.isFinite(IV1) && IV1 > 0 &&
    T0 > 0 &&
    T1 >= 0;

  const deltaPResearch = input.researchExitOptionPrice! - input.researchEntryOptionPrice!;

  if (!canDecompose) {
    return {
      attributionStatus: "COMPLETED",
      researchEntryBarTime: input.researchEntryBarTime ?? null,
      researchExitBarTime: input.researchExitBarTime ?? null,
      deltaPResearch,
      deltaPModel: null,
      attributionResidual: null,
      deltaPSpot: null,
      deltaPTime: null,
      deltaPVol: null,
      deltaPActual,
      contractMultiplier,
      realizedGrossPnL,
      realizedNetPnL,
    };
  }

  const P0 = bsPrice(S0, K, IV0, T0, bsType);
  const P1 = bsPrice(S1, K, IV0, T0, bsType);
  const P2 = bsPrice(S1, K, IV0, T1, bsType);
  const P3 = bsPrice(S1, K, IV1, T1, bsType);

  const deltaPSpot = P1 - P0;
  const deltaPTime = P2 - P1;
  const deltaPVol = P3 - P2;
  const deltaPModel = P3 - P0;
  const attributionResidual = deltaPResearch - deltaPModel;

  return {
    attributionStatus: "COMPLETED",
    researchEntryBarTime: input.researchEntryBarTime ?? null,
    researchExitBarTime: input.researchExitBarTime ?? null,
    deltaPResearch,
    deltaPModel,
    attributionResidual,
    deltaPSpot,
    deltaPTime,
    deltaPVol,
    deltaPActual,
    contractMultiplier,
    realizedGrossPnL,
    realizedNetPnL,
  };
}
