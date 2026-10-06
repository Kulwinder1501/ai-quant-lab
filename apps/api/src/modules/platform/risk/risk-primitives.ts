/**
 * Capacity, concurrency, and the structural shape of a risk decision. **Mechanism, not thresholds.**
 *
 * Readiness Plan Gap 2 assigns concurrency and capacity enforcement to the platform, on the grounds
 * that the harness already proved they belong centrally. What follows is the contract that
 * enforcement satisfies, extracted from the implementation that was verified live rather than
 * designed fresh.
 */

/** Whether a unit of capacity may be consumed. Structural: the caller owns the cap's value. */
export type CapacityOutcome = "NO_CAP" | "WITHIN_CAP" | "CAP_REACHED";

export interface CapacityDecision {
  readonly allowed: boolean;
  readonly outcome: CapacityOutcome;
  readonly used: number;
  readonly cap: number | null;
}

/**
 * Compares consumption against a cap.
 *
 * Generalised from `paper-trading/domain/daily-trade-cap.ts`, whose behaviour this reproduces exactly
 * — including that a `cap` of `0` blocks everything (`used >= cap` at `0 >= 0`) and that `null` means
 * uncapped rather than zero. Those two are easy to get backwards and the difference is "this account
 * cannot trade" versus "this account is unlimited".
 *
 * Renamed away from "daily trade" because the mechanism is not about days or trades: the same
 * comparison bounds concurrent positions, per-session opportunities, or anything else counted against
 * a ceiling. The domain names what it is counting.
 */
export function decideCapacity(input: { used: number; cap: number | null }): CapacityDecision {
  const { used, cap } = input;
  if (!Number.isInteger(used) || used < 0) {
    throw new Error(`Capacity used must be a non-negative integer; received ${used}.`);
  }
  if (cap === null) return { allowed: true, outcome: "NO_CAP", used, cap };
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`A capacity cap must be a non-negative integer; received ${cap}.`);
  }
  return used >= cap
    ? { allowed: false, outcome: "CAP_REACHED", used, cap }
    : { allowed: true, outcome: "WITHIN_CAP", used, cap };
}

/**
 * The three properties a capacity reservation must have, stated so an implementation can be judged.
 *
 * These are not invented. They are the properties of the mechanism already in
 * `postgres-paper-trade-repository.ts`, which holds the account row `FOR UPDATE` for the remainder of
 * the admission transaction:
 *
 * 1. **Serialised per account.** Two concurrent admissions on one account cannot both read the same
 *    count and both insert. The lock is what provides this, not a check-then-act in application code.
 * 2. **Count derived, never stored.** Consumption is counted from the rows it describes, so it cannot
 *    drift from them. A separate capacity counter is a second source of truth that will disagree.
 * 3. **Rollback frees capacity.** A failure anywhere inside the transaction consumes nothing and
 *    blocks no later admission, because the lock releases with the transaction either way.
 *
 * Property 3 is also why a multi-leg structure is all-or-nothing: the transaction reads its own
 * uncommitted first leg, so a straddle that would cross the cap on its second leg rolls back whole.
 *
 * > **What the unit tests here can and cannot show.** A single-process test can exercise
 * > `decideCapacity` and the shape of a reservation, but it cannot demonstrate isolation between two
 * > database connections. Properties 1 and 3 are proved by `interfaces/cli/verify-cap-concurrency.ts`,
 * > a two-connection harness run against the live database, and that is where they stay proved. This
 * > contract exists so a *future* implementation is measured against the same three properties rather
 * > than against whatever it happens to do.
 */
export interface CapacityReservation {
  /**
   * Reserves one unit under a lock held until the surrounding transaction ends.
   *
   * Must throw rather than return a falsy value when the cap is reached, so a caller cannot proceed by
   * ignoring a result.
   */
  reserve(input: { readonly scopeId: string; readonly cap: number | null }): Promise<CapacityDecision>;
}

/**
 * A risk decision's structure. **No score, by invariant I18.**
 *
 * I18 forbids a composite confidence score anywhere in Brain V2, and the reason is specific: a score
 * makes gates commensurable, so a strong reading on one dimension silently offsets a failure on
 * another. This shape can only approve or reject, and a rejection must name every reason it failed —
 * plural, because reporting the first failure hides the rest and makes the next fix look sufficient.
 *
 * Sizing is absent too. How much to commit is a policy output computed from thresholds the domain
 * owns; carrying it here would drag `riskFractionPerTrade` into the platform with it.
 */
export interface StructuralRiskDecision {
  readonly approved: boolean;
  /** Every reason this was refused, in detection order. Empty exactly when approved. */
  readonly reasonCodes: readonly string[];
}

/** Rejection is the default: a decision is approved only by explicit construction. */
export function refuse(reasonCodes: readonly string[]): StructuralRiskDecision {
  if (reasonCodes.length === 0) {
    throw new Error("A refusal must name at least one reason, or it cannot be acted on or audited.");
  }
  return Object.freeze({ approved: false, reasonCodes: Object.freeze([...reasonCodes]) });
}

export function approve(): StructuralRiskDecision {
  return Object.freeze({ approved: true, reasonCodes: Object.freeze([]) });
}
