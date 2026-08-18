import { describe, expect, it } from "vitest";
import { CandlestickPatternEngine } from "./candlestick-pattern-engine.js";
import type {
  CandlestickPatternCode,
  DetectedCandlestickPattern,
  PatternCandle,
  PatternDirection,
} from "./market-pattern.js";

function candle(id: string, open: number, high: number, low: number, close: number): PatternCandle {
  return {
    id,
    openTime: new Date(`2026-07-24T03:${String(Number(id) - 1).padStart(2, "0")}:00.000Z`),
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

function detectionFor(
  engine: CandlestickPatternEngine,
  candles: readonly PatternCandle[],
  patternCode: CandlestickPatternCode,
  candleId: string,
  direction: PatternDirection,
): DetectedCandlestickPattern {
  const detection = engine.detect(candles).find((candidate) => (
    candidate.patternCode === patternCode
    && candidate.candleId === candleId
    && candidate.direction === direction
  ));

  expect(detection).toBeDefined();
  return detection!;
}

describe("CandlestickPatternEngine", () => {
  const engine = new CandlestickPatternEngine();

  it("detects a doji and trend-qualified single-candle reversal shapes", () => {
    const doji = detectionFor(engine, [candle("1", 100, 110, 90, 100.5)], "DOJI", "1", "NEUTRAL");
    expect(doji.contextCandleIds).toEqual(["1"]);
    expect(doji.confidence).toBeGreaterThan(0.9);

    const decline = [
      candle("1", 14.2, 14.5, 13.8, 14),
      candle("2", 13.2, 13.5, 12.8, 13),
      candle("3", 12.2, 12.5, 11.8, 12),
      candle("4", 11.2, 11.5, 10.8, 11),
      candle("5", 10, 10.5, 8, 10.4),
    ];
    const hammer = detectionFor(engine, decline, "HAMMER", "5", "BULLISH");
    expect(hammer.details).toMatchObject({ trend: "DOWN" });

    const advance = [
      candle("1", 9.8, 10.2, 9.6, 10),
      candle("2", 10.8, 11.2, 10.6, 11),
      candle("3", 11.8, 12.2, 11.6, 12),
      candle("4", 12.8, 13.2, 12.6, 13),
      candle("5", 13.2, 13.6, 11, 13.5),
    ];
    const hangingMan = detectionFor(engine, advance, "HANGING_MAN", "5", "BEARISH");
    expect(hangingMan.details).toMatchObject({ trend: "UP" });

    const shootingStar = detectionFor(engine, [
      ...advance.slice(0, 4),
      candle("5", 13.2, 16, 13.1, 13.5),
    ], "SHOOTING_STAR", "5", "BEARISH");
    expect(shootingStar.details).toMatchObject({ trend: "UP" });
  });

  it("detects dragonfly and gravestone dojis with trend context", () => {
    const decline = [
      candle("1", 14.2, 14.5, 13.8, 14),
      candle("2", 13.2, 13.5, 12.8, 13),
      candle("3", 12.2, 12.5, 11.8, 12),
      candle("4", 11.2, 11.5, 10.8, 11),
      candle("5", 10, 10.1, 7.0, 10.05), // Dragonfly: small body, virtually no upper wick, huge lower wick
    ];
    const dragonfly = detectionFor(engine, decline, "DRAGONFLY_DOJI", "5", "BULLISH");
    expect(dragonfly.contextCandleIds).toEqual(["5"]);
    expect(dragonfly.details).toMatchObject({ trend: "DOWN" });

    const advance = [
      candle("1", 9.8, 10.2, 9.6, 10),
      candle("2", 10.8, 11.2, 10.6, 11),
      candle("3", 11.8, 12.2, 11.6, 12),
      candle("4", 12.8, 13.2, 12.6, 13),
      candle("5", 14, 17.0, 13.95, 14.05), // Gravestone: small body, huge upper wick, virtually no lower wick
    ];
    const gravestone = detectionFor(engine, advance, "GRAVESTONE_DOJI", "5", "BEARISH");
    expect(gravestone.contextCandleIds).toEqual(["5"]);
    expect(gravestone.details).toMatchObject({ trend: "UP" });
  });

  it("detects bullish and bearish marubozu candles", () => {
    // Bullish Marubozu: Long body, open near low, close near high
    const bullMarubozu = detectionFor(engine, [
      candle("1", 100, 110, 99.8, 109.8),
    ], "BULLISH_MARUBOZU", "1", "BULLISH");
    expect(bullMarubozu.confidence).toBeGreaterThan(0.85);

    // Bearish Marubozu: Long body, open near high, close near low
    const bearMarubozu = detectionFor(engine, [
      candle("1", 110, 110.2, 99.8, 100.2),
    ], "BEARISH_MARUBOZU", "1", "BEARISH");
    expect(bearMarubozu.confidence).toBeGreaterThan(0.85);
  });

  it("records two-candle body and range patterns with their source-candle evidence", () => {
    const bullishEngulfing = detectionFor(engine, [
      candle("1", 12, 12.2, 9.8, 10),
      candle("2", 9.5, 12.7, 9.4, 12.5),
    ], "BULLISH_ENGULFING", "2", "BULLISH");
    expect(bullishEngulfing.contextCandleIds).toEqual(["1", "2"]);

    const bearishEngulfing = detectionFor(engine, [
      candle("1", 10, 12.2, 9.8, 12),
      candle("2", 12.5, 12.7, 9.4, 9.5),
    ], "BEARISH_ENGULFING", "2", "BEARISH");
    expect(bearishEngulfing.contextCandleIds).toEqual(["1", "2"]);

    const bullishHarami = detectionFor(engine, [
      candle("1", 14, 14.2, 9.8, 10),
      candle("2", 11, 12.2, 10.8, 12),
    ], "BULLISH_HARAMI", "2", "BULLISH");
    expect(bullishHarami.details).toMatchObject({ previousBodyLow: 10, previousBodyHigh: 14 });

    const bearishHarami = detectionFor(engine, [
      candle("1", 10, 14.2, 9.8, 14),
      candle("2", 13, 13.2, 11.8, 12),
    ], "BEARISH_HARAMI", "2", "BEARISH");
    expect(bearishHarami.details).toMatchObject({ previousBodyLow: 10, previousBodyHigh: 14 });

    const insideBar = detectionFor(engine, [
      candle("1", 10, 15, 5, 12),
      candle("2", 11, 14, 6, 12.5),
    ], "INSIDE_BAR", "2", "NEUTRAL");
    expect(insideBar.contextCandleIds).toEqual(["1", "2"]);

    const outsideBar = detectionFor(engine, [
      candle("1", 11, 15, 5, 10),
      candle("2", 9, 16, 4, 12),
    ], "OUTSIDE_BAR", "2", "BULLISH");
    expect(outsideBar.contextCandleIds).toEqual(["1", "2"]);
  });

  it("detects Piercing Line and Dark Cloud Cover with direction and penetration checks", () => {
    const decline = [
      candle("1", 14.2, 14.5, 13.8, 14),
      candle("2", 13.2, 13.5, 12.8, 13),
      candle("3", 12.2, 12.5, 11.8, 12),
      candle("4", 12.0, 12.2, 9.8, 10.0), // Bearish candle 1: body 2.0 (open 12, close 10), midpoint 11.0
      candle("5", 9.5, 11.8, 9.4, 11.5),  // Bullish candle 2: opens below prior low 9.8, closes 11.5 (> midpoint 11.0, < open 12.0)
    ];
    const piercing = detectionFor(engine, decline, "PIERCING_LINE", "5", "BULLISH");
    expect(piercing.contextCandleIds).toEqual(["4", "5"]);
    expect(piercing.details).toMatchObject({ trend: "DOWN" });

    const advance = [
      candle("1", 9.8, 10.2, 9.6, 10),
      candle("2", 10.8, 11.2, 10.6, 11),
      candle("3", 11.8, 12.2, 11.6, 12),
      candle("4", 12.0, 14.5, 11.8, 14.0), // Bullish candle 1: body 2.0 (open 12, close 14), midpoint 13.0
      candle("5", 14.8, 14.9, 12.2, 12.5), // Bearish candle 2: opens above prior high 14.5, closes 12.5 (< midpoint 13.0, > open 12.0)
    ];
    const darkCloud = detectionFor(engine, advance, "DARK_CLOUD_COVER", "5", "BEARISH");
    expect(darkCloud.contextCandleIds).toEqual(["4", "5"]);
    expect(darkCloud.details).toMatchObject({ trend: "UP" });
  });

  it("detects Tweezer Bottom and Top with ATR tolerance", () => {
    const decline = [
      candle("1", 14.2, 14.5, 13.8, 14),
      candle("2", 13.2, 13.5, 12.8, 13),
      candle("3", 12.2, 12.5, 11.8, 12),
      candle("4", 12.0, 12.2, 10.0, 10.2), // Bearish, low = 10.0
      candle("5", 10.2, 12.0, 10.02, 11.8), // Bullish, low = 10.02 (within 0.1 ATR tolerance)
    ];
    const tweezerBottom = detectionFor(engine, decline, "TWEEZER_BOTTOM", "5", "BULLISH");
    expect(tweezerBottom.contextCandleIds).toEqual(["4", "5"]);

    const advance = [
      candle("1", 9.8, 10.2, 9.6, 10),
      candle("2", 10.8, 11.2, 10.6, 11),
      candle("3", 11.8, 12.2, 11.6, 12),
      candle("4", 12.0, 14.0, 11.8, 13.8), // Bullish, high = 14.0
      candle("5", 13.8, 13.98, 12.0, 12.2), // Bearish, high = 13.98 (within tolerance)
    ];
    const tweezerTop = detectionFor(engine, advance, "TWEEZER_TOP", "5", "BEARISH");
    expect(tweezerTop.contextCandleIds).toEqual(["4", "5"]);
  });

  it("requires prior trend context for three-candle reversal and continuation patterns", () => {
    const morningStar = detectionFor(engine, [
      candle("1", 20, 20.5, 18.5, 19),
      candle("2", 19, 19.3, 17.7, 18),
      candle("3", 18, 18.2, 13.8, 14),
      candle("4", 13.8, 14.1, 13.5, 13.9),
      candle("5", 14, 17.2, 13.8, 17),
    ], "MORNING_STAR", "5", "BULLISH");
    expect(morningStar.contextCandleIds).toEqual(["3", "4", "5"]);

    const eveningStar = detectionFor(engine, [
      candle("1", 10, 11.2, 9.8, 11),
      candle("2", 11, 12.2, 10.8, 12),
      candle("3", 12, 16.2, 11.8, 16),
      candle("4", 16.1, 16.4, 15.8, 16),
      candle("5", 16, 16.2, 12.8, 13),
    ], "EVENING_STAR", "5", "BEARISH");
    expect(eveningStar.contextCandleIds).toEqual(["3", "4", "5"]);

    const threeWhiteSoldiers = detectionFor(engine, [
      candle("1", 25.2, 25.5, 24.8, 25),
      candle("2", 21, 21.3, 19.7, 20),
      candle("3", 18, 19.2, 17.8, 19),
      candle("4", 18.5, 20.7, 18.3, 20.5),
      candle("5", 20, 22.2, 19.8, 22),
    ], "THREE_WHITE_SOLDIERS", "5", "BULLISH");
    expect(threeWhiteSoldiers.details).toMatchObject({ trend: "DOWN", closes: [19, 20.5, 22] });

    const threeBlackCrows = detectionFor(engine, [
      candle("1", 9.8, 10.2, 9.5, 10),
      candle("2", 12, 12.3, 11.7, 12),
      candle("3", 15, 15.2, 13.8, 14),
      candle("4", 14.5, 14.7, 12.8, 13),
      candle("5", 13.5, 13.7, 11.8, 12),
    ], "THREE_BLACK_CROWS", "5", "BEARISH");
    expect(threeBlackCrows.details).toMatchObject({ trend: "UP", closes: [14, 13, 12] });
  });

  it("detects Three Inside Up and Three Inside Down according to TA-Lib canonical rules", () => {
    // Three Inside Up:
    // Candle 3: Bearish long body (open 15, close 11)
    // Candle 4: Bullish Harami (open 11.5, close 13.5) inside 11..15
    // Candle 5: Bullish confirmation closing ABOVE Candle 3 open 15 (e.g. close = 15.5)
    const decline = [
      candle("1", 18.2, 18.5, 17.8, 18),
      candle("2", 17.2, 17.5, 16.8, 17),
      candle("3", 15.0, 15.2, 10.8, 11.0),
      candle("4", 11.5, 13.8, 11.2, 13.5),
      candle("5", 13.5, 16.0, 13.2, 15.5),
    ];
    const threeInsideUp = detectionFor(engine, decline, "THREE_INSIDE_UP", "5", "BULLISH");
    expect(threeInsideUp.contextCandleIds).toEqual(["3", "4", "5"]);
    expect(threeInsideUp.details).toMatchObject({ firstOpen: 15.0, confirmationClose: 15.5 });

    // Three Inside Down:
    // Candle 3: Bullish long body (open 11, close 15)
    // Candle 4: Bearish Harami (open 14.5, close 12.5) inside 11..15
    // Candle 5: Bearish confirmation closing BELOW Candle 3 open 11 (e.g. close = 10.5)
    const advance = [
      candle("1", 8.8, 9.2, 8.6, 9),
      candle("2", 9.8, 10.2, 9.6, 10),
      candle("3", 11.0, 15.2, 10.8, 15.0),
      candle("4", 14.5, 14.7, 12.2, 12.5),
      candle("5", 12.5, 12.7, 10.2, 10.5),
    ];
    const threeInsideDown = detectionFor(engine, advance, "THREE_INSIDE_DOWN", "5", "BEARISH");
    expect(threeInsideDown.contextCandleIds).toEqual(["3", "4", "5"]);
    expect(threeInsideDown.details).toMatchObject({ firstOpen: 11.0, confirmationClose: 10.5 });
  });

  it("enforces anti-lookahead guarantees on multi-candle patterns", () => {
    // On a 2-candle Piercing pattern, candle 1 alone must NOT yield Piercing Line
    const singleCandle = [candle("1", 12.0, 12.2, 9.8, 10.0)];
    const singleResults = engine.detect(singleCandle);
    expect(singleResults.some((d) => d.patternCode === "PIERCING_LINE")).toBe(false);

    // On a 3-candle Three Inside Up pattern, candles 1 and 2 alone must NOT yield Three Inside Up
    const twoCandles = [
      candle("1", 15.0, 15.2, 10.8, 11.0),
      candle("2", 11.5, 13.8, 11.2, 13.5),
    ];
    const twoResults = engine.detect(twoCandles);
    expect(twoResults.some((d) => d.patternCode === "THREE_INSIDE_UP")).toBe(false);
  });

  it("detects Inverted Hammer by pure geometry (independent of trend) and Spinning Top indecision", () => {
    // Single isolated candle with Inverted Hammer geometry: small body at bottom (10.0-10.4), long upper wick (12.5), tiny lower wick (9.9)
    const singleInvertedHammer = [
      candle("1", 10.0, 12.5, 9.9, 10.4),
    ];
    const invertedHammer = detectionFor(engine, singleInvertedHammer, "INVERTED_HAMMER", "1", "BULLISH");
    expect(invertedHammer.contextCandleIds).toEqual(["1"]);
    expect(invertedHammer.direction).toBe("BULLISH");
    expect(invertedHammer.details).toHaveProperty("upperShadow");
    expect(invertedHammer.details).toHaveProperty("lowerShadow");
    expect(invertedHammer.details).toHaveProperty("bodyRatio");

    // Spinning top: small body (100.2 - 100.8 = 0.6 on range 3.0 = 20%), upper wick 1.2 (40%), lower wick 1.2 (40%)
    const spinningTop = detectionFor(engine, [
      candle("1", 100.2, 102.0, 99.0, 100.8),
    ], "SPINNING_TOP", "1", "NEUTRAL");
    expect(spinningTop.contextCandleIds).toEqual(["1"]);
    expect(spinningTop.direction).toBe("NEUTRAL");
    expect(spinningTop.confidence).toBeGreaterThan(0.7);
  });

  it("handles zero range and zero volume candles safely without crashing", () => {
    const flatCandles = [
      candle("1", 100, 100, 100, 100),
      candle("2", 100, 100, 100, 100),
    ];
    const results = engine.detect(flatCandles);
    expect(results).toEqual([]);
  });
});
