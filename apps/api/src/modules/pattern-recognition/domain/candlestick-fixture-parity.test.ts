import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CandlestickPatternEngine } from "./candlestick-pattern-engine.js";
import type {
  CandlestickPatternCode,
  PatternCandle,
  PatternDirection,
} from "./market-pattern.js";

interface FixtureCandle {
  id: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PatternFixture {
  name: string;
  candles: FixtureCandle[];
  targetCandleId: string;
  expectedPattern: CandlestickPatternCode;
  expectedDirection: PatternDirection;
}

function toPatternCandle(raw: FixtureCandle): PatternCandle {
  return {
    id: raw.id,
    openTime: new Date(`2026-07-24T03:${String(Number(raw.id) - 1).padStart(2, "0")}:00.000Z`),
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: 1000,
  };
}

describe("Candlestick Pattern Canonical Fixtures", () => {
  const engine = new CandlestickPatternEngine();
  const fixturePath = resolve(process.cwd(), "../ml/tests/fixtures/candlestick_fixtures.json");
  const rawFixtures: PatternFixture[] = JSON.parse(readFileSync(fixturePath, "utf8"));

  for (const fixture of rawFixtures) {
    it(`correctly detects canonical fixture: ${fixture.name}`, () => {
      const candles = fixture.candles.map(toPatternCandle);
      const detections = engine.detect(candles);
      const matched = detections.find(
        (d) => d.candleId === fixture.targetCandleId && d.patternCode === fixture.expectedPattern,
      );

      expect(matched, `Expected detection of ${fixture.expectedPattern} on candle ${fixture.targetCandleId}`).toBeDefined();
      expect(matched?.direction).toBe(fixture.expectedDirection);
      expect(matched?.confidence).toBeGreaterThan(0.5);
    });
  }
});
