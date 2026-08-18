import { test, expect } from "vitest";
import { ChartPatternEngine, defaultChartPatternConfiguration } from "./chart-pattern-engine.js";
import type { PatternCandle } from "./market-pattern.js";

function makeCandle(id: string, open: number, high: number, low: number, close: number, timeIndex = 0): PatternCandle {
  return {
    id,
    openTime: new Date(1700000000000 + timeIndex * 60000),
    open,
    high,
    low,
    close,
    volume: 1000,
  };
}

test("ChartPatternEngine detects DOUBLE_BOTTOM on neckline breakout", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    doublePatternTolerance: 0.20,
    swingWindow: 2,
    minimumSwingAtr: 0.5,
    atrPeriod: 3,
  });

  // Construct Double Bottom:
  // C2: Trough 1 (low 80)
  // C5: Mid Peak / Neckline (high 110, close 108)
  // C8: Trough 2 (low 81 - within tolerance)
  // C11: Breakout above neckline (close 115 > 110)
  const candles: PatternCandle[] = [
    makeCandle("C0", 100, 102, 98, 100, 0),
    makeCandle("C1", 99, 100, 92, 94, 1),
    makeCandle("C2", 94, 95, 80, 85, 2), // Left Trough (80)
    makeCandle("C3", 85, 96, 84, 94, 3),
    makeCandle("C4", 95, 104, 94, 102, 4),
    makeCandle("C5", 102, 110, 100, 108, 5), // Mid Peak (Neckline: 110)
    makeCandle("C6", 107, 108, 98, 100, 6),
    makeCandle("C7", 100, 101, 88, 90, 7),
    makeCandle("C8", 90, 92, 81, 86, 8), // Right Trough (81)
    makeCandle("C9", 86, 98, 85, 96, 9),
    makeCandle("C10", 96, 108, 95, 105, 10), // Confirms C8
    makeCandle("C11", 106, 116, 104, 115, 11), // Breakout candle (close 115 > 110)
  ];

  const events = engine.detect(candles);
  const doubleBottoms = events.filter((e) => e.eventCode === "DOUBLE_BOTTOM");

  expect(doubleBottoms.length).toBe(1);
  expect(doubleBottoms[0].direction).toBe("BULLISH");
  expect(doubleBottoms[0].level).toBe(110);
  expect(doubleBottoms[0].candleId).toBe("C11");
});

test("ChartPatternEngine detects DOUBLE_TOP on neckline breakdown", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    doublePatternTolerance: 0.20,
    swingWindow: 2,
    minimumSwingAtr: 0.5,
    atrPeriod: 3,
  });

  // Construct Double Top:
  // C2: Peak 1 (high 120)
  // C5: Mid Trough / Neckline (low 90, close 92)
  // C8: Peak 2 (high 119 - within tolerance)
  // C11: Breakdown below neckline (close 85 < 90)
  const candles: PatternCandle[] = [
    makeCandle("C0", 100, 102, 98, 100, 0),
    makeCandle("C1", 101, 112, 100, 110, 1),
    makeCandle("C2", 110, 120, 108, 118, 2), // Left Peak (120)
    makeCandle("C3", 118, 119, 106, 108, 3),
    makeCandle("C4", 108, 109, 96, 98, 4),
    makeCandle("C5", 98, 100, 90, 92, 5), // Mid Trough (Neckline: 90)
    makeCandle("C6", 92, 104, 91, 102, 6),
    makeCandle("C7", 102, 114, 101, 112, 7),
    makeCandle("C8", 112, 119, 110, 116, 8), // Right Peak (119)
    makeCandle("C9", 116, 117, 102, 104, 9),
    makeCandle("C10", 104, 105, 94, 95, 10), // Confirms C8
    makeCandle("C11", 95, 96, 82, 85, 11), // Breakdown candle (close 85 < 90)
  ];

  const events = engine.detect(candles);
  const doubleTops = events.filter((e) => e.eventCode === "DOUBLE_TOP");

  expect(doubleTops.length).toBe(1);
  expect(doubleTops[0].direction).toBe("BEARISH");
  expect(doubleTops[0].level).toBe(90);
  expect(doubleTops[0].candleId).toBe("C11");
});

test("ChartPatternEngine detects BULL_FLAG on upper channel breakout", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    flagPoleMinAtr: 1.5,
    flagMaxRetracement: 0.5,
    flagMinBoundaryTouches: 2,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Construct Bull Flag:
  // Pole: C2 (low 80) -> C5 (high 140) -> Pole height = 60
  // Flag Channel:
  // C5: High 0 (140)
  // C8: Low 0 (120)
  // C11: High 1 (135) -> downward sloping
  // C14: Low 1 (115)
  // C17: Breakout above channel line
  const candles: PatternCandle[] = [
    makeCandle("C0", 90, 92, 88, 90, 0),
    makeCandle("C1", 90, 92, 84, 86, 1),
    makeCandle("C2", 86, 88, 80, 85, 2), // Pole Base (80)
    makeCandle("C3", 85, 105, 84, 102, 3),
    makeCandle("C4", 102, 125, 100, 122, 4),
    makeCandle("C5", 122, 140, 120, 138, 5), // Pole Peak (140)
    makeCandle("C6", 137, 138, 128, 130, 6),
    makeCandle("C7", 130, 132, 122, 124, 7),
    makeCandle("C8", 124, 125, 120, 122, 8), // Flag Low 0 (120)
    makeCandle("C9", 122, 130, 121, 128, 9),
    makeCandle("C10", 128, 134, 127, 132, 10),
    makeCandle("C11", 132, 135, 130, 134, 11), // Flag High 1 (135 - lower than 140)
    makeCandle("C12", 134, 134, 124, 126, 12),
    makeCandle("C13", 126, 127, 118, 120, 13),
    makeCandle("C14", 120, 121, 115, 118, 14), // Flag Low 1 (115)
    makeCandle("C15", 118, 128, 117, 126, 15),
    makeCandle("C16", 126, 130, 124, 128, 16), // Inside channel (close 128 <= 130.8)
    makeCandle("C17", 128, 145, 127, 144, 17), // Breakout above channel (close 144 > 130.0)
  ];

  const events = engine.detect(candles);
  const bullFlags = events.filter((e) => e.eventCode === "BULL_FLAG");

  expect(bullFlags.length).toBe(1);
  expect(bullFlags[0].direction).toBe("BULLISH");
  expect(bullFlags[0].candleId).toBe("C17");
});

test("ChartPatternEngine detects BEAR_FLAG on lower channel breakdown", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    flagPoleMinAtr: 1.5,
    flagMaxRetracement: 0.5,
    flagMinBoundaryTouches: 2,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Construct Bear Flag:
  // Pole: C2 (high 140) -> C5 (low 80) -> Pole height = 60
  // Flag Channel:
  // C5: Low 0 (80)
  // C8: High 0 (100)
  // C11: Low 1 (85) -> upward sloping
  // C14: High 1 (105)
  // C17: Breakdown below channel line
  const candles: PatternCandle[] = [
    makeCandle("C0", 130, 132, 128, 130, 0),
    makeCandle("C1", 130, 134, 128, 132, 1),
    makeCandle("C2", 132, 140, 130, 138, 2), // Pole Top (140)
    makeCandle("C3", 138, 139, 115, 118, 3),
    makeCandle("C4", 118, 120, 95, 98, 4),
    makeCandle("C5", 98, 100, 80, 82, 5), // Pole Trough (80)
    makeCandle("C6", 83, 92, 82, 90, 6),
    makeCandle("C7", 90, 98, 89, 96, 7),
    makeCandle("C8", 96, 100, 95, 98, 8), // Flag High 0 (100)
    makeCandle("C9", 98, 99, 90, 92, 9),
    makeCandle("C10", 92, 93, 86, 88, 10),
    makeCandle("C11", 88, 90, 85, 87, 11), // Flag Low 1 (85 - higher than 80)
    makeCandle("C12", 87, 96, 86, 94, 12),
    makeCandle("C13", 94, 102, 93, 100, 13),
    makeCandle("C14", 100, 105, 99, 103, 14), // Flag High 1 (105)
    makeCandle("C15", 103, 104, 94, 95, 15),
    makeCandle("C16", 95, 96, 88, 90, 16), // Confirms C14
    makeCandle("C17", 90, 91, 75, 76, 17), // Breakdown below channel (close 76)
  ];

  const events = engine.detect(candles);
  const bearFlags = events.filter((e) => e.eventCode === "BEAR_FLAG");

  expect(bearFlags.length).toBe(1);
  expect(bearFlags[0].direction).toBe("BEARISH");
  expect(bearFlags[0].candleId).toBe("C17");
});

test("ChartPatternEngine detects ASCENDING_TRIANGLE on resistance breakout", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    triangleHorizontalToleranceAtr: 0.30,
    triangleMinTouches: 2,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Flat Highs (120, 120) + Higher Lows (80, 95)
  // C2: Low 0 (80)
  // C5: High 0 (120)
  // C8: Low 1 (95) -> Higher low
  // C11: High 1 (120) -> Flat high
  // C14: Low 2 (105) -> Higher low
  // C17: Breakout above resistance (close 126 > 120)
  const candles: PatternCandle[] = [
    makeCandle("C0", 95, 98, 92, 95, 0),
    makeCandle("C1", 95, 96, 88, 90, 1),
    makeCandle("C2", 90, 92, 80, 85, 2), // Low 0 (80)
    makeCandle("C3", 85, 105, 84, 100, 3),
    makeCandle("C4", 100, 115, 98, 112, 4),
    makeCandle("C5", 112, 120, 110, 118, 5), // High 0 (120)
    makeCandle("C6", 118, 119, 108, 110, 6),
    makeCandle("C7", 110, 112, 98, 100, 7),
    makeCandle("C8", 100, 102, 95, 98, 8), // Low 1 (95 - higher)
    makeCandle("C9", 98, 110, 97, 108, 9),
    makeCandle("C10", 108, 116, 107, 114, 10),
    makeCandle("C11", 114, 120, 112, 118, 11), // High 1 (120 - flat)
    makeCandle("C12", 118, 119, 110, 112, 12),
    makeCandle("C13", 112, 114, 106, 108, 13),
    makeCandle("C14", 108, 110, 105, 108, 14), // Low 2 (105 - higher)
    makeCandle("C15", 108, 115, 107, 114, 15),
    makeCandle("C16", 114, 120, 113, 118, 16), // Confirms C14
    makeCandle("C17", 118, 128, 117, 126, 17), // Breakout above 120
  ];

  const events = engine.detect(candles);
  const ascTriangles = events.filter((e) => e.eventCode === "ASCENDING_TRIANGLE");

  expect(ascTriangles.length).toBe(1);
  expect(ascTriangles[0].direction).toBe("BULLISH");
  expect(ascTriangles[0].level).toBe(120);
  expect(ascTriangles[0].candleId).toBe("C17");
});

test("ChartPatternEngine detects DESCENDING_TRIANGLE on support breakdown", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    triangleHorizontalToleranceAtr: 0.30,
    triangleMinTouches: 2,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Flat Lows (80, 80) + Lower Highs (120, 105)
  // C2: High 0 (120)
  // C5: Low 0 (80)
  // C8: High 1 (105) -> Lower high
  // C11: Low 1 (80) -> Flat low
  // C14: High 2 (95) -> Lower high
  // C17: Breakdown below support (close 74 < 80)
  const candles: PatternCandle[] = [
    makeCandle("C0", 105, 108, 102, 105, 0),
    makeCandle("C1", 105, 112, 104, 110, 1),
    makeCandle("C2", 110, 120, 108, 118, 2), // High 0 (120)
    makeCandle("C3", 118, 119, 98, 100, 3),
    makeCandle("C4", 100, 102, 88, 90, 4),
    makeCandle("C5", 90, 92, 80, 82, 5), // Low 0 (80)
    makeCandle("C6", 82, 92, 81, 90, 6),
    makeCandle("C7", 90, 100, 89, 98, 7),
    makeCandle("C8", 98, 105, 97, 102, 8), // High 1 (105 - lower)
    makeCandle("C9", 102, 103, 92, 94, 9),
    makeCandle("C10", 94, 95, 84, 86, 10),
    makeCandle("C11", 86, 88, 80, 82, 11), // Low 1 (80 - flat)
    makeCandle("C12", 82, 90, 81, 88, 12),
    makeCandle("C13", 88, 94, 87, 92, 13),
    makeCandle("C14", 92, 95, 91, 94, 14), // High 2 (95 - lower)
    makeCandle("C15", 94, 95, 86, 88, 15),
    makeCandle("C16", 88, 89, 82, 84, 16), // Confirms C14
    makeCandle("C17", 84, 85, 72, 74, 17), // Breakdown below 80
  ];

  const events = engine.detect(candles);
  const descTriangles = events.filter((e) => e.eventCode === "DESCENDING_TRIANGLE");

  expect(descTriangles.length).toBe(1);
  expect(descTriangles[0].direction).toBe("BEARISH");
  expect(descTriangles[0].level).toBe(80);
  expect(descTriangles[0].candleId).toBe("C17");
});

test("ChartPatternEngine detects HEAD_AND_SHOULDERS on neckline breakdown", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Construct Head and Shoulders:
  // C2: Left Shoulder High (120)
  // C5: Left Trough Low (100)
  // C8: Head High (140)
  // C11: Right Trough Low (100)
  // C14: Right Shoulder High (120)
  // C17: Breakdown below neckline (close 95 < 100)
  const candles: PatternCandle[] = [
    makeCandle("C0", 100, 105, 98, 102, 0),
    makeCandle("C1", 102, 115, 100, 112, 1),
    makeCandle("C2", 112, 120, 110, 118, 2), // Left Shoulder (120)
    makeCandle("C3", 118, 119, 106, 108, 3),
    makeCandle("C4", 108, 109, 102, 104, 4),
    makeCandle("C5", 104, 105, 100, 102, 5), // Left Trough (100)
    makeCandle("C6", 102, 120, 101, 118, 6),
    makeCandle("C7", 118, 135, 116, 132, 7),
    makeCandle("C8", 132, 140, 130, 138, 8), // Head (140)
    makeCandle("C9", 138, 139, 120, 122, 9),
    makeCandle("C10", 122, 123, 108, 110, 10),
    makeCandle("C11", 110, 112, 100, 102, 11), // Right Trough (100)
    makeCandle("C12", 102, 114, 101, 112, 12),
    makeCandle("C13", 112, 119, 110, 118, 13),
    makeCandle("C14", 118, 120, 116, 118, 14), // Right Shoulder (120)
    makeCandle("C15", 118, 119, 108, 110, 15),
    makeCandle("C16", 110, 111, 101, 102, 16), // Confirms C14
    makeCandle("C17", 102, 103, 94, 95, 17), // Breakdown below 100
  ];

  const events = engine.detect(candles);
  const hs = events.filter((e) => e.eventCode === "HEAD_AND_SHOULDERS");

  expect(hs.length).toBe(1);
  expect(hs[0].direction).toBe("BEARISH");
  expect(hs[0].candleId).toBe("C17");
});

test("ChartPatternEngine detects INVERSE_HEAD_AND_SHOULDERS on neckline breakout", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Construct Inverse Head and Shoulders:
  // C2: Left Shoulder Low (80)
  // C5: Left Peak High (100)
  // C8: Head Low (60)
  // C11: Right Peak High (100)
  // C14: Right Shoulder Low (80)
  // C17: Breakout above neckline (close 105 > 100)
  const candles: PatternCandle[] = [
    makeCandle("C0", 100, 102, 92, 95, 0),
    makeCandle("C1", 95, 96, 84, 86, 1),
    makeCandle("C2", 86, 88, 80, 84, 2), // Left Shoulder Low (80)
    makeCandle("C3", 84, 94, 83, 92, 3),
    makeCandle("C4", 92, 98, 91, 96, 4),
    makeCandle("C5", 96, 100, 94, 98, 5), // Left Peak High (100)
    makeCandle("C6", 98, 99, 82, 84, 6),
    makeCandle("C7", 84, 85, 68, 70, 7),
    makeCandle("C8", 70, 72, 60, 64, 8), // Head Low (60)
    makeCandle("C9", 64, 80, 63, 78, 9),
    makeCandle("C10", 78, 94, 77, 92, 10),
    makeCandle("C11", 92, 100, 90, 98, 11), // Right Peak High (100)
    makeCandle("C12", 98, 99, 86, 88, 12),
    makeCandle("C13", 88, 89, 81, 84, 13),
    makeCandle("C14", 84, 86, 80, 84, 14), // Right Shoulder Low (80)
    makeCandle("C15", 84, 94, 83, 92, 15),
    makeCandle("C16", 92, 99, 91, 98, 16), // Confirms C14
    makeCandle("C17", 98, 108, 97, 105, 17), // Breakout above 100
  ];

  const events = engine.detect(candles);
  const ihs = events.filter((e) => e.eventCode === "INVERSE_HEAD_AND_SHOULDERS");

  expect(ihs.length).toBe(1);
  expect(ihs[0].direction).toBe("BULLISH");
  expect(ihs[0].candleId).toBe("C17");
});

test("ChartPatternEngine detects RISING_WEDGE on support breakdown", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Construct Rising Wedge:
  // C2: Low 0 (100)
  // C5: High 0 (120)
  // C8: Low 1 (115) -> slope mLow = 15/6 = 2.5
  // C11: High 1 (132) -> slope mHigh = 12/6 = 2.0 (mLow > mHigh > 0)
  // C12: High 130, close 128 (Support at idx 12: 125.0, close 128 >= 125.0)
  // C13: High 129, close 128 (Support at idx 13: 127.5, close 128 >= 127.5) -> Confirms C11
  // C14: Close 120 (Support at idx 14: 130.0, close 120 < 130.0) -> Breakdown!
  const candles: PatternCandle[] = [
    makeCandle("C0", 104, 108, 104, 106, 0),
    makeCandle("C1", 106, 107, 102, 103, 1),
    makeCandle("C2", 103, 104, 100, 101, 2), // Low 0 (100)
    makeCandle("C3", 101, 112, 105, 110, 3),
    makeCandle("C4", 110, 118, 108, 116, 4),
    makeCandle("C5", 116, 120, 114, 118, 5), // High 0 (120)
    makeCandle("C6", 118, 119, 116, 117, 6),
    makeCandle("C7", 117, 118, 116, 117, 7),
    makeCandle("C8", 117, 118, 115, 116, 8), // Low 1 (115)
    makeCandle("C9", 116, 126, 118, 124, 9),
    makeCandle("C10", 124, 130, 123, 128, 10),
    makeCandle("C11", 128, 132, 127, 130, 11), // High 1 (132)
    makeCandle("C12", 130, 130, 128, 128, 12),
    makeCandle("C13", 128, 129, 128, 128, 13), // Confirms C11
    makeCandle("C14", 128, 128, 118, 120, 14), // Breakdown below 130.0
  ];

  const events = engine.detect(candles);
  const wedges = events.filter((e) => e.eventCode === "RISING_WEDGE");

  expect(wedges.length).toBe(1);
  expect(wedges[0].direction).toBe("BEARISH");
  expect(wedges[0].candleId).toBe("C14");
});

test("ChartPatternEngine detects FALLING_WEDGE on resistance breakout", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Construct Falling Wedge:
  // C2: High 0 (130)
  // C5: Low 0 (110)
  // C8: High 1 (115) -> slope mHigh = -15/6 = -2.5
  // C11: Low 1 (105) -> slope mLow = -5/6 = -0.833 (mHigh < mLow < 0)
  // C12: High 104, close 103 (Resistance at idx 12: 105.0, close 103 <= 105.0)
  // C13: High 102, close 101 (Resistance at idx 13: 102.5, close 101 <= 102.5) -> Confirms C11
  // C14: Close 112 (Resistance at idx 14: 100.0, close 112 > 100.0) -> Breakout!
  const candles: PatternCandle[] = [
    makeCandle("C0", 124, 125, 122, 124, 0),
    makeCandle("C1", 124, 126, 123, 125, 1),
    makeCandle("C2", 125, 130, 124, 129, 2), // High 0 (130)
    makeCandle("C3", 129, 129, 118, 120, 3),
    makeCandle("C4", 120, 121, 112, 114, 4),
    makeCandle("C5", 114, 115, 110, 112, 5), // Low 0 (110)
    makeCandle("C6", 112, 114, 111, 113, 6),
    makeCandle("C7", 113, 114, 112, 113, 7),
    makeCandle("C8", 113, 115, 112, 114, 8), // High 1 (115)
    makeCandle("C9", 114, 114, 107, 108, 9),
    makeCandle("C10", 108, 109, 106, 107, 10),
    makeCandle("C11", 107, 108, 105, 106, 11), // Low 1 (105)
    makeCandle("C12", 106, 107, 106, 103, 12),
    makeCandle("C13", 103, 106, 106, 102, 13), // Confirms C11
    makeCandle("C14", 101, 115, 100, 112, 14), // Breakout above 100.0
  ];

  const events = engine.detect(candles);
  const wedges = events.filter((e) => e.eventCode === "FALLING_WEDGE");

  expect(wedges.length).toBe(1);
  expect(wedges[0].direction).toBe("BULLISH");
  expect(wedges[0].candleId).toBe("C14");
});

test("Macro pattern never fires at or before finalPivot.confirmationIndex (Anti-Lookahead Guarantee)", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // H&S with P4 at C14, confirmed at C16. Candle C15 (before confirmation) crosses below neckline.
  // The engine must NOT fire at C15, only at/after confirmation index (C16 onwards).
  const candles: PatternCandle[] = [
    makeCandle("C0", 100, 102, 98, 100, 0),
    makeCandle("C1", 102, 115, 100, 112, 1),
    makeCandle("C2", 112, 120, 110, 118, 2), // Left Shoulder (120)
    makeCandle("C3", 118, 119, 106, 108, 3),
    makeCandle("C4", 108, 109, 102, 104, 4),
    makeCandle("C5", 104, 105, 100, 102, 5), // Left Trough (100)
    makeCandle("C6", 102, 120, 101, 118, 6),
    makeCandle("C7", 118, 135, 116, 132, 7),
    makeCandle("C8", 132, 140, 130, 138, 8), // Head (140)
    makeCandle("C9", 138, 139, 120, 122, 9),
    makeCandle("C10", 122, 123, 108, 110, 10),
    makeCandle("C11", 110, 112, 100, 102, 11), // Right Trough (100)
    makeCandle("C12", 102, 114, 101, 112, 12),
    makeCandle("C13", 112, 119, 110, 118, 13),
    makeCandle("C14", 118, 120, 116, 118, 14), // Right Shoulder (120)
    makeCandle("C15", 118, 119, 95, 96, 15), // Unconfirmed cross at idx 15 (< confirmationIndex 16)
    makeCandle("C16", 96, 101, 95, 100, 16), // Confirms C14
    makeCandle("C17", 100, 101, 94, 95, 17), // Confirmed breakdown cross at idx 17
  ];

  const events = engine.detect(candles);
  const hsEvents = events.filter((e) => e.eventCode === "HEAD_AND_SHOULDERS");

  // Must only detect on C17, NEVER at or before confirmation (C15 or C16)
  expect(hsEvents.length).toBe(1);
  expect(hsEvents[0].candleId).toBe("C17");
  expect(hsEvents.some((e) => e.candleId === "C15")).toBe(false);
});

test("ChartPatternEngine rejects non-converging channel for Wedge detection", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // Parallel channel (slope difference ~ 0, no convergence)
  const parallelCandles: PatternCandle[] = [
    makeCandle("C0", 100, 102, 98, 100, 0),
    makeCandle("C1", 100, 102, 98, 100, 1),
    makeCandle("C2", 100, 104, 100, 101, 2), // Low 0 (100)
    makeCandle("C3", 101, 112, 105, 110, 3),
    makeCandle("C4", 110, 118, 108, 116, 4),
    makeCandle("C5", 116, 120, 114, 118, 5), // High 0 (120) - Width = 20
    makeCandle("C6", 118, 119, 116, 117, 6),
    makeCandle("C7", 117, 118, 116, 117, 7),
    makeCandle("C8", 117, 118, 110, 112, 8), // Low 1 (110) - slope mLow = 10/6
    makeCandle("C9", 112, 124, 114, 122, 9),
    makeCandle("C10", 122, 128, 120, 126, 10),
    makeCandle("C11", 126, 130, 125, 128, 11), // High 1 (130) - slope mHigh = 10/6 (Parallel!)
    makeCandle("C12", 128, 129, 125, 126, 12),
    makeCandle("C13", 126, 127, 124, 125, 13), // Confirms C11
    makeCandle("C14", 125, 125, 115, 118, 14), // Cross below support
  ];

  const events = engine.detect(parallelCandles);
  const wedges = events.filter((e) => e.eventCode === "RISING_WEDGE" || e.eventCode === "FALLING_WEDGE");
  expect(wedges.length).toBe(0);
});

