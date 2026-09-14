import { test, expect } from "vitest";
import { ZigZagEngine } from "./zigzag-engine.js";
import type { PatternCandle } from "./market-pattern.js";

function makeCandle(id: string, high: number, low: number, timeIndex = 0): PatternCandle {
  return {
    id,
    openTime: new Date(1700000000000 + timeIndex * 60000),
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1000,
  };
}

test("ZigZagEngine correctly alternates and classifies HH/HL/LH/LL", () => {
  const engine = new ZigZagEngine({
    swingWindow: 2,
    minimumSwingAtr: 0.5,
    atrPeriod: 3,
    tickSize: 0.05,
  });

  // Construct a clear wave:
  // C0: 100/95
  // C1: 95/90
  // C2: 90/85 (trough at C2: low 80)
  // C3: 95/88
  // C4: 105/98
  // C5: 115/108 (peak at C5: high 120)
  // C6: 108/100
  // C7: 100/92
  // C8: 94/86 (higher low at C8: low 85)
  // C9: 105/95
  // C10: 120/110
  // C11: 132/122 (higher high at C11: high 135)
  // C12: 125/115
  // C13: 120/110
  const candles: PatternCandle[] = [
    makeCandle("C0", 102, 95, 0),
    makeCandle("C1", 96, 90, 1),
    makeCandle("C2", 92, 80, 2), // LOW (80)
    makeCandle("C3", 95, 88, 3),
    makeCandle("C4", 108, 98, 4),
    makeCandle("C5", 120, 110, 5), // HIGH (120)
    makeCandle("C6", 112, 102, 6),
    makeCandle("C7", 100, 92, 7),
    makeCandle("C8", 94, 85, 8), // HL (85)
    makeCandle("C9", 105, 95, 9),
    makeCandle("C10", 120, 110, 10),
    makeCandle("C11", 135, 125, 11), // HH (135)
    makeCandle("C12", 128, 118, 12),
    makeCandle("C13", 122, 112, 13),
  ];

  const segments = engine.detectSegments(candles);

  expect(segments.length).toBe(3);
  
  // Segment 0: C2(LOW: 80) -> C5(HIGH: 120)
  expect(segments[0].fromPivot.candleId).toBe("C2");
  expect(segments[0].fromPivot.type).toBe("LOW");
  expect(segments[0].fromPivot.price).toBe(80);
  expect(segments[0].fromPivot.structure).toBe(null);

  expect(segments[0].toPivot.candleId).toBe("C5");
  expect(segments[0].toPivot.type).toBe("HIGH");
  expect(segments[0].toPivot.price).toBe(120);
  expect(segments[0].toPivot.structure).toBe(null);
  expect(segments[0].direction).toBe("UP");

  // Segment 1: C5(HIGH: 120) -> C8(LOW: 85)
  expect(segments[1].fromPivot.candleId).toBe("C5");
  expect(segments[1].toPivot.candleId).toBe("C8");
  expect(segments[1].toPivot.type).toBe("LOW");
  expect(segments[1].toPivot.price).toBe(85);
  expect(segments[1].toPivot.structure).toBe("HL");
  expect(segments[1].direction).toBe("DOWN");

  // Segment 2: C8(LOW: 85) -> C11(HIGH: 135)
  expect(segments[2].fromPivot.candleId).toBe("C8");
  expect(segments[2].toPivot.candleId).toBe("C11");
  expect(segments[2].toPivot.type).toBe("HIGH");
  expect(segments[2].toPivot.price).toBe(135);
  expect(segments[2].toPivot.structure).toBe("HH");
  expect(segments[2].direction).toBe("UP");
});

test("ZigZagEngine consecutive same-type rule: keep higher HIGH and lower LOW", () => {
  const engine = new ZigZagEngine({
    swingWindow: 2,
    minimumSwingAtr: 0.5,
    atrPeriod: 3,
    tickSize: 0.05,
  });

  // C2: LOW (80)
  // C5: HIGH1 (115)
  // C8: HIGH2 (125) -> should replace HIGH1
  // C11: LOW2 (85)
  const candles: PatternCandle[] = [
    makeCandle("C0", 102, 95, 0),
    makeCandle("C1", 96, 90, 1),
    makeCandle("C2", 92, 80, 2), // LOW (80)
    makeCandle("C3", 95, 88, 3),
    makeCandle("C4", 108, 98, 4),
    makeCandle("C5", 115, 105, 5), // HIGH 1 (115)
    makeCandle("C6", 110, 102, 6),
    makeCandle("C7", 118, 108, 7),
    makeCandle("C8", 125, 115, 8), // HIGH 2 (125)
    makeCandle("C9", 115, 105, 9),
    makeCandle("C10", 100, 92, 10),
    makeCandle("C11", 90, 85, 11), // LOW 2 (85)
    makeCandle("C12", 95, 88, 12),
    makeCandle("C13", 100, 92, 13),
  ];

  const segments = engine.detectSegments(candles);
  
  // Should only be LOW(80) -> HIGH2(125) -> LOW2(85)
  expect(segments.length).toBe(2);
  expect(segments[0].toPivot.candleId).toBe("C8");
  expect(segments[0].toPivot.price).toBe(125);
  expect(segments[1].toPivot.candleId).toBe("C11");
  expect(segments[1].toPivot.price).toBe(85);
});

test("ZigZagEngine equality rule: newer equal pivot replaces older pivot entirely", () => {
  const engine = new ZigZagEngine({
    swingWindow: 2,
    minimumSwingAtr: 0.5,
    atrPeriod: 3,
    tickSize: 0.05,
  });

  // C2: LOW (80)
  // C5: HIGH1 (120)
  // C8: HIGH2 (120) -> equal high within tickSize, replaces C5
  // C11: LOW2 (85)
  const candles: PatternCandle[] = [
    makeCandle("C0", 102, 95, 0),
    makeCandle("C1", 96, 90, 1),
    makeCandle("C2", 92, 80, 2), // LOW (80)
    makeCandle("C3", 95, 88, 3),
    makeCandle("C4", 108, 98, 4),
    makeCandle("C5", 120, 105, 5), // HIGH 1 (120)
    makeCandle("C6", 112, 102, 6),
    makeCandle("C7", 115, 105, 7),
    makeCandle("C8", 120, 108, 8), // HIGH 2 (120 - equal)
    makeCandle("C9", 112, 102, 9),
    makeCandle("C10", 100, 92, 10),
    makeCandle("C11", 92, 85, 11), // LOW 2 (85)
    makeCandle("C12", 96, 88, 12),
    makeCandle("C13", 100, 92, 13),
  ];

  const segments = engine.detectSegments(candles);
  
  expect(segments.length).toBe(2);
  const equalHighPivot = segments[0].toPivot;
  
  // The newer pivot (C8) should have completely replaced the older one (C5)
  expect(equalHighPivot.candleId).toBe("C8");
  expect(equalHighPivot.index).toBe(8);
  expect(equalHighPivot.confirmationCandleId).toBe("C10"); // index 8 + swingWindow 2 = 10
});
