import { describe, expect, it } from "vitest";
import {
  indexVolumeProvenanceFor,
  indexVolumeProvenanceVersion,
} from "./index-volume-provenance.js";

describe("index volume provenance", () => {
  it("records the measured semantics for the constituent-backed indices", () => {
    for (const symbol of ["NIFTY50", "BANKNIFTY"]) {
      const provenance = indexVolumeProvenanceFor(symbol);
      expect(provenance.semantics).toBe("CONSTITUENT_CASH_SHARE_AGGREGATE");
      // The load-bearing flag: an aggregate of other instruments' share counts is not a benchmark
      // anybody could have executed against.
      expect(provenance.usableAsExecutionBenchmark).toBe(false);
    }
  });

  it("marks a genuinely traded instrument as an execution benchmark", () => {
    // The ETFs actually trade, so their volume is their own turnover and VWAP means what it usually does.
    expect(indexVolumeProvenanceFor("NIFTYBEES").usableAsExecutionBenchmark).toBe(true);
  });

  it("records INDIAVIX as not reporting volume at all", () => {
    expect(indexVolumeProvenanceFor("INDIAVIX").semantics).toBe("NOT_REPORTED");
    expect(indexVolumeProvenanceFor("INDIAVIX").usableAsExecutionBenchmark).toBe(false);
  });

  it("defaults an unmeasured symbol to UNVERIFIED rather than assuming", () => {
    // Silent inheritance of "aggregate" is precisely how an unvalidated field becomes a VWAP input.
    const unknown = indexVolumeProvenanceFor("SOMEINDEX");
    expect(unknown.semantics).toBe("UNVERIFIED");
    expect(unknown.usableAsExecutionBenchmark).toBe(false);
  });

  it("stamps a version onto every verdict so derived research is attributable", () => {
    // A vendor can change a field without notice; research built on it must say which reading it used.
    expect(indexVolumeProvenanceFor("NIFTY50").provenanceVersion).toBe(indexVolumeProvenanceVersion);
    expect(indexVolumeProvenanceVersion).toBe("INDEX_VOLUME_CONSTITUENT_AGGREGATE_V1");
  });
});
