import { createHash } from "node:crypto";

/**
 * Deterministic decision identity (invariant I12).
 *
 * A decision is identified by what it decides -- which path, which instrument, which timeframe,
 * which bar -- and by its attempt number, never by a random UUID. With a random id the same bar
 * could be decided twice with nothing to collide on: measured 2026-10-11, 207 of 5,050 native
 * pipeline decisions were repeats of a bar already decided, because the 5m bar-age ceiling (seven
 * minutes) is longer than the five-minute cron, so a late-arriving bar was decided on two ticks.
 *
 * The attempt number exists because a deferral is not a verdict. 43 of those repeats turned an
 * earlier DEFERRED (the pattern layer had not been computed yet) into a real outcome, so a bar whose
 * last attempt deferred must stay decidable. Any other outcome is final, and a repeat run on it is
 * skipped rather than written again.
 */

export const DECISION_ID_VERSION = "decision-id-v1";

/** Far more than the bar-age ceiling allows in practice; exists so a bug cannot loop forever. */
export const MAX_DECISION_ATTEMPTS = 5;

/** States after which a bar is settled and must not be decided again. */
const FINAL_STATES: readonly string[] = ["REJECTED", "CLOSED_NO_ACTION", "EXECUTED"];

export interface DecisionIdentityParts {
  /** The decision path: `"native-pipeline"` or a shadow thesis producer's id. */
  readonly path: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly barCloseTime: Date;
  /** 1-based. Attempt N+1 exists only because attempt N did not settle. */
  readonly attempt: number;
}

function assertPart(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`Decision identity needs a non-empty ${name}.`);
  if (value.includes("|")) throw new Error(`Decision identity ${name} must not contain "|": ${value}`);
}

/** A UUID-formatted (version 5 layout) digest, so the id fits every column and log that already holds UUIDs. */
export function deterministicDecisionId(parts: DecisionIdentityParts): string {
  assertPart("path", parts.path);
  assertPart("symbol", parts.symbol);
  assertPart("timeframe", parts.timeframe);
  if (Number.isNaN(parts.barCloseTime.getTime())) {
    throw new Error("Decision identity needs a valid barCloseTime.");
  }
  if (!Number.isInteger(parts.attempt) || parts.attempt < 1) {
    throw new Error(`Decision identity attempt must be an integer >= 1, got ${parts.attempt}.`);
  }

  const material = [
    DECISION_ID_VERSION,
    parts.path,
    parts.symbol,
    parts.timeframe,
    parts.barCloseTime.toISOString(),
    String(parts.attempt),
  ].join("|");
  const bytes = createHash("sha256").update(material).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export type DecisionAttemptResolution =
  | { readonly kind: "DECIDE"; readonly decisionId: string; readonly attempt: number }
  | { readonly kind: "ALREADY_DECIDED"; readonly decisionId: string; readonly state: string }
  | { readonly kind: "ATTEMPTS_EXHAUSTED"; readonly attempts: number };

/**
 * Chooses the id to decide this bar under.
 *
 * Walks attempts in order. An attempt nobody has written is the one to use; one that settled means
 * the bar is already decided; one that stopped at DEFERRED -- or died part-way through its stages --
 * hands over to the next attempt, so a crashed run cannot strand a bar forever.
 *
 * Two runs racing for the same attempt both pick it, and the ledger's unique
 * `(aggregate_id, aggregate_version)` constraint lets exactly one write; that is the persistence
 * enforcement I24 asks for, which the previous random ids could never have triggered.
 */
export async function resolveDecisionAttempt(
  parts: Omit<DecisionIdentityParts, "attempt">,
  lastStateOf: (decisionId: string) => Promise<string | null>,
  maxAttempts: number = MAX_DECISION_ATTEMPTS,
): Promise<DecisionAttemptResolution> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const decisionId = deterministicDecisionId({ ...parts, attempt });
    const state = await lastStateOf(decisionId);
    if (state === null) return { kind: "DECIDE", decisionId, attempt };
    if (FINAL_STATES.includes(state)) return { kind: "ALREADY_DECIDED", decisionId, state };
  }
  return { kind: "ATTEMPTS_EXHAUSTED", attempts: maxAttempts };
}
