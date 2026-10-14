/**
 * Did the morning pre-market run happen, and if not, why?
 *
 * On 2026-10-14 the 08:52 and 08:57 runs and the 09:10 update left no trace at all -- no job row, no attempt, no
 * stored result -- while the scheduler ran its other jobs, and by the time anyone looked the container had been
 * replaced and its logs with it. "Nothing happened" cannot be told apart from "it failed" without evidence taken
 * the same morning, so this decides from the database plus what this process knows about its own timers.
 */
export interface PremarketRunEvidence {
  readonly sessionDate: string;
  /** The NSE holiday's name, or null on a trading day. */
  readonly holiday: string | null;
  /** The stored result for the date, if any (a VALID or INSUFFICIENT_DATA row, whatever the model did). */
  readonly terminal: { readonly status: string; readonly llmStatus: string } | null;
  readonly attemptStatuses: readonly string[];
  readonly jobRunStatuses: readonly string[];
  /** When this process's 08:52 and 08:57 timers last fired, or null if they have not. */
  readonly firstSlotTimerFiredAt: Date | null;
  readonly finalSlotTimerFiredAt: Date | null;
  readonly processStartedAt: Date;
  /** When the first and last slots were due today. */
  readonly firstSlotDueAt: Date;
  readonly finalSlotDueAt: Date;
}

export type PremarketRunVerdict =
  | { readonly outcome: "HOLIDAY"; readonly detail: string }
  | { readonly outcome: "OK"; readonly detail: string }
  /** A job or attempt was recorded but no result was stored. */
  | { readonly outcome: "RAN_NO_RESULT"; readonly detail: string }
  /** Nothing was recorded at all. */
  | { readonly outcome: "MISSED"; readonly detail: string };

const istTime = (instant: Date): string => new Date(instant.getTime() + 5.5 * 60 * 60_000).toISOString().slice(11, 16);

/** Timer fires are stamped at the second the cron ticks; a minute of slack covers scheduling jitter. */
const TIMER_JITTER_MS = 60_000;

export function assessPremarketRun(evidence: PremarketRunEvidence): PremarketRunVerdict {
  if (evidence.holiday !== null) {
    return { outcome: "HOLIDAY", detail: `${evidence.sessionDate} is an NSE holiday (${evidence.holiday}); no run expected.` };
  }
  if (evidence.terminal !== null) {
    return {
      outcome: "OK",
      detail: `${evidence.sessionDate}: stored result ${evidence.terminal.status}, model ${evidence.terminal.llmStatus}.`,
    };
  }
  if (evidence.jobRunStatuses.length > 0 || evidence.attemptStatuses.length > 0) {
    return {
      outcome: "RAN_NO_RESULT",
      detail: `${evidence.sessionDate}: the run was recorded (job ${evidence.jobRunStatuses.join(",") || "none"}; attempts `
        + `${evidence.attemptStatuses.join(",") || "none"}) but no result was stored.`,
    };
  }

  const prefix = `${evidence.sessionDate}: no pre-market job, attempt or result was recorded`;
  if (evidence.processStartedAt.getTime() > evidence.finalSlotDueAt.getTime()) {
    return {
      outcome: "MISSED",
      detail: `${prefix}. This scheduler process started at ${istTime(evidence.processStartedAt)} IST, after the `
        + `${istTime(evidence.finalSlotDueAt)} slot -- it was down or restarting through the window (a deploy?).`,
    };
  }
  const fired = (at: Date | null, due: Date): boolean => at !== null && at.getTime() >= due.getTime() - TIMER_JITTER_MS;
  if (!fired(evidence.firstSlotTimerFiredAt, evidence.firstSlotDueAt) && !fired(evidence.finalSlotTimerFiredAt, evidence.finalSlotDueAt)) {
    return {
      outcome: "MISSED",
      detail: `${prefix}, and neither the ${istTime(evidence.firstSlotDueAt)} nor the ${istTime(evidence.finalSlotDueAt)} timer fired in `
        + `this process (up since ${istTime(evidence.processStartedAt)} IST): the hour-restricted timers did not run.`,
    };
  }
  return {
    outcome: "MISSED",
    detail: `${prefix}, although the timers fired (first ${evidence.firstSlotTimerFiredAt === null ? "never" : istTime(evidence.firstSlotTimerFiredAt)}, `
      + `final ${evidence.finalSlotTimerFiredAt === null ? "never" : istTime(evidence.finalSlotTimerFiredAt)} IST): the job was not claimed.`,
  };
}
