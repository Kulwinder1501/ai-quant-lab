import { describe, expect, it } from "vitest";
import { atrSeries } from "../../pattern-recognition/domain/atr-series.js";
import { IctAtrTracker } from "./ict/atr-tracker.js";
import { TechnicalIndicatorEngine } from "./technical-indicator-engine.js";
import type { IndicatorCandle, IndicatorDefinitionSpec } from "./technical-indicator.js";

const ATR14: IndicatorDefinitionSpec = {
  code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, outputSchema: { value: "number" },
};
const BOLLINGER: IndicatorDefinitionSpec = {
  code: "BOLLINGER_BANDS", algorithmVersion: "ta-v1", parameters: { period: 20, standardDeviations: 2 },
  outputSchema: { middle: "number" },
};
const FROZEN_PRICE = 23_398.1;
const BAR_MS = 15 * 60_000;

/** Live bars: a 30-point range around a drifting close. Flat bars: the frozen holiday print. */
function liveBar(index: number, price: number): IndicatorCandle {
  const close = price + (index % 2 === 0 ? 6 : -6);
  return {
    id: `c${index}`,
    openTime: new Date(Date.UTC(2026, 8, 1, 3, 45) + index * BAR_MS),
    open: price, high: Math.max(price, close) + 12, low: Math.min(price, close) - 12, close, volume: 1_000,
  };
}

function flatBar(index: number, volume = 0): IndicatorCandle {
  return {
    id: `c${index}`,
    openTime: new Date(Date.UTC(2026, 8, 1, 3, 45) + index * BAR_MS),
    open: FROZEN_PRICE, high: FROZEN_PRICE, low: FROZEN_PRICE, close: FROZEN_PRICE, volume,
  };
}

/**
 * 60 live bars ending at the frozen price, then `frozen` flat zero-volume bars (the holiday),
 * then 30 live bars again. `flatVolume` lets a control run make the frozen bars look traded.
 */
function seriesWithHoliday(frozen: number, flatVolume = 0): IndicatorCandle[] {
  const candles: IndicatorCandle[] = [];
  let index = 0;
  for (let i = 0; i < 59; i += 1) candles.push(liveBar(index++, FROZEN_PRICE));
  // Last live bar closes exactly on the frozen price, as the feed then freezes there.
  candles.push({ ...liveBar(index++, FROZEN_PRICE), open: FROZEN_PRICE, high: FROZEN_PRICE + 12, low: FROZEN_PRICE - 12, close: FROZEN_PRICE });
  for (let i = 0; i < frozen; i += 1) candles.push(flatBar(index++, flatVolume));
  for (let i = 0; i < 30; i += 1) candles.push(liveBar(index++, FROZEN_PRICE));
  return candles;
}

const engine = new TechnicalIndicatorEngine();
const atrById = (candles: IndicatorCandle[], spec = ATR14) =>
  new Map(engine.calculate(candles, spec).map((point) => [point.candleId, point.values.value as number]));

describe("frozen holiday bars (high == low, volume == 0) and ATR", () => {
  const frozen = 20;
  const candles = seriesWithHoliday(frozen);
  const flatIds = new Set(candles.filter((candle) => candle.high === candle.low).map((candle) => candle.id));

  it("does not let a frozen session collapse the ATR", () => {
    const atr = atrById(candles);
    const beforeHoliday = atr.get("c59")!;
    expect(beforeHoliday).toBeGreaterThan(20);

    const afterHoliday = candles.filter((candle) => !flatIds.has(candle.id) && candle.openTime > candles[59 + frozen]!.openTime);
    for (const candle of afterHoliday) {
      const value = atr.get(candle.id);
      // Skipped when the raw window is mostly flat; otherwise it must stay at real-bar scale.
      if (value !== undefined) expect(value).toBeGreaterThan(beforeHoliday * 0.7);
    }
    // And the later bars, once the lookback is live again, are present.
    expect(atr.get(candles[candles.length - 1]!.id)).toBeGreaterThan(beforeHoliday * 0.7);
  });

  it("control: the same series with traded-looking flat bars DOES collapse (the defect)", () => {
    const unfiltered = seriesWithHoliday(frozen, 1);
    const atr = atrById(unfiltered);
    const beforeHoliday = atr.get("c59")!;
    const lastFrozen = atr.get(`c${59 + frozen}`)!;
    // 20 zero-true-range bars decay Wilder(14) by (13/14)^20 = 0.23.
    expect(lastFrozen).toBeLessThan(beforeHoliday * 0.3);
  });

  it("writes no ATR snapshot for a flat bar", () => {
    const atr = atrById(candles);
    for (const id of flatIds) expect(atr.has(id)).toBe(false);
  });

  it("withholds snapshots whose trailing window is mostly flat, and resumes once it is live", () => {
    const atr = atrById(candles);
    // First live bars after the holiday: 14-bar raw window is 13 flat + 1 live .. down to 7 flat + 7 live.
    const firstAfter = 59 + frozen + 1;
    expect(atr.has(`c${firstAfter}`)).toBe(false);
    // 8 live bars into the new session the window is 6 flat / 14 -> 43% flat -> written.
    expect(atr.has(`c${firstAfter + 7}`)).toBe(true);
  });

  it("measures the first live bar after the freeze against the last LIVE close", () => {
    const withHoliday = atrById(candles);
    // Same live bars with the frozen block physically removed: the engine must agree on every
    // snapshot it does write, so the freeze leaves no trace in the numbers.
    const liveOnly = candles.filter((candle) => !flatIds.has(candle.id));
    const reference = atrById(liveOnly);
    for (const [id, value] of withHoliday) expect(value).toBeCloseTo(reference.get(id)!, 8);
  });

  it("is a no-op for a series with no flat bars", () => {
    const clean = seriesWithHoliday(0);
    const live = clean.slice(0, 60);
    expect(engine.calculate(live, ATR14)).toHaveLength(60 - 13);
  });

  it("excludes flat bars from Bollinger inputs too (no zero-variance window)", () => {
    const points = engine.calculate(candles, BOLLINGER);
    const byId = new Map(points.map((point) => [point.candleId, point.values]));
    for (const id of flatIds) expect(byId.has(id)).toBe(false);
    // A 20-bar window of one frozen price would have standardDeviation 0.
    for (const values of byId.values()) expect(values.standardDeviation as number).toBeGreaterThan(0);
  });

  it("leaves atrSeries identical to the legacy full-series Wilder ATR when no bar is flat", () => {
    const live = candles.filter((candle) => !flatIds.has(candle.id));
    const legacy: (number | null)[] = Array(live.length).fill(null);
    const ranges = live.map((candle, index) => index === 0
      ? candle.high - candle.low
      : Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - live[index - 1]!.close),
        Math.abs(candle.low - live[index - 1]!.close),
      ));
    let average = ranges.slice(0, 14).reduce((sum, value) => sum + value, 0) / 14;
    legacy[13] = average;
    for (let index = 14; index < ranges.length; index += 1) {
      average = ((average * 13) + ranges[index]!) / 14;
      legacy[index] = average;
    }

    const current = atrSeries(live, 14);
    for (let index = 0; index < live.length; index += 1) {
      if (legacy[index] === null) expect(current[index]).toBeNull();
      else expect(current[index]).toBeCloseTo(legacy[index]!, 10);
    }
  });

  it("keeps ATR at real-bar scale in the pattern-recognition ATR and the incremental ICT tracker", () => {
    const patternCandles = candles.map((candle) => ({ ...candle }));
    const series = atrSeries(patternCandles, 14);
    const tracker = new IctAtrTracker(14);
    const incremental = patternCandles.map((candle) => tracker.processCandle(candle));
    const engineAtr = atrById(candles);

    for (let index = 0; index < candles.length; index += 1) {
      const id = candles[index]!.id;
      if (flatIds.has(id)) {
        // Flat bars repeat the last live ATR rather than moving it.
        expect(series[index]).toBe(series[index - 1]);
        expect(incremental[index]).toBe(incremental[index - 1]);
      } else if (engineAtr.has(id)) {
        expect(series[index]).toBeCloseTo(engineAtr.get(id)!, 6);
        expect(incremental[index]).toBeCloseTo(engineAtr.get(id)!, 6);
      }
    }
    expect(series[59 + frozen]).toBeGreaterThan(20);
  });
});
