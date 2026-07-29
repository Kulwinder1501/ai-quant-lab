import { describe, expect, it } from "vitest";
import { PriceActionEngine, type PriceActionConfiguration } from "./price-action-engine.js";
import type { DetectedPriceActionEvent, PatternCandle } from "./market-pattern.js";

const testConfiguration: PriceActionConfiguration = {
  swingWindow: 2,
  levelLookback: 10,
  breakoutLookback: 3,
  trendLookback: 3,
  pullbackLookback: 3,
  thresholdMode: "PERCENT",
  atrPeriod: 14,
  breakoutBufferUnits: 0.1,
  trendThresholdUnits: 1,
  pullbackUnits: 2,
  levelToleranceUnits: 0.3,
};

function candle(id: string, close: number, high = close + 1, low = close - 1, open = close - 0.25): PatternCandle {
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

function eventFor(events: readonly DetectedPriceActionEvent[], eventCode: DetectedPriceActionEvent["eventCode"], candleId: string): DetectedPriceActionEvent {
  const detected = events.find((candidate) => candidate.eventCode === eventCode && candidate.candleId === candleId);
  expect(detected).toBeDefined();
  return detected!;
}

describe("PriceActionEngine", () => {
  it("emits trend changes once and detects crossed breakout and breakdown levels", () => {
    const engine = new PriceActionEngine(testConfiguration);
    const breakoutEvents = engine.detect([
      candle("1", 100, 101, 99),
      candle("2", 100, 101, 99),
      candle("3", 100, 101, 99),
      candle("4", 100, 101, 99),
      candle("5", 103, 104, 99),
      candle("6", 104, 105, 102),
    ]);

    expect(breakoutEvents.filter((candidate) => candidate.eventCode === "UPTREND")).toHaveLength(1);
    expect(eventFor(breakoutEvents, "UPTREND", "5")).toMatchObject({ direction: "BULLISH", level: null });
    expect(eventFor(breakoutEvents, "BREAKOUT", "5")).toMatchObject({
      direction: "BULLISH",
      level: 101,
      details: { lookback: 3, close: 103 },
    });

    const breakdownEvents = engine.detect([
      candle("1", 100, 101, 99),
      candle("2", 100, 101, 99),
      candle("3", 100, 101, 99),
      candle("4", 100, 101, 99),
      candle("5", 97, 101, 96),
    ]);
    expect(eventFor(breakdownEvents, "DOWNTREND", "5")).toMatchObject({ direction: "BEARISH", level: null });
    const breakdown = eventFor(breakdownEvents, "BREAKDOWN", "5");
    expect(breakdown).toMatchObject({ direction: "BEARISH", level: 99, details: { lookback: 3, close: 97 } });
    expect(breakdown.confidence).toBeGreaterThanOrEqual(0.65);
    expect(breakdown.confidence).toBeLessThanOrEqual(1);
  });

  it("reports one breakout for a single sustained advance instead of one per candle", () => {
    const engine = new PriceActionEngine(testConfiguration);
    const events = engine.detect([
      candle("1", 100, 101, 99),
      candle("2", 100, 101, 99),
      candle("3", 100, 101, 99),
      candle("4", 100, 101, 99),
      candle("5", 103, 104, 99),
      candle("6", 106, 107, 102),
      candle("7", 109, 110, 105),
    ]);

    const breakouts = events.filter((candidate) => candidate.eventCode === "BREAKOUT");
    expect(breakouts).toHaveLength(1);
    expect(breakouts[0]).toMatchObject({ candleId: "5", level: 101 });
  });

  it("scores a range on flatness so a near-threshold drift ranks below a still market", () => {
    const engine = new PriceActionEngine(testConfiguration);
    const flat = eventFor(engine.detect([candle("1", 100), candle("2", 100), candle("3", 100), candle("4", 100)]), "RANGE", "4");
    const drifting = eventFor(engine.detect([candle("1", 100), candle("2", 100), candle("3", 100), candle("4", 100.9)]), "RANGE", "4");

    expect(flat.confidence).toBeCloseTo(0.9);
    expect(drifting.confidence).toBeLessThan(flat.confidence);
    expect(drifting.confidence).toBeGreaterThanOrEqual(0.55);
  });

  it("counts a consolidation against a level as a single touch", () => {
    const engine = new PriceActionEngine(testConfiguration);
    const events = engine.detect([
      candle("1", 108, 110, 106),
      candle("2", 108, 110, 106),
      candle("3", 108, 110, 106),
      candle("4", 103, 105, 101),
      candle("5", 104, 106, 102),
      candle("6", 108, 110, 106),
      candle("7", 103, 105, 101),
      candle("8", 102, 104, 100),
    ]);

    const swingHigh = eventFor(events, "SWING_HIGH", "8");
    expect(swingHigh).toMatchObject({ level: 110, details: { pivotCandleId: "6", touches: 2 } });
    expect(swingHigh.confidence).toBeCloseTo(0.66);
  });

  it("identifies a pullback only while the broader trend remains intact", () => {
    const engine = new PriceActionEngine(testConfiguration);
    const events = engine.detect([
      candle("1", 98, 99, 97),
      candle("2", 99, 100, 98),
      candle("3", 100, 101, 99),
      candle("4", 105, 106, 104),
      candle("5", 110, 111, 109),
      candle("6", 105, 106, 104),
    ]);

    expect(eventFor(events, "PULLBACK", "6")).toMatchObject({
      direction: "BULLISH",
      level: 111,
      details: { trend: "UPTREND", recentHigh: 111 },
    });
  });

  it("sees an intraday-scale trend in ATR mode that percentage thresholds miss entirely", () => {
    // A 30-point advance on NIFTY is nothing against a 1% threshold (220 points) but
    // is three ATRs on a minute chart. This is the whole reason the mode exists.
    const minuteScaleAdvance = [
      candle("1", 22000, 22002, 21998),
      candle("2", 22010, 22012, 22008),
      candle("3", 22020, 22022, 22018),
      candle("4", 22030, 22032, 22028),
    ];

    const percentEvents = new PriceActionEngine(testConfiguration).detect(minuteScaleAdvance);
    expect(eventFor(percentEvents, "RANGE", "4")).toMatchObject({ direction: "NEUTRAL" });
    expect(percentEvents.filter((candidate) => candidate.eventCode === "UPTREND")).toHaveLength(0);

    const atrEvents = new PriceActionEngine({ ...testConfiguration, thresholdMode: "ATR", atrPeriod: 3 })
      .detect(minuteScaleAdvance);
    expect(eventFor(atrEvents, "UPTREND", "4")).toMatchObject({
      direction: "BULLISH",
      details: { thresholdMode: "ATR", change: 30 },
    });
  });

  it("stays silent in ATR mode until the ATR warm-up window has filled", () => {
    const configuration = { ...testConfiguration, thresholdMode: "ATR" as const, atrPeriod: 5 };
    const candles = [
      candle("1", 22000, 22002, 21998),
      candle("2", 22010, 22012, 22008),
      candle("3", 22020, 22022, 22018),
      candle("4", 22030, 22032, 22028),
      candle("5", 22040, 22042, 22038),
      candle("6", 22050, 22052, 22048),
    ];

    const events = new PriceActionEngine(configuration).detect(candles);

    // The trend lookback is satisfied at candle 4, but ATR(5) is not, so nothing fires
    // until candle 5. Guessing a scale during warm-up would invent the threshold.
    expect(events.filter((candidate) => candidate.candleId === "4")).toEqual([]);
    expect(eventFor(events, "UPTREND", "5")).toMatchObject({ direction: "BULLISH" });
  });

  it("agrees with percentage thresholds when one ATR happens to be one percent of price", () => {
    // Constant 1.0 true range against a price of 100 makes ATR exactly one percent,
    // which is roughly where daily NIFTY sits. The two modes should then classify the
    // same series identically, so switching modes is a comparison and not a new rule.
    const configuration = { ...testConfiguration, atrPeriod: 3 };
    const dailyScale = [
      candle("1", 100, 100.5, 99.5),
      candle("2", 100, 100.5, 99.5),
      candle("3", 100, 100.5, 99.5),
      candle("4", 100.5, 101, 100),
      candle("5", 100.2, 100.7, 99.7),
    ];

    const percentTrends = new PriceActionEngine(configuration).detect(dailyScale)
      .filter((candidate) => ["UPTREND", "DOWNTREND", "RANGE"].includes(candidate.eventCode))
      .map((candidate) => `${candidate.candleId}:${candidate.eventCode}`);
    const atrTrends = new PriceActionEngine({ ...configuration, thresholdMode: "ATR" }).detect(dailyScale)
      .filter((candidate) => ["UPTREND", "DOWNTREND", "RANGE"].includes(candidate.eventCode))
      .map((candidate) => `${candidate.candleId}:${candidate.eventCode}`);

    expect(atrTrends).toEqual(percentTrends);
  });

  it("waits for closed confirmation candles before emitting swing levels", () => {
    const engine = new PriceActionEngine({
      ...testConfiguration,
      trendLookback: 10,
      breakoutLookback: 10,
      pullbackLookback: 10,
    });
    const candidate = [
      candle("1", 8, 10, 5),
      candle("2", 9, 11, 6),
      candle("3", 10, 15, 7),
      candle("4", 9, 11, 6),
    ];

    expect(engine.detect(candidate).filter((detected) => detected.eventCode === "SWING_HIGH")).toHaveLength(0);

    const confirmedEvents = engine.detect([...candidate, candle("5", 8, 10, 5)]);
    const swingHigh = eventFor(confirmedEvents, "SWING_HIGH", "5");
    const resistance = eventFor(confirmedEvents, "RESISTANCE", "5");
    expect(swingHigh).toMatchObject({
      direction: "BEARISH",
      level: 15,
      details: { pivotCandleId: "3", confirmationCandleId: "5", touches: 1, swingWindow: 2 },
    });
    expect(resistance).toMatchObject({ direction: "BEARISH", level: 15, details: swingHigh.details });

    const swingLowEvents = engine.detect([
      candle("1", 12, 15, 10),
      candle("2", 11, 14, 9),
      candle("3", 8, 13, 5),
      candle("4", 11, 14, 9),
      candle("5", 12, 15, 10),
    ]);
    const swingLow = eventFor(swingLowEvents, "SWING_LOW", "5");
    expect(swingLow).toMatchObject({
      direction: "BULLISH",
      level: 5,
      details: { pivotCandleId: "3", confirmationCandleId: "5", touches: 1, swingWindow: 2 },
    });
    expect(eventFor(swingLowEvents, "SUPPORT", "5")).toMatchObject({ direction: "BULLISH", level: 5 });
  });
});
