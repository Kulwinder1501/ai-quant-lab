import type { StrategyMarketContext, TradeSide } from "./strategy.js";

/**
 * Higher-timeframe directional bias, read from a slower bar's own indicators.
 *
 * Distinct from `calculateHtfTrendAlignment` in `multi-timeframe-confluence.ts`, and deliberately
 * so. That one scores a pre-digested `HigherTimeframeContext` (`trendBias`, S/R levels) which
 * nothing has ever populated in production. This one reads the *full* slower `StrategyMarketContext`
 * that `GenerateTradeIdeas` now attaches, so the bias is derived from the same indicator snapshots
 * the slower timeframe already stores rather than from a summary nobody produces.
 *
 * ## Why close-versus-EMA, and what it is not
 *
 * The rule is deliberately the plainest thing that could work: price above its own slower EMA is
 * BULLISH, below is BEARISH. It is a *direction* read, not a trend-strength read -- it says which
 * way the slower timeframe is leaning, not whether it is trending at all. A range-bound 15m bar
 * oscillating around its EMA will alternate bias, and this cannot tell that apart from a genuine
 * trend. Anything stronger (slope, ADX, Supertrend persistence) is a different measurement and
 * should be added as one, with its own evidence, rather than smuggled in here.
 *
 * ## Measured, before it was wired
 *
 * Over the 28 closed 1m `momentum-scalp` option trades to 2026-09-08, requiring agreement with this
 * bias blocked 12 of 28 at 15m and 2 of 28 at 5m. 5m is nearly a no-op because the 1m entry rule
 * already requires price on the correct side of VWAP with EMA(3/8) aligned, which largely implies
 * the 5m relationship -- so 5m re-asks a question the strategy has already asked. 15m binds.
 *
 * What neither does is discriminate: at 15m the win rate is 25% among trades that agree and 25%
 * among those that conflict. The gate cuts good and bad in proportion, reducing exposure rather
 * than error rate. On a strategy with negative expectancy any filter that trades less will appear
 * to save money, and that is arithmetic, not edge. Read a P&L improvement from this gate as "traded
 * less", unless and until the survivors beat the blocked on win rate.
 */
export type HtfBias = "BULLISH" | "BEARISH" | "NEUTRAL";

/**
 * `NEUTRAL` is returned only on an exact close-equals-EMA tie, and separately for "could not be
 * computed" -- the caller distinguishes those by the `null` return, because absence of a slower bar
 * is a different fact from a slower bar that is precisely balanced.
 */
export function htfBiasFrom(
  context: StrategyMarketContext,
  indicatorAlgorithmVersion: string,
  emaPeriod: number,
): HtfBias | null {
  const ema = context.indicators.find(
    (indicator) => indicator.code === "EMA"
      && indicator.algorithmVersion === indicatorAlgorithmVersion
      && indicator.parameters.period === emaPeriod,
  );
  if (!ema) return null;
  const value = ema.values.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;

  const close = context.candle.close;
  if (!Number.isFinite(close) || close <= 0) return null;
  if (close > value) return "BULLISH";
  if (close < value) return "BEARISH";
  return "NEUTRAL";
}

export function biasAgreesWith(bias: HtfBias, side: TradeSide): boolean {
  return side === "LONG" ? bias === "BULLISH" : bias === "BEARISH";
}
