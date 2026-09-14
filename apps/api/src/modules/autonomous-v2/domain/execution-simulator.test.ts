import { describe, expect, it } from "vitest";
import {
  simulateExecution,
  executionSimulationPolicyVersion,
  ExecutionSimulatorError,
  type DualSidedExecutionFill,
  type ExecutionSimulationInput,
  type SideExecutionResult,
} from "./execution-simulator.js";
import type { DualSidedInstrumentSelection, SelectedContract, SideInstrumentResult } from "./instrument-policy.js";
import type { PositionSize } from "./risk-approver.js";
import type { ThesisSide } from "./thesis-producer.js";
import type { BaseDecisionContext } from "./decision-context.js";
import type { OptionChainQuote, OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { calculateEntryFees } from "../../paper-trading/domain/brokerage-calculator.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";

const decisionAt = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });
const expiryDate = new Date("2026-09-21T15:30:00.000Z");

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: decisionAt,
  knownAt: new Date(decisionAt.getTime() + 1_000),
  dataThrough: new Date(decisionAt.getTime() - 1),
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(decisionAt.getTime() + 2_000),
  referenceAt: new Date(decisionAt.getTime() + 2_000),
});

function contract(overrides: Partial<SelectedContract> = {}): SelectedContract {
  return {
    strikePrice: 24_000,
    optionType: "CE",
    expiryDate,
    expiryKind: "WEEKLY",
    moneyness: "ATM",
    spreadPercentOfMid: 2,
    ...overrides,
  };
}

function positionSize(overrides: Partial<PositionSize> = {}): PositionSize {
  return {
    quantity: 75,
    lotSize: 75,
    riskPerUnit: 50,
    estimatedRiskAmount: 3_750,
    notional: 1_800_000,
    capitalRequired: 360_000,
    ...overrides,
  };
}

function approvedInstrumentSide(overrides: {
  side?: ThesisSide;
  contract?: Partial<SelectedContract>;
  positionSize?: Partial<PositionSize>;
} = {}): SideInstrumentResult {
  return {
    outcome: "APPROVED",
    value: {
      side: overrides.side ?? "LONG",
      contract: contract(overrides.contract),
      positionSize: positionSize(overrides.positionSize),
    },
  };
}

function rejectedInstrumentSide(): SideInstrumentResult {
  return { outcome: "REJECTED", reasons: ["NO_APPROVED_RISK_FOR_SIDE"] };
}

function instrument(overrides: { long?: SideInstrumentResult; short?: SideInstrumentResult } = {}): DualSidedInstrumentSelection {
  return Object.freeze({
    instrumentSymbol: "NIFTY50",
    decisionAt,
    observedIn,
    long: overrides.long ?? approvedInstrumentSide({ side: "LONG" }),
    short: overrides.short ?? rejectedInstrumentSide(),
    policyVersion: "NATIVE_INSTRUMENT_SELECTION_POLICY_V1",
  });
}

function context(): Readonly<BaseDecisionContext> {
  return Object.freeze({
    decisionId: "decision-1",
    decisionAt,
    evaluationAt: decisionAt,
    schedulerLagMs: 0,
    instants,
    snapshotRef: observedIn,
    policyVersions: Object.freeze({ executionSimulationPolicyVersion }),
  });
}

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate,
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

function chain(overrides: {
  quotes?: OptionChainQuote[];
  underlyingSymbol?: string;
} = {}): OptionChainSnapshot {
  return {
    underlyingSymbol: overrides.underlyingSymbol ?? "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: 24_000,
    quotes: overrides.quotes ?? [quote(), quote({ optionType: "PE" })],
    listedExpiries: [{ expiryDate, expiryKind: "WEEKLY" }],
  };
}

function input(overrides: Partial<ExecutionSimulationInput> = {}): ExecutionSimulationInput {
  return {
    instrument: instrument(),
    context: context(),
    executionChain: chain(),
    ...overrides,
  };
}

function approvedFill(overrides: Partial<ExecutionSimulationInput> = {}): DualSidedExecutionFill {
  const result = simulateExecution(input(overrides));
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

function expectApprovedSide(side: SideExecutionResult) {
  if (side.outcome !== "APPROVED") throw new Error(`Expected APPROVED side, got ${side.outcome}.`);
  return side.value;
}

function expectRejectedSide(side: SideExecutionResult) {
  if (side.outcome !== "REJECTED") throw new Error(`Expected REJECTED side, got ${side.outcome}.`);
  return side.reasons;
}

function expectDeferredSide(side: SideExecutionResult) {
  if (side.outcome !== "DEFERRED") throw new Error(`Expected DEFERRED side, got ${side.outcome}.`);
  return side;
}

describe("fill correctness", () => {
  it("computes the exact expected lots, entryFees, and totalCost for a known ask/quantity/lotSize", () => {
    const fill = expectApprovedSide(approvedFill().long);
    expect(fill.fillPremium).toBe(102);
    expect(fill.lots).toBe(1); // quantity 75 / lotSize 75
    const expectedFees = calculateEntryFees(102, 75);
    expect(fill.entryFees).toEqual(expectedFees);
    expect(fill.totalCost).toBeCloseTo(expectedFees.turnover + expectedFees.total, 10);
  });

  it("computes multiple lots correctly", () => {
    const fill = expectApprovedSide(approvedFill({
      instrument: instrument({
        long: approvedInstrumentSide({ side: "LONG", positionSize: { quantity: 225, lotSize: 75 } }),
      }),
    }).long);
    expect(fill.lots).toBe(3);
  });
});

describe("per-side deferral, not rejection", () => {
  it("defers when executionChain is null", () => {
    const result = simulateExecution(input({ executionChain: null }));
    if (result.outcome !== "APPROVED") throw new Error("expected stage-level APPROVED");
    expectDeferredSide(result.value.long);
  });

  it("defers when the chain has no quote for the exact selected contract", () => {
    const result = simulateExecution(input({
      executionChain: chain({ quotes: [quote({ strikePrice: 24_100 })] }),
    }));
    if (result.outcome !== "APPROVED") throw new Error("expected stage-level APPROVED");
    expectDeferredSide(result.value.long);
  });

  it("defers when the matching quote has no usable ask", () => {
    const result = simulateExecution(input({
      executionChain: chain({ quotes: [quote({ ask: null }), quote({ optionType: "PE" })] }),
    }));
    if (result.outcome !== "APPROVED") throw new Error("expected stage-level APPROVED");
    expectDeferredSide(result.value.long);
  });
});

describe("independent per-side evaluation", () => {
  it("fills LONG while rejecting SHORT when only LONG was approved upstream", () => {
    const fill = approvedFill();
    expect(fill.long.outcome).toBe("APPROVED");
    expect(expectRejectedSide(fill.short)).toEqual(["NO_APPROVED_INSTRUMENT_FOR_SIDE"]);
  });

  it("fills both sides independently when both were approved upstream and quoted", () => {
    const fill = approvedFill({
      instrument: instrument({
        long: approvedInstrumentSide({ side: "LONG", contract: { optionType: "CE" } }),
        short: approvedInstrumentSide({ side: "SHORT", contract: { optionType: "PE" } }),
      }),
    });
    const long = expectApprovedSide(fill.long);
    const short = expectApprovedSide(fill.short);
    expect(long.contract.optionType).toBe("CE");
    expect(short.contract.optionType).toBe("PE");
  });
});

describe("contract passthrough (I8)", () => {
  it("carries the exact SelectedContract from P9, unchanged", () => {
    const customContract = contract({ strikePrice: 24_200, spreadPercentOfMid: 1.5 });
    const fill = approvedFill({
      instrument: instrument({
        long: {
          outcome: "APPROVED",
          value: { side: "LONG", contract: customContract, positionSize: positionSize() },
        },
      }),
      executionChain: chain({ quotes: [quote({ strikePrice: 24_200 })] }),
    });
    expect(expectApprovedSide(fill.long).contract).toEqual(customContract);
  });
});

describe("never refuses at the stage level", () => {
  it("still yields an APPROVED DualSidedExecutionFill when both sides were unapproved upstream", () => {
    const result = simulateExecution(input({
      instrument: instrument({ long: rejectedInstrumentSide(), short: rejectedInstrumentSide() }),
    }));
    expect(result.outcome).toBe("APPROVED");
    if (result.outcome === "APPROVED") {
      expect(result.value.long.outcome).toBe("REJECTED");
      expect(result.value.short.outcome).toBe("REJECTED");
    }
  });

  it("still yields an APPROVED DualSidedExecutionFill when there is no chain at all", () => {
    const result = simulateExecution(input({ executionChain: null }));
    expect(result.outcome).toBe("APPROVED");
  });
});

describe("structural no-composite-score proof", () => {
  it("pins DualSidedExecutionFill's exact key set", () => {
    expect(Object.keys(approvedFill()).sort()).toEqual([
      "decisionAt",
      "instrumentSymbol",
      "long",
      "observedIn",
      "policyVersion",
      "short",
    ]);
  });

  it("pins an approved ExecutionFill's exact key set", () => {
    const long = expectApprovedSide(approvedFill().long);
    expect(Object.keys(long).sort()).toEqual([
      "contract",
      "entryFees",
      "fillPremium",
      "fillSource",
      "lots",
      "quantity",
      "side",
      "totalCost",
    ]);
  });

  it("invents no score/composite/rank/weight field anywhere", () => {
    const fill = approvedFill();
    const long = expectApprovedSide(fill.long);
    for (const key of [...Object.keys(fill), ...Object.keys(long)]) {
      expect(key).not.toMatch(/score|composite|rank|weight/i);
    }
  });
});

describe("input validation", () => {
  it("throws when executionChain.underlyingSymbol does not match instrument.instrumentSymbol", () => {
    expect(() => simulateExecution(input({ executionChain: chain({ underlyingSymbol: "BANKNIFTY" }) })))
      .toThrow(ExecutionSimulatorError);
  });
});

describe("freezing and determinism", () => {
  it("freezes the fill and each approved side", () => {
    const fill = approvedFill();
    expect(Object.isFrozen(fill)).toBe(true);
    expect(Object.isFrozen(fill.long)).toBe(true);
  });

  it("produces an identical fill for the same input twice", () => {
    const sameInput = input();
    expect(approvedFill(sameInput)).toEqual(approvedFill(sameInput));
  });
});
