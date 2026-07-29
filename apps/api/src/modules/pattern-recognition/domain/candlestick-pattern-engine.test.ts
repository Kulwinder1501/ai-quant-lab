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
});
