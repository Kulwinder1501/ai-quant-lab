import { describe, expect, it } from "vitest";
import {
  canonicalDecisionPipelineOutcome,
  DecisionPipelineComparisonError,
} from "./decision-pipeline-comparison.js";
import { legacyThesisComparison } from "./thesis-adapter.js";
import { runDecisionPipeline, type DecisionPipelineInput, type DecisionPipelineRun } from "../domain/decision-pipeline.js";
import { deriveSideGeometry, type SideResult } from "../domain/thesis-builder.js";
import type { OpportunityCandidate } from "../domain/opportunity-resolver.js";
import type { LegacyPatternObservation, ObservationOrientation } from "./pattern-adapter.js";
import type { InstrumentRiskSnapshot } from "../../platform/risk/risk-snapshot.js";
import type { OptionChainQuote, OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";

const decisionAt = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });
const nearExpiry = new Date("2026-09-14T15:30:00.000Z");
const farExpiry = new Date("2026-09-21T15:30:00.000Z");

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: decisionAt,
  knownAt: new Date(decisionAt.getTime() + 1_000),
  dataThrough: new Date(decisionAt.getTime() - 1),
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(decisionAt.getTime() + 2_000),
  referenceAt: new Date(decisionAt.getTime() + 2_000),
});

function patternObservation(orientation: ObservationOrientation): LegacyPatternObservation {
  return {
    provenance: "LEGACY_CANDLESTICK",
    patternCode: "FIXTURE",
    algorithmVersion: "v1",
    orientation,
    detectorConfidence: 0.8,
    contextCandleIds: ["c1"],
    details: {},
    instants,
    observedIn,
  };
}

function context(decisionId: string) {
  return Object.freeze({
    decisionId,
    decisionAt,
    evaluationAt: decisionAt,
    schedulerLagMs: 0,
    instants,
    snapshotRef: observedIn,
    policyVersions: Object.freeze({ pipeline: "TEST" }),
  });
}

function accountSnapshot(): InstrumentRiskSnapshot<unknown> {
  return {
    accountEquity: 1_000_000,
    peakEquity: 1_000_000,
    openPositionCount: 0,
    realizedPnlToday: 0,
    volatilityRegime: null,
  };
}

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate: farExpiry,
    expiryKind: "WEEKLY",
    strikePrice: 24_000,
    optionType: "CE",
    providerSymbol: "NIFTY24000CE",
    providerToken: null,
    lastPrice: 101,
    bid: 100,
    ask: 102,
    volume: 1_000,
    openInterest: 5_000,
    previousOpenInterest: 4_800,
    openInterestChange: 200,
    ...overrides,
  };
}

function decisionChain(): OptionChainSnapshot {
  const strikes = [23_900, 24_000, 24_100];
  const expiries = [
    { expiryDate: nearExpiry, expiryKind: "WEEKLY" as const },
    { expiryDate: farExpiry, expiryKind: "WEEKLY" as const },
  ];
  const quotes: OptionChainQuote[] = [];
  for (const { expiryDate, expiryKind } of expiries) {
    for (const strike of strikes) {
      for (const optionType of ["CE", "PE"] as const) {
        quotes.push(quote({ expiryDate, expiryKind, strikePrice: strike, optionType }));
      }
    }
  }
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: 24_000,
    quotes,
    listedExpiries: expiries,
  };
}

function executionChain(): OptionChainSnapshot {
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: 24_000,
    quotes: [
      quote({ strikePrice: 24_000, optionType: "CE", expiryDate: farExpiry }),
      quote({ strikePrice: 24_000, optionType: "PE", expiryDate: farExpiry }),
    ],
    listedExpiries: [{ expiryDate: farExpiry, expiryKind: "WEEKLY" }],
  };
}

function input(decisionId: string, overrides: Partial<DecisionPipelineInput> = {}): DecisionPipelineInput {
  return {
    decisionId,
    instrumentSymbol: "NIFTY50",
    context: context(decisionId),
    patternObservations: [patternObservation("UP")],
    patternCoverage: "LOADED",
    volatilityReading: null,
    institutionalFlow: { fiiCashNetCr: null, diiCashNetCr: null },
    tickSize: 25,
    entryReference: 24_000,
    atrValue: 50,
    costBps: 5,
    accountSnapshot: accountSnapshot(),
    lotSize: 75,
    optionChain: decisionChain(),
    executionChain: executionChain(),
    ...overrides,
  };
}

describe("neither side approved", () => {
  it("formats a REJECTED stop with sorted, comma-joined reasons", () => {
    const run = runDecisionPipeline(input("cmp-rejected", { patternObservations: [patternObservation("NONE")] }));
    expect(run.outcome.kind).toBe("REJECTED");
    expect(canonicalDecisionPipelineOutcome(run)).toBe("REJECTED NO_ORIENTATION_EVIDENCE,NO_ORIENTATION_EVIDENCE");
  });

  it("formats a DEFERRED stop", () => {
    const run = runDecisionPipeline(input("cmp-deferred", { atrValue: null }));
    expect(run.outcome.kind).toBe("DEFERRED");
    expect(canonicalDecisionPipelineOutcome(run)).toBe("DEFERRED ATR_NOT_AVAILABLE_FOR_BAR");
  });

  it("formats a CLOSED_NO_ACTION stop as NO_ACTION", () => {
    const run = runDecisionPipeline(input("cmp-no-action", { patternObservations: [] }));
    expect(run.outcome.kind).toBe("CLOSED_NO_ACTION");
    expect(canonicalDecisionPipelineOutcome(run)).toBe("NO_ACTION NO_PATTERNS_OBSERVED");
  });
});

/**
 * `canonicalDecisionPipelineOutcome` only reads `run.stages.thesis` -- P7-P10/lineage/outcome.kind
 * are irrelevant to it except as the no-approved-side fallback (see "neither side approved" above,
 * already covered via the real `runDecisionPipeline`). `evaluateSide` cannot produce an APPROVED side
 * without a validated entry rule (thesis-builder.ts's "No validated entry rule" section), so these
 * tests build the thesis stage directly via `deriveSideGeometry` -- the shape a validated rule will
 * actually return -- rather than through `runDecisionPipeline`.
 */
function approvedGeometry(side: "LONG" | "SHORT", overrides: Partial<{
  entryReference: number; atrValue: number; tickSize: number;
}> = {}): SideResult {
  const candidate: OpportunityCandidate = Object.freeze({
    candidateId: "candidate-hash",
    instrumentSymbol: "NIFTY50",
    decisionAt,
    orientation: side === "LONG" ? "UP" : "DOWN",
    observedIn,
    memberObservationHashes: Object.freeze(["a".repeat(64)]),
    members: Object.freeze([]),
    groupingPolicyVersion: "OPPORTUNITY_GROUPING_POLICY_V1",
  });
  return deriveSideGeometry({
    side,
    entryReference: overrides.entryReference ?? 24_000,
    atrValue: overrides.atrValue ?? 50,
    tickSize: overrides.tickSize ?? 25,
    supportingCandidate: candidate,
  });
}

function runWithThesis(thesis: DecisionPipelineRun["stages"]["thesis"]): DecisionPipelineRun {
  return {
    decisionId: "cmp-fixture",
    context: context("cmp-fixture"),
    lineage: null,
    outcome: { kind: "EXECUTED" },
    stages: { thesis },
  };
}

describe("exactly one side approved", () => {
  it("matches legacyThesisComparison's own output for identical geometry", () => {
    const long = approvedGeometry("LONG");
    if (long.outcome !== "APPROVED") throw new Error("expected LONG to be approved");
    const run = runWithThesis({
      instrumentSymbol: "NIFTY50", decisionAt, observedIn,
      long, short: { outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] },
      policyVersion: "TEST",
    });

    const expected = legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date(0),
      verdict: "APPROVED",
      geometry: {
        side: "LONG",
        entryPrice: long.value.entryReference,
        stopLoss: long.value.stopLoss,
        targetPrice: long.value.targetPrice,
      },
    }).canonicalOutcome;

    expect(canonicalDecisionPipelineOutcome(run)).toBe(expected);
    expect(canonicalDecisionPipelineOutcome(run)).toBe(
      `APPROVED LONG entry=${long.value.entryReference.toFixed(2)} `
      + `stop=${long.value.stopLoss.toFixed(2)} target=${long.value.targetPrice.toFixed(2)}`,
    );
  });
});

describe("both sides approved", () => {
  it("labels the run APPROVED_BOTH_SIDES with each side's own canonical string", () => {
    const long = approvedGeometry("LONG");
    const short = approvedGeometry("SHORT");
    if (long.outcome !== "APPROVED" || short.outcome !== "APPROVED") {
      throw new Error("expected both sides to be approved for this fixture");
    }
    const run = runWithThesis({
      instrumentSymbol: "NIFTY50", decisionAt, observedIn, long, short, policyVersion: "TEST",
    });

    const longExpected = legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date(0),
      verdict: "APPROVED",
      geometry: { side: "LONG", entryPrice: long.value.entryReference, stopLoss: long.value.stopLoss, targetPrice: long.value.targetPrice },
    }).canonicalOutcome;
    const shortExpected = legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date(0),
      verdict: "APPROVED",
      geometry: { side: "SHORT", entryPrice: short.value.entryReference, stopLoss: short.value.stopLoss, targetPrice: short.value.targetPrice },
    }).canonicalOutcome;

    expect(canonicalDecisionPipelineOutcome(run)).toBe(`APPROVED_BOTH_SIDES ${longExpected} | ${shortExpected}`);
  });
});

describe("quantisation matches legacyThesisComparison's own rounding", () => {
  it("produces the identical string for geometry carrying float noise past 2 decimals", () => {
    const long = approvedGeometry("LONG", { entryReference: 24_000.126, tickSize: 0.01, atrValue: 49.987 });
    if (long.outcome !== "APPROVED") throw new Error("expected LONG to be approved");
    const run = runWithThesis({
      instrumentSymbol: "NIFTY50", decisionAt, observedIn,
      long, short: { outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] },
      policyVersion: "TEST",
    });

    const independentlyRounded = legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: new Date(0),
      verdict: "APPROVED",
      geometry: {
        side: "LONG",
        entryPrice: long.value.entryReference,
        stopLoss: long.value.stopLoss,
        targetPrice: long.value.targetPrice,
      },
    }).canonicalOutcome;

    expect(canonicalDecisionPipelineOutcome(run)).toBe(independentlyRounded);
  });
});

describe("defensive throw", () => {
  it("throws when a run somehow reached EXECUTED with no thesis stage recorded", () => {
    const contrived: DecisionPipelineRun = {
      decisionId: "cmp-contrived",
      context: context("cmp-contrived"),
      lineage: null,
      outcome: { kind: "EXECUTED" },
      stages: {},
    };
    expect(() => canonicalDecisionPipelineOutcome(contrived)).toThrow(DecisionPipelineComparisonError);
  });
});
