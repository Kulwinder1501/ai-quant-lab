import { describe, expect, it } from "vitest";
import type { SessionCandle } from "../domain/session-calendar.js";
import { generateDirectionalDataset as realGenerate } from "./generate-directional-dataset.js";
import {
  assertNoFutureInjection,
  detectFutureInjection,
  SENTINEL_COMPARED_FEATURES,
} from "./future-injection-sentinel.js";

function sessionCandles(sessionDate: string, count = 375): SessionCandle[] {
  const startMs = new Date(`${sessionDate}T09:15:00+05:30`).getTime();
  const candles: SessionCandle[] = [];
  let price = 100;
  for (let index = 0; index < count; index += 1) {
    const openTime = new Date(startMs + index * 60_000);
    const close = price + price * (0.0001 + Math.sin(index / 10) * 0.0005);
    candles.push({
      openTime,
      closeTime: new Date(openTime.getTime() + 60_000),
      open: price,
      high: Math.max(price, close) + 0.05,
      low: Math.min(price, close) - 0.05,
      close,
      volume: 1000 + Math.floor(Math.sin(index / 5) * 200),
    });
    price = close;
  }
  return candles;
}

const candles = [...sessionCandles("2026-01-02"), ...sessionCandles("2026-01-05")];
/** Mid-way through the second session, so both sessions contribute protected samples. */
const cutAt = new Date("2026-01-05T12:00:00+05:30");

describe("future-injection sentinel", () => {
  it("finds no leakage in the frozen dataset generator", () => {
    const report = detectFutureInjection({ instrument: "NIFTYBEES", candles, cutAt });

    expect(report.leaked).toBe(false);
    expect(report.findings).toEqual([]);
    expect(report.protectedSampleCount).toBeGreaterThan(0);
    expect(report.corruptedCandleCount).toBeGreaterThan(0);
  });

  it("compares features only, so label movement is not mistaken for leakage", () => {
    // Labels are *defined* by future bars: forwardPath, adaptive30, tb60 all move when the future
    // is corrupted, and must. A whole-sample comparison would fire on every row and detect nothing.
    expect([...SENTINEL_COMPARED_FEATURES]).toEqual([
      "minuteOfDay",
      "timeToSessionCloseMinutes",
      "referencePrice",
      "volatility",
    ]);

    const baseline = detectFutureInjection({ instrument: "NIFTYBEES", candles, cutAt });
    expect(baseline.leaked).toBe(false);
  });

  it("fires on a generator that reads past dataThrough", () => {
    // The sentinel must be shown to fail, or a clean report proves nothing. This generator leaks
    // deliberately: it sets every sample's referencePrice from the *last* bar in the series, which
    // is precisely the mistake -- a pre-cut decision reading a post-cut price.
    const leakyGenerate = ((instrument, seriesCandles, options) => {
      const honest = realGenerate(instrument, seriesCandles, options);
      const lastClose = seriesCandles[seriesCandles.length - 1]!.close;
      return {
        ...honest,
        samples: honest.samples.map((sample) => ({ ...sample, referencePrice: lastClose })),
      };
    }) as typeof realGenerate;

    const report = detectFutureInjection({
      instrument: "NIFTYBEES", candles, cutAt, generate: leakyGenerate,
    });

    expect(report.leaked).toBe(true);
    expect(report.findings.every((finding) => finding.field === "referencePrice")).toBe(true);
    expect(report.findings.length).toBe(report.protectedSampleCount);
  });

  it("raises FUTURE_INJECTION_DETECTED as a gate, naming the offending field", () => {
    const leakyGenerate = ((instrument, seriesCandles, options) => {
      const honest = realGenerate(instrument, seriesCandles, options);
      const lastClose = seriesCandles[seriesCandles.length - 1]!.close;
      return {
        ...honest,
        samples: honest.samples.map((sample) => ({ ...sample, referencePrice: lastClose })),
      };
    }) as typeof realGenerate;

    expect(() => assertNoFutureInjection({
      instrument: "NIFTYBEES", candles, cutAt, generate: leakyGenerate,
    })).toThrow(/FUTURE_INJECTION_DETECTED.*referencePrice/s);
  });

  it("treats a pre-cut sample vanishing as leakage in its own right", () => {
    // Whether a decision point exists cannot depend on what happened after it.
    const droppingGenerate = ((instrument, seriesCandles, options) => {
      const honest = realGenerate(instrument, seriesCandles, options);
      const corrupted = seriesCandles.some((candle) => candle.close > 400);
      return corrupted ? { ...honest, samples: honest.samples.slice(1) } : honest;
    }) as typeof realGenerate;

    const report = detectFutureInjection({
      instrument: "NIFTYBEES", candles, cutAt, generate: droppingGenerate,
    });

    expect(report.leaked).toBe(true);
    expect(report.findings.some((finding) => finding.field === "(sample missing)")).toBe(true);
  });

  it("refuses a cut that corrupts nothing, rather than passing vacuously", () => {
    const afterEverything = new Date("2027-01-01T00:00:00+05:30");

    expect(() => detectFutureInjection({ instrument: "NIFTYBEES", candles, cutAt: afterEverything }))
      .toThrow(/corrupted no candles/);
  });

  it("refuses a cut that protects nothing, rather than passing vacuously", () => {
    // Before the first bar every sample is post-cut, so nothing is being checked. A gate that
    // silently passes on an empty protected set is how leakage detection quietly stops working.
    const beforeEverything = new Date("2026-01-02T09:15:00+05:30");

    expect(() => assertNoFutureInjection({ instrument: "NIFTYBEES", candles, cutAt: beforeEverything }))
      .toThrow(/protected no samples/);
  });

  it("refuses an invalid cut timestamp", () => {
    expect(() => detectFutureInjection({ instrument: "NIFTYBEES", candles, cutAt: new Date(Number.NaN) }))
      .toThrow(/valid cut timestamp/);
  });

  it("passes as a gate on the real generator and returns its report", () => {
    const report = assertNoFutureInjection({ instrument: "NIFTYBEES", candles, cutAt });

    expect(report.leaked).toBe(false);
    expect(report.cutAt).toEqual(cutAt);
  });
});
