import type { StrategyMarketContext } from "./strategy.js";

/**
 * The higher-timeframe covariate extractor for `momentum-v6-research`.
 *
 * `momentum-v6-research` is `momentum-v5-research` with one difference: the raw context records the
 * most recent *closed* 5m bar alongside the 1m decision, so the estimators can ask whether slower-
 * timeframe information adds discriminating power to a setup whose trigger and geometry are held
 * byte-identical to V5. It changes what is *captured*, never what is *scored* -- the candidate
 * logic is the same `MomentumScalpStrategy`, which is why V6 reuses V5's implementation checksum.
 *
 * ## Lossless, like `rawContext` itself
 *
 * The 5m slice mirrors the shape `rawContext` records for the 1m bar -- candle, indicators,
 * patterns, price-action events, regime -- rather than a hand-picked handful of scalars. Choosing
 * `htf_5m_ema20` and `htf_5m_atr14` up front would be the digest mistake `higherTimeframes` already
 * makes: it decides which slower-timeframe facts matter before any measurement says they do. The
 * blob is a covariate record, not a feature vector; downstream extraction navigates it.
 *
 * ## Absence is information, and it is recorded as such
 *
 * `present: false` is returned when no 5m context was attached -- early in a session before the
 * first 5m bar has closed, or a gap. It is deliberately distinguished from a loaded-but-empty
 * slice, the same rule `patternObservationCoverage` follows: a silent absence would read to an
 * estimator like a genuine feature value of zero.
 *
 * ## No look-ahead is enforced here
 *
 * This is a pure read of what the caller attached; it does not fetch. The anti-lookahead guarantee
 * -- the 5m bar closed at or before the 1m decision instant -- lives at the fetch site
 * (`findCompletedBefore`, `close_time <= $asOf`), which is the only place that can know `decisionAt`.
 * `dataThrough` is recorded on the slice so a reader can confirm the recency downstream.
 */
export const HTF_RESEARCH_TIMEFRAME = "5m" as const;

export function extractHtfObservations(context: StrategyMarketContext): Record<string, unknown> {
  const htf = context.higherTimeframeContexts?.[HTF_RESEARCH_TIMEFRAME];
  if (!htf) {
    return { htf5m: { present: false } };
  }
  return {
    htf5m: {
      present: true,
      timeframe: htf.candle.timeframe,
      // The 5m bar's own recency, mirroring `featureDataThrough` on the 1m layer: one tick before
      // its close, so a reader never mistakes the close instant for a knowable-during-the-bar value.
      dataThrough: new Date(htf.candle.closeTime.getTime() - 1),
      candle: {
        id: htf.candle.id,
        timeframe: htf.candle.timeframe,
        openTime: htf.candle.openTime,
        closeTime: htf.candle.closeTime,
        open: htf.candle.open,
        high: htf.candle.high,
        low: htf.candle.low,
        close: htf.candle.close,
        volume: htf.candle.volume,
      },
      indicators: htf.indicators.map((item) => ({
        code: item.code,
        algorithmVersion: item.algorithmVersion,
        parameters: item.parameters,
        values: item.values,
      })),
      patterns: htf.patterns.map((item) => ({
        code: item.code,
        algorithmVersion: item.algorithmVersion,
        direction: item.direction,
        confidence: item.confidence,
        contextCandleIds: item.contextCandleIds,
        details: item.details,
      })),
      priceActionEvents: htf.priceActionEvents.map((item) => ({
        eventCode: item.eventCode,
        algorithmVersion: item.algorithmVersion,
        direction: item.direction,
        level: item.level,
        confidence: item.confidence,
        details: item.details,
      })),
      regime: htf.regime ?? null,
    },
  };
}
