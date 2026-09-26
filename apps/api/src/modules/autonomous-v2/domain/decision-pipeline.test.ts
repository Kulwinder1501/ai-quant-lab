import { describe, expect, it } from "vitest";
import {
  continuePastThesis,
  runDecisionPipeline,
  type DecisionPipelineInput,
  type DecisionPipelineStages,
} from "./decision-pipeline.js";
import { resolveOpportunityCandidates } from "./opportunity-resolver.js";
import { interpretMarketState } from "./state-interpreter.js";
import { deriveSideGeometry, thesisBuilderPolicyVersion, type DualSidedThesis } from "./thesis-builder.js";
import { beginLineage, advanceLineage, type DecisionLineage } from "./decision-lineage.js";
import { sha256CanonicalJson } from "../../platform/identity/identity.js";
import type { LegacyPatternObservation, ObservationOrientation } from "../application/pattern-adapter.js";
import type { InstrumentRiskSnapshot } from "../../platform/risk/risk-snapshot.js";
import type { OptionChainQuote, OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";

const decisionAt = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });
const nearExpiry = new Date("2026-09-14T15:30:00.000Z"); // 0 DTE
const farExpiry = new Date("2026-09-21T15:30:00.000Z"); // 7 DTE, eligible

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

function context() {
  return Object.freeze({
    decisionId: "decision-1",
    decisionAt,
    evaluationAt: decisionAt,
    schedulerLagMs: 0,
    instants,
    snapshotRef: observedIn,
    policyVersions: Object.freeze({ pipeline: "TEST" }),
  });
}

function accountSnapshot(overrides: Partial<InstrumentRiskSnapshot<unknown>> = {}): InstrumentRiskSnapshot<unknown> {
  return {
    accountEquity: 1_000_000,
    peakEquity: 1_000_000,
    openPositionCount: 0,
    realizedPnlToday: 0,
    volatilityRegime: null,
    ...overrides,
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

function decisionChain(overrides: { quotes?: OptionChainQuote[] } = {}): OptionChainSnapshot {
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
    quotes: overrides.quotes ?? quotes,
    listedExpiries: expiries,
  };
}

function executionChain(overrides: { quotes?: OptionChainQuote[] } = {}): OptionChainSnapshot {
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: 24_000,
    quotes: overrides.quotes ?? [
      quote({ strikePrice: 24_000, optionType: "CE", expiryDate: farExpiry }),
      quote({ strikePrice: 24_000, optionType: "PE", expiryDate: farExpiry }),
    ],
    listedExpiries: [{ expiryDate: farExpiry, expiryKind: "WEEKLY" }],
  };
}

function input(overrides: Partial<DecisionPipelineInput> = {}): DecisionPipelineInput {
  return {
    decisionId: "decision-1",
    instrumentSymbol: "NIFTY50",
    context: context(),
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

/**
 * P7-P10 tests can no longer reach that far through `runDecisionPipeline`: `evaluateSide` cannot
 * produce an APPROVED side without a validated entry rule (thesis-builder.ts's "No validated entry
 * rule" section), so P6b now always rejects. This rebuilds exactly what P5-P6b's real functions would
 * have produced (same calls `runDecisionPipeline` makes, already proven correct by the still-passing
 * "P5 stage-level outcomes"/"dies at P6b" tests below), then hand-builds the thesis via
 * `deriveSideGeometry` -- the shape a validated rule will actually return -- so P7-P10's own sequencing
 * and lineage-tracking stay covered via `continuePastThesis`.
 */
function approvedThesisFixture(overrides: Partial<DecisionPipelineInput> = {}): {
  readonly pipelineInput: DecisionPipelineInput;
  readonly thesis: DualSidedThesis;
  readonly lineage: DecisionLineage;
  readonly stages: DecisionPipelineStages;
} {
  const pipelineInput = input({ patternObservations: [patternObservation("BIDIRECTIONAL")], ...overrides });

  const opportunityResult = resolveOpportunityCandidates({
    observations: pipelineInput.patternObservations,
    patternCoverage: pipelineInput.patternCoverage,
    instrumentSymbol: pipelineInput.instrumentSymbol,
    decisionAt: pipelineInput.context.decisionAt,
  });
  if (opportunityResult.outcome !== "APPROVED") throw new Error("fixture setup: expected candidates");
  const candidates = opportunityResult.value;
  let lineage = beginLineage({
    decisionId: pipelineInput.decisionId,
    candidateId: sha256CanonicalJson(candidates.map((candidate) => candidate.candidateId)),
  });

  const marketStateResult = interpretMarketState({
    candidate: candidates[0]!,
    context: pipelineInput.context,
    volatilityReading: pipelineInput.volatilityReading,
    institutionalFlow: pipelineInput.institutionalFlow,
  });
  if (marketStateResult.outcome !== "APPROVED") throw new Error("fixture setup: interpretMarketState is always APPROVED");
  const marketState = marketStateResult.value;
  lineage = advanceLineage({ lineage, to: "MARKET_STATE_INTERPRETED", artifactId: marketState.interpretationId });

  // Mirrors evaluateSide's own orientation-matching exactly (thesis-builder.ts), for the side that HAS
  // a supporting candidate -- the branch this fixture exists to exercise -- while a side with no
  // supporting candidate stays NO_ORIENTATION_EVIDENCE, unchanged by whether a rule is validated.
  const longSupport = candidates.find((c) => c.orientation === "UP" || c.orientation === "BIDIRECTIONAL");
  const shortSupport = candidates.find((c) => c.orientation === "DOWN" || c.orientation === "BIDIRECTIONAL");
  const long = longSupport
    ? deriveSideGeometry({
        side: "LONG", entryReference: pipelineInput.entryReference, atrValue: pipelineInput.atrValue!,
        tickSize: pipelineInput.tickSize, supportingCandidate: longSupport,
      })
    : ({ outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] } as const);
  const short = shortSupport
    ? deriveSideGeometry({
        side: "SHORT", entryReference: pipelineInput.entryReference, atrValue: pipelineInput.atrValue!,
        tickSize: pipelineInput.tickSize, supportingCandidate: shortSupport,
      })
    : ({ outcome: "REJECTED", reasons: ["NO_ORIENTATION_EVIDENCE"] } as const);
  const thesis: DualSidedThesis = Object.freeze({
    instrumentSymbol: pipelineInput.instrumentSymbol,
    decisionAt: pipelineInput.context.decisionAt,
    observedIn,
    long,
    short,
    policyVersion: thesisBuilderPolicyVersion,
  });
  lineage = advanceLineage({ lineage, to: "THESIS_FORMED", artifactId: sha256CanonicalJson(thesis) });

  return { pipelineInput, thesis, lineage, stages: { candidates, marketState, thesis } };
}

describe("full happy path", () => {
  it("reaches EXECUTED with a complete lineage and a filled LONG side", () => {
    const { pipelineInput, thesis, lineage, stages } = approvedThesisFixture({
      patternObservations: [patternObservation("UP")],
    });
    const run = continuePastThesis(pipelineInput, thesis, lineage, stages);

    expect(run.outcome).toEqual({ kind: "EXECUTED" });
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
      "EDGE_ASSESSED",
      "RISK_APPROVED",
      "INSTRUMENT_SELECTED",
      "EXECUTED",
    ]);
    expect(run.stages.execution?.long.outcome).toBe("APPROVED");
    expect(run.stages.execution?.short.outcome).toBe("REJECTED");
  });
});

describe("P5 stage-level outcomes", () => {
  it("closes with no action when the pattern layer found nothing", () => {
    const run = runDecisionPipeline(input({ patternObservations: [], patternCoverage: "LOADED" }));
    expect(run.outcome).toEqual({ kind: "CLOSED_NO_ACTION", reason: "NO_PATTERNS_OBSERVED" });
    expect(run.lineage).toBeNull();
    expect(run.stages).toEqual({});
  });

  it("defers when the pattern layer was not computed", () => {
    const run = runDecisionPipeline(input({ patternObservations: [], patternCoverage: "NOT_LOADED" }));
    expect(run.outcome.kind).toBe("DEFERRED");
    expect(run.lineage).toBeNull();
  });
});

describe("dies at P6b", () => {
  it("defers when ATR is unavailable, with lineage stopping at MARKET_STATE_INTERPRETED", () => {
    const run = runDecisionPipeline(input({ atrValue: null }));
    expect(run.outcome.kind).toBe("DEFERRED");
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
    ]);
  });

  it("rejects both sides when no orientation evidence supports either, stopping at THESIS_FORMED", () => {
    const run = runDecisionPipeline(input({ patternObservations: [patternObservation("NONE")] }));
    expect(run.outcome).toEqual({
      kind: "REJECTED",
      reasons: ["NO_ORIENTATION_EVIDENCE", "NO_ORIENTATION_EVIDENCE"],
    });
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
    ]);
  });
});

describe("dies at P8 (risk gate)", () => {
  it("rejects both sides identically when the account is at the concurrent-position cap", () => {
    const { pipelineInput, thesis, lineage, stages } = approvedThesisFixture({
      accountSnapshot: accountSnapshot({ openPositionCount: 3 }),
    });
    const run = continuePastThesis(pipelineInput, thesis, lineage, stages);
    expect(run.outcome).toEqual({
      kind: "REJECTED",
      reasons: ["MAX_CONCURRENT_POSITIONS", "MAX_CONCURRENT_POSITIONS"],
    });
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
      "EDGE_ASSESSED",
      "RISK_APPROVED",
    ]);
  });
});

describe("P9 stage-level deferral", () => {
  it("defers when no option chain is available, stopping at RISK_APPROVED", () => {
    const { pipelineInput, thesis, lineage, stages } = approvedThesisFixture({ optionChain: null });
    const run = continuePastThesis(pipelineInput, thesis, lineage, stages);
    expect(run.outcome.kind).toBe("DEFERRED");
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
      "EDGE_ASSESSED",
      "RISK_APPROVED",
    ]);
  });
});

describe("reaches EXECUTED with a mixed fill", () => {
  it("fills LONG while deferring SHORT when only LONG's contract has a fresh quote", () => {
    const { pipelineInput, thesis, lineage, stages } = approvedThesisFixture({
      executionChain: executionChain({ quotes: [quote({ strikePrice: 24_000, optionType: "CE", expiryDate: farExpiry })] }),
    });
    const run = continuePastThesis(pipelineInput, thesis, lineage, stages);
    expect(run.outcome).toEqual({ kind: "EXECUTED" });
    expect(run.stages.execution?.long.outcome).toBe("APPROVED");
    expect(run.stages.execution?.short.outcome).toBe("DEFERRED");
  });
});

describe("both fills dead at P10", () => {
  it("defers even though the lineage reached EXECUTED", () => {
    const { pipelineInput, thesis, lineage, stages } = approvedThesisFixture({ executionChain: null });
    const run = continuePastThesis(pipelineInput, thesis, lineage, stages);
    expect(run.outcome.kind).toBe("DEFERRED");
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
      "EDGE_ASSESSED",
      "RISK_APPROVED",
      "INSTRUMENT_SELECTED",
      "EXECUTED",
    ]);
  });
});

describe("lineage artifactId correctness", () => {
  it("records marketState.interpretationId as the MARKET_STATE_INTERPRETED entry's artifactId", () => {
    const run = runDecisionPipeline(input());
    const entry = run.lineage?.entries.find((candidate) => candidate.state === "MARKET_STATE_INTERPRETED");
    expect(entry?.artifactId).toBe(run.stages.marketState?.interpretationId);
  });
});

describe("determinism", () => {
  it("produces an identical run for the same input twice", () => {
    const sameInput = input();
    expect(runDecisionPipeline(sameInput)).toEqual(runDecisionPipeline(sameInput));
  });
});
