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
    makeCandle("C16", 126, 131, 124, 128, 16), // Flag High 2 (131 - lower than 135): second channel high
    makeCandle("C17", 128, 129, 123, 124, 17),
    makeCandle("C18", 124, 126, 122, 123, 18), // Confirms C16
    makeCandle("C19", 123, 128, 122, 127, 19), // Inside channel (close 127 <= 128.6)
    makeCandle("C20", 127, 150, 126, 148, 20), // Breakout above channel (close 148 > 127.8)
  ];

  const events = engine.detect(candles);
  const bullFlags = events.filter((e) => e.eventCode === "BULL_FLAG");

  expect(bullFlags.length).toBe(1);
  expect(bullFlags[0].direction).toBe("BULLISH");
  expect(bullFlags[0].candleId).toBe("C20");
});

test("ChartPatternEngine does not count the pole-end pivot as a flag channel high", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    flagPoleMinAtr: 1.5,
    flagMaxRetracement: 0.5,
    flagMinBoundaryTouches: 2,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  });

  // The original bull-flag fixture: after the pole peak (C5) there is only ONE genuine channel high
  // (C11). Before the fix the pole-end pivot itself was channelHighs[0], so this passed as a flag
  // with a "channel" whose upper boundary started at the pole's own peak.
  const candles: PatternCandle[] = [
    makeCandle("C0", 90, 92, 88, 90, 0),
    makeCandle("C1", 90, 92, 84, 86, 1),
    makeCandle("C2", 86, 88, 80, 85, 2),
    makeCandle("C3", 85, 105, 84, 102, 3),
    makeCandle("C4", 102, 125, 100, 122, 4),
    makeCandle("C5", 122, 140, 120, 138, 5),
    makeCandle("C6", 137, 138, 128, 130, 6),
    makeCandle("C7", 130, 132, 122, 124, 7),
    makeCandle("C8", 124, 125, 120, 122, 8),
    makeCandle("C9", 122, 130, 121, 128, 9),
    makeCandle("C10", 128, 134, 127, 132, 10),
    makeCandle("C11", 132, 135, 130, 134, 11),
    makeCandle("C12", 134, 134, 124, 126, 12),
    makeCandle("C13", 126, 127, 118, 120, 13),
    makeCandle("C14", 120, 121, 115, 118, 14),
    makeCandle("C15", 118, 128, 117, 126, 15),
    makeCandle("C16", 126, 130, 124, 128, 16),
    makeCandle("C17", 128, 145, 127, 144, 17),
  ];

  const events = engine.detect(candles);
  expect(events.filter((e) => e.eventCode === "BULL_FLAG")).toEqual([]);
});

test("ChartPatternEngine requires flagMinBars between the pole end and the last channel pivot", () => {
  const candles: PatternCandle[] = [
    makeCandle("C0", 90, 92, 88, 90, 0),
    makeCandle("C1", 90, 92, 84, 86, 1),
    makeCandle("C2", 86, 88, 80, 85, 2),
    makeCandle("C3", 85, 105, 84, 102, 3),
    makeCandle("C4", 102, 125, 100, 122, 4),
    makeCandle("C5", 122, 140, 120, 138, 5),
    makeCandle("C6", 137, 138, 128, 130, 6),
    makeCandle("C7", 130, 132, 122, 124, 7),
    makeCandle("C8", 124, 125, 120, 122, 8),
    makeCandle("C9", 122, 130, 121, 128, 9),
    makeCandle("C10", 128, 134, 127, 132, 10),
    makeCandle("C11", 132, 135, 130, 134, 11),
    makeCandle("C12", 134, 134, 124, 126, 12),
    makeCandle("C13", 126, 127, 118, 120, 13),
    makeCandle("C14", 120, 121, 115, 118, 14),
    makeCandle("C15", 118, 128, 117, 126, 15),
    makeCandle("C16", 126, 131, 124, 128, 16),
    makeCandle("C17", 128, 129, 123, 124, 17),
    makeCandle("C18", 124, 126, 122, 123, 18),
    makeCandle("C19", 123, 128, 122, 127, 19),
    makeCandle("C20", 127, 150, 126, 148, 20),
  ];
  const base = {
    ...defaultChartPatternConfiguration,
    flagPoleMinAtr: 1.5,
    flagMaxRetracement: 0.5,
    flagMinBoundaryTouches: 2,
    swingWindow: 2,
    minimumSwingAtr: 0.3,
    atrPeriod: 3,
  };

  // The channel's last pivot (the C18 low) is 13 bars after the pole end (C5).
  expect(new ChartPatternEngine({ ...base, flagMinBars: 13 }).detect(candles)
    .some((e) => e.eventCode === "BULL_FLAG")).toBe(true);
  expect(new ChartPatternEngine({ ...base, flagMinBars: 14 }).detect(candles)
    .some((e) => e.eventCode === "BULL_FLAG")).toBe(false);
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
    makeCandle("C17", 90, 92, 87, 91, 17), // Flag Low 2 (87 - higher than 85): second channel low
    makeCandle("C18", 91, 96, 88, 94, 18),
    makeCandle("C19", 94, 97, 92, 95, 19), // Confirms C17
    makeCandle("C20", 95, 96, 74, 75, 20), // Breakdown below channel (close 75 < 88)
  ];

  const events = engine.detect(candles);
  const bearFlags = events.filter((e) => e.eventCode === "BEAR_FLAG");

  expect(bearFlags.length).toBe(1);
  expect(bearFlags[0].direction).toBe("BEARISH");
  expect(bearFlags[0].candleId).toBe("C20");
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

test("ChartPatternEngine detects RISING_WEDGE on support breakdown (four pivots, minimum lowered)", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    wedgeMinTotalPivots: 4,
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

test("ChartPatternEngine detects FALLING_WEDGE on resistance breakout (four pivots, minimum lowered)", () => {
  const engine = new ChartPatternEngine({
    ...defaultChartPatternConfiguration,
    wedgeMinTotalPivots: 4,
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

/**
 * Five pivots (L, H, L, H, L): lows rise 100 -> 115 -> 129.5 (slope ~2.46), highs rise 120 -> 132
 * (slope 2.0), so the boundaries converge. Price stays above the rising support until it closes
 * through it on C16, the bar on which the last low (C14) is confirmed.
 */
function risingWedgeFivePivots(): PatternCandle[] {
  return [
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
    makeCandle("C12", 130, 131, 130.5, 130.8, 12),
    makeCandle("C13", 130.8, 131.5, 130.4, 131, 13),
    makeCandle("C14", 131, 131.6, 129.5, 130.9, 14), // Low 2 (129.5)
    makeCandle("C15", 130.9, 133, 130.6, 132.5, 15), // Close 132.5 >= support 131.96
    makeCandle("C16", 132.5, 134, 130.8, 133, 16), // Close 133 < support 134.4 -> breakdown
  ];
}

/** The mirror image (price -> 250 - price) of a candle series: a rising wedge becomes a falling one. */
function mirrored(candles: readonly PatternCandle[]): PatternCandle[] {
  return candles.map((c) => ({
    ...c,
    open: 250 - c.open,
    high: 250 - c.low,
    low: 250 - c.high,
    close: 250 - c.close,
  }));
}

const wedgeConfiguration = {
  ...defaultChartPatternConfiguration,
  swingWindow: 2,
  minimumSwingAtr: 0.3,
  atrPeriod: 3,
};

test("ChartPatternEngine detects RISING_WEDGE with the default five-pivot minimum", () => {
  const events = new ChartPatternEngine(wedgeConfiguration).detect(risingWedgeFivePivots());
  const wedges = events.filter((e) => e.eventCode === "RISING_WEDGE");

  expect(wedges.length).toBe(1);
  expect(wedges[0].candleId).toBe("C16");
});

test("ChartPatternEngine detects FALLING_WEDGE with the default five-pivot minimum", () => {
  const events = new ChartPatternEngine(wedgeConfiguration).detect(mirrored(risingWedgeFivePivots()));
  const wedges = events.filter((e) => e.eventCode === "FALLING_WEDGE");

  expect(wedges.length).toBe(1);
  expect(wedges[0].candleId).toBe("C16");
});

test("ChartPatternEngine enforces wedgeMinTotalPivots (a four-pivot wedge is rejected by default)", () => {
  // Same shape as the five-pivot wedge but cut at four pivots, then run with the default minimum.
  const fourPivots = risingWedgeFivePivots().slice(0, 14);
  const lowered = new ChartPatternEngine({ ...wedgeConfiguration, wedgeMinTotalPivots: 4 }).detect(fourPivots);
  const strict = new ChartPatternEngine(wedgeConfiguration).detect(fourPivots);

  expect(strict.filter((e) => e.eventCode === "RISING_WEDGE")).toEqual([]);
  // Control: the rejection is the pivot count, not the data (lowering the minimum may or may not
  // fire on this truncated series, but it can never fire *less* than the strict run).
  expect(lowered.length).toBeGreaterThanOrEqual(strict.length);
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

/** C0..C10 of the double-bottom fixture: left trough C2, neckline 110 at C5, right trough C8. */
function doubleBottomBase(): PatternCandle[] {
  return [
    makeCandle("C0", 100, 102, 98, 100, 0),
    makeCandle("C1", 99, 100, 92, 94, 1),
    makeCandle("C2", 94, 95, 80, 85, 2),
    makeCandle("C3", 85, 96, 84, 94, 3),
    makeCandle("C4", 95, 104, 94, 102, 4),
    makeCandle("C5", 102, 110, 100, 108, 5),
    makeCandle("C6", 107, 108, 98, 100, 6),
    makeCandle("C7", 100, 101, 88, 90, 7),
    makeCandle("C8", 90, 92, 81, 86, 8),
    makeCandle("C9", 86, 98, 85, 96, 9),
    makeCandle("C10", 96, 108, 95, 105, 10),
  ];
}

/** Flat bars below the neckline (close 105), then a breakout bar closing at 115, at `breakoutIndex`. */
function doubleBottomWithBreakoutAt(breakoutIndex: number): PatternCandle[] {
  const candles = doubleBottomBase();
  for (let i = 11; i < breakoutIndex; i += 1) candles.push(makeCandle(`C${i}`, 105, 106, 104, 105, i));
  candles.push(makeCandle(`C${breakoutIndex}`, 106, 116, 104, 115, breakoutIndex));
  return candles;
}

const doubleConfiguration = {
  ...defaultChartPatternConfiguration,
  doublePatternTolerance: 0.20,
  swingWindow: 2,
  minimumSwingAtr: 0.5,
  atrPeriod: 3,
};

test("ChartPatternEngine only accepts a double-bottom breakout within 3x the pattern width", () => {
  // Width = right trough (C8) - left trough (C2) = 6 bars, so the window closes at C8 + 18 = C26.
  const engine = new ChartPatternEngine(doubleConfiguration);

  const inside = engine.detect(doubleBottomWithBreakoutAt(26)).filter((e) => e.eventCode === "DOUBLE_BOTTOM");
  expect(inside.map((e) => e.candleId)).toEqual(["C26"]);

  // One bar later the same crossing is a stale neckline touch, not the pattern completing.
  const outside = engine.detect(doubleBottomWithBreakoutAt(27)).filter((e) => e.eventCode === "DOUBLE_BOTTOM");
  expect(outside).toEqual([]);
});

test("ChartPatternEngine honours breakoutWindowMultiplier", () => {
  const candles = doubleBottomWithBreakoutAt(15);
  const tight = new ChartPatternEngine({ ...doubleConfiguration, breakoutWindowMultiplier: 1 });
  const loose = new ChartPatternEngine({ ...doubleConfiguration, breakoutWindowMultiplier: 2 });

  // 1 width (6) -> window closes at C14; 2 widths (12) -> C20.
  expect(tight.detect(candles).some((e) => e.eventCode === "DOUBLE_BOTTOM")).toBe(false);
  expect(loose.detect(candles).some((e) => e.eventCode === "DOUBLE_BOTTOM")).toBe(true);
});

const headAndShouldersConfiguration = {
  ...defaultChartPatternConfiguration,
  swingWindow: 2,
  minimumSwingAtr: 0.3,
  atrPeriod: 3,
};

/** C0..C16 of the H&S fixture: head 140 at C8, shoulders 120, neckline 100, right shoulder confirmed at C16. */
function headAndShouldersBase(): PatternCandle[] {
  return [
    makeCandle("C0", 100, 105, 98, 102, 0),
    makeCandle("C1", 102, 115, 100, 112, 1),
    makeCandle("C2", 112, 120, 110, 118, 2),
    makeCandle("C3", 118, 119, 106, 108, 3),
    makeCandle("C4", 108, 109, 102, 104, 4),
    makeCandle("C5", 104, 105, 100, 102, 5),
    makeCandle("C6", 102, 120, 101, 118, 6),
    makeCandle("C7", 118, 135, 116, 132, 7),
    makeCandle("C8", 132, 140, 130, 138, 8),
    makeCandle("C9", 138, 139, 120, 122, 9),
    makeCandle("C10", 122, 123, 108, 110, 10),
    makeCandle("C11", 110, 112, 100, 102, 11),
    makeCandle("C12", 102, 114, 101, 112, 12),
    makeCandle("C13", 112, 119, 110, 118, 13),
    makeCandle("C14", 118, 120, 116, 118, 14),
    makeCandle("C15", 118, 119, 108, 110, 15),
    makeCandle("C16", 110, 111, 101, 102, 16),
  ];
}

test("ChartPatternEngine invalidates head and shoulders when price makes a new high above the head first", () => {
  const engine = new ChartPatternEngine(headAndShouldersConfiguration);

  // Control: the plain breakdown on the next bar is detected.
  const control = [...headAndShouldersBase(), makeCandle("C17", 102, 103, 94, 95, 17)];
  expect(engine.detect(control).some((e) => e.eventCode === "HEAD_AND_SHOULDERS")).toBe(true);

  // Same breakdown close, but the bar first trades above the 140 head: the structure is void.
  const invalidated = [...headAndShouldersBase(), makeCandle("C17", 102, 145, 94, 95, 17)];
  expect(engine.detect(invalidated).filter((e) => e.eventCode === "HEAD_AND_SHOULDERS")).toEqual([]);
});

test("ChartPatternEngine invalidates inverse head and shoulders when price makes a new low below the head first", () => {
  const engine = new ChartPatternEngine(headAndShouldersConfiguration);
  // Mirror of the head-and-shoulders fixture: price -> 200 - price turns it into an inverse pattern.
  const mirror = (candles: PatternCandle[]): PatternCandle[] => candles.map((c) => ({
    ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close,
  }));

  const control = mirror([...headAndShouldersBase(), makeCandle("C17", 102, 103, 94, 95, 17)]);
  expect(engine.detect(control).some((e) => e.eventCode === "INVERSE_HEAD_AND_SHOULDERS")).toBe(true);

  const invalidated = mirror([...headAndShouldersBase(), makeCandle("C17", 102, 145, 94, 95, 17)]);
  expect(engine.detect(invalidated).filter((e) => e.eventCode === "INVERSE_HEAD_AND_SHOULDERS")).toEqual([]);
});

const triangleConfiguration = {
  ...defaultChartPatternConfiguration,
  triangleHorizontalToleranceAtr: 0.30,
  triangleMinTouches: 2,
  swingWindow: 2,
  minimumSwingAtr: 0.3,
  atrPeriod: 3,
};

/** C0..C16 of the ascending-triangle fixture: flat highs at 120, rising lows 80/95/105, last low confirmed at C16. */
function ascendingTriangleBase(): PatternCandle[] {
  return [
    makeCandle("C0", 95, 98, 92, 95, 0),
    makeCandle("C1", 95, 96, 88, 90, 1),
    makeCandle("C2", 90, 92, 80, 85, 2),
    makeCandle("C3", 85, 105, 84, 100, 3),
    makeCandle("C4", 100, 115, 98, 112, 4),
    makeCandle("C5", 112, 120, 110, 118, 5),
    makeCandle("C6", 118, 119, 108, 110, 6),
    makeCandle("C7", 110, 112, 98, 100, 7),
    makeCandle("C8", 100, 102, 95, 98, 8),
    makeCandle("C9", 98, 110, 97, 108, 9),
    makeCandle("C10", 108, 116, 107, 114, 10),
    makeCandle("C11", 114, 120, 112, 118, 11),
    makeCandle("C12", 118, 119, 110, 112, 12),
    makeCandle("C13", 112, 114, 106, 108, 13),
    makeCandle("C14", 108, 110, 105, 108, 14),
    makeCandle("C15", 108, 115, 107, 114, 15),
    makeCandle("C16", 114, 120, 113, 118, 16),
  ];
}

test("ChartPatternEngine invalidates an ascending triangle that breaks down before it breaks out", () => {
  const engine = new ChartPatternEngine(triangleConfiguration);

  // Control: straight breakout on C17.
  const control = [...ascendingTriangleBase(), makeCandle("C17", 118, 128, 117, 126, 17)];
  expect(engine.detect(control).some((e) => e.eventCode === "ASCENDING_TRIANGLE")).toBe(true);

  // A close at 102 (below the last higher low, 105) first, then the same breakout a bar later.
  const brokeDown = [
    ...ascendingTriangleBase(),
    makeCandle("C17", 118, 119, 100, 102, 17),
    makeCandle("C18", 102, 128, 101, 126, 18),
  ];
  expect(engine.detect(brokeDown).filter((e) => e.eventCode === "ASCENDING_TRIANGLE")).toEqual([]);
});

test("ChartPatternEngine invalidates a descending triangle that breaks out before it breaks down", () => {
  const engine = new ChartPatternEngine(triangleConfiguration);
  // Mirror of the ascending triangle (price -> 200 - price): flat lows, falling highs.
  const mirror = (candles: PatternCandle[]): PatternCandle[] => candles.map((c) => ({
    ...c, open: 200 - c.open, high: 200 - c.low, low: 200 - c.high, close: 200 - c.close,
  }));

  const control = mirror([...ascendingTriangleBase(), makeCandle("C17", 118, 128, 117, 126, 17)]);
  expect(engine.detect(control).some((e) => e.eventCode === "DESCENDING_TRIANGLE")).toBe(true);

  const brokeOut = mirror([
    ...ascendingTriangleBase(),
    makeCandle("C17", 118, 119, 100, 102, 17),
    makeCandle("C18", 102, 128, 101, 126, 18),
  ]);
  expect(engine.detect(brokeOut).filter((e) => e.eventCode === "DESCENDING_TRIANGLE")).toEqual([]);
});
