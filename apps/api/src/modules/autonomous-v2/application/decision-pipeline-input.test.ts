import { describe, expect, it } from "vitest";
import {
  buildDecisionPipelineInput,
  placeholderAccountSnapshot,
  placeholderCostBps,
  type DecisionPipelineInputFacts,
} from "./decision-pipeline-input.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import type { PitInstants } from "../../platform/pit/pit-instants.js";

const closeTime = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });

const snapshotInstants: Readonly<PitInstants> = {
  eventAt: closeTime,
  knownAt: new Date(closeTime.getTime() + 500),
  dataThrough: closeTime, // the sealed snapshot's own convention: equal to the bar's close
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(closeTime.getTime() + 1_000),
  referenceAt: new Date(closeTime.getTime() + 1_000),
};

function facts(overrides: Partial<DecisionPipelineInputFacts> = {}): DecisionPipelineInputFacts {
  return {
    decisionId: "decision-1",
    instrumentSymbol: "NIFTY50",
    instrumentTickSize: "0.05",
    instrumentLotSize: 75,
    latestClose: 24_000,
    latestCloseTime: closeTime,
    evaluationAt: new Date(closeTime.getTime() + 500),
    snapshotInstants,
    observedIn,
    indicators: [
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 42.5 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14 }, values: { value: 55 } },
    ],
    legacyPatterns: [],
    patternsComputed: true,
    volatilityReading: { vixClose: 13.5, vixSma20: 14.1 },
    institutionalFlow: { fiiCashNetCr: -120.5, diiCashNetCr: 340.2 },
    optionChain: null,
    executionChain: null,
    ...overrides,
  };
}

describe("context assembly", () => {
  it("seals a context whose decisionAt is the bar's close and dataThrough sits strictly before it", () => {
    const input = buildDecisionPipelineInput(facts());
    expect(input.context.decisionAt).toEqual(closeTime);
    expect(input.context.instants.dataThrough.getTime()).toBe(closeTime.getTime() - 1);
    expect(input.context.snapshotRef).toEqual(observedIn);
  });

  it("does not mutate the original snapshot instants used for pattern observations", () => {
    const input = buildDecisionPipelineInput(facts({
      legacyPatterns: [{
        code: "BULLISH_ENGULFING",
        algorithmVersion: "candlestick-v1",
        direction: "BULLISH",
        confidence: 0.7,
        contextCandleIds: [],
        details: {},
      }],
    }));
    expect(input.patternObservations[0]?.instants.dataThrough).toEqual(closeTime);
  });

  it("records every stage's own policy version, not a placeholder", () => {
    const input = buildDecisionPipelineInput(facts());
    const versions = Object.values(input.context.policyVersions);
    expect(versions).toContain("OPPORTUNITY_GROUPING_POLICY_V1");
    expect(versions).toContain("NATIVE_RISK_APPROVAL_POLICY_V1");
    expect(new Set(versions).size).toBe(versions.length); // no accidental duplicate values
  });
});

describe("pattern observations", () => {
  it("maps a legacy pattern through legacyPatternObservations, carrying the sealed snapshot's instants", () => {
    const input = buildDecisionPipelineInput(facts({
      legacyPatterns: [{
        code: "BULLISH_ENGULFING",
        algorithmVersion: "candlestick-v1",
        direction: "BULLISH",
        confidence: 0.7,
        contextCandleIds: ["c1", "c2"],
        details: {},
      }],
      patternsComputed: true,
    }));
    expect(input.patternObservations).toHaveLength(1);
    expect(input.patternObservations[0]).toMatchObject({
      provenance: "LEGACY_CANDLESTICK",
      patternCode: "BULLISH_ENGULFING",
      orientation: "UP",
      observedIn,
    });
  });

  it("passes patternCoverage as NOT_LOADED when the layer was not computed", () => {
    const input = buildDecisionPipelineInput(facts({ legacyPatterns: [], patternsComputed: false }));
    expect(input.patternCoverage).toBe("NOT_LOADED");
    expect(input.patternObservations).toEqual([]);
  });

  it("passes patternCoverage as LOADED with an empty array when the layer ran and found nothing", () => {
    const input = buildDecisionPipelineInput(facts({ legacyPatterns: [], patternsComputed: true }));
    expect(input.patternCoverage).toBe("LOADED");
    expect(input.patternObservations).toEqual([]);
  });
});

describe("ATR / entry extraction", () => {
  it("extracts the canonical ATR reading (ta-v1, period 14, WILDER) and ignores other indicators", () => {
    const input = buildDecisionPipelineInput(facts());
    expect(input.atrValue).toBe(42.5);
    expect(input.entryReference).toBe(24_000);
  });

  it("returns null when no matching ATR indicator is present", () => {
    const input = buildDecisionPipelineInput(facts({ indicators: [] }));
    expect(input.atrValue).toBeNull();
  });

  it("does not match an ATR row under a different period or smoothing", () => {
    const input = buildDecisionPipelineInput(facts({
      indicators: [{ code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 20, smoothing: "WILDER" }, values: { value: 99 } }],
    }));
    expect(input.atrValue).toBeNull();
  });
});

describe("tickSize / lotSize", () => {
  it("converts the instrument's string tickSize to a number", () => {
    const input = buildDecisionPipelineInput(facts({ instrumentTickSize: "0.05" }));
    expect(input.tickSize).toBe(0.05);
    expect(input.lotSize).toBe(75);
  });
});

describe("institutional flow", () => {
  it("maps a present flow reading through unchanged", () => {
    const input = buildDecisionPipelineInput(facts());
    expect(input.institutionalFlow).toEqual({ fiiCashNetCr: -120.5, diiCashNetCr: 340.2 });
  });

  it("defaults both legs to null when no flow reading exists", () => {
    const input = buildDecisionPipelineInput(facts({ institutionalFlow: null }));
    expect(input.institutionalFlow).toEqual({ fiiCashNetCr: null, diiCashNetCr: null });
  });
});

describe("documented placeholders", () => {
  it("uses the exact placeholder account snapshot and cost", () => {
    const input = buildDecisionPipelineInput(facts());
    expect(input.accountSnapshot).toEqual(placeholderAccountSnapshot());
    expect(input.costBps).toBe(placeholderCostBps);
  });
});

describe("option chains", () => {
  it("passes optionChain and executionChain through unchanged, including null", () => {
    const input = buildDecisionPipelineInput(facts({ optionChain: null, executionChain: null }));
    expect(input.optionChain).toBeNull();
    expect(input.executionChain).toBeNull();
  });
});
