import type { ProposedTradeIdea } from "./strategy.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { largestOpenInterestStrikes } from "../../market-data/domain/option-chain.js";
import { yearsToExpiry } from "@ai-quant-lab/pricing";
import { evaluateOrderbookDirectionalGate } from "./orderbook-directional-gate.js";

export interface OptionsValidationContext {
  proposedIdea: Pick<ProposedTradeIdea, "side" | "confidence" | "reasoning">;
  candleVolume?: number | null;
  volumeAbsenceReason?: string;
  optionChain?: OptionChainSnapshot;
  intendedStrike?: number;
  hasMacroEvent?: boolean;
  intendedContractDelta?: number | null;
  ivPercentile?: number | null;
  ivPercentileCeiling?: number;
  confluenceSignal?: {
    is_level_proximate?: boolean;
    nearest_level_type?: string | null;
    nearest_level_price?: number | null;
    distance_bps?: number | null;
    raw_di?: number | null;
    di_tilde?: number | null;
    directional_bias?: string;
    gate_action?: string;
  } | null;
}

export interface OptionsValidationResult {
  isValid: boolean;
  reasons: string[];
  /**
   * Factors that could not be evaluated for want of an input, so a caller can tell
   * "checked and passed" from "never checked". `isValid: true` with a non-empty list here
   * is a weaker statement than `isValid: true` with an empty one.
   */
  unchecked: string[];
}

export function validateOptionsEntry(context: OptionsValidationContext): OptionsValidationResult {
  const reasons: string[] = [];
  const unchecked: string[] = [];
  let isValid = true;
  const {
    proposedIdea, candleVolume, volumeAbsenceReason, optionChain, intendedStrike,
    hasMacroEvent, intendedContractDelta,
  } = context;

  // Every chain-derived factor below needs a chain. Without one they are unchecked, not
  // satisfied -- the whole block used to be skipped in silence.
  if (!optionChain || optionChain.quotes.length === 0) {
    unchecked.push("Open interest, liquidity, expiry and greeks: no option chain was supplied.");
  }

  // Macro Events Check.
  //
  // Blocks only when a caller asserts a macro event. It is deliberately not fed from the
  // headline keyword detector: measured on 2026-08-05 that fires on 7 of 9 days, so wiring
  // it here would refuse almost every entry. See ai-autonomous-agent for the measurement.
  if (hasMacroEvent === true) {
    isValid = false;
    reasons.push("Macro Event Filter: a scheduled macro event was asserted for today. Options entry is blocked to avoid volatility crush.");
  } else if (hasMacroEvent === undefined) {
    unchecked.push("Macro events: no scheduled-event calendar exists, so event risk was not screened.");
  }

  // 1-6: Price action, Trend, Market Structure, Trade Direction
  if (proposedIdea.confidence < 0.6) {
    isValid = false;
    reasons.push("Trade idea confidence is too low (< 0.6) for an options entry.");
  }

  // 7: Volume - Breakout should ideally have strong volume
  const hasStrongVolume = proposedIdea.reasoning.some(r => r.toLowerCase().includes("volume") && !r.toLowerCase().includes("low volume"));
  if (candleVolume == null) {
    unchecked.push(
      `Volume confirmation: ${volumeAbsenceReason ?? "no bar volume was supplied"}.`,
    );
  } else if (!hasStrongVolume && candleVolume <= 0) {
    isValid = false;
    reasons.push("Low-volume moves are weak or false. Avoid options entry without volume confirmation.");
  }

  if (optionChain && optionChain.quotes.length > 0) {
    // 8: Open Interest (OI)
    const { call, put } = largestOpenInterestStrikes(optionChain.quotes);
    
    if (proposedIdea.side === "LONG") {
      if (put && put.openInterest > 0) {
        reasons.push(`Confirmed strong Put OI support at strike ${put.strikePrice}.`);
      }
    } else {
      if (call && call.openInterest > 0) {
        reasons.push(`Confirmed strong Call OI resistance at strike ${call.strikePrice}.`);
      }
    }

    if (intendedStrike) {
      const intendedContract = optionChain.quotes.find(
        q => q.strikePrice === intendedStrike && q.optionType === (proposedIdea.side === "LONG" ? "CE" : "PE")
      );
      if (intendedContract) {
        if (intendedContract.openInterestChange !== null && intendedContract.openInterestChange < 0) {
          isValid = false;
          reasons.push(`Open interest is decreasing on the intended strike ${intendedStrike}. Avoid entry.`);
        }

        // Spread & Liquidity Check (Max 3%)
        //
        // `!= null` rather than `!== null`: the fields are `number | null`, and an
        // `x !== null` test passes for `undefined` too, so a mistyped field name would
        // reach the arithmetic and quietly produce NaN. That is how this check read
        // before -- it referenced `bidPrice`/`askPrice`, which do not exist on a quote,
        // so `midPrice > 0` was false and the spread was never evaluated.
        if (intendedContract.bid != null && intendedContract.ask != null && intendedContract.ask > 0) {
           const midPrice = (intendedContract.bid + intendedContract.ask) / 2;
           if (midPrice > 0) {
             const spread = (intendedContract.ask - intendedContract.bid) / midPrice;
             if (spread > 0.03) {
               isValid = false;
               reasons.push(`Liquidity Alert: Bid-Ask spread for strike ${intendedStrike} is ${(spread * 100).toFixed(1)}% (Limit: 3%). Wide spreads increase slippage costs.`);
             }
           }
        } else {
          unchecked.push(`Bid-ask spread for strike ${intendedStrike}: the contract has no two-sided quote, so its cost to trade is unknown.`);
        }

        // Expiry & Time Decay Check
        //
        // Derived from the contract's own expiry and the snapshot's observation time, both
        // already present. A quote carries no `daysToExpiry` field, which is what the
        // previous version read.
        const daysToExpiry = yearsToExpiry(optionChain.observedAt, intendedContract.expiryDate) * 365;
        if (daysToExpiry < 1 && proposedIdea.confidence < 0.8) {
          isValid = false;
          reasons.push(`Time Decay Alert: 0-DTE option is highly sensitive. ML Confidence is ${proposedIdea.confidence} (requires > 0.8 for 0-DTE scalp).`);
        }

        // Greek Enforcement (Delta)
        if (intendedContractDelta != null) {
          if (Math.abs(intendedContractDelta) < 0.40) {
             isValid = false;
             reasons.push(`Greek Alert: Contract Delta is ${intendedContractDelta.toFixed(2)}. Avoid buying far-OTM options (|Delta| < 0.40).`);
          }
        } else {
          unchecked.push(`Delta for strike ${intendedStrike}: no solved delta was supplied, so far-OTM contracts were not screened out.`);
        }
      }
    }

    const hasVolatilityExpansion = proposedIdea.reasoning.some(r => r.includes("VOLATILITY_EXPANSION"));
    if (hasVolatilityExpansion) {
      reasons.push("Volatility expansion regime confirmed. Premium buying is justified.");
    }
  }

  // 12: IV Percentile Ceiling Gate
  const ivPercentileCeiling = context.ivPercentileCeiling ?? 85;
  if (context.ivPercentile !== null && context.ivPercentile !== undefined) {
    if (context.ivPercentile >= ivPercentileCeiling) {
      isValid = false;
      reasons.push(
        `IV Regime Alert: IV percentile ${context.ivPercentile.toFixed(0)}% >= ${ivPercentileCeiling}% ceiling. Options buying in extreme elevated IV risks severe volatility crush.`,
      );
    } else {
      reasons.push(`IV percentile ${context.ivPercentile.toFixed(0)}% clears ceiling (${ivPercentileCeiling}%).`);
    }
  } else {
    unchecked.push("IV percentile: IV percentile is unavailable; trade allowed but ivPercentileUnavailable is recorded.");
  }

  // 13: ORDERBOOK-01 Directional Gate
  if (context.confluenceSignal != null) {
    if (context.confluenceSignal.is_level_proximate) {
      const obResult = evaluateOrderbookDirectionalGate(proposedIdea.side, context.confluenceSignal);
      if (obResult.gateStatus === "BLOCK") {
        isValid = false;
        reasons.push(obResult.reasoning ?? "ORDERBOOK-01 Directional Gate BLOCKED entry.");
      } else if (obResult.gateStatus === "PASS") {
        reasons.push(obResult.reasoning ?? "ORDERBOOK-01 Directional Gate PASSED entry.");
      }
    } else {
      unchecked.push("ORDERBOOK-01 Directional Gate: No structural level proximate within bandwidth.");
    }
  }

  return {
    isValid,
    reasons,
    unchecked,
  };
}
