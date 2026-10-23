import {
  RISK_FREE_RATE,
  effectiveSpotForForward,
  impliedVolatilityFromPremium,
  midPriceForIv,
  priceEuropeanOption,
} from "@ai-quant-lab/pricing";
import { getApiV1Url } from "../research/api";

/**
 * The live option chain: the types the API returns, and how a streamed tick is merged into one.
 *
 * Shared by the Option Chain page and the Manual Trade picker, so both read the market the same way. The
 * picker used to re-fetch the stored snapshot instead, which is minutes old and, polled, would also have
 * overwritten any tick already merged.
 */

/** The cost budget the measured volatility edge can afford: it dies near 1.09% per leg. */
export const DEFAULT_COST_BUDGET_PERCENT = 1.0;

export interface Leg {
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  openInterestChange: number | null;
  spreadAbsolute: number | null;
  spreadPercentOfMid: number | null;
  withinCostBudget: boolean | null;
  moneyness: "ITM" | "ATM" | "OTM" | null;
  providerSymbol: string;
  /** Solved from the mid, not published by the exchange. Null carries a reason. */
  impliedVolatility: number | null;
  impliedVolatilityRefusal: string | null;
  /** Computed at the solved IV, so null together with it - never at a house volatility. */
  delta: number | null;
  gamma: number | null;
  /** Currency per calendar day. Negative for a long option: the buyer pays theta. */
  theta: number | null;
  /** Per one absolute percentage point of IV. Positive for calls and puts alike. */
  vega: number | null;
  daysToExpiry: number | null;
  /**
   * What Fyers itself reported for this contract (`greeks=1`), as sent and in its units: IV in PERCENT,
   * one value per strike shared by call and put (delta aside: put = call - 1). Observed, never computed
   * here, and not touched by `applyChainTick`, which only re-solves the model values above. Null or
   * absent when none was stored.
   */
  vendorGreeks?: VendorGreeks | null;
}

export interface VendorGreeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  impliedVolatilityPercent: number | null;
}

export interface StrikeRow {
  strikePrice: number;
  isAtm: boolean;
  call: Leg | null;
  put: Leg | null;
}

export interface ChainResponse {
  underlyingSymbol: string;
  available: boolean;
  reason?: string;
  provider?: string;
  observedAt?: string;
  underlyingValue?: number | null;
  /**
   * The spot at the instant of the stored snapshot, kept once the first tick starts moving
   * `underlyingValue`. It is the denominator that carries the snapshot's implied forward to the live
   * spot (see `applyChainTick`). Absent on a response straight from the server, where it equals
   * `underlyingValue`.
   */
  snapshotUnderlyingValue?: number | null;
  atmStrike?: number | null;
  atmImpliedVolatility?: number | null;
  impliedForwardByExpiry?: Record<string, number>;
  expiries?: Array<{ expiryDate: string; expiryKind: string }>;
  putCall?: {
    openInterestRatio: number | null;
    volumeRatio: number | null;
    callOpenInterest: number;
    putOpenInterest: number;
  };
  liquidity?: {
    contracts: number;
    quotedBothSides: number;
    medianSpreadPercent: number | null;
    withinCostBudget: number;
    costBudgetPercent: number;
  };
  largestOpenInterest?: {
    call: { strikePrice: number; openInterest: number } | null;
    put: { strikePrice: number; openInterest: number } | null;
  };
  strikes?: StrikeRow[];
}

/** One message from `/option-chain/stream`: an index tick, or a tick for one option contract. */
export interface ChainTick {
  symbol: string;
  ltp?: number | null;
  bid?: number | null;
  ask?: number | null;
  volume?: number | null;
}

/**
 * Merges one tick into the chain: the leg that ticked takes its new prices, and every leg is re-solved when
 * the index ticked. Returns the same object when nothing in the chain changed. Pure.
 */
export function applyChainTick(prevChain: ChainResponse | null, tick: ChainTick): ChainResponse | null {
  if (!prevChain || !prevChain.strikes) return prevChain;

  const newStrikes = [...prevChain.strikes];
  let changed = false;
  let currentSpot = prevChain.underlyingValue ?? 0;

  // If the tick is for the underlying index or equity
  const isIndex = tick.symbol.endsWith("-INDEX") || tick.symbol.endsWith("-EQ");
  if (isIndex && tick.ltp) {
    currentSpot = tick.ltp;
    changed = true;
  }

  // The forward the option market prices, as the server uses. Re-solving against
  // raw spot is what made a live BANKNIFTY delta read 0.61 where the server said
  // 0.53, and it showed up as the number jumping the instant a tick arrived.
  const forwardByExpiry = prevChain.impliedForwardByExpiry ?? {};

  /**
   * The spot the snapshot's forward belongs to. `underlyingValue` is replaced by every index tick, so
   * the first tick has to remember what it replaced.
   */
  const snapshotSpot = prevChain.snapshotUnderlyingValue ?? prevChain.underlyingValue ?? null;

  const recalculateLeg = (leg: Leg, strikePrice: number, optionType: "CE" | "PE", isLegTick: boolean): Leg => {
    const newLastPrice = isLegTick ? (tick.ltp ?? leg.lastPrice) : leg.lastPrice;
    const newBid = isLegTick ? (tick.bid ?? leg.bid) : leg.bid;
    const newAsk = isLegTick ? (tick.ask ?? leg.ask) : leg.ask;
    const newVolume = isLegTick ? (tick.volume ?? leg.volume) : leg.volume;

    let spreadAbs: number | null = null;
    let midPrice: number | null = null;
    let spreadPct: number | null = null;
    let withinBudget: boolean | null = leg.withinCostBudget;

    if (newBid !== null && newAsk !== null && newBid > 0 && newAsk > 0 && newAsk >= newBid) {
      spreadAbs = newAsk - newBid;
      midPrice = (newAsk + newBid) / 2;
      spreadPct = (spreadAbs / midPrice) * 100;
      withinBudget = spreadPct <= DEFAULT_COST_BUDGET_PERCENT;
    } else {
      midPrice = midPriceForIv(newBid, newAsk);
    }

    const premium = midPrice ?? newLastPrice;
    let iv: number | null = null;
    let ivRefusal: string | null = "NO_PREMIUM";
    let newDelta = leg.delta;
    let newGamma = leg.gamma;
    let newTheta = leg.theta;
    let newVega = leg.vega;

    const timeToExpiryYears = leg.daysToExpiry === null
      ? null
      : Math.max(0, leg.daysToExpiry / 365);
    // Only the expiry's own forward may price it; spot is the fallback, and then
    // the bias is the known one rather than a silent one.
    const snapshotForward = Object.values(forwardByExpiry)[0];
    /*
     * A premium and the forward it is solved against must belong to the same instant.
     *
     * A leg that just ticked carries a premium from now, but the snapshot forward is from the snapshot,
     * up to 18 minutes ago. Solved against it, the implied vol absorbs however far spot has moved since:
     * with spot 30 points up on a 7-day ATM NIFTY option (delta ~0.5, vega ~12.4 a vol point) that is
     * 15 / 12.4, roughly 1.2 vol points of error, and the delta moves with it. So a ticking leg is priced at the snapshot
     * forward carried to the live spot -- F/S is steady over minutes because it is e^((r-q)T) -- while a
     * leg that did not tick keeps its snapshot premium, which stays consistent with the snapshot forward.
     */
    const legForward = snapshotForward !== undefined && isLegTick
      && snapshotSpot !== null && snapshotSpot > 0 && currentSpot > 0
      ? snapshotForward * (currentSpot / snapshotSpot)
      : snapshotForward;
    const pricingSpot = legForward !== undefined && timeToExpiryYears !== null && timeToExpiryYears > 0
      ? effectiveSpotForForward(legForward, RISK_FREE_RATE, timeToExpiryYears)
      : currentSpot;

    if (premium !== null && timeToExpiryYears !== null && pricingSpot > 0) {
      const ivResult = impliedVolatilityFromPremium({
        spot: pricingSpot,
        strike: strikePrice,
        timeToExpiryYears,
        riskFreeRate: RISK_FREE_RATE,
        optionType,
        premium,
      });

      if (ivResult.measurable) {
        iv = ivResult.impliedVolatility;
        ivRefusal = null;
        const greeks = priceEuropeanOption({
          spot: pricingSpot,
          strike: strikePrice,
          timeToExpiryYears,
          riskFreeRate: RISK_FREE_RATE,
          volatility: iv,
          optionType,
        });
        newDelta = greeks.delta;
        newGamma = greeks.gamma;
        newTheta = greeks.theta;
        newVega = greeks.vega;
      } else {
        ivRefusal = ivResult.reason;
        newDelta = null;
        newGamma = null;
        newTheta = null;
        newVega = null;
      }
    }

    return {
      ...leg,
      lastPrice: newLastPrice,
      bid: newBid,
      ask: newAsk,
      volume: newVolume,
      spreadAbsolute: spreadAbs,
      spreadPercentOfMid: spreadPct,
      withinCostBudget: withinBudget,
      impliedVolatility: iv,
      impliedVolatilityRefusal: ivRefusal,
      delta: newDelta,
      gamma: newGamma,
      theta: newTheta,
      vega: newVega,
    };
  };

  for (let i = 0; i < newStrikes.length; i++) {
    const row = newStrikes[i];
    const call = row.call;
    const put = row.put;

    const isCallTick = call?.providerSymbol === tick.symbol;
    const isPutTick = put?.providerSymbol === tick.symbol;

    // Recalculate if this specific leg ticked, OR if the index ticked (affecting all legs)
    if (isCallTick || isIndex) {
      if (call) {
        newStrikes[i] = {
          ...newStrikes[i],
          call: recalculateLeg(call, row.strikePrice, "CE", isCallTick),
        };
        changed = true;
      }
    }

    if (isPutTick || isIndex) {
      if (put) {
        newStrikes[i] = {
          ...newStrikes[i],
          put: recalculateLeg(put, row.strikePrice, "PE", isPutTick),
        };
        changed = true;
      }
    }
  }

  if (changed) {
    return {
      ...prevChain,
      underlyingValue: currentSpot,
      snapshotUnderlyingValue: snapshotSpot,
      strikes: newStrikes,
    };
  }
  return prevChain;
}

/**
 * Opens the live tick stream for an underlying and calls `onTick` for each message. Returns the function that
 * closes it. A stream error closes it for good, as the Option Chain page has always done; a caller that needs
 * to know the feed is still alive should watch for ticks rather than assume the stream is open.
 */
export function subscribeToChainTicks(underlying: string, onTick: (tick: ChainTick) => void): () => void {
  let eventSource: EventSource | null = null;
  try {
    eventSource = new EventSource(`${getApiV1Url()}/option-chain/stream?underlying=${encodeURIComponent(underlying)}`);
    eventSource.onmessage = (event) => {
      try {
        onTick(JSON.parse(event.data) as ChainTick);
      } catch (err) {
        console.error("Failed to parse tick:", err);
      }
    };
    eventSource.onerror = (err) => {
      console.warn("Option chain SSE connection interrupted, auto-reconnecting:", err);
    };
  } catch (err) {
    console.error("Failed to setup SSE:", err);
  }
  return () => {
    eventSource?.close();
  };
}
