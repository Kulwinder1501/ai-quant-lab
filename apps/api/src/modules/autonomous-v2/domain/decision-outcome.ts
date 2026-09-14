/**
 * The four outcomes a Brain V2.2 stage may return, and nothing else.
 *
 * ## Why four, and why they are not booleans
 *
 * Each says something different about *why* nothing happened, and collapsing any pair destroys a
 * distinction this system has already paid to learn:
 *
 * | Outcome | Meaning | What conflating it costs |
 * | :--- | :--- | :--- |
 * | `APPROVED` | this stage's condition is met, and here is the value proving it | — |
 * | `REJECTED` | a rule refused. Retrying now changes nothing | reads as a transient failure and gets retried forever |
 * | `DEFERRED` | the answer is not knowable yet; a dependency is missing | reads as a refusal, and a pipeline defect looks like a decision |
 * | `NO_ACTION` | every rule passed and the correct action was still to do nothing | reads as a failure, so a healthy quiet market looks broken |
 *
 * `DEFERRED` versus `REJECTED` is the pair that has actually bitten: the collector-health check keeps
 * `INCOMPLETE` separate from `DEGRADED` for exactly this reason, and the frozen-tape gate defers
 * rather than rejecting because the bar may be republished later in the session.
 *
 * ## Rejection is the default
 *
 * There is no way to obtain an `APPROVED` other than by calling `approved()` with a value. A stage
 * that falls out of its own logic without deciding cannot accidentally return an approval, which is
 * the property `evaluateRisk` in V1 established by hand ("every path that returns early returns a
 * rejection") and which is structural here.
 *
 * ## No score, by I18
 *
 * None of these carries a number that could be summed, averaged, or compared across stages. A
 * composite score makes gates commensurable, so a strong reading on one dimension silently offsets a
 * failure on another -- and V1's `scoreDirectionalSetup` is quarantined precisely because it was
 * measured to select *bad* shorts while looking confident. The key sets are pinned by test.
 */

export interface Approved<T> {
  readonly outcome: "APPROVED";
  readonly value: T;
}

export interface Rejected<R extends string = string> {
  readonly outcome: "REJECTED";
  /** Every rule that refused, in detection order. Never empty. */
  readonly reasons: readonly R[];
}

export interface Deferred<R extends string = string> {
  readonly outcome: "DEFERRED";
  readonly reason: R;
  /**
   * When retrying could plausibly succeed, where that is knowable.
   *
   * Null rather than absent when unknown, so "we did not compute a retry time" cannot be mistaken for
   * "retry immediately".
   */
  readonly retryAt: Date | null;
  /** What is missing. The field that makes a deferral actionable rather than a shrug. */
  readonly blockingDependency: string;
}

export interface NoAction<R extends string = string> {
  readonly outcome: "NO_ACTION";
  readonly reason: R;
}

export type EvaluationResult<T, R extends string = string> =
  | Approved<T>
  | Rejected<R>
  | Deferred<R>
  | NoAction<R>;

export function approved<T>(value: T): Approved<T> {
  return Object.freeze({ outcome: "APPROVED" as const, value });
}

export function rejected<R extends string>(reasons: readonly R[]): Rejected<R> {
  if (reasons.length === 0) {
    // A refusal nobody can act on or audit. The same rule the structural risk decision enforces.
    throw new Error("A rejection must name at least one reason.");
  }
  return Object.freeze({ outcome: "REJECTED" as const, reasons: Object.freeze([...reasons]) });
}

export function deferred<R extends string>(input: {
  readonly reason: R;
  readonly blockingDependency: string;
  readonly retryAt?: Date | null;
}): Deferred<R> {
  if (input.blockingDependency.trim().length === 0) {
    /*
     * A deferral without a named dependency is indistinguishable from a rejection in practice: nobody
     * can tell what to wait for, so it gets retried blindly or treated as a refusal. Naming the
     * dependency is what makes `DEFERRED` a different answer rather than a softer one.
     */
    throw new Error("A deferral must name the dependency that is blocking it.");
  }
  return Object.freeze({
    outcome: "DEFERRED" as const,
    reason: input.reason,
    retryAt: input.retryAt ?? null,
    blockingDependency: input.blockingDependency,
  });
}

export function noAction<R extends string>(reason: R): NoAction<R> {
  return Object.freeze({ outcome: "NO_ACTION" as const, reason });
}

/** Narrowing helper, so a caller reads the outcome rather than testing a truthiness. */
export function isApproved<T, R extends string>(
  result: EvaluationResult<T, R>,
): result is Approved<T> {
  return result.outcome === "APPROVED";
}

/**
 * Every outcome that is not an approval, as one type.
 *
 * Useful because a stage that receives a non-approval from upstream must pass it through unchanged
 * rather than re-deriving it: re-deriving loses the original reason, and the reason is the only record
 * of *which* rule stopped the decision.
 */
export type NotApproved<R extends string = string> = Rejected<R> | Deferred<R> | NoAction<R>;
