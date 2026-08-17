import type { StrategyMarketContext } from "./strategy.js";
import type { HigherTimeframeContext } from "./multi-timeframe-confluence.js";

/**
 * Builds higher-timeframe context for a replayed series, so the confluence terms in
 * `multi-timeframe-confluence.ts` have something to read.
 *
 * ## Why this aggregates instead of reading stored higher-timeframe candles
 *
 * A production resolver should query the stored series. This one cannot, because the series does
 * not exist over the window the question needs: measured 2026-08-17, NIFTYBEES holds 9,830 `15m`
 * bars from 2025-01-01 and BANKBEES 1,200 from 2026-06-08, against 140,700 `5m` bars from 2019 in
 * both — and there is no `60m` series for either at all. Resolving from storage would quietly
 * shrink a seven-year test to a few weeks and report the result as though it covered the window,
 * which is the failure mode `eod-pipeline-silent-window-truncation` records.
 *
 * Aggregating from completed base bars is not an approximation. A 60-minute bar built from twelve
 * completed 5-minute bars has the same open, high, low, and close as the stored one, provided the
 * buckets do not straddle a session. So this measures the confluence thesis on the full window,
 * and any later disagreement with a storage-backed resolver is a data-coverage question rather
 * than a different answer.
 *
 * ## Anti-lookahead
 *
 * `ResolveHtfInput` states the rule: the higher-timeframe bar must satisfy `closeTime <= asOf`. A
 * bucket is therefore published only once a *later* base bar proves it closed, and the bar being
 * evaluated never sees the bucket it belongs to. That costs one bucket of latency, which is the
 * real cost of the information and not an artifact to tune away: a 60m bias that includes the
 * still-forming hour is a look at the future, and it flatters a backtest without failing any test.
 */

export interface HigherTimeframeResolverOptions {
  /** Base bars per higher-timeframe bucket, e.g. 3 for 15m from 5m, 12 for 60m from 5m. */
  readonly buckets: readonly { readonly htfTimeframe: string; readonly barsPerBucket: number }[];
  /** Bars in the fast/slow EMA over higher-timeframe closes, in higher-timeframe bars. */
  readonly emaFastPeriod: number;
  readonly emaSlowPeriod: number;
  /**
   * Fraction of the slow EMA the fast EMA must clear before a bias is called directional.
   * Without it, two nearly equal EMAs produce a bias that flips on noise, and
   * `calculateHtfTrendAlignment` treats every flip as a full +1/-1 swing.
   */
  readonly biasBandFraction: number;
  /** Completed higher-timeframe bars scanned for the nearest swing support and resistance. */
  readonly swingLookbackBuckets: number;
}

export const defaultHigherTimeframeResolverOptions: HigherTimeframeResolverOptions = {
  // 15m and 60m from a 5m base: the two the pattern strategy's own doc names.
  buckets: [
    { htfTimeframe: "15m", barsPerBucket: 3 },
    { htfTimeframe: "60m", barsPerBucket: 12 },
  ],
  emaFastPeriod: 9,
  emaSlowPeriod: 21,
  biasBandFraction: 0.0005,
  swingLookbackBuckets: 20,
};

interface Bucket {
  high: number;
  low: number;
  close: number;
  /** Base bars folded in so far. A bucket publishes only when this reaches `barsPerBucket`. */
  filled: number;
}

function sessionKey(closeTime: Date): string {
  return closeTime.toISOString().slice(0, 10);
}

/**
 * Higher-timeframe context per base bar, aligned by index with `contexts`.
 *
 * Index `i` carries only buckets that had closed before `contexts[i]` opened, so attaching the
 * result to `contexts[i]` cannot leak the current bar's own outcome.
 */
export function resolveHigherTimeframes(
  contexts: readonly StrategyMarketContext[],
  options: HigherTimeframeResolverOptions = defaultHigherTimeframeResolverOptions,
): HigherTimeframeContext[][] {
  const perBar: HigherTimeframeContext[][] = contexts.map(() => []);
  if (contexts.length === 0) return perBar;

  for (const bucketSpec of options.buckets) {
    if (!Number.isInteger(bucketSpec.barsPerBucket) || bucketSpec.barsPerBucket < 2) {
      throw new Error(`barsPerBucket for ${bucketSpec.htfTimeframe} must be an integer of at least 2.`);
    }
    let open: Bucket | null = null;
    let currentSession = "";
    let emaFast: number | null = null;
    let emaSlow: number | null = null;
    const closedHighs: number[] = [];
    const closedLows: number[] = [];
    let published: HigherTimeframeContext | null = null;

    const fastWeight = 2 / (options.emaFastPeriod + 1);
    const slowWeight = 2 / (options.emaSlowPeriod + 1);

    for (let index = 0; index < contexts.length; index += 1) {
      // Publish first, consume second. The bar at `index` receives the state built from bars
      // strictly before it, which is what `closeTime <= asOf` means once asOf is this bar's open.
      if (published !== null) perBar[index]!.push(published);

      const candle = contexts[index]!.candle;
      const session = sessionKey(candle.closeTime);
      if (session !== currentSession) {
        // A bucket may not straddle a session; an overnight gap is not sixty minutes of trade.
        // The partial bucket is discarded rather than completed with the next day's bars.
        currentSession = session;
        open = null;
      }

      if (open === null) {
        open = { high: candle.high, low: candle.low, close: candle.close, filled: 1 };
      } else {
        open.high = Math.max(open.high, candle.high);
        open.low = Math.min(open.low, candle.low);
        open.close = candle.close;
        open.filled += 1;
      }

      if (open.filled < bucketSpec.barsPerBucket) continue;

      const completed = open;
      open = null;
      emaFast = emaFast === null ? completed.close : completed.close * fastWeight + emaFast * (1 - fastWeight);
      emaSlow = emaSlow === null ? completed.close : completed.close * slowWeight + emaSlow * (1 - slowWeight);
      closedHighs.push(completed.high);
      closedLows.push(completed.low);
      if (closedHighs.length > options.swingLookbackBuckets) {
        closedHighs.shift();
        closedLows.shift();
      }

      const band = Math.abs(emaSlow) * options.biasBandFraction;
      const trendBias: HigherTimeframeContext["trendBias"] = emaFast - emaSlow > band
        ? "BULLISH"
        : emaSlow - emaFast > band
          ? "BEARISH"
          : "NEUTRAL";
      // Distance between the averages in units of the slow average, capped at 1. A number, not a
      // probability -- nothing downstream calibrates it, so it must not be dressed as one.
      const trendConfidence = emaSlow === 0
        ? 0
        : Math.min(1, Math.abs(emaFast - emaSlow) / Math.abs(emaSlow) / Math.max(options.biasBandFraction * 20, Number.EPSILON));

      // Support below the last close and resistance above it, taken from completed buckets only.
      // A level on the wrong side of price is not a level; it is the one price just crossed.
      const supports = closedLows.filter((low) => low <= completed.close);
      const resistances = closedHighs.filter((high) => high >= completed.close);
      published = {
        htfTimeframe: bucketSpec.htfTimeframe,
        trendBias,
        trendConfidence,
        nearestSupportLevel: supports.length === 0 ? null : Math.max(...supports),
        nearestResistanceLevel: resistances.length === 0 ? null : Math.min(...resistances),
        chartPatterns: [],
      };
    }
  }

  return perBar;
}

/** Returns a copy of `contexts` with resolved higher-timeframe context attached. */
export function attachHigherTimeframes(
  contexts: readonly StrategyMarketContext[],
  options: HigherTimeframeResolverOptions = defaultHigherTimeframeResolverOptions,
): StrategyMarketContext[] {
  const resolved = resolveHigherTimeframes(contexts, options);
  return contexts.map((context, index) => ({ ...context, higherTimeframes: resolved[index]! }));
}
