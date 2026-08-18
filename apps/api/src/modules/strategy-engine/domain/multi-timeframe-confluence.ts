import type {
  PatternDirection,
  PriceActionEventCode,
} from "../../pattern-recognition/domain/market-pattern.js";

export interface HigherTimeframeContext {
  htfTimeframe: string; // e.g. "15m" or "60m"
  trendBias: "BULLISH" | "BEARISH" | "NEUTRAL";
  trendConfidence: number;
  nearestSupportLevel: number | null;
  nearestResistanceLevel: number | null;
  chartPatterns: Array<{
    code: PriceActionEventCode;
    direction: PatternDirection;
    level: number | null;
    confidence: number;
  }>;
}

export interface ResolveHtfInput {
  instrumentId: string;
  htfTimeframe: string;
  asOf: Date; // HTF candle must have closeTime <= asOf (anti-lookahead)
}

/**
 * Calculates trend alignment score across multiple higher timeframes.
 * Returns:
 *  +1 : all directional HTFs agree with signalDirection
 *  -1 : all directional HTFs disagree with signalDirection
 *   0 : mixed bullish/bearish, or all NEUTRAL, or no HTF data
 */
export function calculateHtfTrendAlignment(
  signalDirection: "BULLISH" | "BEARISH",
  htfs?: readonly HigherTimeframeContext[],
): number {
  if (!htfs || htfs.length === 0) return 0;
  const directional = htfs.filter((h) => h.trendBias !== "NEUTRAL");
  if (directional.length === 0) return 0;

  const allAgree = directional.every((h) => h.trendBias === signalDirection);
  const allDisagree = directional.every((h) => h.trendBias !== signalDirection);

  if (allAgree) return 1;
  if (allDisagree) return -1;
  return 0; // Mixed
}

/**
 * Calculates whether price is close to a higher-timeframe S/R level.
 * Returns:
 *  +1 : near HTF support (for LONG) or near HTF resistance (for SHORT) within maxDistanceAtr
 *   0 : no HTF S/R within tolerance or no HTF data
 */
export function calculateHtfSrConfluence(
  entryPrice: number,
  signalDirection: "BULLISH" | "BEARISH",
  atr: number,
  htfs?: readonly HigherTimeframeContext[],
  maxDistanceAtr = 1.5,
): number {
  if (!htfs || htfs.length === 0 || atr <= 0) return 0;
  const tolerance = maxDistanceAtr * atr;

  if (signalDirection === "BULLISH") {
    const nearSupport = htfs.some(
      (h) => h.nearestSupportLevel !== null && Math.abs(entryPrice - h.nearestSupportLevel) <= tolerance,
    );
    return nearSupport ? 1 : 0;
  } else {
    const nearResistance = htfs.some(
      (h) => h.nearestResistanceLevel !== null && Math.abs(h.nearestResistanceLevel - entryPrice) <= tolerance,
    );
    return nearResistance ? 1 : 0;
  }
}
