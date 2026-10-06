import { describe, expect, it } from "vitest";
import {
  assessSequenceCandidate,
  candidateKindForTimeframe,
  instrumentSemanticsFor,
  type SequenceCandidateMeasurements,
} from "./sequence-readiness.js";

function base(overrides: Partial<SequenceCandidateMeasurements> = {}): SequenceCandidateMeasurements {
  return {
    symbol: "NIFTYBEES",
    exchange: "NSE",
    instrumentType: "ETF",
    instrumentSemantics: "ETF_PROXY",
    timeframe: "1m",
    candidate: "tcn-1m",
    provider: "fyers-api-v3",
    barCount: 331_141,
    sessionCount: 887,
    zeroVolumeFraction: 0.000003,
    completeness: 0.995,
    seriesState: "READY",
    nativeInterval: true,
    firstOpenTime: "2023-01-02T03:45:00.000Z",
    lastOpenTime: "2026-07-31T10:00:00.000Z",
    ...overrides,
  };
}

describe("instrumentSemanticsFor", () => {
  it("maps the ETF proxy purpose and spot indices", () => {
    expect(instrumentSemanticsFor("ETF", "tradable-index-proxy")).toBe("ETF_PROXY");
    expect(instrumentSemanticsFor("INDEX", null)).toBe("SPOT_INDEX");
    expect(instrumentSemanticsFor("EQUITY", null)).toBe("EQUITY");
  });
});

describe("candidateKindForTimeframe", () => {
  it("maps each intraday timeframe to its TCN candidate", () => {
    expect(candidateKindForTimeframe("1m")).toBe("tcn-1m");
    expect(candidateKindForTimeframe("5m")).toBe("tcn-5m");
    expect(candidateKindForTimeframe("15m")).toBe("tcn-15m");
  });
});

describe("assessSequenceCandidate", () => {
  it("passes a READY NIFTYBEES 1m series that clears every numeric gate", () => {
    const result = assessSequenceCandidate(base());
    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("fails when bar count is below the 1m floor even if the series is READY", () => {
    const result = assessSequenceCandidate(base({ barCount: 50_000 }));
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.map((f) => f.code)).toContain("INSUFFICIENT_BARS");
  });

  it("fails the 5m gate below 100k bars", () => {
    const result = assessSequenceCandidate(
      base({
        timeframe: "5m",
        candidate: "tcn-5m",
        barCount: 66_229,
        sessionCount: 887,
      }),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.findings.map((f) => f.code)).toContain("INSUFFICIENT_BARS");
  });

  it("blocks when the Workstream A series is not READY", () => {
    const result = assessSequenceCandidate(base({ seriesState: "DEGRADED", barCount: 300_000 }));
    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings.map((f) => f.code)).toContain("SERIES_NOT_READY");
  });

  it("rejects spot-index semantics and zero-volume series", () => {
    const result = assessSequenceCandidate(
      base({
        symbol: "NIFTY50",
        instrumentType: "INDEX",
        instrumentSemantics: "SPOT_INDEX",
        zeroVolumeFraction: 1,
        barCount: 53_625,
        sessionCount: 143,
      }),
    );
    expect(result.verdict).toBe("FAIL");
    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("SPOT_INDEX_SEMANTICS");
    expect(codes).toContain("ZERO_VOLUME");
    expect(codes).toContain("INSUFFICIENT_BARS");
    expect(codes).toContain("INSUFFICIENT_SESSIONS");
  });

  it("rejects a mixed or wrong provider lineage", () => {
    const mixed = assessSequenceCandidate(base({ provider: null }));
    expect(mixed.findings.map((f) => f.code)).toContain("PROVIDER_MISMATCH");
    const yahoo = assessSequenceCandidate(base({ provider: "yahoo" }));
    expect(yahoo.findings.map((f) => f.code)).toContain("PROVIDER_MISMATCH");
  });
});
