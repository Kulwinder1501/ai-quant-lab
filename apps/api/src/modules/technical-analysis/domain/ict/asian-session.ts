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

export class AsianSessionRangeTracker {
  private currentDateKey: string | null = null;
  private high: number = -Infinity;
  private low: number = Infinity;
  private barCount: number = 0;
  private sweepObservedToday: boolean = false;

  constructor(private readonly config: AsianSessionTrackerConfig = defaultAsianSessionConfig) {}

  processCandle(candle: AsianCandleLike): AsianRangeSnapshot {
    const utcDateStr = candle.openTime.toISOString().slice(0, 10);
    const hour = candle.openTime.getUTCHours();
    const minute = candle.openTime.getUTCMinutes();
    const decHour = hour + minute / 60;

    // Reset when moving to a new UTC calendar day
    if (this.currentDateKey !== utcDateStr) {
      this.currentDateKey = utcDateStr;
      this.high = -Infinity;
      this.low = Infinity;
      this.barCount = 0;
      this.sweepObservedToday = false;
    }

    // Asian session accumulation [00:00, 06:00) UTC
    const inAsiaWindow = decHour >= this.config.asiaStartHourUtc && decHour < this.config.asiaEndHourUtc;
    if (inAsiaWindow) {
      this.high = Math.max(this.high, candle.high);
      this.low = Math.min(this.low, candle.low);
      this.barCount++;
    }

    const hasAsiaData = this.barCount > 0 && this.high > -Infinity && this.low < Infinity;
    const asiaHigh = hasAsiaData ? this.high : null;
    const asiaLow = hasAsiaData ? this.low : null;
    const asiaRange = (asiaHigh !== null && asiaLow !== null) ? asiaHigh - asiaLow : null;
    const asiaRangeBps = (asiaRange !== null && asiaLow !== null && asiaLow > 0)
      ? (asiaRange / asiaLow) * 10000
      : null;
    const midpoint = (asiaHigh !== null && asiaLow !== null) ? (asiaHigh + asiaLow) / 2 : null;

    const isValid = asiaRangeBps !== null &&
      asiaRangeBps >= this.config.minRangeBps &&
      asiaRangeBps <= this.config.maxRangeBps;

    const state: AsianRangeSnapshot["state"] = inAsiaWindow
      ? "FORMING"
      : decHour >= this.config.asiaEndHourUtc && decHour < 18
      ? "LOCKED"
      : "COMPLETED";

    // Sweep detection during London execution window [06:30, 11:30] UTC
    let sweepEvent: AsianSessionSweepEvent | null = null;
    const inLondonWindow = decHour >= this.config.londonStartHourUtc && decHour <= this.config.londonEndHourUtc;

    if (inLondonWindow && isValid && asiaHigh !== null && asiaLow !== null && !this.sweepObservedToday) {
      const span = candle.high - candle.low;

      // 1. Bearish Sweep of Asia High: High breaks above AH, but bar closes back below AH
      if (candle.high > asiaHigh && candle.close < asiaHigh && span > 0) {
        const penBps = ((candle.high - asiaHigh) / asiaHigh) * 10000;
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const upperWickPct = upperWick / span;
        const reclaimBps = ((asiaHigh - candle.close) / asiaHigh) * 10000;

        if (
          penBps >= this.config.minPenetrationBps &&
          penBps <= this.config.maxPenetrationBps &&
          upperWickPct >= this.config.minRejectionWickPct
        ) {
          sweepEvent = {
            type: "BEARISH_SWEEP",
            level: asiaHigh,
            sweepExtreme: candle.high,
            penetrationBps: Number(penBps.toFixed(2)),
            reclaimBps: Number(reclaimBps.toFixed(2)),
            rejectionWickPct: Number(upperWickPct.toFixed(2)),
            time: candle.openTime,
          };
          this.sweepObservedToday = true;
        }
      }

      // 2. Bullish Sweep of Asia Low: Low breaks below AL, but bar closes back above AL
      if (!sweepEvent && candle.low < asiaLow && candle.close > asiaLow && span > 0) {
        const penBps = ((asiaLow - candle.low) / asiaLow) * 10000;
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const lowerWickPct = lowerWick / span;
        const reclaimBps = ((candle.close - asiaLow) / asiaLow) * 10000;

        if (
          penBps >= this.config.minPenetrationBps &&
          penBps <= this.config.maxPenetrationBps &&
          lowerWickPct >= this.config.minRejectionWickPct
        ) {
          sweepEvent = {
            type: "BULLISH_SWEEP",
            level: asiaLow,
            sweepExtreme: candle.low,
            penetrationBps: Number(penBps.toFixed(2)),
            reclaimBps: Number(reclaimBps.toFixed(2)),
            rejectionWickPct: Number(lowerWickPct.toFixed(2)),
            time: candle.openTime,
          };
          this.sweepObservedToday = true;
        }
      }
    }

    return {
      dateKey: this.currentDateKey ?? utcDateStr,
      state,
      asiaHigh,
      asiaLow,
      asiaRange,
      asiaRangeBps: asiaRangeBps !== null ? Number(asiaRangeBps.toFixed(2)) : null,
      midpoint,
      isValid,
      sweepEvent,
    };
  }
}
