import {
  sameSnapshotRef,
  type SnapshotRef,
} from "../../platform/snapshot/snapshot-ref.js";
import type { SnapshotRegistry } from "../../platform/snapshot/snapshot-registry.js";
import { sealPitInstants, type PitInstants } from "../../platform/pit/pit-instants.js";

/**
 * The sealed point-in-time context a decision is evaluated against (I11), and the mechanism that
 * makes I25 and I26 structural rather than aspirational.
 *
 * ## Freezing the object is not enough
 *
 * I26 says a sealed context cannot be refreshed during evaluation: "once a Snapshot is sealed, no
 * stage may resolve a newer version." `Object.freeze` prevents a stage from *editing* the context. It
 * does nothing about the failure that actually matters -- a stage holding a registry handle and asking
 * it for current data, which needs no mutation at all.
 *
 * So the enforcement is a capability, not a flag. `bindSealedResolver` hands a stage a resolver that
 * can only resolve *this* context's ref and throws on anything else. A stage cannot ask for "latest",
 * because the only resolution it is given has no parameter for it. That is I25 as well: the sole
 * decision-critical input a stage can reach is the sealed one.
 *
 * The registry itself stays out of the stages' hands. Passing a `SnapshotRegistry` into a stage would
 * reintroduce exactly the reach this type exists to remove, so a stage's dependencies should name a
 * `SealedResolver` and never the registry.
 *
 * ## Why `dataThrough` must be strictly before `decisionAt`
 *
 * The one leakage rule enforced here. The scalp harness derives `dataThrough` as `decisionAt - 1ms`
 * for the same reason: a decision may consume everything available strictly before its instant, and
 * nothing at or after it. An equality would admit the bar that closes *at* `decisionAt`, which is the
 * bar the decision is about -- and I10 forbids any stage receiving post-decision information.
 *
 * ## Scheduler lag is telemetry and is checked against the clocks it describes
 *
 * `decisionAt` is the canonical grid slot; `evaluationAt` is when the scheduler actually woke. Lag
 * never moves `decisionAt`, because replay depends on the grid-anchored value. It is validated rather
 * than merely stored: a lag that disagrees with its own timestamps is a corrupt record, and a corrupt
 * record is worse than a missing field because it will be trusted.
 */

export interface BaseDecisionContext {
  readonly decisionId: string;
  /** The canonical grid slot. Never derived from wall-clock time. */
  readonly decisionAt: Date;
  /** When the scheduler actually woke. Telemetry only. */
  readonly evaluationAt: Date;
  /** `evaluationAt - decisionAt`, validated against both. */
  readonly schedulerLagMs: number;
  readonly instants: Readonly<PitInstants>;
  /** The only data any stage may reach. */
  readonly snapshotRef: SnapshotRef;
  /** Every policy version in force, so a replay resolves the same rules. */
  readonly policyVersions: Readonly<Record<string, string>>;
}

export class DecisionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionContextError";
  }
}

export class SealedContextViolation extends Error {
  constructor(readonly requested: SnapshotRef, readonly sealed: SnapshotRef) {
    super(
      `A stage asked to resolve snapshot ${requested.snapshotId} while the decision is sealed to `
      + `${sealed.snapshotId}. Once a context is sealed no stage may resolve a different or newer `
      + "version (I26); a stage needing other data is a stage whose context was built wrong.",
    );
    this.name = "SealedContextViolation";
  }
}

/**
 * Validates and freezes a decision context.
 *
 * Every check here is one that, if violated, would make the recorded decision describe something that
 * did not happen -- which is the whole reason the ledger exists.
 */
export function sealDecisionContext(input: BaseDecisionContext): Readonly<BaseDecisionContext> {
  if (input.decisionId.trim().length === 0) {
    throw new DecisionContextError("A decision context needs a decisionId; it is what everything joins on.");
  }
  for (const [field, value] of [
    ["decisionAt", input.decisionAt],
    ["evaluationAt", input.evaluationAt],
  ] as const) {
    if (Number.isNaN(value.getTime())) throw new DecisionContextError(`${field} must be a valid Date.`);
  }

  const instants = sealPitInstants(input.instants);

  if (instants.dataThrough.getTime() >= input.decisionAt.getTime()) {
    throw new DecisionContextError(
      `dataThrough (${instants.dataThrough.toISOString()}) must be strictly before decisionAt `
      + `(${input.decisionAt.toISOString()}). At or after admits the bar the decision is about, which is `
      + "post-decision information (I10).",
    );
  }
  const expectedLag = input.evaluationAt.getTime() - input.decisionAt.getTime();
  if (input.schedulerLagMs !== expectedLag) {
    throw new DecisionContextError(
      `schedulerLagMs is ${input.schedulerLagMs} but evaluationAt - decisionAt is ${expectedLag}. A lag `
      + "that disagrees with its own clocks is a corrupt record, and it will be trusted.",
    );
  }
  if (expectedLag < 0) {
    throw new DecisionContextError(
      "evaluationAt precedes decisionAt: the scheduler cannot have evaluated a grid slot before it existed.",
    );
  }
  if (Object.keys(input.policyVersions).length === 0) {
    /*
     * An empty policy set means a replay cannot know which rules were in force, so it cannot
     * reproduce the decision -- and I20 requires every paper trade to be fully replayable. Refusing
     * here is cheaper than discovering it at replay, when the session is gone.
     */
    throw new DecisionContextError("A decision context must record the policy versions in force.");
  }

  return Object.freeze({
    ...input,
    instants,
    snapshotRef: Object.freeze({ ...input.snapshotRef }),
    policyVersions: Object.freeze({ ...input.policyVersions }),
  });
}

/**
 * Resolution scoped to one sealed context. The only data-reading capability a stage receives.
 *
 * Deliberately has no parameter for "which snapshot" and no way to reach the registry: a stage cannot
 * ask for a newer version because there is nothing to ask. That is stronger than a runtime check on a
 * ref a stage supplies, since the check can be forgotten and a missing parameter cannot.
 */
export interface SealedResolver {
  /** The canonical bytes sealed for this decision. */
  resolve(): Promise<string>;
  /** Present so a caller can log or compare, not so a caller can choose. */
  readonly snapshotRef: SnapshotRef;
}

/**
 * Binds a registry to a context, yielding a resolver that can reach nothing else.
 *
 * `assertResolvable` exists for the one legitimate case where a caller holds a ref and wants to know
 * whether it is the sealed one -- an adapter validating its own inputs, say. It throws rather than
 * returning false so an ignored result cannot become a silent read of the wrong snapshot.
 */
export function bindSealedResolver(input: {
  readonly context: Readonly<BaseDecisionContext>;
  readonly registry: SnapshotRegistry;
}): SealedResolver & { assertResolvable(ref: SnapshotRef): void } {
  const sealed = input.context.snapshotRef;
  return Object.freeze({
    snapshotRef: sealed,
    async resolve(): Promise<string> {
      return input.registry.resolve(sealed);
    },
    assertResolvable(ref: SnapshotRef): void {
      if (!sameSnapshotRef(ref, sealed)) throw new SealedContextViolation(ref, sealed);
    },
  });
}
