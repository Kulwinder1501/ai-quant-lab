import { describe, expect, it } from "vitest";
import {
  DATA_READINESS_THRESHOLDS,
  assessSeries,
  canonicalJsonForReportHash,
  longestSessionGapWeekdays,
  modalValue,
  weekdaysBetween,
  type SeriesMeasurements,
} from "./data-readiness.js";

function measurements(overrides: Partial<SeriesMeasurements> = {}): SeriesMeasurements {
  return {
    symbol: "NIFTY50",
    exchange: "NSE",
    instrumentType: "INDEX",
    isActive: true,
    timeframe: "1d",
    providers: ["yahoo"],
    barCount: 883,
    provisionalBars: 0,
    expiredProvisionalBars: 0,
    duplicateOpenTimes: 0,
    invalidOhlcBars: 0,
    negativeVolumeBars: 0,
    firstOpenTime: "2023-01-03T03:45:00.000Z",
    lastOpenTime: "2026-08-03T03:45:00.000Z",
    lastCloseTime: "2026-08-03T10:00:00.000Z",
    sessionCount: 883,
    modalBarsPerSession: null,
    completeness: null,
    longestGapWeekdays: 2,
    ageWeekdays: 0,
    zeroVolumeFraction: 0,
    medianVolume: 250000,
    indicatorCoverage: {
      ATR: 0.98, BOLLINGER_BANDS: 0.98, EMA: 0.99, MACD: 0.97,
      RSI: 0.99, SMA: 0.99, SUPERTREND: 0.98,
    },
    ...overrides,
  };
}

describe("weekdaysBetween", () => {
  it("counts weekdays strictly between two dates", () => {
    // Mon 2026-07-27 to Fri 2026-07-31: Tue, Wed, Thu between.
    expect(weekdaysBetween("2026-07-27", "2026-07-31")).toBe(3);
  });

  it("sees no missed sessions across an ordinary weekend", () => {
    // Fri to Mon: Sat and Sun between, neither a weekday.
    expect(weekdaysBetween("2026-07-31", "2026-08-03")).toBe(0);
  });

  it("returns zero for same-day and inverted ranges", () => {
    expect(weekdaysBetween("2026-08-03", "2026-08-03")).toBe(0);
    expect(weekdaysBetween("2026-08-04", "2026-08-03")).toBe(0);
  });
});

describe("longestSessionGapWeekdays", () => {
  it("finds the longest internal run of missing weekday sessions", () => {
    // Gap between 07-20 (Mon) and 07-27 (Mon) misses Tue-Fri: four weekdays.
    expect(longestSessionGapWeekdays(["2026-07-17", "2026-07-20", "2026-07-27", "2026-07-28"]))
      .toBe(4);
  });

  it("is zero for consecutive sessions", () => {
    expect(longestSessionGapWeekdays(["2026-07-30", "2026-07-31", "2026-08-03"])).toBe(0);
  });
});

describe("modalValue", () => {
  it("returns the most frequent value", () => {
    expect(modalValue([375, 375, 375, 200])).toBe(375);
  });

  it("breaks ties toward the larger value so stub sessions do not define expected bars", () => {
    expect(modalValue([374, 375])).toBe(375);
  });

  it("returns null for an empty series", () => {
    expect(modalValue([])).toBeNull();
  });
});

describe("assessSeries", () => {
  it("reports READY when every gate passes", () => {
    expect(assessSeries(measurements())).toEqual({ state: "READY", reasons: [] });
  });

  it("quarantines mixed provider lineage as INVALID", () => {
    const assessment = assessSeries(measurements({ providers: ["fyers-api-v3", "yahoo"] }));
    expect(assessment.state).toBe("INVALID");
    expect(assessment.reasons[0]).toMatch(/Mixed provider lineage/);
  });

  it("quarantines OHLC violations as INVALID even when the series is also stale", () => {
    // INVALID outranks STALE: a corrupt series' freshness is irrelevant.
    const assessment = assessSeries(measurements({ invalidOhlcBars: 1, ageWeekdays: 10 }));
    expect(assessment.state).toBe("INVALID");
  });

  it("marks a series STALE beyond the missed-session tolerance", () => {
    const assessment = assessSeries(measurements({
      ageWeekdays: DATA_READINESS_THRESHOLDS.maximumAgeWeekdays + 1,
    }));
    expect(assessment.state).toBe("STALE");
  });

  it("tolerates a long weekend plus one missed collection", () => {
    expect(assessSeries(measurements({ ageWeekdays: 3 })).state).toBe("READY");
  });

  it("degrades on intraday completeness below the floor", () => {
    const assessment = assessSeries(measurements({
      timeframe: "15m",
      modalBarsPerSession: 25,
      completeness: 0.97,
    }));
    expect(assessment.state).toBe("DEGRADED");
    expect(assessment.reasons[0]).toMatch(/Completeness 97.00%/);
  });

  it("degrades on missing required indicator coverage and names the indicator", () => {
    const assessment = assessSeries(measurements({
      indicatorCoverage: { ...measurements().indicatorCoverage, SUPERTREND: 0.4 },
    }));
    expect(assessment.state).toBe("DEGRADED");
    expect(assessment.reasons.join(" ")).toMatch(/SUPERTREND covers 40.0%/);
  });

  it("treats an absent indicator as zero coverage", () => {
    const partial = { ...measurements().indicatorCoverage } as Record<string, number>;
    delete partial["MACD"];
    const assessment = assessSeries(measurements({ indicatorCoverage: partial }));
    expect(assessment.state).toBe("DEGRADED");
    expect(assessment.reasons.join(" ")).toMatch(/MACD covers 0.0%/);
  });

  it("degrades on an internal gap beyond the holiday allowance", () => {
    const assessment = assessSeries(measurements({
      longestGapWeekdays: DATA_READINESS_THRESHOLDS.maximumGapWeekdays + 1,
    }));
    expect(assessment.state).toBe("DEGRADED");
  });

  it("degrades on expired provisional bars", () => {
    const assessment = assessSeries(measurements({ expiredProvisionalBars: 2 }));
    expect(assessment.state).toBe("DEGRADED");
  });

  it("collects every degradation reason rather than stopping at the first", () => {
    const assessment = assessSeries(measurements({
      timeframe: "15m",
      modalBarsPerSession: 25,
      completeness: 0.9,
      expiredProvisionalBars: 1,
    }));
    expect(assessment.state).toBe("DEGRADED");
    expect(assessment.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe("canonicalJsonForReportHash", () => {
  it("is insensitive to key insertion order", () => {
    expect(canonicalJsonForReportHash({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe(canonicalJsonForReportHash({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }));
  });

  it("drops undefined properties like JSON.stringify does", () => {
    expect(canonicalJsonForReportHash({ a: 1, b: undefined })).toBe("{\"a\":1}");
  });
});
