import {
  deferred,
  noAction,
  rejected,
  type EvaluationResult,
} from "./decision-outcome.js";
import type { MarketSnapshot } from "../application/market-context-adapter.js";

/**
 * The thesis-producer slot: the one thing V2.2 was missing, and the only reason V1 cannot be retired.
 *
 * V2.2 could already record a decision, seal its context, attribute its outcome and replay it. What it
 * could not do was *decide*. §6 forbids the shortcut — `ThesisAdapter` is "differential analysis only,
 * not live decisions" — because wiring V1's scorer in would rebuild V1 with better bookkeeping and
 * inherit the part that does not work.
 *
 * The legal route is §6's KEEP AS PRINCIPLE bucket: *"Extract the behavioral rule, prove it under V2.2
 * tests — do not copy code verbatim."* So a native thesis is a re-derived rule set, and no machine
 * learning is required to make V2.2 tradeable.
 *
 * ## This producer claims no edge, deliberately
 *
 * `structuralGateThesisProducer` implements only gates that have been **measured**, and then abstains.
 * It can return `REJECTED` and `DEFERRED`; it can never return `APPROVED`, because no entry rule in
 * this system has established an edge. Across triple-barrier, 15m direction, HTF confluence, pattern
 * gating, the tier sweep and RAG retrieval the answer has been no, and the live book is 362 trades at
 * 39.2% for −Rs 39,924.
 *
 * Writing a plausible-looking entry rule here to make the slot "complete" would be the worst thing
 * this file could do: it would look like a working strategy, it would trade, and its losses would be
 * attributed to V2.2's architecture rather than to a rule nobody validated.
 *
 * So the missing piece is *named* instead of filled: `NO_ESTABLISHED_ENTRY_RULE`. When research
 * produces a rule that clears its gates, it slots into exactly one place, and everything around it —
 * sealing, ledger, outcomes, replay, differential comparison — already exists and is tested.
 *
 * ## What the gates are, and why only these
 *
 * Each one is a finding this system paid for:
 *
 * | Gate | Outcome | Why it is here |
 * | :--- | :--- | :--- |
 * | Frozen tape | `REJECTED` | D3. The index feed republishes its last print from 15:16 to the close; 52 control points were refused in one minute on 2026-09-01, and 41 proposals had already been stored at prices nobody was quoting. |
 * | Pattern layer not computed | `DEFERRED` | 46% of scalp evaluations on 2026-08-24 read an uncomputed layer; firing rate fell 93% and nothing could see why. Deferring is recoverable, a wrong row is not. |
 * | Non-executable side | `REJECTED` | Measured per strategy: the long side is −Rs 13,414 over 62 trades on the index scalp and −Rs 8,531 over 36 on pattern confluence. |
 * | No established entry rule | `NO_ACTION` | The honest terminal state. See above. |
 *
 * There is no confidence score and no composite. A single number summarising a bar is where V1's
 * quarantined scorer would take up residence, and `MarketSnapshot` deliberately does not carry one.
 */

export const thesisPolicyVersion = "NATIVE_THESIS_POLICY_V1";

export type ThesisRefusal =
  | "TAPE_FROZEN"
  | "FEATURE_LAYER_NOT_COMPUTED"
  | "SIDE_NOT_EXECUTABLE"
  | "OUTSIDE_EXECUTABLE_WINDOW"
  | "NO_ESTABLISHED_ENTRY_RULE"
  /**
   * Two or more candidate theses and nothing entitled to choose between them.
   *
   * A V2.2 gap, not a legacy one: I3's Opportunity Resolver is what selects, and it does not exist.
   * Any producer that yields two candidates hits this wall, so the name carries no "legacy" prefix.
   *
   * Refusing is the whole point. Ranking candidates by a score is `scoreDirectionalSetup` rebuilt, and
   * taking the first is `patterns[0]` -- both quarantined by name. A producer that quietly picked one
   * would be inventing the decision logic §6 forbids adapters from holding.
   */
  | "AMBIGUOUS_PROPOSALS";

export type ThesisSide = "LONG" | "SHORT";

/**
 * What an approved native thesis would be.
 *
 * Defined even though nothing produces one yet, because the shape is what research has to deliver
 * into — and because `EvaluationResult<NativeThesis, …>` is what the shadow path and P13 both consume.
 * Geometry is required: a thesis that cannot say where it exits is not a thesis.
 */
export interface NativeThesis {
  readonly instrumentSymbol: string;
  readonly side: ThesisSide;
  readonly entryReference: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  /** Which rule produced it, so an outcome can be attributed to a named rule rather than to V2.2. */
  readonly ruleId: string;
  readonly policyVersion: string;
}

export type ThesisResult = EvaluationResult<NativeThesis, ThesisRefusal>;

/** Everything the producer needs that is not on the snapshot itself. */
export interface ThesisGateInput {
  readonly snapshot: MarketSnapshot;
  /** From `assessTapeLiveness`, resolved by the caller against the bar's predecessors. */
  readonly tapeLiveness: "LIVE" | "FROZEN";
  /** The sides this instrument's strategy may trade, from the operational registry's measurement. */
  readonly executableSides: readonly ThesisSide[];
  /** Whether the bar sits inside a session the calendar declares executable. */
  readonly insideExecutableWindow: boolean;
  readonly instrumentSymbol: string;
}

export type ThesisProducer = (input: ThesisGateInput) => ThesisResult;

/**
 * Whether a producer may ever hold live authority.
 *
 * §6 licenses `ThesisAdapter` for "differential analysis only, **not live decisions**". A producer
 * built on V1's rules is legal evidence and illegal authority, and the difference cannot live in a
 * comment: the shadow path executes nothing today, but P19 will grant paper authority to *some*
 * producer, and at that moment the distinction has to be machine-checkable.
 *
 * `NATIVE` means the rule was re-derived and proved under V2.2's own tests -- §6's KEEP AS PRINCIPLE
 * route. `DIFFERENTIAL_ONLY` means it reaches legacy decision logic and may only ever be compared.
 */
export type ThesisAuthority = "NATIVE" | "DIFFERENTIAL_ONLY";

export interface AuthorizedThesisProducer {
  readonly producerId: string;
  readonly authority: ThesisAuthority;
  readonly produce: ThesisProducer;
}

export class ThesisAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThesisAuthorityError";
  }
}

/**
 * The gate P19 must call before letting a producer's theses reach an execution path.
 *
 * Throws rather than returning false. A boolean would be checked in one caller and forgotten in the
 * next, and the failure mode is a legacy-derived thesis trading under V2.2's name -- which would make
 * V1's losses read as V2.2's architecture failing. The shadow path needs no such guard because it
 * holds no execution port at all; this exists for the path that will.
 */
export function assertMayHoldAuthority(producer: AuthorizedThesisProducer): void {
  if (producer.authority === "DIFFERENTIAL_ONLY") {
    throw new ThesisAuthorityError(
      `Producer ${producer.producerId} is DIFFERENTIAL_ONLY and cannot hold live authority. Brain `
      + "V2.2 Section 6 licenses a legacy-derived thesis for differential analysis only, not live "
      + "decisions. To trade this rule, re-derive it as a native producer and prove it under V2.2 "
      + "tests -- that is the KEEP AS PRINCIPLE route, and it is deliberately not a flag.",
    );
  }
}


/**
 * The gate order is not cosmetic.
 *
 * A frozen tape is checked before anything else because every later reading is drawn from a bar whose
 * prices are a republication — evaluating features on it produces a confident answer about a price
 * nobody was quoting. The window check follows, then coverage, then sides, and the abstention is
 * last: it is the only branch that means "everything was fine and we still have no rule".
 *
 * Ordering matters for the report as much as the logic: the first refusal is the one recorded, so a
 * bar refused for a frozen tape must not be recorded as missing features.
 */
export const structuralGateThesisProducer: ThesisProducer = (input) => {
  if (input.tapeLiveness === "FROZEN") {
    return rejected<ThesisRefusal>(["TAPE_FROZEN"]);
  }

  if (!input.insideExecutableWindow) {
    return rejected<ThesisRefusal>(["OUTSIDE_EXECUTABLE_WINDOW"]);
  }

  if (input.snapshot.patternCoverage === "NOT_LOADED") {
    /*
     * Deferred rather than rejected, and the distinction is the point: the bar is not disqualified,
     * its features have not arrived. `retryAt` is null because when the detection pass next runs is
     * a scheduler fact this function cannot see, and null is required to mean "not computed" rather
     * than "retry immediately".
     */
    return deferred<ThesisRefusal>({
      reason: "FEATURE_LAYER_NOT_COMPUTED",
      retryAt: null,
      blockingDependency: "candlestick pattern layer for this bar",
    });
  }

  if (input.executableSides.length === 0) {
    return rejected<ThesisRefusal>(["SIDE_NOT_EXECUTABLE"]);
  }

  /*
   * Everything structural passed, and there is still no rule to apply.
   *
   * NO_ACTION rather than REJECTED: nothing about this bar was wrong. Reporting it as a rejection
   * would put every clean bar in the same bucket as a frozen tape, and the difference between "we
   * refused this setup" and "we have no way to evaluate any setup" is the entire state of the
   * research programme.
   */
  return noAction<ThesisRefusal>("NO_ESTABLISHED_ENTRY_RULE");
};

/**
 * True when a result means "the machinery worked and had nothing to propose".
 *
 * Exposed because the shadow path and P13 both need to tell this apart from a refusal: a run of these
 * is a healthy V2.2 with no strategy, whereas a run of `TAPE_FROZEN` is a data problem.
 */
export function isAbstention(result: ThesisResult): boolean {
  return result.outcome === "NO_ACTION" && result.reason === "NO_ESTABLISHED_ENTRY_RULE";
}

/** V2.2's own producer. Native because it re-derives every gate it applies and claims no edge. */
export const nativeStructuralProducer: AuthorizedThesisProducer = Object.freeze({
  producerId: "structural-gate-v1",
  authority: "NATIVE",
  produce: structuralGateThesisProducer,
});
