import {
  assertLedgerChain,
  type DecisionLedgerEvent,
} from "../domain/decision-ledger.js";
import {
  assertDecisionPath,
  isTerminalDecisionState,
  type DecisionState,
} from "../domain/decision-lifecycle.js";
import { researchIdentityEncodingVersion } from "../../platform/identity/identity.js";
import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";

/**
 * Replay: establishing that a decision *is* replayable (I20).
 *
 * ## What this does and does not do, stated plainly
 *
 * It does **not** re-execute a decision. Brain's stages (P5-P10) do not exist yet, so there is nothing
 * to re-run and any claim to have "replayed and matched" would be theatre.
 *
 * What it does is check the property I20 actually asserts -- that the record is *sufficient* to replay
 * from. That is a real and falsifiable question, and answering it now is the point: it tests the P2 and
 * P3 designs against the requirement rather than assuming they satisfy it. When the stages arrive they
 * consume this same reconstruction; if it were built afterwards, the first thing it would discover is
 * that something needed was never recorded, by which time the sessions are gone.
 *
 * The checks:
 *
 * - the hash chain is continuous and each version is dense from 1 (`assertLedgerChain`)
 * - the state path was legal, including where it starts (`assertDecisionPath`)
 * - **every event's sealed context actually resolves to bytes**
 * - policy versions are recorded on every event, so the rules in force are recoverable
 *
 * ## Reading, never writing
 *
 * The ports are read-only by construction. A replay that could append would be able to rewrite the
 * history it is verifying, and its verdict would then be about a record it had changed. This also keeps
 * replay on the right side of I27: it consumes outcomes-era data and hands nothing back to a live
 * decision.
 *
 * ## Why the context check should never fail, and is still made
 *
 * `decision_ledger_context_resolvable` is a foreign key onto the snapshot store, so an event
 * referencing an unsealed context cannot be inserted. If this check ever fires, the interesting fact is
 * not the missing snapshot -- it is that something reached the table without going through the
 * constraint. Removing the check because "the database guarantees it" would discard the only signal
 * that the guarantee stopped holding.
 */

export interface DecisionHistoryReader {
  readAggregate(aggregateId: string): Promise<readonly DecisionLedgerEvent[]>;
}

export interface SealedContextReader {
  /** Must throw or reject when the snapshot is absent; an empty result would read as an empty context. */
  resolve(ref: SnapshotRef): Promise<string>;
}

export type ReplayVerdict = "REPLAYABLE" | "NOT_REPLAYABLE";

export interface ReplayReport {
  readonly aggregateId: string;
  readonly decisionId: string | null;
  readonly eventCount: number;
  readonly verdict: ReplayVerdict;
  /** Named problems, in the order detected. Empty exactly when REPLAYABLE. */
  readonly findings: readonly string[];
  /** The reconstructed state path, oldest first. */
  readonly path: readonly DecisionState[];
  /**
   * Whether the decision reached a terminal state.
   *
   * Kept separate from the verdict on purpose. A decision still in flight is entirely replayable up to
   * where it got, and folding "not finished" into "not replayable" is the same conflation that made an
   * earlier collector outage invisible -- "we have not looked yet" and "it broke" must not share a value.
   */
  readonly complete: boolean;
  readonly contextsResolved: number;
  /** Every distinct policy version seen, so a reader can spot a mid-decision policy change. */
  readonly policyVersions: Readonly<Record<string, readonly string[]>>;
}

/**
 * Reconstructs one decision aggregate and reports whether its record supports a replay.
 *
 * Collects findings rather than throwing on the first problem. A decision with a broken chain *and* an
 * unresolvable context has two things wrong with it, and being told only the first means fixing it
 * twice -- the same reason a rejection names every reason it failed.
 */
export async function replayDecision(input: {
  readonly aggregateId: string;
  readonly history: DecisionHistoryReader;
  readonly contexts: SealedContextReader;
  readonly encodingVersion?: string;
}): Promise<ReplayReport> {
  const events = await input.history.readAggregate(input.aggregateId);
  const findings: string[] = [];

  if (events.length === 0) {
    return {
      aggregateId: input.aggregateId,
      decisionId: null,
      eventCount: 0,
      verdict: "NOT_REPLAYABLE",
      findings: ["NO_HISTORY"],
      path: [],
      complete: false,
      contextsResolved: 0,
      policyVersions: {},
    };
  }

  try {
    assertLedgerChain(events);
  } catch (error: unknown) {
    findings.push(`BROKEN_CHAIN: ${(error as Error).message}`);
  }

  /*
   * The path is the arrival state of each event, and the opening event's stateFrom equals its stateTo,
   * so taking stateTo throughout yields the sequence the transition table expects.
   */
  const path = events.map((event) => event.stateTo);
  try {
    assertDecisionPath(path);
  } catch (error: unknown) {
    findings.push(`ILLEGAL_PATH: ${(error as Error).message}`);
  }

  const encodingVersion = input.encodingVersion ?? researchIdentityEncodingVersion;
  let contextsResolved = 0;
  for (const event of events) {
    try {
      const bytes = await input.contexts.resolve({
        snapshotId: event.contextSnapshotId,
        encodingVersion,
      });
      if (bytes.length === 0) {
        // A resolver that returned empty rather than throwing would make a lost context look like a
        // decision that legitimately saw nothing.
        findings.push(`EMPTY_CONTEXT: ${event.eventId} resolved to zero bytes`);
      } else {
        contextsResolved += 1;
      }
    } catch (error: unknown) {
      findings.push(`UNRESOLVABLE_CONTEXT: ${event.eventId} -> ${(error as Error).message}`);
    }
  }

  const policyVersions: Record<string, string[]> = {};
  for (const event of events) {
    if (Object.keys(event.policyVersions).length === 0) {
      findings.push(`NO_POLICY_VERSIONS: ${event.eventId}`);
      continue;
    }
    for (const [key, value] of Object.entries(event.policyVersions)) {
      const seen = policyVersions[key] ?? [];
      if (!seen.includes(value)) seen.push(value);
      policyVersions[key] = seen;
    }
  }

  const head = events[events.length - 1]!;
  return {
    aggregateId: input.aggregateId,
    decisionId: events[0]!.decisionId,
    eventCount: events.length,
    verdict: findings.length === 0 ? "REPLAYABLE" : "NOT_REPLAYABLE",
    findings,
    path,
    complete: isTerminalDecisionState(head.stateTo) || head.stateTo === "EXECUTED",
    contextsResolved,
    policyVersions: Object.freeze(
      Object.fromEntries(Object.entries(policyVersions).map(([key, values]) => [key, Object.freeze(values)])),
    ),
  };
}

/**
 * Which policy versions changed mid-decision, if any.
 *
 * A decision evaluated under two versions of the same policy cannot be replayed to one answer, so this
 * is a replayability hazard even when every other check passes. Reported separately rather than folded
 * into `findings`, because it is a property of the *history* rather than a defect in the record: it can
 * legitimately happen when a policy is bumped between stages, and what to do about it is a research
 * judgement.
 */
export function policiesChangedMidDecision(report: ReplayReport): readonly string[] {
  return Object.entries(report.policyVersions)
    .filter(([, versions]) => versions.length > 1)
    .map(([key, versions]) => `${key}: ${versions.join(" -> ")}`);
}
