/**
 * Digests attached `higherTimeframeContexts` into the pre-scored `higherTimeframes` array that
 * `calculateHtfTrendAlignment` / `calculateHtfSrConfluence` (and Sniper) actually read.
 *
 * Live `GenerateTradeIdeas.withHigherTimeframes` already attaches full slower bars, but until this
 * digest ran, `higherTimeframes` stayed undefined and every HTF confluence score was 0.
 *
 * Anti-lookahead is the caller's job (attach only bars with closeTime <= decision). This function
 * only summarises what it is given.
 */

import type { HistoricalTimeframe } from "../../market-data/domain/historical-data-provider.js";
import type { StrategyMarketContext } from "./strategy.js";
import type { HigherTimeframeContext } from "./multi-timeframe-confluence.js";
import { htfBiasFrom } from "./htf-bias.js";
import { trendSliceFromIndicators } from "../../market-context/domain/market-context-map.js";
import type { TrendSlice } from "../../market-context/domain/market-context-map.js";

const DEFAULT_EMA_PERIOD = 20;
const FALLBACK_EMA_PERIODS = [20, 9, 8, 21] as const;

export interface DigestHigherTimeframesOptions {
  indicatorAlgorithmVersion?: string;
  emaPeriod?: number;
}

function readEma(
  context: StrategyMarketContext,
  algorithmVersion: string,
  preferredPeriod: number,
): number | null {
  const periods = [preferredPeriod, ...FALLBACK_EMA_PERIODS.filter((p) => p !== preferredPeriod)];
  for (const period of periods) {
    const ema = context.indicators.find(
      (indicator) => indicator.code === "EMA"
        && indicator.algorithmVersion === algorithmVersion
        && indicator.parameters.period === period,
    );
    const value = ema?.values?.value;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  // Any EMA of this algorithm version if periods do not match.
  const any = context.indicators.find(
    (indicator) => indicator.code === "EMA" && indicator.algorithmVersion === algorithmVersion,
  );
  const value = any?.values?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function readSupertrendUp(
  context: StrategyMarketContext,
  algorithmVersion: string,
): boolean | null {
  const st = context.indicators.find(
    (indicator) => indicator.code === "SUPERTREND" && indicator.algorithmVersion === algorithmVersion,
  );
  if (!st) return null;
  const trend = st.values?.trend;
  if (trend === "UP" || trend === "BULLISH") return true;
  if (trend === "DOWN" || trend === "BEARISH") return false;
  const value = st.values?.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return context.candle.close > value;
  }
  return null;
}

function nearestSwingLevels(context: StrategyMarketContext): {
  support: number | null;
  resistance: number | null;
} {
  const price = context.candle.close;
  const supports = context.priceActionEvents
    .filter((e) => e.eventCode === "SUPPORT" && e.level !== null && e.level <= price)
    .map((e) => e.level as number);
  const resistances = context.priceActionEvents
    .filter((e) => e.eventCode === "RESISTANCE" && e.level !== null && e.level >= price)
    .map((e) => e.level as number);
  return {
    support: supports.length === 0 ? null : Math.max(...supports),
    resistance: resistances.length === 0 ? null : Math.min(...resistances),
  };
}

function digestOne(
  timeframe: string,
  context: StrategyMarketContext,
  options: Required<DigestHigherTimeframesOptions>,
): HigherTimeframeContext {
  const ema = readEma(context, options.indicatorAlgorithmVersion, options.emaPeriod);
  const supertrendUp = readSupertrendUp(context, options.indicatorAlgorithmVersion);
  const slice = trendSliceFromIndicators({
    price: context.candle.close,
    ema,
    supertrendUp,
  });

  // Prefer close-vs-EMA bias when available (same as htfBiasFrom); fall back to soft slice.
  const biasFromEma = htfBiasFrom(context, options.indicatorAlgorithmVersion, options.emaPeriod)
    ?? (ema !== null
      ? (context.candle.close > ema ? "BULLISH" : context.candle.close < ema ? "BEARISH" : "NEUTRAL")
      : null);

  let trendBias: HigherTimeframeContext["trendBias"] = "NEUTRAL";
  if (biasFromEma) {
    trendBias = biasFromEma;
  } else if (slice.soft === "UP") {
    trendBias = "BULLISH";
  } else if (slice.soft === "DOWN") {
    trendBias = "BEARISH";
  }

  const swings = nearestSwingLevels(context);
  const chartPatterns = context.priceActionEvents
    .filter((e) => e.eventCode === "SUPPORT" || e.eventCode === "RESISTANCE")
    .slice(0, 8)
    .map((e) => ({
      code: e.eventCode,
      direction: e.direction,
      level: e.level,
      confidence: e.confidence,
    }));

  return {
    htfTimeframe: timeframe,
    trendBias,
    trendConfidence: trendBias === "NEUTRAL" ? 0 : 0.5,
    nearestSupportLevel: swings.support,
    nearestResistanceLevel: swings.resistance,
    chartPatterns,
  };
}

/**
 * Converts attached full HTF contexts into the digest array Sniper / confluence scorers read.
 * Order follows the keys' natural timeframe order when possible (5m before 15m).
 */
export function digestHigherTimeframeContexts(
  attached: Partial<Record<HistoricalTimeframe, StrategyMarketContext>> | undefined,
  options: DigestHigherTimeframesOptions = {},
): HigherTimeframeContext[] {
  if (!attached) return [];
  const resolved: Required<DigestHigherTimeframesOptions> = {
    indicatorAlgorithmVersion: options.indicatorAlgorithmVersion ?? "ta-v1",
    emaPeriod: options.emaPeriod ?? DEFAULT_EMA_PERIOD,
  };

  const preferredOrder = ["5m", "15m", "30m", "60m"] as const;
  const keys = Object.keys(attached) as HistoricalTimeframe[];
  keys.sort((a, b) => {
    const ia = preferredOrder.indexOf(a as typeof preferredOrder[number]);
    const ib = preferredOrder.indexOf(b as typeof preferredOrder[number]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const out: HigherTimeframeContext[] = [];
  for (const key of keys) {
    const ctx = attached[key];
    if (!ctx) continue;
    out.push(digestOne(key, ctx, resolved));
  }
  return out;
}

/** Trend slices for the Market Context Map from the same digest inputs. */
export function trendSlicesFromHigherTimeframeContexts(
  attached: Partial<Record<HistoricalTimeframe, StrategyMarketContext>> | undefined,
  options: DigestHigherTimeframesOptions = {},
): { tf5: TrendSlice | null; tf15: TrendSlice | null; tf60: TrendSlice | null } {
  if (!attached) return { tf5: null, tf15: null, tf60: null };
  const resolved: Required<DigestHigherTimeframesOptions> = {
    indicatorAlgorithmVersion: options.indicatorAlgorithmVersion ?? "ta-v1",
    emaPeriod: options.emaPeriod ?? DEFAULT_EMA_PERIOD,
  };

  const sliceFor = (key: HistoricalTimeframe): TrendSlice | null => {
    const ctx = attached[key];
    if (!ctx) return null;
    return trendSliceFromIndicators({
      price: ctx.candle.close,
      ema: readEma(ctx, resolved.indicatorAlgorithmVersion, resolved.emaPeriod),
      supertrendUp: readSupertrendUp(ctx, resolved.indicatorAlgorithmVersion),
    });
  };

  return { tf5: sliceFor("5m"), tf15: sliceFor("15m"), tf60: sliceFor("60m") };
}
