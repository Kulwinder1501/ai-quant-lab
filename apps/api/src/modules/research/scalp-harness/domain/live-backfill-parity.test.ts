import { describe, expect, it } from "vitest";
import {
  canonicalEventSetHash,
  canonicalJson,
  checkCoverageOrdering,
  compareConsumedState,
  summariseParity,
  type ParityConsumedState,
  type ParitySampleResult,
} from "./live-backfill-parity.js";

function state(overrides: Partial<ParityConsumedState> = {}): ParityConsumedState {
  return {
    sampleEligible: true,
    ineligibleReason: null,
    indicators: [
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 6.2 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 24_310 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 24_305 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 61 } },
      { code: "VWAP", algorithmVersion: "ta-v1", parameters: { reset: "NSE_SESSION" }, values: { value: 24_300 } },
      { code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 }, values: { value: 24_280, trend: "UP" } },
    ],
    patterns: [
      { code: "HAMMER", algorithmVersion: "candlestick-v1", direction: "BULLISH", confidence: 0.7 },
      { code: "DOJI", algorithmVersion: "candlestick-v1", direction: "NEUTRAL", confidence: 0.4 },
    ],
    priceActionEvents: [
      { eventCode: "SUPPORT", algorithmVersion: "price-action-v2", direction: "BULLISH", level: 24_290, confidence: 0.6 },
    ],
    nativeConfidenceByStrategy: { "pattern-v4-research:1m": 0.52 },
    legacyScoreGateByStrategy: { "pattern-v4-research:1m": { parameter: "scoreThreshold", threshold: 5, value: 7, passed: true } },
    proposalDirections: { "pattern-v4-research:1m": "LONG" },
    ...overrides,
  };
}

describe("LIVE_BACKFILL_FEATURE_PARITY_V1 comparison", () => {
  it("reports no mismatch when the live state matches the reconstruction", () => {
    expect(compareConsumedState(state(), state())).toEqual([]);
  });

  it("does not report a legacy score gate that differs only in key order", () => {
    // The live side reloads an object Postgres serialised; the reconstruction builds a literal in
    // source order. Comparing raw JSON strings made every gate look different: on 2026-08-25 that
    // produced 483 of 748 reported mismatches and pushed a run to NO_PARITY on nothing at all.
    const live = state({
      legacyScoreGateByStrategy: {
        "pattern-v4-research:1m": { value: 7, passed: true, maximum: 11, parameter: "scoreThreshold", threshold: 5 },
      },
    });
    const rebuilt = state({
      legacyScoreGateByStrategy: {
        "pattern-v4-research:1m": { parameter: "scoreThreshold", threshold: 5, value: 7, maximum: 11, passed: true },
      },
    });

    expect(compareConsumedState(live, rebuilt)).toEqual([]);
  });

  it("still reports a legacy score gate whose values genuinely differ", () => {
    // The guard above must not be bought by making the comparison blind.
    const live = state({
      legacyScoreGateByStrategy: {
        "pattern-v4-research:1m": { value: 7, passed: true, maximum: 11, parameter: "scoreThreshold", threshold: 5 },
      },
    });
    const rebuilt = state({
      legacyScoreGateByStrategy: {
        "pattern-v4-research:1m": { parameter: "scoreThreshold", threshold: 5, value: 3, maximum: 11, passed: false },
      },
    });

    const mismatches = compareConsumedState(live, rebuilt);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.field).toBe("legacyScoreGate");
  });

  it("ignores event ordering, which is a query detail rather than a difference", () => {
    // The repository orders by code then algorithm version; a positional comparison would turn a
    // harmless reorder into a false parity failure and bury the real ones.
    const reordered = state({ patterns: [...state().patterns].reverse() });

    expect(compareConsumedState(state(), reordered)).toEqual([]);
  });

  it("catches a pattern the live capture did not see", () => {
    // The 2026-08-24 defect in miniature: live read a bar before its candlestick layer landed.
    const liveMissedOne = state({ patterns: [state().patterns[0]!] });
    const mismatches = compareConsumedState(liveMissedOne, state());

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.field).toBe("patternSet");
    expect(mismatches[0]!.detail).toMatch(/1 live vs 2 reconstructed/);
  });

  it("catches a price-action event the live capture did not see", () => {
    const mismatches = compareConsumedState(state({ priceActionEvents: [] }), state());

    expect(mismatches.map((item) => item.field)).toEqual(["priceActionSet"]);
  });

  it("catches an indicator value mutated after capture", () => {
    // The residual race the planner named: a feature layer recalculated after the sample was taken.
    const mutated = state({
      indicators: state().indicators.map((item) => (
        item.code === "RSI" ? { ...item, values: { value: 58 } } : item
      )),
    });
    const mismatches = compareConsumedState(state(), mutated);

    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.detail).toBe("RSI.value differs");
  });

  it("distinguishes the two EMA periods rather than collapsing them", () => {
    const movedSlowEma = state({
      indicators: state().indicators.map((item) => (
        item.code === "EMA" && item.parameters.period === 8 ? { ...item, values: { value: 24_299 } } : item
      )),
    });

    expect(compareConsumedState(state(), movedSlowEma).map((item) => item.detail)).toEqual(["EMA:8.value differs"]);
  });

  it("tolerates a JSON round-trip last-bit difference but not a real move", () => {
    const roundTripped = state({
      indicators: state().indicators.map((item) => (
        item.code === "ATR" ? { ...item, values: { value: 6.2 + 1e-13 } } : item
      )),
    });
    const realMove = state({
      indicators: state().indicators.map((item) => (
        item.code === "ATR" ? { ...item, values: { value: 6.2001 } } : item
      )),
    });

    expect(compareConsumedState(state(), roundTripped)).toEqual([]);
    expect(compareConsumedState(state(), realMove)).toHaveLength(1);
  });

  it("catches a proposal that fired live but not in reconstruction, and the reverse", () => {
    const noProposal = state({ proposalDirections: {}, nativeConfidenceByStrategy: {}, legacyScoreGateByStrategy: {} });

    expect(compareConsumedState(state(), noProposal).some((item) => item.field === "proposalPresence")).toBe(true);
    expect(compareConsumedState(noProposal, state()).some((item) => item.field === "proposalPresence")).toBe(true);
  });

  it("reports one fact, not nine, when only one side proposed", () => {
    // A bar with no proposal stores no raw_context, so the silent side has empty arrays. Comparing
    // them anyway produced 6 indicator + 1 patternSet + 1 nativeConfidence + 1 legacyScoreGate
    // mismatches for a single fact, which reads as an indicator race and buries the real signal.
    // Measured on 2026-08-24: 1,146 phantom indicator mismatches against 250 genuine ones.
    const silent = state({
      indicators: [], patterns: [], priceActionEvents: [],
      nativeConfidenceByStrategy: {}, legacyScoreGateByStrategy: {}, proposalDirections: {},
    });

    const inflated = compareConsumedState(silent, state());
    const honest = compareConsumedState(silent, state(), { compareFeatureVectors: false });

    expect(inflated.length).toBeGreaterThan(5);
    expect(honest).toHaveLength(1);
    expect(honest[0]!.field).toBe("proposalPresence");
  });

  it("still compares eligibility when the feature vectors are skipped", () => {
    const silent = state({
      sampleEligible: false, ineligibleReason: "FEATURE_LAYER_NOT_COMPUTED",
      indicators: [], patterns: [], priceActionEvents: [],
      nativeConfidenceByStrategy: {}, legacyScoreGateByStrategy: {}, proposalDirections: {},
    });
    const fields = compareConsumedState(silent, state(), { compareFeatureVectors: false }).map((item) => item.field);

    expect(fields).toContain("sampleEligible");
    expect(fields).toContain("ineligibleReason");
  });

  it("catches a direction flip", () => {
    const flipped = state({ proposalDirections: { "pattern-v4-research:1m": "SHORT" } });
    const mismatches = compareConsumedState(state(), flipped);

    expect(mismatches.map((item) => item.field)).toEqual(["proposalDirection"]);
  });

  it("catches eligibility and reason drift", () => {
    const ineligible = state({ sampleEligible: false, ineligibleReason: "FEATURE_LAYER_NOT_COMPUTED" });
    const fields = compareConsumedState(state(), ineligible).map((item) => item.field);

    expect(fields).toContain("sampleEligible");
    expect(fields).toContain("ineligibleReason");
  });

  it("catches a legacy score gate that changed", () => {
    const movedGate = state({
      legacyScoreGateByStrategy: { "pattern-v4-research:1m": { parameter: "scoreThreshold", threshold: 5, value: 3, passed: false } },
    });

    expect(compareConsumedState(state(), movedGate).map((item) => item.field)).toEqual(["legacyScoreGate"]);
  });
});

describe("canonicalEventSetHash", () => {
  it("is stable across key order as well as element order", () => {
    const left = canonicalEventSetHash([{ code: "A", confidence: 1 }, { code: "B", confidence: 2 }]);
    const right = canonicalEventSetHash([{ confidence: 2, code: "B" }, { confidence: 1, code: "A" }]);

    expect(left).toBe(right);
  });

  it("changes when content changes", () => {
    expect(canonicalEventSetHash([{ code: "A" }])).not.toBe(canonicalEventSetHash([{ code: "B" }]));
  });
});

describe("canonicalJson", () => {
  it("is insensitive to key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("keeps array order, which can carry meaning", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("separates null from absent-but-present values", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson(null));
  });

  it("does not collapse distinct values", () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ b: 1 }));
    expect(canonicalJson("1")).not.toBe(canonicalJson(1));
  });
});

describe("coverage ordering", () => {
  const decisionAt = new Date("2026-08-25T04:00:00.000Z");

  it("accepts coverage stamped before capture and reports the lag", () => {
    const result = checkCoverageOrdering({
      decisionAt,
      coverageSatisfiedAt: new Date("2026-08-25T04:05:00.000Z"),
      sampleCapturedAt: new Date("2026-08-25T04:06:00.000Z"),
    });

    expect(result.mismatch).toBeNull();
    expect(result.coverageLagMs).toBe(60_000);
  });

  it("fails when coverage was stamped after the sample was captured", () => {
    // Coverage existing is a weaker claim than coverage preceding capture. A row stamped late reads
    // as compliance while being exactly the race the gate is meant to remove.
    const result = checkCoverageOrdering({
      decisionAt,
      coverageSatisfiedAt: new Date("2026-08-25T04:07:00.000Z"),
      sampleCapturedAt: new Date("2026-08-25T04:06:00.000Z"),
    });

    expect(result.mismatch?.field).toBe("coverageOrdering");
    expect(result.mismatch?.detail).toMatch(/stamped after/);
  });

  it("fails an eligible sample with no coverage row at all", () => {
    const result = checkCoverageOrdering({
      decisionAt, coverageSatisfiedAt: null, sampleCapturedAt: new Date("2026-08-25T04:06:00.000Z"),
    });

    expect(result.mismatch?.detail).toMatch(/no coverage timestamp/);
  });
});

describe("parity verdict", () => {
  const clean: ParitySampleResult = {
    sessionDate: "2026-08-25", instrumentSymbol: "NIFTY50",
    decisionAt: "2026-08-25T04:00:00.000Z", comparable: true, mismatches: [],
  };

  it("passes only when something was compared and nothing differed", () => {
    const report = summariseParity({ sessionDate: "2026-08-25", samples: [clean, clean], coverageLags: [1_000, 2_000] });

    expect(report.passed).toBe(true);
    expect(report.comparableSampleCount).toBe(2);
    expect(report.coverageLagMs).toEqual({ min: 1_000, median: 2_000, max: 2_000 });
  });

  it("refuses to pass vacuously when nothing was comparable", () => {
    // A vacuous pass on an acceptance test is worse than a failure: it gets read as evidence.
    const report = summariseParity({ sessionDate: "2026-08-25", samples: [], coverageLags: [] });

    expect(report.passed).toBe(false);
  });

  it("fails and tallies mismatches by field", () => {
    const dirty: ParitySampleResult = {
      ...clean,
      mismatches: [
        { field: "patternSet", detail: "d", live: "a", reconstructed: "b" },
        { field: "proposalPresence", detail: "d", live: "a", reconstructed: "b" },
      ],
    };
    const report = summariseParity({ sessionDate: "2026-08-25", samples: [clean, dirty], coverageLags: [5] });

    expect(report.passed).toBe(false);
    expect(report.mismatchCountsByField).toEqual({ patternSet: 1, proposalPresence: 1 });
  });

  it("stamps the version so a report cannot be mistaken for a backtest", () => {
    expect(summariseParity({ sessionDate: "2026-08-25", samples: [clean], coverageLags: [] }).version)
      .toBe("LIVE_BACKFILL_FEATURE_PARITY_V1");
  });
});
