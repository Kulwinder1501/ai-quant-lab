import type { DirectionalSample } from "./generate-directional-dataset.js";
import type { SessionCandle } from "../domain/session-calendar.js";

/**
 * Minimal Feature Engine for Directional Intelligence V2 (Phase 29 §4).
 *
 * Implements the verified minimal feature intersection:
 * - return_5m (5m close-to-close log return in bps)
 * - return_15m (15m close-to-close log return in bps)
 * - atr_ratio (14-period intraday ATR / trailing price in bps)
 * - rvol (20-period volume / trailing median volume)
 * - vwap_distance_bps (10_000 * log(close / sessionVWAP))
 * - minute_of_day (0 to 375)
 * - time_to_session_close_minutes (375 to 0)
 *
 * Warm-up invariant: `sampleEligible = allRequiredFeaturesAvailable`.
 * No intraday rolling window crosses an overnight boundary.
 */

export const MINIMAL_FEATURE_NAMES = [
  "return_5m",
  "return_15m",
  "atr_ratio",
  "rvol",
  "vwap_distance_bps",
  "minute_of_day",
  "time_to_session_close_minutes",
] as const;

export type MinimalFeatureName = typeof MINIMAL_FEATURE_NAMES[number];

export interface FeatureVector {
  readonly sampleId: string;
  readonly isEligible: boolean;
  readonly features: readonly number[]; // aligned with MINIMAL_FEATURE_NAMES
  readonly featureMap: ReadonlyMap<MinimalFeatureName, number>;
}

export function extractMinimalFeaturesForSample(
  sample: DirectionalSample,
  sessionCandles: readonly SessionCandle[],
): FeatureVector {
  const currentDecisionMs = sample.decisionAt.getTime();

  // Find all candles completed on or before currentDecisionMs in this session
  const completedCandles = sessionCandles.filter((c) => c.closeTime.getTime() <= currentDecisionMs);
  const n = completedCandles.length;

  // Twenty bars are required by RVOL; a 15m close-to-close return also needs
  // sixteen close observations. Partial windows are not silently substituted.
  const expectedFirstOpenMs = currentDecisionMs - sample.minuteOfDay * 60_000;
  const isContiguous = completedCandles.every((candle, index) => (
    candle.openTime.getTime() === expectedFirstOpenMs + index * 60_000
    && candle.closeTime.getTime() === candle.openTime.getTime() + 60_000
  ));
  if (n < 20 || !isContiguous) {
    const emptyMap = new Map<MinimalFeatureName, number>();
    return {
      sampleId: sample.sampleId,
      isEligible: false,
      features: new Array(MINIMAL_FEATURE_NAMES.length).fill(Number.NaN),
      featureMap: emptyMap,
    };
  }

  const curCandle = completedCandles[n - 1]!;
  const curClose = curCandle.close;

  // 1. return_5m (5 bars ago)
  const candle5m = completedCandles[n - 6]!;
  const return5m = candle5m.close > 0 ? 10_000 * Math.log(curClose / candle5m.close) : 0;

  // 2. return_15m (15 bars ago)
  const candle15m = completedCandles[n - 16]!;
  const return15m = candle15m.close > 0 ? 10_000 * Math.log(curClose / candle15m.close) : 0;

  // 3. atr_ratio (14-period true range mean / close * 10_000)
  const atrPeriod = 14;
  let trSum = 0;
  for (let i = n - atrPeriod; i < n; i += 1) {
    const cur = completedCandles[i]!;
    const prev = completedCandles[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trSum += tr;
  }
  const atr = trSum / atrPeriod;
  const atrRatio = curClose > 0 ? (atr / curClose) * 10_000 : 0;

  // 4. rvol (current 20-bar volume / median of volume)
  const volWindow = 20;
  const volumes: number[] = [];
  for (let i = n - volWindow; i < n; i += 1) {
    volumes.push(completedCandles[i]!.volume);
  }
  volumes.sort((a, b) => a - b);
  const medianVol = volumes[Math.floor(volumes.length / 2)] ?? 1;
  const recentVol = completedCandles[n - 1]!.volume;
  const rvol = medianVol > 0 ? recentVol / medianVol : 1.0;

  // 5. vwap_distance_bps
  let cumulativePv = 0;
  let cumulativeV = 0;
  for (const c of completedCandles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativePv += typicalPrice * c.volume;
    cumulativeV += c.volume;
  }
  const sessionVwap = cumulativeV > 0 ? cumulativePv / cumulativeV : curClose;
  const vwapDistanceBps = sessionVwap > 0 ? 10_000 * Math.log(curClose / sessionVwap) : 0;

  // 6. minute_of_day & 7. time_to_session_close_minutes
  const minuteOfDay = sample.minuteOfDay;
  const timeToSessionCloseMinutes = sample.timeToSessionCloseMinutes;

  const featureMap = new Map<MinimalFeatureName, number>([
    ["return_5m", return5m],
    ["return_15m", return15m],
    ["atr_ratio", atrRatio],
    ["rvol", rvol],
    ["vwap_distance_bps", vwapDistanceBps],
    ["minute_of_day", minuteOfDay],
    ["time_to_session_close_minutes", timeToSessionCloseMinutes],
  ]);

  const features = MINIMAL_FEATURE_NAMES.map((name) => featureMap.get(name)!);

  return {
    sampleId: sample.sampleId,
    isEligible: true,
    features,
    featureMap,
  };
}
