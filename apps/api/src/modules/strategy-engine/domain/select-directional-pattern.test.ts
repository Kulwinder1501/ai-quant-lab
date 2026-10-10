import { describe, expect, it } from "vitest";
import { candlestickAlgorithmVersion } from "../../pattern-recognition/domain/market-pattern.js";
import { selectDirectionalPattern, type PatternCandidate } from "./select-directional-pattern.js";

const LATEST = "candle-9";

function pattern(code: string, direction: string, confidence: number, overrides: Partial<PatternCandidate> = {}): PatternCandidate {
  return {
    code,
    direction,
    confidence,
    algorithmVersion: candlestickAlgorithmVersion,
    contextCandleIds: ["candle-8", LATEST],
    ...overrides,
  };
}

describe("selectDirectionalPattern", () => {
  it("picks the highest-confidence pattern, not the alphabetically first code", () => {
    // The repository orders by pattern_code ASC: BEARISH_* would have won as `patterns[0]`.
    const selected = selectDirectionalPattern([
      pattern("BULLISH_HARAMI", "BULLISH", 0.6),
      pattern("HAMMER", "BULLISH", 0.92),
      pattern("DRAGONFLY_DOJI", "BULLISH", 0.7),
    ], LATEST);
    expect(selected).toEqual({ code: "HAMMER", direction: "BULLISH", confidence: 0.92 });
  });

  it("does not let an alphabetically earlier BEARISH code beat a stronger bullish-only set", () => {
    const selected = selectDirectionalPattern([
      pattern("BEARISH_MARUBOZU", "NEUTRAL", 0.99),
      pattern("BULLISH_ENGULFING", "BULLISH", 0.8),
    ], LATEST);
    expect(selected?.code).toBe("BULLISH_ENGULFING");
  });

  it("drops NEUTRAL patterns entirely", () => {
    expect(selectDirectionalPattern([
      pattern("DOJI", "NEUTRAL", 0.99),
      pattern("INSIDE_BAR", "NEUTRAL", 0.9),
      pattern("SPINNING_TOP", "NEUTRAL", 0.8),
    ], LATEST)).toBeNull();
  });

  it("abstains when bullish and bearish patterns conflict, whatever their confidences", () => {
    expect(selectDirectionalPattern([
      pattern("BEARISH_ENGULFING", "BEARISH", 0.7),
      pattern("HAMMER", "BULLISH", 0.95),
    ], LATEST)).toBeNull();
  });

  it("is independent of input order", () => {
    const patterns = [
      pattern("HAMMER", "BULLISH", 0.8),
      pattern("PIERCING_LINE", "BULLISH", 0.8, { contextCandleIds: ["candle-8", LATEST] }),
      pattern("BULLISH_ENGULFING", "BULLISH", 0.8),
    ];
    const forward = selectDirectionalPattern(patterns, LATEST);
    const backward = selectDirectionalPattern([...patterns].reverse(), LATEST);
    expect(forward).toEqual(backward);
    // Equal confidence and equal formation length: code ascending is the fixed final tiebreak.
    expect(forward?.code).toBe("BULLISH_ENGULFING");
  });

  it("breaks a confidence tie in favour of the longer formation before the code", () => {
    const selected = selectDirectionalPattern([
      pattern("BULLISH_ENGULFING", "BULLISH", 0.8, { contextCandleIds: ["candle-8", LATEST] }),
      pattern("MORNING_STAR", "BULLISH", 0.8, { contextCandleIds: ["candle-7", "candle-8", LATEST] }),
    ], LATEST);
    expect(selected?.code).toBe("MORNING_STAR");
  });

  it("only considers patterns detected on the latest candle", () => {
    expect(selectDirectionalPattern([
      pattern("HAMMER", "BULLISH", 0.95, { contextCandleIds: ["candle-3"] }),
    ], LATEST)).toBeNull();
  });

  it("ignores superseded algorithm versions", () => {
    expect(selectDirectionalPattern([
      pattern("HAMMER", "BULLISH", 0.95, { algorithmVersion: "candlestick-v1" }),
    ], LATEST)).toBeNull();
  });
});
