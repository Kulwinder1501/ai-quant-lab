import { describe, expect, it, vi } from "vitest";
import {
  canonicalV2Outcome,
  comparableAction,
  runShadowDecision,
  ShadowDecisionError,
  type ShadowLedgerPort,
} from "./shadow-decision.js";
import {
  structuralGateThesisProducer,
  thesisPolicyVersion,
  type ThesisGateInput,
  type ThesisProducer,
} from "../domain/thesis-producer.js";
import { approved } from "../domain/decision-outcome.js";
import { marketSnapshotFromLegacyContext } from "./market-context-adapter.js";
import { evaluateDifferentialRun } from "../domain/differential-testing.js";
import { legacyThesisComparison } from "./thesis-adapter.js";
import type { BarLabelConvention } from "../../platform/pit/pit-instants.js";

const openTime = new Date("2026-09-02T09:20:00.000Z");
const closeTime = new Date("2026-09-02T09:25:00.000Z");
const convention: BarLabelConvention = "CLOSE_LABELLED";

function snapshot(patternsComputed = true) {
  return marketSnapshotFromLegacyContext({
    context: {
      candle: {
        instrumentId: "instrument-1", timeframe: "5m", openTime, closeTime,
        open: 23_850, high: 23_870, low: 23_840, close: 23_860, volume: 125_000, tickSize: 0.05,
      },
      indicators: [],
      patterns: [],
      priceActionEvents: [],
      patternsComputed,
      priceActionComputed: true,
    },
    instants: {
      eventAt: closeTime,
      knownAt: new Date(closeTime.getTime() + 1_000),
      dataThrough: closeTime,
      dataThroughConvention: convention,
      earliestExecutionAt: new Date(closeTime.getTime() + 2_000),
      referenceAt: new Date(closeTime.getTime() + 2_000),
    },
    labelConvention: convention,
  });
}

function gate(overrides: Partial<ThesisGateInput> = {}): ThesisGateInput {
  return {
    snapshot: snapshot(),
    tapeLiveness: "LIVE",
    executableSides: ["SHORT"],
    insideExecutableWindow: true,
    instrumentSymbol: "NIFTY50",
    ...overrides,
  };
}

function ledger(): ShadowLedgerPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, append: vi.fn(async (input) => { calls.push(input); }) };
}

describe("the producer claims no edge", () => {
  it("abstains on a clean bar instead of inventing a setup", () => {
    /*
     * The honest terminal state. No entry rule in this system has established an edge -- the live book
     * is 362 trades at 39.2% for -Rs 39,924 -- so a plausible-looking rule here would trade, lose, and
     * have its losses attributed to V2.2's architecture rather than to a rule nobody validated.
     */
    const result = structuralGateThesisProducer(gate());

    expect(result.outcome).toBe("NO_ACTION");
    expect(result.outcome === "NO_ACTION" && result.reason).toBe("NO_ESTABLISHED_ENTRY_RULE");
  });

  it("can never return APPROVED, on any input", () => {
    // The property, not an example. If this ever fails someone has added an edge claim.
    const inputs: ThesisGateInput[] = [
      gate(),
      gate({ tapeLiveness: "FROZEN" }),
      gate({ insideExecutableWindow: false }),
      gate({ snapshot: snapshot(false) }),
      gate({ executableSides: [] }),
      gate({ executableSides: ["LONG", "SHORT"] }),
    ];

    for (const input of inputs) {
      expect(structuralGateThesisProducer(input).outcome).not.toBe("APPROVED");
    }
  });

  it("distinguishes abstention from refusal, which is the state of the research programme", () => {
    // A run of abstentions is a healthy V2.2 with no strategy. A run of TAPE_FROZEN is a data problem.
    // Collapsing them would hide which.
    expect(structuralGateThesisProducer(gate({ tapeLiveness: "FROZEN" })).outcome).toBe("REJECTED");
    expect(structuralGateThesisProducer(gate()).outcome).toBe("NO_ACTION");
  });
});

describe("the measured gates, in order", () => {
  it("rejects a frozen tape before reading anything else on the bar", () => {
    /*
     * Order is not cosmetic: every later reading is drawn from a bar whose prices are a
     * republication. A bar that is both frozen AND missing features must record the freeze, because
     * that is the disqualifying fact.
     */
    const result = structuralGateThesisProducer(
      gate({ tapeLiveness: "FROZEN", snapshot: snapshot(false) }),
    );

    expect(result.outcome).toBe("REJECTED");
    expect(result.outcome === "REJECTED" && result.reasons).toEqual(["TAPE_FROZEN"]);
  });

  it("defers rather than rejects when the pattern layer has not been computed", () => {
    // The bar is not disqualified; its features have not arrived. Deferring is recoverable, and a
    // wrong row is not.
    const result = structuralGateThesisProducer(gate({ snapshot: snapshot(false) }));

    expect(result.outcome).toBe("DEFERRED");
    if (result.outcome !== "DEFERRED") throw new Error("unreachable");
    expect(result.reason).toBe("FEATURE_LAYER_NOT_COMPUTED");
    // Null, never a guess: when detection next runs is a scheduler fact this cannot see.
    expect(result.retryAt).toBeNull();
    expect(result.blockingDependency).toMatch(/pattern layer/);
  });

  it("rejects when the instrument has no executable side", () => {
    const result = structuralGateThesisProducer(gate({ executableSides: [] }));

    expect(result.outcome === "REJECTED" && result.reasons).toEqual(["SIDE_NOT_EXECUTABLE"]);
  });

  it("rejects a bar outside an executable session window", () => {
    const result = structuralGateThesisProducer(gate({ insideExecutableWindow: false }));

    expect(result.outcome === "REJECTED" && result.reasons).toEqual(["OUTSIDE_EXECUTABLE_WINDOW"]);
  });
});

describe("the shadow path cannot execute", () => {
  it("has no execution dependency to invoke", async () => {
    /*
     * The enforcement. There is no order repository, position writer or paper-trade port in the
     * signature, so the shadow path cannot trade because the capability is absent -- not because a
     * flag is off. A boolean-guarded "record-only mode" is one inverted condition away from live
     * trading, and this system has already had a timeframe silently produce 89 trades for -Rs 13,858.
     */
    const port = ledger();
    await runShadowDecision({
      decisionId: "decision-1",
      gate: gate(),
      produce: structuralGateThesisProducer,
      ledger: port,
    });

    expect(port.calls).toHaveLength(1);
    // The only port it holds is the ledger, and the only verb on it is append.
    expect(Object.keys(port).filter((k) => k !== "calls")).toEqual(["append"]);
  });

  it("records a refusal under the same rules as any other decision", async () => {
    // Not a dry run: the record is authoritative about what V2.2 decided, and P13 depends on that.
    const port = ledger();
    const record = await runShadowDecision({
      decisionId: "decision-2",
      gate: gate({ tapeLiveness: "FROZEN" }),
      produce: structuralGateThesisProducer,
      ledger: port,
    });

    expect(record.v2Outcome).toBe("REJECTED TAPE_FROZEN");
    expect(record.abstained).toBe(false);
    expect(record.contextSnapshotId).toMatch(/^[a-f0-9]{64}$/);
  });

  it("versions the policy on refusals too, not only on approvals", async () => {
    /*
     * A refusal is as much a product of the policy as an approval. Recording the version only on
     * approvals would leave exactly the rows this producer emits -- all refusals and abstentions
     * today -- as the unversioned ones.
     */
    const record = await runShadowDecision({
      decisionId: "decision-3",
      gate: gate(),
      produce: structuralGateThesisProducer,
      ledger: ledger(),
    });

    expect(record.policyVersions.thesis).toBe(thesisPolicyVersion);
    expect(record.abstained).toBe(true);
  });

  it("refuses an unidentified decision, because the record is real", async () => {
    await expect(runShadowDecision({
      decisionId: "  ",
      gate: gate(),
      produce: structuralGateThesisProducer,
      ledger: ledger(),
    })).rejects.toThrow(ShadowDecisionError);
  });
});

describe("it produces P13 evidence, which is the point", () => {
  it("renders an approval in the same format the legacy side uses", () => {
    /*
     * The comparison is string equality, so two systems formatting differently would diverge on
     * presentation, land in UNKNOWN -- the blocking bucket -- and drown the real findings. One format,
     * one quantisation.
     */
    const v2 = canonicalV2Outcome(approved({
      instrumentSymbol: "NIFTY50", side: "LONG",
      entryReference: 23_850.5, stopLoss: 23_820.25, targetPrice: 23_910.75,
      ruleId: "hypothetical", policyVersion: thesisPolicyVersion,
    }));
    const legacy = legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: closeTime,
      verdict: "APPROVED",
      geometry: { side: "LONG", entryPrice: 23_850.5, stopLoss: 23_820.25, targetPrice: 23_910.75 },
    }).canonicalOutcome;

    expect(v2).toBe(legacy);
  });

  it("feeds a differential run end to end, V1 approving where V2 abstains", async () => {
    /*
     * The shape the shadow path will actually produce today: V1 trades, V2 has no rule. The
     * divergence is real and must be classified -- unexplained, it blocks promotion, which is
     * correct. V2.2 abstaining is not grounds to retire V1.
     */
    const record = await runShadowDecision({
      decisionId: "decision-4",
      gate: gate(),
      produce: structuralGateThesisProducer,
      ledger: ledger(),
    });
    const legacy = legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: closeTime,
      verdict: "APPROVED",
      geometry: { side: "SHORT", entryPrice: 23_860, stopLoss: 23_890, targetPrice: 23_800 },
    });

    const observation = {
      comparisonKey: record.comparisonKey,
      legacySnapshotRef: record.contextSnapshotId,
      v2SnapshotRef: record.contextSnapshotId,
      legacyOutcome: legacy.canonicalOutcome,
      v2Outcome: record.v2Outcome,
    };
    const verdict = evaluateDifferentialRun({
      observations: [observation],
      divergences: [{ observation, evidence: { kind: "UNKNOWN" } }],
    });

    expect(verdict.agreements).toBe(0);
    expect(verdict.byClassification.UNKNOWN).toBe(1);
    expect(verdict.promotable).toBe(false);
  });

  it("accepts a custom producer, which is the slot research delivers into", async () => {
    // The whole point of the seam: everything around the rule already exists and is tested.
    const producer: ThesisProducer = (input) => approved({
      instrumentSymbol: input.instrumentSymbol, side: "SHORT",
      entryReference: 23_860, stopLoss: 23_890, targetPrice: 23_800,
      ruleId: "research-rule-1", policyVersion: thesisPolicyVersion,
    });
    const record = await runShadowDecision({
      decisionId: "decision-5", gate: gate(), produce: producer, ledger: ledger(),
    });

    expect(record.v2Outcome).toBe("APPROVED SHORT entry=23860.00 stop=23890.00 target=23800.00");
    expect(record.abstained).toBe(false);
  });
});

describe("P13 compares the action, not the reason", () => {
  it("treats every refusal as one comparable action", () => {
    /*
     * The correction. The first stored observations compared whole strings, so
     * `NO_ACTION NO_PROPOSAL` diverged from `REJECTED OUTSIDE_EXECUTABLE_WINDOW` even though neither
     * system traded. Every bar would have diverged for as long as V2.2 has no entry rule -- all
     * UNKNOWN, all blockers -- which is the "hundreds of expected divergences is noise" failure the
     * thesis comparison already refuses for composite scores. See migration 093.
     */
    const legacy = comparableAction("NO_ACTION NO_PROPOSAL");
    const v2 = comparableAction("REJECTED OUTSIDE_EXECUTABLE_WINDOW");

    expect(legacy.action).toBe("NO_TRADE");
    expect(v2.action).toBe("NO_TRADE");
    expect(legacy.action).toBe(v2.action);
  });

  it("keeps each reason, because a blocker with nothing to diagnose is useless", () => {
    // promotionBlocker prints both sides, and a reviewer classifying a divergence needs the why.
    expect(comparableAction("REJECTED TAPE_FROZEN").detail).toBe("REJECTED TAPE_FROZEN");
    expect(comparableAction("DEFERRED FEATURE_LAYER_NOT_COMPUTED").detail)
      .toBe("DEFERRED FEATURE_LAYER_NOT_COMPUTED");
  });

  it("keeps an approval's geometry in the action, since that is the substitution question", () => {
    // Two approvals with different stops are genuinely different decisions and must diverge.
    const a = comparableAction("APPROVED SHORT entry=23860.00 stop=23890.00 target=23800.00");
    const b = comparableAction("APPROVED SHORT entry=23860.00 stop=23895.00 target=23800.00");

    expect(a.action).not.toBe(b.action);
    expect(a.detail).toBe("");
  });

  it("diverges when one system trades and the other does not", () => {
    // The case P13 exists for, and the one that must survive the normalisation above.
    const traded = comparableAction("APPROVED SHORT entry=23860.00 stop=23890.00 target=23800.00");
    const declined = comparableAction("NO_ACTION NO_ESTABLISHED_ENTRY_RULE");

    expect(traded.action).not.toBe(declined.action);
  });

  it("uses one implementation for both sides", () => {
    // Two would drift, and a drift here reads as the systems disagreeing rather than the formatters.
    const fromV2 = comparableAction(canonicalV2Outcome(approved({
      instrumentSymbol: "NIFTY50", side: "SHORT",
      entryReference: 23_860, stopLoss: 23_890, targetPrice: 23_800,
      ruleId: "r", policyVersion: thesisPolicyVersion,
    })));
    const fromLegacy = comparableAction(legacyThesisComparison({
      instrumentSymbol: "NIFTY50",
      decisionAt: closeTime,
      verdict: "APPROVED",
      geometry: { side: "SHORT", entryPrice: 23_860, stopLoss: 23_890, targetPrice: 23_800 },
    }).canonicalOutcome);

    expect(fromV2.action).toBe(fromLegacy.action);
  });
});
