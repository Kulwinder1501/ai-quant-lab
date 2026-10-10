import type { ConfluenceSignal, ProposedTradeIdea } from "./strategy.js";
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
  /**
   * Expiry of the intended contract. When absent and the chain spans several expiries, the nearest
   * one is assumed and the assumption is reported in `unchecked`.
   */
  intendedExpiryDate?: Date;
  hasMacroEvent?: boolean;
  intendedContractDelta?: number | null;
  ivPercentile?: number | null;
  ivPercentileCeiling?: number;
  confluenceSignal?: ConfluenceSignal | null;
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

/**
 * Epoch ms of the expiry the intended contract is on: the caller's, else the nearest expiry present
 * in the chain. Null for a chain with no quotes.
 */
function resolveIntendedExpiryMs(chain: OptionChainSnapshot, intended: Date | undefined): number | null {
  if (intended) return intended.getTime();
  const expiries = chain.quotes.map(q => q.expiryDate.getTime());
  return expiries.length === 0 ? null : Math.min(...expiries);
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
    //
    // The heaviest-OI strike is only "support" (put wall) if it sits at or BELOW spot and only
    // "resistance" (call wall) if it sits at or ABOVE spot. A put wall above spot is not support
    // and a call wall below spot is not resistance, so the wall is compared with spot before it
    // is labelled. Without a spot reading the position is unknown and is reported as unchecked.
    // Informational either way: this never rejects an entry.
    //
    // The walls are taken over the intended expiry's book only: largest OI across several expiries
    // would mix different contracts.
    const intendedExpiryMs = resolveIntendedExpiryMs(optionChain, context.intendedExpiryDate);
    const wallQuotes = intendedExpiryMs === null
      ? optionChain.quotes
      : optionChain.quotes.filter(q => q.expiryDate.getTime() === intendedExpiryMs);
    const { call, put } = largestOpenInterestStrikes(wallQuotes);
    const spot = optionChain.underlyingValue;
    const hasSpot = spot != null && Number.isFinite(spot);

    if (proposedIdea.side === "LONG") {
      if (put && put.openInterest > 0) {
        if (!hasSpot) {
          unchecked.push(`Put OI wall at strike ${put.strikePrice}: no underlying value in the chain, so it cannot be classed as support or not.`);
        } else if (put.strikePrice <= spot) {
          reasons.push(`Strong Put OI support at strike ${put.strikePrice} (at or below spot ${spot}).`);
        } else {
          reasons.push(`Largest Put OI is at strike ${put.strikePrice}, ABOVE spot ${spot}: not support. Informational only.`);
        }
      }
    } else {
      if (call && call.openInterest > 0) {
        if (!hasSpot) {
          unchecked.push(`Call OI wall at strike ${call.strikePrice}: no underlying value in the chain, so it cannot be classed as resistance or not.`);
        } else if (call.strikePrice >= spot) {
          reasons.push(`Strong Call OI resistance at strike ${call.strikePrice} (at or above spot ${spot}).`);
        } else {
          reasons.push(`Largest Call OI is at strike ${call.strikePrice}, BELOW spot ${spot}: not resistance. Informational only.`);
        }
      }
    }

    if (intendedStrike) {
      // Match on expiry as well as strike and side: the same strike exists on every listed
      // expiry, and `find(strike && type)` returned whichever came first.
      const intendedContract = optionChain.quotes.find(
        q => q.strikePrice === intendedStrike
          && q.optionType === (proposedIdea.side === "LONG" ? "CE" : "PE")
          && (intendedExpiryMs === null || q.expiryDate.getTime() === intendedExpiryMs),
      );
      if (!context.intendedExpiryDate && new Set(optionChain.quotes.map(q => q.expiryDate.getTime())).size > 1) {
        unchecked.push(
          `Intended expiry: not supplied and the chain spans several expiries, so the nearest expiry (${new Date(intendedExpiryMs ?? 0).toISOString().slice(0, 10)}) was assumed.`,
        );
      }
      if (intendedContract) {
        // Informational, deliberately NOT a rejection. `openInterestChange` is the vendor's
        // open_interest - previous_open_interest, i.e. change versus the PREVIOUS DAY's close, not
        // a poll-to-poll flow. Falling day-over-day OI is read by direction of the price move:
        // unwinding on a rising premium is short-covering, on a falling one is long liquidation,
        // so the sign alone says nothing about whether to buy. It also fires on nearly every
        // contract close to expiry, where positions are closed out routinely. Nothing in this repo
        // shows that an OI decline predicts worse entries, so it no longer blocks.
        if (intendedContract.openInterestChange !== null && intendedContract.openInterestChange < 0) {
          reasons.push(
            `Open interest on the intended strike ${intendedStrike} is down ${Math.abs(intendedContract.openInterestChange)} versus the previous day's close. Informational only: day-over-day OI change is not a rejection signal.`,
          );
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
  //
  // Kill switch: apps/ml/orderbook01_verdict.json (re-run 2026-10-05, after fixing two
  // confirmed bugs -- see docs/2026-10-05-orderbook01-bug-fixes-and-honest-verdict.md) recorded
  // CASE E -- "FALSIFIED. No robust directional edge found in OOS test." A 2026-09-28 run had
  // also found CASE E, but an 2026-10-01 re-derivation (now known to be wrong) tested model
  // accuracy against a 50/50 coin-flip null on heavily class-imbalanced labels (PDL breaches
  // 97%+ of the time), which let a below-trivial-baseline accuracy (96.8% model vs 97.3%
  // always-predict-breach) read as "PASS" and briefly re-enabled this flag. The 2026-10-05
  // re-run fixed that (majority-class baseline + one-sided McNemar test) and reconfirmed CASE E
  // outright: every hypothesis's model accuracy is now shown to sit *below* its real trivial
  // baseline. ORDERBOOK01_LIVE_GATE_ENABLED defaults OFF pending a documented edge: the shadow
  // verdict below is still computed and still pushed into `reasons` unchanged (shadow-trade
  // logging in generate-trade-ideas.ts / orderbook-directional-gate.ts is untouched and keeps
  // measuring would-have-happened P&L), it just no longer flips `isValid` and rejects a real
  // paper trade entry. Set it to exactly "true" to restore the blocking behaviour -- but only
  // after a genuine PASS, not by patching the test until one appears.
  const orderbook01LiveGateEnabled = process.env.ORDERBOOK01_LIVE_GATE_ENABLED === "true";
  if (context.confluenceSignal != null) {
    if (context.confluenceSignal.is_level_proximate) {
      const obResult = evaluateOrderbookDirectionalGate(proposedIdea.side, context.confluenceSignal);
      if (obResult.gateStatus === "BLOCK") {
        if (orderbook01LiveGateEnabled) {
          isValid = false;
        }
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
