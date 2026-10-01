import { describe, expect, it } from "vitest";
import {
  selectInstrument,
  instrumentSelectionPolicyVersion,
  InstrumentPolicyError,
  type DualSidedInstrumentSelection,
  type InstrumentPolicyInput,
  type SideInstrumentResult,
} from "./instrument-policy.js";
import type { DualSidedRiskApproval, PositionSize, SideRiskResult } from "./risk-approver.js";
import type { ThesisSide } from "./thesis-producer.js";
import type { BaseDecisionContext } from "./decision-context.js";
import type { OptionChainQuote, OptionChainSnapshot } from "../../market-data/domain/option-chain.js";
import { snapshotRefFor, type SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";

const decisionAt = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });
const nearExpiry = new Date("2026-09-14T15:30:00.000Z"); // same day as decisionAt -> 0 DTE
const farExpiry = new Date("2026-09-21T15:30:00.000Z"); // 7 days out -> eligible

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: decisionAt,
  knownAt: new Date(decisionAt.getTime() + 1_000),
  dataThrough: new Date(decisionAt.getTime() - 1),
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(decisionAt.getTime() + 2_000),
  referenceAt: new Date(decisionAt.getTime() + 2_000),
});

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

function approvedRiskSide(side: ThesisSide, overrides: Partial<PositionSize> = {}): SideRiskResult {
  return { outcome: "APPROVED", value: { side, positionSize: positionSize(overrides) } };
}

function rejectedRiskSide(): SideRiskResult {
  return { outcome: "REJECTED", reasons: ["NO_APPROVED_EDGE_FOR_SIDE"] };
}

function risk(overrides: { long?: SideRiskResult; short?: SideRiskResult } = {}): DualSidedRiskApproval {
  return Object.freeze({
    instrumentSymbol: "NIFTY50",
    decisionAt,
    observedIn,
    long: overrides.long ?? approvedRiskSide("LONG"),
    short: overrides.short ?? rejectedRiskSide(),
    policyVersion: "NATIVE_RISK_APPROVAL_POLICY_V1",
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
    policyVersions: Object.freeze({ instrumentSelectionPolicyVersion }),
  });
}

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate: farExpiry,
    expiryKind: "WEEKLY",
    strikePrice: 24000,
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

function defaultQuotes(expiries: readonly { expiryDate: Date; expiryKind: "WEEKLY" }[] = [
  { expiryDate: nearExpiry, expiryKind: "WEEKLY" },
  { expiryDate: farExpiry, expiryKind: "WEEKLY" },
]): OptionChainQuote[] {
  const strikes = [23_900, 24_000, 24_100];
  const quotes: OptionChainQuote[] = [];
  for (const { expiryDate, expiryKind } of expiries) {
    for (const strike of strikes) {
      for (const optionType of ["CE", "PE"] as const) {
        quotes.push(quote({
          expiryDate,
          expiryKind,
          strikePrice: strike,
          optionType,
          providerSymbol: `NIFTY${strike}${optionType}`,
        }));
      }
    }
  }
  return quotes;
}

function chain(overrides: {
  quotes?: OptionChainQuote[];
  underlyingValue?: number | null;
  underlyingSymbol?: string;
  listedExpiries?: { expiryDate: Date; expiryKind: "WEEKLY" }[];
} = {}): OptionChainSnapshot {
  return {
    underlyingSymbol: overrides.underlyingSymbol ?? "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: overrides.underlyingValue === undefined ? 24_000 : overrides.underlyingValue,
    quotes: overrides.quotes ?? defaultQuotes(),
    listedExpiries: overrides.listedExpiries ?? [
      { expiryDate: nearExpiry, expiryKind: "WEEKLY" },
      { expiryDate: farExpiry, expiryKind: "WEEKLY" },
    ],
  };
}

function input(overrides: Partial<InstrumentPolicyInput> = {}): InstrumentPolicyInput {
  return {
    risk: risk(),
    context: context(),
    optionChain: chain(),
    ...overrides,
  };
}

function approvedSelection(overrides: Partial<InstrumentPolicyInput> = {}): DualSidedInstrumentSelection {
  const result = selectInstrument(input(overrides));
  if (result.outcome !== "APPROVED") throw new Error(`Expected APPROVED, got ${result.outcome}.`);
  return result.value;
}

function expectApprovedSide(side: SideInstrumentResult) {
  if (side.outcome !== "APPROVED") throw new Error(`Expected APPROVED side, got ${side.outcome}.`);
  return side.value;
}

function expectRejectedSide(side: SideInstrumentResult) {
  if (side.outcome !== "REJECTED") throw new Error(`Expected REJECTED side, got ${side.outcome}.`);
  return side.reasons;
}

describe("stage-level deferral", () => {
  it("defers when optionChain is null", () => {
    const result = selectInstrument(input({ optionChain: null }));
    expect(result.outcome).toBe("DEFERRED");
    if (result.outcome === "DEFERRED") expect(result.reason).toBe("OPTION_CHAIN_NOT_AVAILABLE");
  });

  it("defers when the chain has no quotes", () => {
    const result = selectInstrument(input({ optionChain: chain({ quotes: [] }) }));
    expect(result.outcome).toBe("DEFERRED");
  });

  it("defers when the chain has no underlying value", () => {
    const result = selectInstrument(input({ optionChain: chain({ underlyingValue: null }) }));
    expect(result.outcome).toBe("DEFERRED");
  });
});

describe("contract selection correctness", () => {
  it("selects the exact ATM strike, CE for LONG, at the eligible expiry", () => {
    const selection = approvedSelection();
    const long = expectApprovedSide(selection.long);
    expect(long.contract.strikePrice).toBe(24_000);
    expect(long.contract.optionType).toBe("CE");
    expect(long.contract.expiryDate).toEqual(farExpiry);
    expect(long.contract.moneyness).toBe("ATM");
  });

  it("selects PE for SHORT when SHORT was approved upstream", () => {
    const selection = approvedSelection({
      risk: risk({ long: approvedRiskSide("LONG"), short: approvedRiskSide("SHORT") }),
    });
    const short = expectApprovedSide(selection.short);
    expect(short.contract.optionType).toBe("PE");
  });
});

describe("expiry floor", () => {
  it("rejects with NO_ELIGIBLE_EXPIRY when the only listed expiry is 0-DTE", () => {
    const zeroDteChain = chain({
      quotes: defaultQuotes([{ expiryDate: nearExpiry, expiryKind: "WEEKLY" }]),
      listedExpiries: [{ expiryDate: nearExpiry, expiryKind: "WEEKLY" }],
    });
    const selection = approvedSelection({ optionChain: zeroDteChain });
    expect(expectRejectedSide(selection.long)).toEqual(["NO_ELIGIBLE_EXPIRY"]);
  });

  it("selects the later expiry when both a 0-DTE and an eligible expiry are listed", () => {
    const selection = approvedSelection();
    expect(expectApprovedSide(selection.long).contract.expiryDate).toEqual(farExpiry);
  });
});

describe("eligibility gates", () => {
  it("rejects with SPREAD_TOO_WIDE when the contract has no two-sided quote", () => {
    const quotes = defaultQuotes().map((q) =>
      q.strikePrice === 24_000 && q.optionType === "CE" && q.expiryDate.getTime() === farExpiry.getTime()
        ? { ...q, bid: null, ask: null }
        : q);
    const selection = approvedSelection({ optionChain: chain({ quotes }) });
    expect(expectRejectedSide(selection.long)).toEqual(["SPREAD_TOO_WIDE"]);
  });

  it("rejects with SPREAD_TOO_WIDE when the spread exceeds the ceiling", () => {
    const quotes = defaultQuotes().map((q) =>
      q.strikePrice === 24_000 && q.optionType === "CE" && q.expiryDate.getTime() === farExpiry.getTime()
        ? { ...q, bid: 95, ask: 105 } // mid 100, spread 10%
        : q);
    const selection = approvedSelection({ optionChain: chain({ quotes }) });
    expect(expectRejectedSide(selection.long)).toEqual(["SPREAD_TOO_WIDE"]);
  });

  it("rejects with OPEN_INTEREST_DECREASING when the contract's OI is falling", () => {
    const quotes = defaultQuotes().map((q) =>
      q.strikePrice === 24_000 && q.optionType === "CE" && q.expiryDate.getTime() === farExpiry.getTime()
        ? { ...q, openInterestChange: -50 }
        : q);
    const selection = approvedSelection({ optionChain: chain({ quotes }) });
    expect(expectRejectedSide(selection.long)).toEqual(["OPEN_INTEREST_DECREASING"]);
  });

  it("rejects with CONTRACT_SIZE_IMPLAUSIBLE when the lot size implies a below-floor contract", () => {
    const selection = approvedSelection({
      risk: risk({ long: approvedRiskSide("LONG", { lotSize: 1 }) }),
    });
    expect(expectRejectedSide(selection.long)).toEqual(["CONTRACT_SIZE_IMPLAUSIBLE"]);
  });
});

describe("independent per-side evaluation", () => {
  it("selects LONG while rejecting SHORT when only LONG was approved upstream in risk", () => {
    const selection = approvedSelection();
    expect(selection.long.outcome).toBe("APPROVED");
    expect(expectRejectedSide(selection.short)).toEqual(["NO_APPROVED_RISK_FOR_SIDE"]);
  });

  it("selects independent contracts for both sides when both were approved upstream", () => {
    const selection = approvedSelection({
      risk: risk({ long: approvedRiskSide("LONG"), short: approvedRiskSide("SHORT") }),
    });
    const long = expectApprovedSide(selection.long);
    const short = expectApprovedSide(selection.short);
    expect(long.contract.optionType).toBe("CE");
    expect(short.contract.optionType).toBe("PE");
  });
});

describe("positionSize passthrough", () => {
  it("carries the exact PositionSize from the risk side, unchanged", () => {
    const customSize = positionSize({ quantity: 150, estimatedRiskAmount: 7_500 });
    const selection = approvedSelection({
      risk: risk({ long: { outcome: "APPROVED", value: { side: "LONG", positionSize: customSize } } }),
    });
    expect(expectApprovedSide(selection.long).positionSize).toEqual(customSize);
  });
});

describe("structural no-composite-score proof", () => {
  it("pins DualSidedInstrumentSelection's exact key set", () => {
    expect(Object.keys(approvedSelection()).sort()).toEqual([
      "decisionAt",
      "instrumentSymbol",
      "long",
      "observedIn",
      "policyVersion",
      "short",
    ]);
  });

  it("pins an approved SideInstrumentSelection's and SelectedContract's exact key sets", () => {
    const long = expectApprovedSide(approvedSelection().long);
    expect(Object.keys(long).sort()).toEqual(["contract", "positionSize", "side"]);
    expect(Object.keys(long.contract).sort()).toEqual([
      "expiryDate",
      "expiryKind",
      "moneyness",
      "optionType",
      "spreadPercentOfMid",
      "strikePrice",
    ]);
  });

  it("invents no score/composite/rank/weight field anywhere", () => {
    const selection = approvedSelection();
    const long = expectApprovedSide(selection.long);
    for (const key of [...Object.keys(selection), ...Object.keys(long), ...Object.keys(long.contract)]) {
      expect(key).not.toMatch(/score|composite|rank|weight/i);
    }
  });
});

describe("input validation", () => {
  it("throws when optionChain.underlyingSymbol does not match risk.instrumentSymbol", () => {
    expect(() => selectInstrument(input({ optionChain: chain({ underlyingSymbol: "BANKNIFTY" }) })))
      .toThrow(InstrumentPolicyError);
  });
});

describe("freezing and determinism", () => {
  it("freezes the selection and each approved side", () => {
    const selection = approvedSelection();
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.long)).toBe(true);
  });

  it("produces an identical selection for the same input twice", () => {
    const sameInput = input();
    expect(approvedSelection(sameInput)).toEqual(approvedSelection(sameInput));
  });
});
