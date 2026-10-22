export interface AsianCandleLike {
  openTime: Date;
  closeTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface AsianSessionSweepEvent {
  type: "BULLISH_SWEEP" | "BEARISH_SWEEP";
  level: number;
  sweepExtreme: number;
  penetrationBps: number;
  reclaimBps: number;
  rejectionWickPct: number;
  time: Date;
}

export interface AsianRangeSnapshot {
  dateKey: string;
  state: "FORMING" | "LOCKED" | "COMPLETED";
  asiaHigh: number | null;
  asiaLow: number | null;
  asiaRange: number | null;
  asiaRangeBps: number | null;
  midpoint: number | null;
  isValid: boolean;
  sweepEvent: AsianSessionSweepEvent | null;
}

export interface AsianSessionTrackerConfig {
  asiaStartHourUtc: number; // 0
  asiaEndHourUtc: number; // 6
  londonStartHourUtc: number; // 6.5 (06:30 UTC)
  londonEndHourUtc: number; // 11.5 (11:30 UTC)
  minPenetrationBps: number; // 3.0
  maxPenetrationBps: number; // 50.0
  minRejectionWickPct: number; // 0.30 (30%)
  minRangeBps: number; // 15.0
  maxRangeBps: number; // 180.0
}

export const defaultAsianSessionConfig: AsianSessionTrackerConfig = {
  asiaStartHourUtc: 0,
  asiaEndHourUtc: 6,
  londonStartHourUtc: 6.5,
  londonEndHourUtc: 11.5,
  minPenetrationBps: 3.0,
  maxPenetrationBps: 50.0,
  minRejectionWickPct: 0.30,
  minRangeBps: 15.0,
  maxRangeBps: 180.0,
};

/**
 * Pure, stateless function that computes the Asian session range and evaluates
 * whether the current candle forms a valid London liquidity sweep & reclaim.
 *
 * @param dayCandles Historical candles of the SAME UTC calendar day up to (and including) currentCandle.
 * @param currentCandle The target candle being evaluated.
 * @param config Configuration parameters.
 */
export function evaluateAsianSession(
  dayCandles: readonly AsianCandleLike[],
  currentCandle: AsianCandleLike,
  config: AsianSessionTrackerConfig = defaultAsianSessionConfig
): AsianRangeSnapshot {
  const utcDateStr = currentCandle.openTime.toISOString().slice(0, 10);
  const hour = currentCandle.openTime.getUTCHours();
  const minute = currentCandle.openTime.getUTCMinutes();
  const decHour = hour + minute / 60;

  // Filter candles belonging to the Asian session [00:00, 06:00) UTC
  const asiaCandles = dayCandles.filter((c) => {
    const cHour = c.openTime.getUTCHours();
    const cMinute = c.openTime.getUTCMinutes();
    const cDec = cHour + cMinute / 60;
    return cDec >= config.asiaStartHourUtc && cDec < config.asiaEndHourUtc;
  });

  const hasAsiaData = asiaCandles.length > 0;
  let asiaHigh: number | null = null;
  let asiaLow: number | null = null;

  if (hasAsiaData) {
    let maxH = -Infinity;
    let minL = Infinity;
    for (const c of asiaCandles) {
      if (c.high > maxH) maxH = c.high;
      if (c.low < minL) minL = c.low;
    }
    if (maxH > -Infinity && minL < Infinity) {
      asiaHigh = maxH;
      asiaLow = minL;
    }
  }

  const asiaRange = (asiaHigh !== null && asiaLow !== null) ? Number((asiaHigh - asiaLow).toFixed(4)) : null;
  const asiaRangeBps = (asiaRange !== null && asiaLow !== null && asiaLow > 0)
    ? Number(((asiaRange / asiaLow) * 10000).toFixed(2))
    : null;
  const midpoint = (asiaHigh !== null && asiaLow !== null) ? Number(((asiaHigh + asiaLow) / 2).toFixed(4)) : null;

  const inAsiaWindow = decHour >= config.asiaStartHourUtc && decHour < config.asiaEndHourUtc;
  const isValid = asiaRangeBps !== null &&
    asiaRangeBps >= config.minRangeBps &&
    asiaRangeBps <= config.maxRangeBps;

  const state: AsianRangeSnapshot["state"] = inAsiaWindow
    ? "FORMING"
    : decHour >= config.asiaEndHourUtc && decHour < 18
    ? "LOCKED"
    : "COMPLETED";

  // Check if any prior London bar earlier today ALREADY fired a sweep
  // This satisfies the "only first sweep of the day" requirement causally from history
  let priorSweepObserved = false;
  if (hasAsiaData && asiaHigh !== null && asiaLow !== null) {
    for (const prior of dayCandles) {
      if (prior.openTime.getTime() >= currentCandle.openTime.getTime()) continue;
      const pHour = prior.openTime.getUTCHours() + prior.openTime.getUTCMinutes() / 60;
      if (pHour < config.londonStartHourUtc || pHour > config.londonEndHourUtc) continue;

      const pSpan = prior.high - prior.low;
      if (pSpan <= 0) continue;

      // Prior bearish sweep check
      if (prior.high > asiaHigh && prior.close < asiaHigh) {
        const penBps = ((prior.high - asiaHigh) / asiaHigh) * 10000;
        const upperWick = prior.high - Math.max(prior.open, prior.close);
        const upperWickPct = upperWick / pSpan;
        if (penBps >= config.minPenetrationBps && penBps <= config.maxPenetrationBps && upperWickPct >= config.minRejectionWickPct) {
          priorSweepObserved = true;
          break;
        }
      }

      // Prior bullish sweep check
      if (prior.low < asiaLow && prior.close > asiaLow) {
        const penBps = ((asiaLow - prior.low) / asiaLow) * 10000;
        const lowerWick = Math.min(prior.open, prior.close) - prior.low;
        const lowerWickPct = lowerWick / pSpan;
        if (penBps >= config.minPenetrationBps && penBps <= config.maxPenetrationBps && lowerWickPct >= config.minRejectionWickPct) {
          priorSweepObserved = true;
          break;
        }
      }
    }
  }

  let sweepEvent: AsianSessionSweepEvent | null = null;
  const inLondonWindow = decHour >= config.londonStartHourUtc && decHour <= config.londonEndHourUtc;

  if (inLondonWindow && isValid && asiaHigh !== null && asiaLow !== null && !priorSweepObserved) {
    const span = currentCandle.high - currentCandle.low;

    // 1. Bearish Sweep of Asia High: High breaks above AH, but bar closes back below AH
    if (currentCandle.high > asiaHigh && currentCandle.close < asiaHigh && span > 0) {
      const penBps = ((currentCandle.high - asiaHigh) / asiaHigh) * 10000;
      const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
      const upperWickPct = upperWick / span;
      const reclaimBps = ((asiaHigh - currentCandle.close) / asiaHigh) * 10000;

      if (
        penBps >= config.minPenetrationBps &&
        penBps <= config.maxPenetrationBps &&
        upperWickPct >= config.minRejectionWickPct
      ) {
        sweepEvent = {
          type: "BEARISH_SWEEP",
          level: asiaHigh,
          sweepExtreme: currentCandle.high,
          penetrationBps: Number(penBps.toFixed(2)),
          reclaimBps: Number(reclaimBps.toFixed(2)),
          rejectionWickPct: Number(upperWickPct.toFixed(2)),
          time: currentCandle.openTime,
        };
      }
    }

    // 2. Bullish Sweep of Asia Low: Low breaks below AL, but bar closes back above AL
    if (!sweepEvent && currentCandle.low < asiaLow && currentCandle.close > asiaLow && span > 0) {
      const penBps = ((asiaLow - currentCandle.low) / asiaLow) * 10000;
      const lowerWick = Math.min(currentCandle.open, currentCandle.close) - currentCandle.low;
      const lowerWickPct = lowerWick / span;
      const reclaimBps = ((currentCandle.close - asiaLow) / asiaLow) * 10000;

      if (
        penBps >= config.minPenetrationBps &&
        penBps <= config.maxPenetrationBps &&
        lowerWickPct >= config.minRejectionWickPct
      ) {
        sweepEvent = {
          type: "BULLISH_SWEEP",
          level: asiaLow,
          sweepExtreme: currentCandle.low,
          penetrationBps: Number(penBps.toFixed(2)),
          reclaimBps: Number(reclaimBps.toFixed(2)),
          rejectionWickPct: Number(lowerWickPct.toFixed(2)),
          time: currentCandle.openTime,
        };
      }
    }
  }

  return {
    dateKey: utcDateStr,
    state,
    asiaHigh,
    asiaLow,
    asiaRange,
    asiaRangeBps,
    midpoint,
    isValid,
    sweepEvent,
  };
}
