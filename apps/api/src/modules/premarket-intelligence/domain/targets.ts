/**
 * The research contract for the Asia-to-India pre-market engine: what is predicted, and how the
 * outcome is measured. Fixed BEFORE the first LLM run, so nothing here may be tuned after seeing
 * results -- change a number and every earlier score stops being comparable. Bump
 * `PREMARKET_CONFIG_VERSION` if one ever has to change, which starts a fresh scored population.
 *
 * `UNCERTAIN` is the model's explicit abstention. `FLAT` is a measured physical outcome. They are
 * never interchangeable: an abstention is excluded from accuracy and reported as coverage instead.
 */

export const PREMARKET_CONFIG_VERSION = "V1";
export const PREMARKET_PIPELINE_NAME = "ASIA_INDIA_PREMARKET";

export const PREMARKET_INSTRUMENTS = ["NIFTY50", "BANKNIFTY"] as const;
export type PremarketInstrument = (typeof PREMARKET_INSTRUMENTS)[number];

export const PREMARKET_TARGETS = ["OPENING_GAP", "FIRST_60_MINUTES", "FULL_SESSION"] as const;
export type PremarketTarget = (typeof PREMARKET_TARGETS)[number];

/** Measured outcome of a target: price went up past the band, down past it, or stayed inside. */
export type MeasuredOutcome = "UP" | "DOWN" | "FLAT";

/** Symmetric thresholds in percent. Inclusive at the boundary, as in the opening-gap classifier. */
export const TARGET_THRESHOLD_PCT: Record<PremarketTarget, Record<PremarketInstrument, number>> = {
  OPENING_GAP: { NIFTY50: 0.25, BANKNIFTY: 0.35 },
  FIRST_60_MINUTES: { NIFTY50: 0.2, BANKNIFTY: 0.2 },
  FULL_SESSION: { NIFTY50: 0.3, BANKNIFTY: 0.3 },
};

/** 09:15 IST open, 10:15 IST first-hour mark, and the closing VWAP window 15:00-15:30 IST. */
export const SESSION_OPEN_MINUTE = 9 * 60 + 15;
export const FIRST_HOUR_MARK_MINUTE = 10 * 60 + 15;
export const CLOSE_VWAP_START_MINUTE = 15 * 60;
export const SESSION_CLOSE_MINUTE = 15 * 60 + 30;

export function returnPercent(from: number, to: number): number {
  if (!(from > 0) || !Number.isFinite(to)) throw new Error("returnPercent needs a positive base and a finite end value.");
  return ((to - from) / from) * 100;
}

export function classifyReturn(changePct: number, thresholdPct: number): MeasuredOutcome {
  if (!Number.isFinite(changePct)) throw new Error(`changePct must be finite; got ${changePct}.`);
  if (!(thresholdPct > 0)) throw new Error(`thresholdPct must be positive; got ${thresholdPct}.`);
  if (changePct >= thresholdPct) return "UP";
  if (changePct <= -thresholdPct) return "DOWN";
  return "FLAT";
}

export interface MinuteBar {
  /** Bar open instant. */
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

/**
 * Volume-weighted average price over the supplied bars, using typical price (H+L+C)/3.
 *
 * Null when no bar carries positive volume. There is deliberately no unweighted-mean fallback:
 * an index VWAP with no volume is not a VWAP, and silently substituting a different statistic would
 * grade the full-session target against a number the contract never defined. The caller records
 * the session as unsettleable for that target instead.
 *
 * Index volume here is a constituent aggregate (see index-volume-is-constituent-aggregate), which
 * is adequate as a weight but not a tradable volume.
 */
export function volumeWeightedAveragePrice(bars: readonly MinuteBar[]): number | null {
  let weighted = 0;
  let volume = 0;
  for (const bar of bars) {
    if (bar.volume === null || !(bar.volume > 0)) continue;
    weighted += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
    volume += bar.volume;
  }
  return volume > 0 ? weighted / volume : null;
}

/** Maps any model/baseline directional word onto the measured alphabet; null for an abstention. */
export function toMeasuredOutcome(word: string): MeasuredOutcome | null {
  switch (word) {
    case "GAP_UP":
    case "BULLISH":
    case "UP":
      return "UP";
    case "GAP_DOWN":
    case "BEARISH":
    case "DOWN":
      return "DOWN";
    case "FLAT":
    case "NEUTRAL":
      return "FLAT";
    default:
      return null;
  }
}
