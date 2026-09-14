import { describe, expect, it } from "vitest";
import {
  approved,
  deferred,
  isApproved,
  noAction,
  rejected,
} from "./decision-outcome.js";
import {
  assertDecisionPath,
  assertDecisionTransition,
  DecisionTransitionError,
  isTerminalDecisionState,
  LIVE_DECISION_STATES,
  permittedNextStates,
  TERMINAL_DECISION_STATES,
} from "./decision-lifecycle.js";
import {
  advanceLineage,
  artifactApprovedAt,
  assertLineageCarries,
  beginLineage,
  completedStates,
  LineageError,
} from "./decision-lineage.js";

describe("evaluation outcomes", () => {
  it("keeps the four outcomes distinct, because each says a different thing about doing nothing", () => {
    /*
     * REJECTED / DEFERRED / NO_ACTION all produce zero trades. Collapsing any pair is how a pipeline
     * defect starts looking like a decision: the collector-health check keeps INCOMPLETE apart from
     * DEGRADED for the same reason, and the frozen-tape gate defers rather than rejecting because the
     * bar may be republished later in the session.
     */
    const outcomes = new Set([
      rejected(["EXPOSURE_LIMIT"]).outcome,
      deferred({ reason: "SNAPSHOT_MISSING", blockingDependency: "snapshot-registry" }).outcome,
      noAction("NO_QUALIFYING_SETUP").outcome,
      approved({ thing: 1 }).outcome,
    ]);

    expect(outcomes.size).toBe(4);
  });

  it("cannot produce an approval except by supplying a value", () => {
    // Rejection is the default by construction. V1's evaluateRisk had to establish this by hand --
    // "every path that returns early returns a rejection" -- and a later-added check could have
    // broken it silently.
    const result = approved({ thesisId: "thesis-1" });

    expect(isApproved(result)).toBe(true);
    expect(result.value).toEqual({ thesisId: "thesis-1" });
    expect(isApproved(rejected(["NO"]))).toBe(false);
    expect(isApproved(noAction("QUIET"))).toBe(false);
  });

  it("names every rejection reason, not just the first", () => {
    // Reporting one failure hides the rest and makes the next fix look sufficient.
    expect(rejected(["A", "B"]).reasons).toEqual(["A", "B"]);
    expect(() => rejected([])).toThrow(/at least one reason/);
  });

  it("requires a deferral to name what is blocking it", () => {
    /*
     * A deferral without a named dependency is a rejection in practice: nobody can tell what to wait
     * for, so it gets retried blindly or read as a refusal. The dependency is what makes DEFERRED a
     * different answer rather than a softer one.
     */
    expect(() => deferred({ reason: "X", blockingDependency: "  " })).toThrow(/blocking it/);
    expect(deferred({ reason: "X", blockingDependency: "feature-layer" }).blockingDependency)
      .toBe("feature-layer");
  });

  it("makes an uncomputed retryAt explicit rather than absent", () => {
    // Null, not undefined: "we did not compute a retry time" must not read as "retry immediately".
    expect(deferred({ reason: "X", blockingDependency: "d" }).retryAt).toBeNull();
  });

  it("carries no field that could be summed across stages (I18)", () => {
    /*
     * A composite score makes gates commensurable, so a strong reading on one dimension offsets a
     * failure on another. V1's `scoreDirectionalSetup` is quarantined because it was measured to
     * select *bad* shorts while looking confident. A type alone would not stop a later edit adding
     * `score`, so the key sets are pinned.
     */
    expect(Object.keys(approved(1)).sort()).toEqual(["outcome", "value"]);
    expect(Object.keys(rejected(["A"])).sort()).toEqual(["outcome", "reasons"]);
    expect(Object.keys(noAction("A")).sort()).toEqual(["outcome", "reason"]);
    expect(Object.keys(deferred({ reason: "A", blockingDependency: "d" })).sort())
      .toEqual(["blockingDependency", "outcome", "reason", "retryAt"]);
  });

  it("freezes every outcome", () => {
    // These travel into the ledger; a later mutation would leave no trace.
    for (const result of [approved(1), rejected(["A"]), noAction("A"), deferred({ reason: "A", blockingDependency: "d" })]) {
      expect(Object.isFrozen(result)).toBe(true);
    }
  });
});

describe("decision lifecycle", () => {
  it("permits exactly one live successor per stage", () => {
    // The property that makes a skipped stage impossible rather than merely discouraged.
    for (let index = 0; index < LIVE_DECISION_STATES.length - 1; index += 1) {
      const from = LIVE_DECISION_STATES[index]!;
      const live = permittedNextStates(from).filter((state) => !isTerminalDecisionState(state));
      expect(live, from).toEqual([LIVE_DECISION_STATES[index + 1]]);
    }
  });

  it("refuses a transition that skips a stage, and says it is a bypassed control", () => {
    /*
     * I17: ML cannot bypass risk controls. The way that gets violated is not malice but a stage
     * discovering it can construct the next state directly, which is why the transitions are a table
     * rather than an ordered list a caller could index into.
     */
    expect(() => assertDecisionTransition("THESIS_FORMED", "EXECUTED")).toThrow(DecisionTransitionError);
    expect(() => assertDecisionTransition("EDGE_ASSESSED", "INSTRUMENT_SELECTED"))
      .toThrow(/skips RISK_APPROVED.*bypassed \(I17\)/s);
  });

  it("lets any live stage stop, and never lets a stopped decision move", () => {
    for (const state of LIVE_DECISION_STATES) {
      if (state === "EXECUTED") continue;
      for (const terminal of TERMINAL_DECISION_STATES) {
        expect(() => assertDecisionTransition(state, terminal), `${state}->${terminal}`).not.toThrow();
      }
    }
    for (const terminal of TERMINAL_DECISION_STATES) {
      expect(() => assertDecisionTransition(terminal, "CANDIDATE_RESOLVED"), terminal)
        .toThrow(/cannot move again/);
    }
  });

  it("hands everything after execution to the position aggregate", () => {
    // I9: the position supervisor never creates entries, and this decision never manages a position.
    expect(permittedNextStates("EXECUTED")).toEqual([]);
    expect(() => assertDecisionTransition("EXECUTED", "CLOSED_NO_ACTION")).toThrow(/position aggregate/);
  });

  it("refuses a self-transition, which would record a step that did not happen", () => {
    expect(() => assertDecisionTransition("THESIS_FORMED", "THESIS_FORMED")).toThrow(/must change state/);
  });

  it("validates a whole replayed path, including where it starts", () => {
    /*
     * Replay reconstructs a decision from its ledger events, and a path that was never legal cannot be
     * a faithful reconstruction. Checking the whole path also catches a sequence that is pairwise legal
     * but begins in the wrong place.
     */
    expect(() => assertDecisionPath([...LIVE_DECISION_STATES])).not.toThrow();
    expect(() => assertDecisionPath(["CANDIDATE_RESOLVED", "REJECTED"])).not.toThrow();
    expect(() => assertDecisionPath(["MARKET_STATE_INTERPRETED", "THESIS_FORMED"]))
      .toThrow(/must begin at CANDIDATE_RESOLVED/);
    expect(() => assertDecisionPath([])).toThrow(/cannot be empty/);
  });
});

describe("decision lineage (I22, the check the type system cannot make)", () => {
  const chain = () => advanceLineage({
    lineage: beginLineage({ decisionId: "decision-1", candidateId: "candidate-1" }),
    to: "MARKET_STATE_INTERPRETED",
    artifactId: "market-state-1",
  });

  it("records one artifact per completed stage, in order", () => {
    const lineage = chain();

    expect(completedStates(lineage)).toEqual(["CANDIDATE_RESOLVED", "MARKET_STATE_INTERPRETED"]);
    expect(artifactApprovedAt(lineage, "CANDIDATE_RESOLVED")).toBe("candidate-1");
    expect(artifactApprovedAt(lineage, "THESIS_FORMED")).toBeNull();
  });

  it("catches a proof that is well-formed but belongs to another decision", () => {
    /*
     * The gap between I14 and I22. The type system proves a proof was supplied; it cannot prove it is
     * *this* decision's. Two decisions evaluated in the same tick produce structurally identical
     * proofs and the compiler is satisfied by either -- the same class of defect the harness's
     * opportunity resolver throws on when members disagree about their reference evidence.
     */
    expect(() => assertLineageCarries({
      lineage: chain(), decisionId: "decision-2",
      state: "MARKET_STATE_INTERPRETED", artifactId: "market-state-1",
    })).toThrow(/belongs to decision decision-1, not decision-2/);
  });

  it("catches a lineage that names a different artifact than the one supplied", () => {
    expect(() => assertLineageCarries({
      lineage: chain(), decisionId: "decision-1",
      state: "MARKET_STATE_INTERPRETED", artifactId: "market-state-OTHER",
    })).toThrow(/records MARKET_STATE_INTERPRETED artifact market-state-1/);
  });

  it("catches a stage that never ran", () => {
    // Distinct from a mismatch: nothing was approved at that stage at all.
    expect(() => assertLineageCarries({
      lineage: chain(), decisionId: "decision-1",
      state: "RISK_APPROVED", artifactId: "risk-1",
    })).toThrow(/no RISK_APPROVED entry/);
  });

  it("accepts a lineage that genuinely carries the artifact", () => {
    expect(() => assertLineageCarries({
      lineage: chain(), decisionId: "decision-1",
      state: "MARKET_STATE_INTERPRETED", artifactId: "market-state-1",
    })).not.toThrow();
  });

  it("applies the transition table when advancing, not only when validating", () => {
    // Otherwise a lineage could record a legal-looking chain of stages that skipped a control.
    expect(() => advanceLineage({ lineage: chain(), to: "EXECUTED", artifactId: "execution-1" }))
      .toThrow(/not a permitted decision transition/);
  });

  it("records a stage once, guarding a hand-built lineage the transition table cannot catch", () => {
    /*
     * Scoped honestly: `advanceLineage` on its own cannot produce a duplicate stage, because
     * transitions only move one step forward and the self-transition is refused first. The first
     * version of this test asserted the duplicate message and got the transition message instead.
     *
     * The check is still doing work, because `DecisionLineage` is a plain interface a caller can
     * construct. A lineage whose entries loop back -- candidate, market state, candidate -- has a
     * legal-looking previous state and a permitted next transition, and only this check refuses it.
     * Reaching a stage twice would mean the decision was re-evaluated in place, which I15 forbids for
     * ledger history and which makes replay ambiguous.
     */
    const looped = {
      decisionId: "decision-1",
      entries: [
        { state: "CANDIDATE_RESOLVED" as const, artifactId: "candidate-1" },
        { state: "MARKET_STATE_INTERPRETED" as const, artifactId: "market-state-1" },
        { state: "CANDIDATE_RESOLVED" as const, artifactId: "candidate-1" },
      ],
    };

    expect(() => advanceLineage({ lineage: looped, to: "MARKET_STATE_INTERPRETED", artifactId: "market-state-2" }))
      .toThrow(/already appears in this lineage/);
    // And the ordinary path is refused earlier, by the transition table.
    expect(() => advanceLineage({
      lineage: advanceLineage({ lineage: chain(), to: "THESIS_FORMED", artifactId: "thesis-1" }),
      to: "THESIS_FORMED", artifactId: "thesis-2",
    })).toThrow(/must change state/);
  });

  it("is immutable, so a later stage cannot rewrite an earlier approval", () => {
    const lineage = chain();

    expect(Object.isFrozen(lineage)).toBe(true);
    expect(Object.isFrozen(lineage.entries)).toBe(true);
    expect(() => { (lineage.entries as unknown as LineageEntryArray).push({ state: "THESIS_FORMED", artifactId: "x" }); })
      .toThrow();
  });

  it("refuses ids that cannot be joined on", () => {
    expect(() => beginLineage({ decisionId: "", candidateId: "c" })).toThrow(LineageError);
    expect(() => beginLineage({ decisionId: "d", candidateId: "  " })).toThrow(/non-empty id/);
    expect(() => advanceLineage({ lineage: chain(), to: "THESIS_FORMED", artifactId: "" }))
      .toThrow(LineageError);
  });
});

type LineageEntryArray = { push(entry: { state: string; artifactId: string }): number };
