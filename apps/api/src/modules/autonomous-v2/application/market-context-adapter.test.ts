import { describe, expect, it } from "vitest";
import {
  marketSnapshotFromLegacyContext,
  MarketContextAdapterError,
  type LegacyMarketContext,
} from "./market-context-adapter.js";
import type { BarLabelConvention, PitInstants } from "../../platform/pit/pit-instants.js";

const openTime = new Date("2026-09-02T09:20:00.000Z");
const closeTime = new Date("2026-09-02T09:25:00.000Z");

function bar() {
  return {
    instrumentId: "instrument-1",
    timeframe: "5m",
    openTime,
    closeTime,
    open: 23_850,
    high: 23_870,
    low: 23_840,
    close: 23_860,
    volume: 125_000,
    tickSize: 0.05,
  };
}

function instants(convention: BarLabelConvention = "CLOSE_LABELLED"): PitInstants {
  return {
    eventAt: closeTime,
    knownAt: new Date(closeTime.getTime() + 1_000),
    dataThrough: closeTime,
    dataThroughConvention: convention,
    // Strictly after knownAt: sealPitInstants refuses equality, because a decision acting at the
    // instant it learned something acted on information it did not yet have.
    earliestExecutionAt: new Date(closeTime.getTime() + 2_000),
    // Not before entry: a forward measurement cannot start earlier than the trade it measures.
    referenceAt: new Date(closeTime.getTime() + 2_000),
  };
}

function context(overrides: Partial<LegacyMarketContext> = {}): LegacyMarketContext {
  return {
    candle: bar(),
    indicators: [{ code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 22.5 } }],
    patterns: [],
    priceActionEvents: [],
    patternsComputed: true,
    priceActionComputed: true,
    ...overrides,
  };
}

function adapt(overrides: Partial<LegacyMarketContext> = {}, convention: BarLabelConvention = "CLOSE_LABELLED") {
  return marketSnapshotFromLegacyContext({
    context: context(overrides),
    instants: instants(convention),
    labelConvention: convention,
  });
}

describe("translating a legacy context", () => {
  it("derives the snapshot identity from its own content", () => {
    // Stamped from the content, so a snapshot cannot carry an identity that disagrees with what it
    // holds -- the failure `assertSnapshotRef` exists to catch, closed here by construction.
    const snapshot = adapt();

    expect(snapshot.ref.snapshotId).toMatch(/^[a-f0-9]{64}$/);
    expect(adapt().ref.snapshotId).toBe(snapshot.ref.snapshotId);
  });

  it("gives a different identity to a different market state", () => {
    const changed = adapt({ candle: { ...bar(), close: 23_861 } });

    expect(changed.ref.snapshotId).not.toBe(adapt().ref.snapshotId);
  });

  it("seals the instants and freezes the snapshot", () => {
    const snapshot = adapt();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.instants)).toBe(true);
    expect(Object.isFrozen(snapshot.bar)).toBe(true);
  });

  it("carries the label convention, which is not recoverable from the instant", () => {
    // Pattern Intelligence is OPEN_LABELLED and the scalp harness CLOSE_LABELLED, so the same
    // timestamp names different bars. A consumer that guesses is off by one span, silently.
    expect(adapt({}, "OPEN_LABELLED").labelConvention).toBe("OPEN_LABELLED");
    expect(adapt({}, "CLOSE_LABELLED").labelConvention).toBe("CLOSE_LABELLED");
  });

  it("refuses a bar whose convention disagrees with its dataThrough", () => {
    expect(() => marketSnapshotFromLegacyContext({
      context: context(),
      instants: instants("OPEN_LABELLED"),
      labelConvention: "CLOSE_LABELLED",
    })).toThrow(/describe different bars/);
  });

  it("refuses a bar that spans no time", () => {
    expect(() => adapt({ candle: { ...bar(), closeTime: openTime } }))
      .toThrow(/spans no time/);
  });
});

describe("coverage is declared, never inferred from emptiness", () => {
  it("distinguishes computed-and-empty from not-computed", () => {
    /*
     * The distinction an adapter would erase by mapping `undefined -> []`, and it is load-bearing:
     * absence of observations is only information when the detector is known to have run. It has
     * already cost a measurement -- 46% of scalp evaluations on 2026-08-24 read an uncomputed pattern
     * layer, firing rate fell 93%, and the eligibility check could not see why.
     */
    expect(adapt({ patterns: [], patternsComputed: true }).patternCoverage).toBe("LOADED");
    expect(adapt({ patterns: [], patternsComputed: false }).patternCoverage).toBe("NOT_LOADED");
  });

  it("gives the two a different snapshot identity, so they cannot compare equal", () => {
    // The stronger form of the same guarantee: two decisions that read different coverage states
    // must not be shown to have read the same market.
    expect(adapt({ patterns: [], patternsComputed: true }).ref.snapshotId)
      .not.toBe(adapt({ patterns: [], patternsComputed: false }).ref.snapshotId);
  });

  it("refuses rows supplied under a not-computed layer, rather than picking a winner", () => {
    /*
     * A contradiction: the caller has data it says was never computed. Trusting the rows admits data
     * of unknown provenance; trusting the flag silently discards real detections. Neither is safe, so
     * it is refused.
     */
    const pattern = { code: "HAMMER", algorithmVersion: "candlestick-v1", direction: "BULLISH", confidence: 0.7 };

    expect(() => adapt({ patterns: [pattern], patternsComputed: false }))
      .toThrow(MarketContextAdapterError);
    expect(() => adapt({ patterns: [pattern], patternsComputed: false }))
      .toThrow(/declared, never inferred from emptiness/);
  });

  it("applies the same rule to price-action events", () => {
    const event = { eventCode: "BOS", algorithmVersion: "pa-v1", direction: "BULLISH", level: 23_855 };

    expect(() => adapt({ priceActionEvents: [event], priceActionComputed: false }))
      .toThrow(/priceActionEvents/);
  });
});

describe("V1 habits the contract makes unrepresentable", () => {
  it("has no primary-pattern field, so patterns[0] cannot be inherited", () => {
    /*
     * `patterns[0]` as "the pattern" is on §6's QUARANTINE list. There is no field for it and no
     * documented ordering, so a consumer wanting one pattern must select and justify it in its own
     * code, where the choice is visible -- rather than inheriting an accident of detector order.
     */
    const snapshot = adapt({
      patterns: [
        { code: "HAMMER", algorithmVersion: "candlestick-v1", direction: "BULLISH", confidence: 0.7 },
        { code: "ENGULFING", algorithmVersion: "candlestick-v1", direction: "BEARISH", confidence: 0.9 },
      ],
    });

    expect(snapshot.patterns).toHaveLength(2);
    expect(Object.keys(snapshot)).not.toContain("primaryPattern");
    expect(Object.keys(snapshot)).not.toContain("pattern");
    // Per-pattern confidence survives: it is a detector output. Composing them is what is refused.
    expect(snapshot.patterns.map((p) => p.confidence)).toEqual([0.7, 0.9]);
  });

  it("carries no composite score of any kind", () => {
    // "composite confidence" is quarantined alongside patterns[0]. If the snapshot had a single
    // number summarising the bar, V1's scorer would have somewhere to live inside V2.2.
    const snapshot = adapt();

    for (const key of Object.keys(snapshot)) {
      expect(key).not.toMatch(/score|composite|confidence/i);
    }
  });

  it("represents higher timeframes as coverage only, fixed at NOT_LOADED", () => {
    /*
     * Nothing in V1 populates `higherTimeframes` -- no resolver, no repository -- so every confluence
     * term it feeds computes 0 today. Carrying it as data would manufacture "no HTF context" where
     * the truth is "never measured", and the measured finding is that the veto it fed does not
     * replicate across instruments.
     */
    const snapshot = adapt();

    expect(snapshot.higherTimeframeCoverage).toBe("NOT_LOADED");
    expect(Object.keys(snapshot)).not.toContain("higherTimeframes");
  });
});
