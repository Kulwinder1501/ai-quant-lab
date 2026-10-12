import { describe, expect, it } from "vitest";
import {
  MINIMUM_BASELINE_SPAN_DAYS,
  baselineSpanDays,
  resolveValidatorIvPercentile,
  type TenorImpliedVolatilityObservation,
  type TenorIvPercentileResult,
} from "./iv-percentile-by-tenor.js";

const AS_OF = new Date("2026-10-12T08:30:00Z");

function isoDay(offsetFromStart: number, start = "2025-06-02"): string {
  return new Date(new Date(`${start}T00:00:00Z`).getTime() + offsetFromStart * 86_400_000).toISOString().slice(0, 10);
}

/** Chain history that starts `spanDays` before AS_OF -- one reading per day. */
function chainHistory(spanDays: number): TenorImpliedVolatilityObservation[] {
  const startMs = AS_OF.getTime() - spanDays * 86_400_000;
  return Array.from({ length: Math.min(spanDays, 40) }, (_, index) => ({
    date: new Date(startMs + index * 86_400_000).toISOString().slice(0, 10),
    impliedVolatility: 0.1 + index * 0.001,
    daysToExpiry: 12,
  }));
}

const measurable = (percentile: number): TenorIvPercentileResult => ({
  measurable: true,
  percentile,
  bucket: "DTE_8_PLUS",
  currentImpliedVolatility: 0.14,
  observedDays: 30,
  lowestImpliedVolatility: 0.1,
  highestImpliedVolatility: 0.14,
});

const unmeasurable: TenorIvPercentileResult = {
  measurable: false,
  reason: "INSUFFICIENT_BUCKET_HISTORY",
  explanation: "bucket too thin",
  bucket: "DTE_8_PLUS",
  observedDays: 3,
  requiredDays: 20,
};

/** 300 sessions of VIX closes spread evenly across 11..23, so 15.35 sits about a third of the way up. */
function vixCloses(count = 300): Array<{ date: string; close: number }> {
  return Array.from({ length: count }, (_, index) => ({ date: isoDay(index), close: 11 + (12 * index) / (count - 1) }));
}

describe("baselineSpanDays", () => {
  it("counts calendar days from the oldest history date", () => {
    const history = [
      { date: "2026-08-04", impliedVolatility: 0.12, daysToExpiry: 12 },
      { date: "2026-09-10", impliedVolatility: 0.13, daysToExpiry: 12 },
    ];
    expect(baselineSpanDays(history, AS_OF)).toBe(69);
  });

  it("is zero without history", () => {
    expect(baselineSpanDays([], AS_OF)).toBe(0);
  });
});

describe("resolveValidatorIvPercentile", () => {
  it("regression 2026-10-12: a 69-day chain window calling 100% is replaced by India VIX's longer baseline", () => {
    const closes = vixCloses();
    const result = resolveValidatorIvPercentile({
      tenor: measurable(100), // what the chain said: the highest of two months
      history: chainHistory(69),
      asOf: AS_OF,
      vix: { current: 15.35, dailyCloses: closes },
    });

    expect(result.source).toBe("INDIA_VIX_FALLBACK");
    const expected = (100 * closes.filter((entry) => entry.close < 15.35).length) / closes.length;
    expect(result.percentile).toBeCloseTo(expected, 5);
    // The point of the change: well under the 85% ceiling that blocked every index entry.
    expect(result.percentile!).toBeLessThan(85);
    expect(result.note).toMatch(/69 day/);
  });

  it("still blocks on India VIX when volatility really is extreme against the longer baseline", () => {
    const result = resolveValidatorIvPercentile({
      tenor: measurable(100), history: chainHistory(69), asOf: AS_OF,
      vix: { current: 22.5, dailyCloses: vixCloses() },
    });
    expect(result.source).toBe("INDIA_VIX_FALLBACK");
    expect(result.percentile!).toBeGreaterThanOrEqual(85);
  });

  it("trusts the chain percentile once its history spans the minimum", () => {
    const result = resolveValidatorIvPercentile({
      tenor: measurable(91), history: chainHistory(MINIMUM_BASELINE_SPAN_DAYS), asOf: AS_OF,
      vix: { current: 15.35, dailyCloses: vixCloses() },
    });
    expect(result).toMatchObject({ source: "TENOR_MATCHED_CHAIN", percentile: 91, note: null });
  });

  it("falls back to India VIX when the chain bucket is not measurable at all", () => {
    const result = resolveValidatorIvPercentile({
      tenor: unmeasurable, history: chainHistory(200), asOf: AS_OF,
      vix: { current: 15.35, dailyCloses: vixCloses() },
    });
    expect(result.source).toBe("INDIA_VIX_FALLBACK");
    expect(result.note).toBe("bucket too thin");
  });

  it("is unavailable, not a pass or a block, when the fallback has no fresh reading", () => {
    const result = resolveValidatorIvPercentile({
      tenor: measurable(100), history: chainHistory(69), asOf: AS_OF,
      vix: { current: null, dailyCloses: vixCloses() },
    });
    expect(result).toMatchObject({ source: "UNAVAILABLE", percentile: null });
  });

  it("is unavailable when India VIX history is itself shorter than the minimum", () => {
    const result = resolveValidatorIvPercentile({
      tenor: measurable(100), history: chainHistory(69), asOf: AS_OF,
      vix: { current: 15.35, dailyCloses: vixCloses(50) },
    });
    expect(result).toMatchObject({ source: "UNAVAILABLE", percentile: null });
  });

  it("is unavailable when there is no VIX baseline to read", () => {
    const result = resolveValidatorIvPercentile({ tenor: measurable(100), history: chainHistory(69), asOf: AS_OF, vix: null });
    expect(result).toMatchObject({ source: "UNAVAILABLE", percentile: null });
  });
});
