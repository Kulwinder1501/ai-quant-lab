import { describe, expect, it } from "vitest";
import { TechnicalIndicatorEngine } from "./technical-indicator-engine.js";
import type { IndicatorCandle, IndicatorDefinitionSpec } from "./technical-indicator.js";

function candles(count: number, start = new Date("2026-07-24T03:45:00Z")): IndicatorCandle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = index + 1;
    return {
      id: String(index + 1),
      openTime: new Date(start.getTime() + index * 60_000),
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume: 10,
    };
  });
}

function definition(code: IndicatorDefinitionSpec["code"], parameters: IndicatorDefinitionSpec["parameters"]): IndicatorDefinitionSpec {
  return { code, algorithmVersion: "test", parameters, outputSchema: {} };
}

describe("TechnicalIndicatorEngine", () => {
  const engine = new TechnicalIndicatorEngine();

  it("uses explicit warm-up periods for moving averages, RSI, and ATR", () => {
    const series = candles(8);
    const sma = engine.calculate(series, definition("SMA", { period: 3 }));
    const ema = engine.calculate(series, definition("EMA", { period: 3 }));
    const rsi = engine.calculate(series, definition("RSI", { period: 3 }));
    const atr = engine.calculate(series, definition("ATR", { period: 3 }));

    expect(sma).toHaveLength(6);
    expect(sma[0]).toMatchObject({ candleId: "3", values: { value: 2 } });
    expect(ema[0]).toMatchObject({ candleId: "3", values: { value: 2 } });
    expect(ema[1]).toMatchObject({ candleId: "4", values: { value: 3 } });
    expect(rsi[0]).toMatchObject({ candleId: "4", values: { value: 100 } });
    expect(atr[0]).toMatchObject({ candleId: "3", values: { value: 2 } });
  });

  it("computes VWAP per NSE session and population-standard-deviation Bollinger Bands", () => {
    const series = candles(3);
    const vwap = engine.calculate(series, definition("VWAP", { reset: "NSE_SESSION" }));
    const bands = engine.calculate(series, definition("BOLLINGER_BANDS", { period: 3, standardDeviations: 2 }));

    expect(vwap[2]).toMatchObject({ candleId: "3", values: { value: 2 } });
    expect(bands[0]).toMatchObject({
      candleId: "3",
      values: { middle: 2, upper: 3.63299316, lower: 0.36700684, standardDeviation: 0.81649658 },
    });
  });

  it("delays MACD signal output and produces Supertrend only after ATR is ready", () => {
    const series = candles(40);
    const macd = engine.calculate(series, definition("MACD", { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }));
    const supertrend = engine.calculate(series, definition("SUPERTREND", { atrPeriod: 10, multiplier: 3 }));

    expect(macd[0]).toMatchObject({ candleId: "26", values: { signal: null, histogram: null } });
    expect(macd[8].values.signal).not.toBeNull();
    expect(supertrend[0]).toMatchObject({ candleId: "10", values: { trend: "DOWN" } });
    expect(supertrend).toHaveLength(31);
  });
});
