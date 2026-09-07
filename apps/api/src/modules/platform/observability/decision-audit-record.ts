/**
 * The per-tick audit record, and the taxonomy it is not allowed to reinvent.
 *
 * ## The rule this enforces, and where the plan broke it
 *
 * The Scalp Engine V2 specification is explicit: "Production must use the **same taxonomy codes**, not
 * new ones." Its own `DecisionAuditRecord` sketch then listed a parallel set:
 *
 * | The harness actually emits | The sketch listed |
 * | :--- | :--- |
 * | `TAPE_FROZEN` | *absent* — the sketch predates the frozen-tape gate |
 * | `FEATURE_WARMUP:ATR,EMA` | `DEFERRED_FEATURE_WARMUP` |
 * | `FEATURE_LAYER_NOT_COMPUTED` | `DEFERRED_FEATURE_NOT_COMPUTED` |
 *
 * Two renames and an omission. The renames matter less for being ugly than for what the second one
 * destroys: `FEATURE_WARMUP:ATR,EMA` names *which* indicators were missing, and a flat
 * `DEFERRED_FEATURE_WARMUP` throws that away. The whole reason the harness stopped using an ATR-only
 * eligibility check was that a coarse flag hid which feature was absent.
 *
 * So the record reuses the emitted strings. What the platform contributes is a rule that no *new*
 * family can appear without being declared here — enforced by parsing rather than by convention.
 *
 * ## Why the family is platform vocabulary and the payload is not
 *
 * `FEATURE_WARMUP` is a shared kind of answer: "a declared input was not ready". `ATR,EMA` is a domain
 * fact about which indicators one strategy family consumes. Splitting them lets the platform refuse an
 * undeclared family while staying ignorant of indicator names — the same division that kept
 * `AccountRiskSnapshot` generic over its evidence type.
 */

/**
 * Every deferral family the system may report. Adding one is a deliberate act, not a typo.
 *
 * `GRID_MISALIGNED` has no harness counterpart, and that asymmetry is correct rather than an
 * oversight: the harness calls `assertOnGridDecision`, which **throws** on an off-grid decision,
 * because a research capture that drifted off the lattice is a bug in the capture. Production cannot
 * throw at a scheduler tick, so it needs a reportable state for the same condition.
 */
export const DEFERRAL_FAMILIES = [
  "TAPE_FROZEN",
  "FEATURE_WARMUP",
  "FEATURE_LAYER_NOT_COMPUTED",
  "GRID_MISALIGNED",
] as const;

export type DeferralFamily = (typeof DEFERRAL_FAMILIES)[number];

export interface DeferralReason {
  readonly family: DeferralFamily;
  /** The detail after the colon, verbatim. Null when the family carries none. */
  readonly payload: string | null;
  /** The original string, so a stored row round-trips without reassembly. */
  readonly raw: string;
}

export class UnknownDeferralFamilyError extends Error {
  constructor(readonly raw: string, readonly family: string) {
    super(
      `"${family}" is not a declared deferral family (from "${raw}"). Production must reuse the `
      + `research taxonomy rather than inventing codes: ${DEFERRAL_FAMILIES.join(", ")}. `
      + "A new family is a deliberate addition here, because an undeclared one cannot be aggregated "
      + "or compared against research.",
    );
    this.name = "UnknownDeferralFamilyError";
  }
}

/**
 * Parses an emitted reason string into family and payload.
 *
 * Splits on the **first** colon only. A payload may itself contain colons, and consuming them would
 * silently truncate the detail the code exists to carry.
 */
export function parseDeferralReason(raw: string): DeferralReason {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("A deferral reason cannot be blank.");
  const separator = trimmed.indexOf(":");
  const family = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const payload = separator === -1 ? null : trimmed.slice(separator + 1);
  if (!(DEFERRAL_FAMILIES as readonly string[]).includes(family)) {
    throw new UnknownDeferralFamilyError(raw, family);
  }
  if (payload !== null && payload.length === 0) {
    // `FEATURE_WARMUP:` claims a payload and supplies none, which reads as "nothing was missing".
    throw new Error(`Deferral reason "${raw}" has a trailing colon but no payload.`);
  }
  return { family: family as DeferralFamily, payload, raw: trimmed };
}

export type SnapshotResult = "RESOLVED" | "STALE" | "UNAVAILABLE";
/** "Never ran" and "ran and found nothing" are different pipeline states, and must stay distinct. */
export type StrategyEvaluationStatus = "EVALUATED" | "SKIPPED" | "INELIGIBLE";
export type AdmissionResult = "APPROVED" | "REJECTED" | "DEFERRED" | "NO_CANDIDATE";
export type RiskResult = "APPROVED" | "REJECTED";
export type ExecutionResult = "EXECUTED" | "NO_ACTION";

export interface DecisionAuditRecord {
  readonly decisionId: string;
  readonly symbol: string;
  /** The canonical grid slot. */
  readonly decisionAt: Date;
  /** Wall-clock scheduler wakeup. */
  readonly evaluationAt: Date;
  /** Telemetry only. Never alters `decisionAt`; replay depends on that. */
  readonly schedulerLagMs: number;

  readonly snapshotResult: SnapshotResult;
  readonly snapshotRef: string | null;

  /** Null when the data and feature gate passed. */
  readonly deferral: DeferralReason | null;

  readonly strategyEvaluationStatus: StrategyEvaluationStatus;
  readonly candidateCount: number;
  /** `proposalKey` values, so a production tick cross-references a research row. */
  readonly candidateIds: readonly string[];

  readonly admissionResult: AdmissionResult;
  readonly riskResult: RiskResult | null;
  /** Which invariant refused, e.g. `I5_EXPOSURE_LIMIT`. */
  readonly riskRejectionInvariant: string | null;
  readonly executionResult: ExecutionResult | null;
}

/** What a tick amounted to. Every record resolves to exactly one of these. */
export type TickOutcome =
  | "DEFERRED_BEFORE_STRATEGY"
  | "STRATEGY_NOT_RUN"
  | "NO_CANDIDATE"
  | "REJECTED_BY_ADMISSION"
  | "REJECTED_BY_RISK"
  | "EXECUTED"
  | "NO_ACTION_AFTER_APPROVAL";

/**
 * Classifies a tick, or throws.
 *
 * This function is the actual deliverable. The specification's requirement is "**No silent
 * `NO_ACTION`:** every tick must be classifiable from this record", and a field list alone cannot
 * establish that — it is a claim about whether the fields are *sufficient*. Making classification a
 * total function turns the claim into something a test can falsify: any combination of fields that
 * this cannot resolve is a hole in the schema, and it surfaces here rather than as an unexplained
 * quiet tick six months on.
 *
 * The order is causal, not arbitrary. A tick deferred before the strategy ran cannot also be a
 * no-candidate tick, and reporting the later state would describe a decision that never happened.
 */
export function classifyTick(record: DecisionAuditRecord): TickOutcome {
  if (record.snapshotResult !== "RESOLVED" || record.deferral !== null) {
    if (record.strategyEvaluationStatus === "EVALUATED") {
      throw new Error(
        `Tick ${record.decisionId} was deferred (${record.deferral?.raw ?? record.snapshotResult}) `
        + "yet reports the strategy as EVALUATED. One of the two is wrong, and a record that "
        + "disagrees with itself cannot be aggregated.",
      );
    }
    return "DEFERRED_BEFORE_STRATEGY";
  }
  if (record.strategyEvaluationStatus !== "EVALUATED") return "STRATEGY_NOT_RUN";

  if (record.candidateCount === 0) {
    if (record.admissionResult !== "NO_CANDIDATE") {
      throw new Error(
        `Tick ${record.decisionId} produced no candidate yet admission reported `
        + `"${record.admissionResult}". Admission cannot have judged something that does not exist.`,
      );
    }
    return "NO_CANDIDATE";
  }
  if (record.candidateIds.length !== record.candidateCount) {
    // A count without matching ids cannot be cross-referenced against research, which is the one
    // thing `candidateIds` is for.
    throw new Error(
      `Tick ${record.decisionId} reports ${record.candidateCount} candidates but `
      + `${record.candidateIds.length} ids.`,
    );
  }

  if (record.admissionResult === "REJECTED" || record.admissionResult === "DEFERRED") {
    return "REJECTED_BY_ADMISSION";
  }
  if (record.admissionResult === "NO_CANDIDATE") {
    throw new Error(
      `Tick ${record.decisionId} reports ${record.candidateCount} candidates and NO_CANDIDATE admission.`,
    );
  }
  if (record.riskResult === null) {
    throw new Error(
      `Tick ${record.decisionId} was admitted but records no risk result. Risk is not optional on an `
      + "approved candidate, and a null here would hide a bypassed gate (I17).",
    );
  }
  if (record.riskResult === "REJECTED") return "REJECTED_BY_RISK";
  return record.executionResult === "EXECUTED" ? "EXECUTED" : "NO_ACTION_AFTER_APPROVAL";
}
