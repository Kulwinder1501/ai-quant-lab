/**
 * Detects a scheduled job that has stopped running, as distinct from one that is failing.
 *
 * These are different faults with different evidence, and only one of them was covered.
 * `countUnrecoveredScheduledJobFailures` counts FAILED rows, so a job that keeps failing is
 * visible; a job that stops *claiming* writes no row at all and therefore no failure, which
 * makes total silence indistinguishable from a healthy quiet period.
 *
 * That gap is not hypothetical. On 2026-08-17 OPTION_CHAIN completed every fifteen minutes until
 * 05:45, failed once at 06:00, then produced no row whatsoever at 06:15 or 06:30 -- while
 * every-minute jobs in the same process kept claiming normally. The chain snapshot went an hour
 * stale, OPTION_PREMIUM_TICKS refused with NO_FRESH_ATM_CONTRACTS for fifty minutes, and nothing
 * raised an alarm because nothing was watching for absence. It was found by hand.
 *
 * A skip is deliberately not recorded (`runExclusively` treats claiming a run that did not happen
 * as a lie), so absence cannot be diagnosed from the table after the container's logs are gone.
 * Watching the gap since the last *completion* is the one signal that survives that.
 */
export interface ScheduledJobExpectation {
  jobType: string;
  /** How often the cron fires, in milliseconds. */
  intervalMs: number;
  /**
   * How many intervals may pass with no completion before this is overdue.
   *
   * Above one because a skip is normal: an every-minute job whose run outlives its minute
   * legitimately misses ticks, and a job that failed once legitimately has a gap. This is meant
   * to catch a job that has stopped, not one that stuttered.
   */
  toleratedIntervals?: number;
}

export interface OverdueScheduledJob {
  jobType: string;
  lastCompletedAt: Date | null;
  /** Milliseconds since the last completion, or since `since` when there has never been one. */
  silentForMs: number;
  toleratedSilenceMs: number;
}

const DEFAULT_TOLERATED_INTERVALS = 3;

export interface FindOverdueScheduledJobsInput {
  expectations: readonly ScheduledJobExpectation[];
  lastCompletedAt: ReadonlyMap<string, Date>;
  now: Date;
  /**
   * When the watch window opened -- normally the later of market open and process start.
   *
   * A job with no completion at all is only overdue relative to something. Measuring from epoch
   * would report every job as infinitely overdue on a fresh database, and measuring from `now`
   * would never report one.
   */
  since: Date;
}

export function findOverdueScheduledJobs(
  input: FindOverdueScheduledJobsInput,
): OverdueScheduledJob[] {
  const overdue: OverdueScheduledJob[] = [];
  for (const expectation of input.expectations) {
    const tolerated = expectation.intervalMs
      * (expectation.toleratedIntervals ?? DEFAULT_TOLERATED_INTERVALS);
    const lastCompletedAt = input.lastCompletedAt.get(expectation.jobType) ?? null;
    // A completion before the window opened tells us nothing about this window, so it is
    // measured from `since` exactly as a job with no completion at all would be.
    const measuredFrom = lastCompletedAt !== null && lastCompletedAt.getTime() > input.since.getTime()
      ? lastCompletedAt.getTime()
      : input.since.getTime();
    const silentForMs = input.now.getTime() - measuredFrom;
    if (silentForMs > tolerated) {
      overdue.push({
        jobType: expectation.jobType,
        lastCompletedAt,
        silentForMs,
        toleratedSilenceMs: tolerated,
      });
    }
  }
  // Worst first: the longest silence is the one most likely to have starved something downstream.
  return overdue.sort((left, right) => right.silentForMs - left.silentForMs);
}
