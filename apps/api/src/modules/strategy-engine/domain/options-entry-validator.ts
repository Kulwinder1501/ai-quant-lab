import type { ProposedTradeIdea } from "./strategy.js";
import type { OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { largestOpenInterestStrikes } from "../../market-data/domain/option-chain.js";
import { yearsToExpiry } from "@ai-quant-lab/pricing";

export interface OptionsValidationContext {
  /**
   * Only the three fields actually read. It used to demand a whole `StrategyMarketContext`
   * and `ProposedTradeIdea` to reach one volume and three idea fields, which is why no
   * caller could reasonably construct the input -- and why this went unwired.
   */
  proposedIdea: Pick<ProposedTradeIdea, "side" | "confidence" | "reasoning">;
  /**
   * Volume of the bar the idea was raised on. Omit when unknown; it is then unchecked.
   *
   * Must be null rather than 0 when the series does not report volume at all. Measured
   * 2026-08-05: every one of 1,069 stored 15m BANKNIFTY and NIFTY50 bars has zero or null
   * volume -- not because intraday index volume is unavailable, but because 15m belongs to
   * Yahoo under the provenance split and Yahoo carries none. The Fyers 5m series for the
   * same index is 99.9% populated. Passing that 0 through would read as "nobody traded" and
   * refuse essentially every 15m-sourced index entry, when the honest reading is "this
   * series carries no volume".
   */
  candleVolume?: number | null;
  /**
   * Why volume is absent, when it is. Without it "not reported by this series" and "nobody
   * looked it up" produce the same unchecked line, and only one of those is worth acting on.
   */
  volumeAbsenceReason?: string;
  optionChain?: OptionChainSnapshot;
  intendedStrike?: number;
  hasMacroEvent?: boolean;
  /**
   * Delta of the intended contract, supplied by the caller.
   *
   * It cannot be read off a chain quote: the provider returns no greeks, so a delta only
   * exists once an IV has been solved from the mid. Passing it in keeps this function a
   * pure check rather than a second pricing path that could disagree with the first.
   *
   * When absent the delta factor is reported as unchecked rather than passed. An entry
   * validator that stays silent about a factor it could not evaluate is the failure this
   * project has already paid for twice.
   */
  intendedContractDelta?: number | null;
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

  return {
    isValid,
    reasons,
    unchecked,
  };
}
