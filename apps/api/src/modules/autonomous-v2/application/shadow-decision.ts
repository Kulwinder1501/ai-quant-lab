import { isApproved } from "../domain/decision-outcome.js";
import { legacyThesisComparison } from "./thesis-adapter.js";
import { noTradeAction } from "../domain/differential-testing.js";
import {
  isAbstention,
  thesisPolicyVersion,
  type ThesisGateInput,
  type ThesisProducer,
  type ThesisResult,
} from "../domain/thesis-producer.js";

/**
 * The shadow path: V2.2 decides for real, on live data, and executes nothing.
 *
 * This is step 2 of retiring V1, and the only step that can run before an entry rule exists. It puts
 * the whole V2.2 chain — sealed snapshot, thesis producer, recorded decision — on the live tape while
 * V1 keeps trading, so the new system accumulates a real decision record without holding authority.
 *
 * ## "Executes nothing" is structural, not procedural
 *
 * There is no execution port in this function's signature. No order repository, no position writer,
 * no paper-trade dependency — so the shadow path cannot place a trade for the same reason
 * `ThesisAdapter` cannot: the capability is absent, not merely unused. A future author who wants
 * shadow mode to trade has to add a dependency and change the type, which is a visible act rather
 * than an inattentive one.
 *
 * That matters more than it sounds. "Record-only mode" guarded by a boolean is one inverted condition
 * away from live trading, and this system has already had a `1m` timeframe silently produce 89 trades
 * for −Rs 13,858 before anyone noticed which cell they came from.
 *
 * ## It produces a P13 observation, not a trade
 *
 * The output pairs V2.2's decision with V1's canonical outcome for the same instant, which is exactly
 * `DifferentialObservation`'s two sides. So running the shadow path *is* generating the differential
 * evidence P13 grades — the two pieces were built to meet here, and neither had a use without the
 * other.
 *
 * ## Every shadow decision is a real decision
 *
 * The ledger entry is written under the same append-only rules and the same content-addressed
 * snapshot as a live one. It is not a dry run: the record is authoritative about what V2.2 decided,
 * and P13 later depends on that being true. What differs is authority, and nothing else.
 */

/** Only what the shadow path may do: append a record. Deliberately narrow. */
export interface ShadowLedgerPort {
  append(input: {
    readonly decisionId: string;
    readonly contextSnapshotId: string;
    readonly policyVersions: Readonly<Record<string, string>>;
    readonly outcome: ThesisResult["outcome"];
    readonly detail: string;
  }): Promise<void>;
}

export interface ShadowDecisionRecord {
  readonly decisionId: string;
  readonly comparisonKey: string;
  /** V2.2's canonical outcome, in the same shape P13 compares V1's against. */
  readonly v2Outcome: string;
  readonly contextSnapshotId: string;
  /** True when the machinery ran clean and simply had no rule to apply. */
  readonly abstained: boolean;
  readonly policyVersions: Readonly<Record<string, string>>;
}

export class ShadowDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShadowDecisionError";
  }
}

/**
 * Renders a thesis result into the canonical form P13 compares.
 *
 * Deliberately the same layout `legacyThesisComparison` produces, and quantised the same way. Two
 * systems whose outcomes are formatted differently would diverge on presentation, land in `UNKNOWN` —
 * the blocking bucket — and drown the real findings. The comparison is string equality, so the
 * formats have to be one format.
 */
export function canonicalV2Outcome(result: ThesisResult): string {
  if (isApproved(result)) {
    const thesis = result.value;
    return legacyThesisComparison({
      instrumentSymbol: thesis.instrumentSymbol,
      // Only the geometry is compared; the instant is carried by the comparison key.
      decisionAt: new Date(0),
      verdict: "APPROVED",
      geometry: {
        side: thesis.side,
        entryPrice: thesis.entryReference,
        stopLoss: thesis.stopLoss,
        targetPrice: thesis.targetPrice,
      },
    }).canonicalOutcome;
  }
  if (result.outcome === "REJECTED") return `REJECTED ${[...result.reasons].sort().join(",")}`;
  if (result.outcome === "DEFERRED") return `DEFERRED ${result.reason}`;
  return `NO_ACTION ${result.reason}`;
}

/**
 * Splits an outcome into the part P13 compares and the part it only records.
 *
 * ## Why the action is compared and the reason is not
 *
 * P13 gates whether V2.2 may **substitute** for V1. If both systems declined to trade then V2.2 is
 * behaviourally equivalent for that bar, whatever each called its refusal -- so `NO_TRADE` is the
 * comparable fact and `TAPE_FROZEN` versus `NO_PROPOSAL` is colour.
 *
 * Learned by getting it wrong. The first stored observations compared whole strings, which made
 * `NO_ACTION NO_PROPOSAL` diverge from `REJECTED OUTSIDE_EXECUTABLE_WINDOW` even though neither
 * system traded. Every bar would have diverged for as long as V2.2 has no entry rule, all `UNKNOWN`,
 * all blockers -- the exact "hundreds of expected divergences is noise" failure the thesis comparison
 * already refuses for composite scores, reintroduced in the equality test. See migration 093.
 *
 * An approval keeps its geometry in the action, because *what* was traded is the substitution
 * question: two approvals with different stops are genuinely different decisions.
 *
 * One implementation, used for both sides. Two would drift, and a drift here reads as disagreement
 * between the systems rather than between the formatters.
 */
export function comparableAction(outcome: string): { readonly action: string; readonly detail: string } {
  if (outcome.startsWith("APPROVED")) return { action: outcome, detail: "" };
  return { action: noTradeAction, detail: outcome };
}

/**
 * Runs one shadow decision and records it.
 *
 * Returns the observation half a P13 comparison needs. The caller supplies V1's side and the shared
 * snapshot ref — it cannot be derived here, and P13 refuses a comparison whose two sides read
 * different snapshots.
 */
export async function runShadowDecision(input: {
  readonly decisionId: string;
  readonly gate: ThesisGateInput;
  readonly produce: ThesisProducer;
  readonly ledger: ShadowLedgerPort;
  readonly additionalPolicyVersions?: Readonly<Record<string, string>>;
}): Promise<ShadowDecisionRecord> {
  if (input.decisionId.trim() === "") {
    throw new ShadowDecisionError("A shadow decision needs an id: it is a real ledger record.");
  }

  const result = input.produce(input.gate);
  const v2Outcome = canonicalV2Outcome(result);
  const contextSnapshotId = input.gate.snapshot.ref.snapshotId;

  /*
   * The thesis policy version travels on every record, including refusals.
   *
   * A refusal is as much a product of the policy as an approval, and a later reader comparing two
   * sessions has to know whether the gates changed between them. Recording it only on approvals
   * would make exactly the rows this producer emits — all of them refusals and abstentions today —
   * the unversioned ones.
   */
  const policyVersions = Object.freeze({
    ...input.additionalPolicyVersions,
    thesis: thesisPolicyVersion,
  });

  await input.ledger.append({
    decisionId: input.decisionId,
    contextSnapshotId,
    policyVersions,
    outcome: result.outcome,
    detail: v2Outcome,
  });

  return Object.freeze({
    decisionId: input.decisionId,
    comparisonKey: `${input.gate.instrumentSymbol}@${input.gate.snapshot.instants.eventAt.toISOString()}`,
    v2Outcome,
    contextSnapshotId,
    abstained: isAbstention(result),
    policyVersions,
  });
}
