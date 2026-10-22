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
  barCount: number;
  expectedBars: number;
  coveragePct: number;
  isValid: boolean;
  sweepEvent: AsianSessionSweepEvent | null;
}

export interface AsianSessionSweepConfig {
  minPenetrationBps: number;
  maxPenetrationBps: number;
  minRejectionWickPct: number;
}

export interface AsianSessionTrackerConfig extends AsianSessionSweepConfig {
  asiaStartHourUtc: number; // 0
  asiaEndHourUtc: number; // 6
  londonStartHourUtc: number; // 6.5 (06:30 UTC)
  londonEndHourUtc: number; // 11.5 (11:30 UTC)
  minRangeBps: number; // 15.0
  maxRangeBps: number; // 180.0
  minAsiaCoveragePct?: number; // 0.90 (90% minimum fraction of Asian session bars required)
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
  minAsiaCoveragePct: 0.90,
};

/**
 * Pure helper that evaluates whether a single candle constitutes a valid liquidity sweep
 * and reclaim of either the Asian session high or low.
 */
export function detectBarSweep(
  bar: AsianCandleLike,
  asiaHigh: number,
  asiaLow: number,
  config: AsianSessionSweepConfig
): AsianSessionSweepEvent | null {
  const span = bar.high - bar.low;
  if (span <= 0) return null;

  // 1. Bearish Sweep of Asia High: High breaks above AH, but bar closes back below AH
  if (bar.high > asiaHigh && bar.close < asiaHigh) {
    const penBps = ((bar.high - asiaHigh) / asiaHigh) * 10000;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const upperWickPct = upperWick / span;
    const reclaimBps = ((asiaHigh - bar.close) / asiaHigh) * 10000;

    if (
      penBps >= config.minPenetrationBps &&
      penBps <= config.maxPenetrationBps &&
      upperWickPct >= config.minRejectionWickPct
    ) {
      return {
        type: "BEARISH_SWEEP",
        level: asiaHigh,
        sweepExtreme: bar.high,
        penetrationBps: Number(penBps.toFixed(2)),
        reclaimBps: Number(reclaimBps.toFixed(2)),
        rejectionWickPct: Number(upperWickPct.toFixed(2)),
        time: bar.openTime,
      };
    }
  }

  // 2. Bullish Sweep of Asia Low: Low breaks below AL, but bar closes back above AL
  if (bar.low < asiaLow && bar.close > asiaLow) {
    const penBps = ((asiaLow - bar.low) / asiaLow) * 10000;
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const lowerWickPct = lowerWick / span;
    const reclaimBps = ((bar.close - asiaLow) / asiaLow) * 10000;

    if (
      penBps >= config.minPenetrationBps &&
      penBps <= config.maxPenetrationBps &&
      lowerWickPct >= config.minRejectionWickPct
    ) {
      return {
        type: "BULLISH_SWEEP",
        level: asiaLow,
        sweepExtreme: bar.low,
        penetrationBps: Number(penBps.toFixed(2)),
        reclaimBps: Number(reclaimBps.toFixed(2)),
        rejectionWickPct: Number(lowerWickPct.toFixed(2)),
        time: bar.openTime,
      };
    }
  }

  return null;
}

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

  // Measure data coverage: verify the collector didn't drop bars during the Asian window [00:00, 06:00)
  const barDurationMs = currentCandle.closeTime.getTime() - currentCandle.openTime.getTime();
  const windowDurationMs = (config.asiaEndHourUtc - config.asiaStartHourUtc) * 3600 * 1000;
  const expectedBars = barDurationMs > 0 ? Math.floor(windowDurationMs / barDurationMs) : 1;
  const barCount = asiaCandles.length;
  const coveragePct = expectedBars > 0 ? Number((barCount / expectedBars).toFixed(4)) : 1.0;
  const minCoveragePct = config.minAsiaCoveragePct ?? 0.90;

  const inAsiaWindow = decHour >= config.asiaStartHourUtc && decHour < config.asiaEndHourUtc;
  const hasCoverage = inAsiaWindow || coveragePct >= minCoveragePct;

  const isValid = hasCoverage &&
    asiaRangeBps !== null &&
    asiaRangeBps >= config.minRangeBps &&
    asiaRangeBps <= config.maxRangeBps;

  // Before 06:00: FORMING; 06:00 - 11:30: LOCKED; 11:30+: COMPLETED
  const state: AsianRangeSnapshot["state"] = inAsiaWindow
    ? "FORMING"
    : decHour < config.londonEndHourUtc
    ? "LOCKED"
    : "COMPLETED";

  // Check if any prior London bar earlier today ALREADY fired a sweep
  // This satisfies the "only first sweep of the day" requirement causally from history
  let priorSweepObserved = false;
  if (hasAsiaData && asiaHigh !== null && asiaLow !== null) {
    for (const prior of dayCandles) {
      if (prior.openTime.getTime() >= currentCandle.openTime.getTime()) continue;
      const pHour = prior.openTime.getUTCHours() + prior.openTime.getUTCMinutes() / 60;
      if (pHour < config.londonStartHourUtc || pHour >= config.londonEndHourUtc) continue;

      if (detectBarSweep(prior, asiaHigh, asiaLow, config) !== null) {
        priorSweepObserved = true;
        break;
      }
    }
  }

  let sweepEvent: AsianSessionSweepEvent | null = null;
  const inLondonWindow = decHour >= config.londonStartHourUtc && decHour < config.londonEndHourUtc;

  if (inLondonWindow && isValid && asiaHigh !== null && asiaLow !== null && !priorSweepObserved) {
    sweepEvent = detectBarSweep(currentCandle, asiaHigh, asiaLow, config);
  }

  return {
    dateKey: utcDateStr,
    state,
    asiaHigh,
    asiaLow,
    asiaRange,
    asiaRangeBps,
    midpoint,
    barCount,
    expectedBars,
    coveragePct,
    isValid,
    sweepEvent,
  };
}
