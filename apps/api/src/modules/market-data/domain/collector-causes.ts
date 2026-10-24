/**
 * Why a day's data is thin: what the collectors recorded about themselves. Pure.
 *
 * The data-coverage view says WHAT is missing. Two records the system already keeps say why, and this module only reads them:
 *
 * - **The scheduler's run history** (`scheduled_job_runs`): for the option-chain job, how many runs there were, how many
 *   completed and how many failed, and why each failure happened, classified from the failure text by a few stated patterns.
 *   A skipped run (for example by the Fyers budget guard) is absent from the table by design, so it shows as fewer runs, not as a
 *   failure.
 * - **The Fyers request ledger** (`fyers_daily_request_ledger`): how many REST requests were counted that day and by whom, against
 *   the plan's 5,000 a day. Requests are counted when made, including those the broker then refused, so a total can exceed the cap.
 *   The ledger starts on 2026-10-17; earlier days have no figure, which is "not recorded", never zero.
 *
 * Two limits are stated, not hidden. The classification is pattern matching on a failure text and says "other" when no pattern
 * fits. And "completed" means the job exited cleanly, which is weaker than "wrote every index": one run covers several
 * underlyings, and a run in which one underlying failed can still complete. `completedRunsExceedSnapshots` flags the days where
 * an index has far fewer snapshots than completed runs, the signature of that partial failure.
 */
import { FYERS_DAILY_BUDGET_WARNING_THRESHOLD, FYERS_DAILY_REQUEST_CAP } from "./fyers-rate-limit.js";
import { istMinuteOfDay } from "./data-coverage.js";
import { baseUnderlying, parsePartialNote } from "./partial-run-note.js";

export type FailureCause = "fyers-daily-limit" | "fyers-rate-limited" | "fyers-auth" | "network" | "other";

export const FAILURE_CAUSES: readonly FailureCause[] = ["fyers-daily-limit", "fyers-rate-limited", "fyers-auth", "network", "other"];

/**
 * The cause of a failed job run, from its stored text, tested in this order.
 * - `fyers-daily-limit`: the broker refused with HTTP 429 and its daily-limit code (-360) or said so ("requests/day").
 * - `fyers-auth`: an HTTP 401, a token-class Fyers error code (-8, -15, -16, -17) or a token that is expired, invalid or unusable.
 * - `fyers-rate-limited`: any other HTTP 429, for example one that carries no code. It is the broker refusing for volume, but the
 *   text does not prove it was the daily limit (on 2026-10-16 the first such refusal came at 11:11, as the cap was reached).
 * - `network`: the request never got an answer ("fetch failed", a reset or timed-out connection).
 * - `other`: anything else, including an empty text.
 * The daily limit is tested first: a limit message can also mention the plan or account.
 */
export function classifyJobFailure(errorDetails: string | null): FailureCause {
  const text = errorDetails ?? "";
  if (/HTTP 429/i.test(text) && (/code -360/i.test(text) || /requests\/day/i.test(text))) return "fyers-daily-limit";
  if (/requests\/day/i.test(text) && /limit/i.test(text)) return "fyers-daily-limit";
  if (/HTTP 401/i.test(text) || /code -(8|15|16|17)\b/i.test(text) || /token (is |was )?(expired|invalid)/i.test(text) || /not session-usable/i.test(text)) return "fyers-auth";
  if (/HTTP 429/i.test(text)) return "fyers-rate-limited";
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text)) return "network";
  return "other";
}

export interface JobRun {
  scheduledFor: Date;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  errorDetails: string | null;
  /** The note kept against a completed run, when it has one. Absent on runs recorded before the note existed. */
  completionNote?: string | null;
}

export interface JobDaySummary {
  runs: number;
  completed: number;
  failed: number;
  running: number;
  /** Runs scheduled inside 09:15-15:30 IST, which are the ones that can write an in-session snapshot. */
  completedInSession: number;
  failedInSession: number;
  causes: Record<FailureCause, number>;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  /**
   * Completed runs that said, in their own note, that an underlying was not collected, and how many such runs named each underlying
   * (a tradable-expiry failure counts for its underlying). Runs from before the note existed carry no note and are not counted here:
   * that is "not recorded", which `partialFailureHidden` still covers by comparing runs with snapshots.
   */
  partialRuns: number;
  partialByUnderlying: Record<string, number>;
}

const IST_OFFSET_MS = 330 * 60_000;

/** The IST calendar date (`YYYY-MM-DD`) of an instant. */
export function istDateOf(instant: Date): string {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function inSession(instant: Date): boolean {
  const minute = istMinuteOfDay(instant);
  return minute >= 9 * 60 + 15 && minute < 15 * 60 + 30;
}

/** Each IST day's runs, counted and failure-classified. A day with no run is simply absent from the map. */
export function summariseJobRuns(runs: readonly JobRun[]): Map<string, JobDaySummary> {
  const byDate = new Map<string, JobDaySummary>();
  for (const run of [...runs].sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())) {
    const date = istDateOf(run.scheduledFor);
    const day = byDate.get(date) ?? {
      runs: 0, completed: 0, failed: 0, running: 0, completedInSession: 0, failedInSession: 0,
      causes: { "fyers-daily-limit": 0, "fyers-rate-limited": 0, "fyers-auth": 0, network: 0, other: 0 }, firstFailureAt: null, lastFailureAt: null,
      partialRuns: 0, partialByUnderlying: {},
    };
    day.runs += 1;
    if (run.status === "COMPLETED") {
      day.completed += 1;
      if (inSession(run.scheduledFor)) day.completedInSession += 1;
      const partial = parsePartialNote(run.completionNote ?? null);
      if (partial !== null && partial.length > 0) {
        day.partialRuns += 1;
        for (const underlying of new Set(partial.map((failure) => baseUnderlying(failure.underlyingSymbol)))) {
          day.partialByUnderlying[underlying] = (day.partialByUnderlying[underlying] ?? 0) + 1;
        }
      }
    } else if (run.status === "FAILED") {
      day.failed += 1;
      if (inSession(run.scheduledFor)) day.failedInSession += 1;
      day.causes[classifyJobFailure(run.errorDetails)] += 1;
      day.firstFailureAt ??= run.scheduledFor.toISOString();
      day.lastFailureAt = run.scheduledFor.toISOString();
    } else {
      day.running += 1;
    }
    byDate.set(date, day);
  }
  return byDate;
}

export interface FyersRequestDay {
  total: number;
  /** Requests by endpoint label, largest first. */
  byEndpoint: Array<{ endpoint: string; count: number }>;
  cap: number;
  guard: number;
  /** The counted total is at or above the plan's daily limit (requests the broker refused are counted too). */
  overCap: boolean;
  /** At or above the scheduler's own budget guard, past which it skips its optional polling jobs (the AI agent tick). */
  overGuard: boolean;
}

/** Each day's Fyers request total from the ledger rows. A day with no row is absent: not recorded, not zero. */
export function summariseFyersRequests(rows: ReadonlyArray<{ dateKey: string; endpoint: string; requestCount: number }>): Map<string, FyersRequestDay> {
  const byDate = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const endpoints = byDate.get(row.dateKey) ?? new Map<string, number>();
    endpoints.set(row.endpoint, (endpoints.get(row.endpoint) ?? 0) + row.requestCount);
    byDate.set(row.dateKey, endpoints);
  }
  const result = new Map<string, FyersRequestDay>();
  for (const [date, endpoints] of byDate) {
    const byEndpoint = [...endpoints.entries()].map(([endpoint, count]) => ({ endpoint, count })).sort((a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint));
    const total = byEndpoint.reduce((sum, entry) => sum + entry.count, 0);
    result.set(date, { total, byEndpoint, cap: FYERS_DAILY_REQUEST_CAP, guard: FYERS_DAILY_BUDGET_WARNING_THRESHOLD, overCap: total >= FYERS_DAILY_REQUEST_CAP, overGuard: total >= FYERS_DAILY_BUDGET_WARNING_THRESHOLD });
  }
  return result;
}

/** The minimum completed in-session runs before a snapshot shortfall is read as a partial failure. */
export const PARTIAL_FAILURE_MIN_RUNS = 5;
/** An index with fewer in-session snapshot minutes than this share of the completed in-session runs is flagged. */
export const PARTIAL_FAILURE_MAX_SHARE = 0.5;

/**
 * The job completed many in-session runs but this index wrote far fewer snapshots: one run covers several underlyings, so a run
 * in which this one failed can still complete. Needs at least `PARTIAL_FAILURE_MIN_RUNS` completed runs to say anything.
 */
export function completedRunsExceedSnapshots(completedInSession: number, snapshotMinutesInSession: number): boolean {
  return completedInSession >= PARTIAL_FAILURE_MIN_RUNS && snapshotMinutesInSession < PARTIAL_FAILURE_MAX_SHARE * completedInSession;
}

export const COLLECTOR_CAUSE_DEFINITIONS = {
  runs: "The option-chain job's runs for the day, from the scheduler's own history. A run the scheduler skipped (for example the Fyers budget guard) is not recorded, so it shows as fewer runs, not as a failure.",
  causes: "A failed run's cause is read from its stored text by pattern, in this order: HTTP 429 with Fyers code -360 or 'requests/day' is the daily limit; HTTP 401, a token error code or an expired/invalid token is authentication; any other HTTP 429 is rate-limited (the text does not prove it was the daily limit); 'fetch failed' or a reset or timed-out connection is network; anything else is other.",
  requests: "Fyers REST requests counted for the day by the request ledger, against the plan's 5,000. Requests are counted when made, including ones the broker refused, so a total can pass the cap. The ledger starts on 2026-10-17: earlier days are not recorded, not zero.",
  guard: "The scheduler skips its optional Fyers polling jobs (the AI agent tick) once the day's count reaches its budget guard (4,200). The futures-bar fetch is not among them since 2026-10-24; before that it was paused at 3,500, so an earlier day over that figure can have truncated futures bars without any failed run.",
  partial: "A run covers several underlyings and can complete with one of them failed. When an index has fewer than half as many in-session snapshot minutes as completed in-session runs (and there are at least 5 runs), the job status is hiding a partial failure for that index.",
} as const;
