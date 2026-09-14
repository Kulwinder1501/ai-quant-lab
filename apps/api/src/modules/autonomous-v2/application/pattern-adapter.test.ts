import { describe, expect, it } from "vitest";
import {
  legacyPatternObservations,
  orientationFromLegacyDirection,
  PatternAdapterError,
  type LegacyCandlestickPattern,
} from "./pattern-adapter.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";
import { snapshotRefFor } from "../../platform/snapshot/snapshot-ref.js";

const closeTime = new Date("2026-09-02T09:25:00.000Z");

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: closeTime,
  knownAt: new Date(closeTime.getTime() + 1_000),
  dataThrough: closeTime,
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(closeTime.getTime() + 2_000),
  referenceAt: new Date(closeTime.getTime() + 2_000),
});

const observedIn = snapshotRefFor({ bar: "NIFTY50@09:25" });

function pattern(overrides: Partial<LegacyCandlestickPattern> = {}): LegacyCandlestickPattern {
  return {
    code: "HAMMER",
    algorithmVersion: "candlestick-v1",
    direction: "BULLISH",
    confidence: 0.72,
    contextCandleIds: ["candle-1", "candle-2"],
    details: { bodyRatio: 0.31 },
    ...overrides,
  };
}

function adapt(patterns: readonly LegacyCandlestickPattern[], patternsComputed = true) {
  return legacyPatternObservations({ patterns, instants, observedIn, patternsComputed });
}

describe("the direction mapping is total", () => {
  it("maps the three legacy directions", () => {
    expect(orientationFromLegacyDirection("BULLISH")).toBe("UP");
    expect(orientationFromLegacyDirection("BEARISH")).toBe("DOWN");
    expect(orientationFromLegacyDirection("NEUTRAL")).toBe("NONE");
  });

  it("refuses an unmapped direction rather than defaulting to NONE", () => {
    /*
     * Defaulting would relabel a directional pattern as neutral, which is the quietest possible way
     * to destroy a signal: the row survives, the analysis runs, and the bias is invisible.
     */
    expect(() => orientationFromLegacyDirection("SIDEWAYS")).toThrow(PatternAdapterError);
    expect(() => orientationFromLegacyDirection("SIDEWAYS")).toThrow(/Refused rather than defaulted/);
  });

  it("can never produce BIDIRECTIONAL, and that is a mapping artifact", () => {
    /*
     * The native vocabulary has four orientations; the legacy one has three. So legacy-derived rows
     * are structurally absent from the BIDIRECTIONAL bucket, and a zero there is an artifact of the
     * mapping rather than a fact about markets. Pinned so nobody reads that zero as evidence.
     */
    const produced = new Set(
      (["BULLISH", "BEARISH", "NEUTRAL"] as const).map(orientationFromLegacyDirection),
    );

    expect(produced.has("BIDIRECTIONAL")).toBe(false);
    expect([...produced].sort()).toEqual(["DOWN", "NONE", "UP"]);
  });
});

describe("translating legacy patterns", () => {
  it("carries only what the legacy detector knew, marked as legacy", () => {
    const [observation] = adapt([pattern()]);

    expect(observation!.provenance).toBe("LEGACY_CANDLESTICK");
    expect(observation!.patternCode).toBe("HAMMER");
    expect(observation!.algorithmVersion).toBe("candlestick-v1");
    expect(observation!.orientation).toBe("UP");
    expect(observation!.detectorConfidence).toBe(0.72);
  });

  it("invents none of the fields a native observation measures", () => {
    /*
     * The whole risk. A native PatternObservationSummary carries definitionHash, durationBars,
     * rangeBps, rangeAtr, trendState, sessionSegment and three z-scores. None of that exists in a
     * legacy detection, and supplying a default would be a claim: rangeAtr 0 asserts a pattern with
     * no range, volumeZscore 0 asserts perfectly average volume. Both would then be
     * indistinguishable from measurements.
     */
    const [observation] = adapt([pattern()]);
    const keys = Object.keys(observation!);

    for (const invented of [
      "definitionId", "definitionVersion", "definitionHash",
      "durationBars", "rangeBps", "rangeAtr",
      "trendState", "sessionSegment",
      "volumeZscore", "rangeZscore", "effortResultDivergence",
    ]) {
      expect(keys, invented).not.toContain(invented);
    }
  });

  it("takes its instants from the sealed bar, because a legacy pattern has none", () => {
    // A legacy pattern is a row attached to a bar. The only defensible answer to "when was this
    // knowable" is the bar's own sealed instants; deriving them here would reconstruct a timeline
    // from a row that never had one.
    const [observation] = adapt([pattern()]);

    expect(observation!.instants).toBe(instants);
    expect(observation!.observedIn.snapshotId).toBe(observedIn.snapshotId);
  });

  it("carries no rank and no composite, both quarantined", () => {
    const observations = adapt([
      pattern({ code: "HAMMER", confidence: 0.4 }),
      pattern({ code: "ENGULFING", direction: "BEARISH", confidence: 0.9 }),
    ]);

    expect(observations).toHaveLength(2);
    for (const observation of observations) {
      for (const key of Object.keys(observation)) {
        expect(key).not.toMatch(/rank|composite|score|aggregate/i);
      }
    }
    // Each detector confidence survives individually; nothing sums or ranks them.
    expect(observations.map((o) => o.detectorConfidence)).toEqual([0.4, 0.9]);
  });

  it("freezes each observation and the list", () => {
    const observations = adapt([pattern()]);

    expect(Object.isFrozen(observations)).toBe(true);
    expect(Object.isFrozen(observations[0])).toBe(true);
    expect(Object.isFrozen(observations[0]!.details)).toBe(true);
  });
});

describe("coverage and validity", () => {
  it("returns nothing for an uncomputed layer", () => {
    expect(adapt([], false)).toEqual([]);
  });

  it("refuses patterns supplied under an uncomputed layer", () => {
    // The same contradiction MarketContextAdapter refuses, for the same reason: rows under a
    // not-computed layer have unknown provenance, and the flag and the data cannot both be right.
    expect(() => adapt([pattern()], false)).toThrow(/refused rather than resolved/);
  });

  it("refuses a non-finite detector confidence", () => {
    expect(() => adapt([pattern({ confidence: Number.NaN })])).toThrow(/finite number/);
  });

  it("copies the mutable inputs rather than aliasing them", () => {
    // The caller built these from database rows and may reuse the arrays; an aliased observation
    // would mutate under a consumer that never touched it.
    const source = pattern();
    const [observation] = adapt([source]);

    expect(observation!.contextCandleIds).not.toBe(source.contextCandleIds);
    expect(observation!.contextCandleIds).toEqual(["candle-1", "candle-2"]);
  });
});
