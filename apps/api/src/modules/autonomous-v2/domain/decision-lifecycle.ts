/**
 * The decision lifecycle: one state per pipeline stage, and the transitions between them.
 *
 * ## The states are derived from the frozen pipeline, not invented
 *
 * Brain V2.2 §2 specifies seven state-carrying proofs — `CandidateApproved` through
 * `ExecutionApproved` — and the ledger event carries `stateFrom`/`stateTo` without enumerating the
 * states. These are those seven stages, plus the three ways a decision can stop.
 *
 * ## Why a table rather than an ordered list
 *
 * An ordered list would let a caller advance by index, and "advance one step" is exactly the operation
 * that must not exist: I17 says ML cannot bypass risk controls, and the way that gets violated is not
 * malice but a stage discovering it can construct the next state directly. A table makes
 * `THESIS_FORMED -> EXECUTED` an error with a name rather than an arithmetic possibility.
 *
 * The terminal states are reachable from every live stage, because any stage may refuse, defer, or
 * conclude that nothing should happen. Nothing is reachable *from* a terminal state — a decision that
 * stopped is finished, and the ledger is append-only (I15), so a resumption is a new decision with its
 * own identity rather than a revival of this one.
 */

export const LIVE_DECISION_STATES = [
  "CANDIDATE_RESOLVED",
  "MARKET_STATE_INTERPRETED",
  "THESIS_FORMED",
  "EDGE_ASSESSED",
  "RISK_APPROVED",
  "INSTRUMENT_SELECTED",
  "EXECUTED",
] as const;

export const TERMINAL_DECISION_STATES = ["REJECTED", "DEFERRED", "CLOSED_NO_ACTION"] as const;

export type LiveDecisionState = (typeof LIVE_DECISION_STATES)[number];
export type TerminalDecisionState = (typeof TERMINAL_DECISION_STATES)[number];
export type DecisionState = LiveDecisionState | TerminalDecisionState;

export class DecisionTransitionError extends Error {
  constructor(readonly from: DecisionState, readonly to: DecisionState, detail: string) {
    super(`${from} -> ${to} is not a permitted decision transition: ${detail}`);
    this.name = "DecisionTransitionError";
  }
}

/**
 * The one legal successor of each live stage, plus the terminals every stage may reach.
 *
 * Written out rather than generated from the ordered list. Generating it would reintroduce the
 * "advance by index" operation this table exists to remove, and would make a future insertion of a
 * stage silently renumber every transition instead of failing a test.
 */
const PERMITTED_TRANSITIONS: Readonly<Record<DecisionState, readonly DecisionState[]>> = Object.freeze({
  CANDIDATE_RESOLVED: ["MARKET_STATE_INTERPRETED", ...TERMINAL_DECISION_STATES],
  MARKET_STATE_INTERPRETED: ["THESIS_FORMED", ...TERMINAL_DECISION_STATES],
  THESIS_FORMED: ["EDGE_ASSESSED", ...TERMINAL_DECISION_STATES],
  EDGE_ASSESSED: ["RISK_APPROVED", ...TERMINAL_DECISION_STATES],
  RISK_APPROVED: ["INSTRUMENT_SELECTED", ...TERMINAL_DECISION_STATES],
  INSTRUMENT_SELECTED: ["EXECUTED", ...TERMINAL_DECISION_STATES],
  // Execution is the last live state. A position's own lifecycle is the Position Aggregate's, not
  // this one's -- event sourcing is scoped to two aggregates and conflating them would put position
  // management inside the decision that opened it (I9).
  EXECUTED: [],
  REJECTED: [],
  DEFERRED: [],
  CLOSED_NO_ACTION: [],
});

export function isTerminalDecisionState(state: DecisionState): state is TerminalDecisionState {
  return (TERMINAL_DECISION_STATES as readonly string[]).includes(state);
}

/** The states a decision may move to from here. Empty for every terminal state, and for EXECUTED. */
export function permittedNextStates(from: DecisionState): readonly DecisionState[] {
  return PERMITTED_TRANSITIONS[from];
}

/**
 * Validates one transition, or throws with the reason.
 *
 * Throws rather than returning false: a caller that ignored a boolean would append a ledger event
 * describing a transition that never legally happened, and the ledger is the record everything else
 * is reconstructed from (I13, I15).
 */
export function assertDecisionTransition(from: DecisionState, to: DecisionState): void {
  if (isTerminalDecisionState(from)) {
    throw new DecisionTransitionError(from, to, "a decision that has stopped cannot move again; start a new decision");
  }
  if (from === "EXECUTED") {
    throw new DecisionTransitionError(from, to, "the position aggregate owns everything after execution (I9)");
  }
  if (from === to) {
    throw new DecisionTransitionError(from, to, "a transition must change state, or the ledger records a step that did not happen");
  }
  const permitted = PERMITTED_TRANSITIONS[from];
  if (!permitted.includes(to)) {
    const skipped = LIVE_DECISION_STATES.indexOf(to as LiveDecisionState) > LIVE_DECISION_STATES.indexOf(from as LiveDecisionState) + 1;
    throw new DecisionTransitionError(
      from,
      to,
      skipped
        ? `it skips ${LIVE_DECISION_STATES[LIVE_DECISION_STATES.indexOf(from as LiveDecisionState) + 1]}, `
          + "and a stage that can be skipped is a control that can be bypassed (I17)"
        : `permitted: ${permitted.join(", ") || "(none)"}`,
    );
  }
}

/**
 * Validates a whole path, for replay.
 *
 * Replay (P12) reconstructs a decision from its ledger events, and a path that was never legal cannot
 * be a faithful reconstruction of one that happened. Checking the whole path rather than each pair
 * independently also catches a sequence that is pairwise legal but starts in the wrong place.
 */
export function assertDecisionPath(path: readonly DecisionState[]): void {
  if (path.length === 0) throw new Error("A decision path cannot be empty.");
  if (path[0] !== "CANDIDATE_RESOLVED") {
    throw new Error(
      `A decision path must begin at CANDIDATE_RESOLVED; got ${path[0]}. Every decision starts from a `
      + "resolved candidate, so a path starting elsewhere is missing its own beginning.",
    );
  }
  for (let index = 1; index < path.length; index += 1) {
    assertDecisionTransition(path[index - 1]!, path[index]!);
  }
}
