import { candlestickAlgorithmVersion } from "../../pattern-recognition/domain/market-pattern.js";

export interface PatternCandidate {
  code: string;
  algorithmVersion: string;
  direction: string;
  confidence: number;
  /** Ids of the candles the pattern was built from; the last one is the detection candle. */
  contextCandleIds: readonly string[];
}

export interface SelectedPattern {
  code: string;
  direction: string;
  confidence: number;
}

/**
 * Picks the single pattern the directional scorer may use for a bar, deterministically.
 *
 * The market-context repository returns patterns `ORDER BY pattern_code ASC` (a storage detail), so
 * the previous `ctx.patterns[0]` meant "the alphabetically first code": BEARISH_* sorts before
 * BULLISH_* and beat everything else whenever present. The rule here does not depend on input order:
 *
 * 1. Only the current candlestick algorithm version (superseded `candlestick-v1` rows are mixed-rule
 *    data and must not be read; until v2 is re-detected this yields no pattern, which is correct).
 * 2. Only patterns detected on `latestCandleId` (the last context candle) -- never one carried
 *    over from an earlier bar.
 * 3. NEUTRAL patterns (DOJI, INSIDE_BAR, SPINNING_TOP, ...) are dropped: indecision has no side.
 * 4. If both a BULLISH and a BEARISH pattern remain, they conflict and nothing is selected.
 * 5. Otherwise the highest-confidence pattern wins; ties break on more context candles (the
 *    longer, multi-bar formation), then on `code` ascending so the result is fully deterministic.
 */
export function selectDirectionalPattern(
  patterns: readonly PatternCandidate[],
  latestCandleId: string,
  algorithmVersion: string = candlestickAlgorithmVersion,
): SelectedPattern | null {
  const directional = patterns.filter((pattern) => (
    pattern.algorithmVersion === algorithmVersion
    && (pattern.direction === "BULLISH" || pattern.direction === "BEARISH")
    && (
      // The repository loads patterns by the latest candle's id, so an absent context list can
      // only mean "not recorded", not "another bar"; a recorded list must end on the latest bar.
      pattern.contextCandleIds.length === 0
      || pattern.contextCandleIds[pattern.contextCandleIds.length - 1] === latestCandleId
    )
  ));
  if (directional.length === 0) return null;

  const hasBullish = directional.some((pattern) => pattern.direction === "BULLISH");
  const hasBearish = directional.some((pattern) => pattern.direction === "BEARISH");
  if (hasBullish && hasBearish) return null;

  const [best] = [...directional].sort((a, b) => (
    b.confidence - a.confidence
    || b.contextCandleIds.length - a.contextCandleIds.length
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)
  ));
  return { code: best.code, direction: best.direction, confidence: best.confidence };
}
