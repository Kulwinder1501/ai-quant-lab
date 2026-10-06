/**
 * A scheduled job's identity and its due time, independent of how it is run.
 *
 * Kept free of cron and of the database so the claim semantics can be tested without
 * either.
 */
export interface ScheduledJobClaim {
  jobType: string;
  /** The due time, truncated to the minute so concurrent claimants agree on the key. */
  scheduledFor: Date;
  claimedBy: string;
}

export interface ScheduledJobClaimRepository {
  /** True when this process won the claim; false when a peer already holds it. */
  claim(claim: ScheduledJobClaim): Promise<boolean>;
  complete(claim: Omit<ScheduledJobClaim, "claimedBy">): Promise<void>;
  fail(claim: Omit<ScheduledJobClaim, "claimedBy">, errorDetails: string): Promise<void>;
  /**
   * Marks runs still RUNNING that were claimed before `abandonedBefore` as FAILED, and
   * returns how many. A claimant that is killed -- a container restart, an OOM -- leaves
   * its row RUNNING forever, because nothing else knows the process is gone.
   */
  abandonStaleRuns(jobType: string, abandonedBefore: Date, reason: string): Promise<number>;
  /** How many runs of this job are still RUNNING. */
  countRunning(jobType: string): Promise<number>;
}

/**
 * Truncates a due time to the minute.
 *
 * Two instances woken by the same cron tick are milliseconds apart, so the raw
 * timestamps differ and a uniqueness constraint on them would let both through. The
 * minute is the finest granularity any cron expression here can express, so it is the
 * correct key.
 */
export function toDueMinute(instant: Date): Date {
  const due = new Date(instant.getTime());
  due.setUTCSeconds(0, 0);
  return due;
}

export interface RunExclusivelyResult {
  ran: boolean;
  failed: boolean;
  /** Why the task did not run. Absent when it did. */
  skippedReason?: "CLAIMED_BY_PEER" | "PREVIOUS_RUN_UNFINISHED";
  /** Crashed runs reconciled to FAILED on the way in. */
  abandonedRuns?: number;
}

export interface RunExclusivelyOptions {
  /**
   * Skip this due minute when an earlier run of the same job is still going.
   *
   * The claim key is (jobType, scheduledFor), so it makes each *minute* run once -- it
   * says nothing about whether the previous minute has finished. On an every-minute cron
   * over a job that takes longer than a minute, every tick therefore starts another copy,
   * and they accumulate: INDICES_INTRADAY reached 330 concurrent runs and completed once
   * in 72 hours, each copy making the rest slower.
   */
  overlap?: "SKIP" | "ALLOW";
  /**
   * How long a run may be RUNNING before it is presumed dead. Must exceed the job's
   * longest honest runtime, or a slow run is declared abandoned while it is still working
   * and the next tick starts a second copy -- the exact pileup this prevents.
   */
  abandonedAfterMs?: number;
  now?: Date;
}

/** Long enough for the intraday jobs, which is what `overlap: "SKIP"` is for. Override per job. */
export const DEFAULT_ABANDONED_AFTER_MS = 15 * 60 * 1000;

/**
 * Runs `task` only if this process wins the claim for that due minute.
 *
 * A losing claimant does nothing and says so, rather than throwing: losing is the normal
 * outcome for every instance but one, not an error.
 *
 * A task that throws is recorded as FAILED and the error is rethrown to the caller. The
 * claim row is deliberately *not* deleted on failure -- a failed run has still consumed
 * its due minute, and deleting it would let a peer immediately retry the same work,
 * which for the EOD pipeline means concurrent training.
 *
 * With `overlap: "SKIP"` the due minute is skipped while a previous run is unfinished, and
 * is deliberately **not claimed** -- nothing ran, so recording a run would be a lie, and
 * the next tick has its own key regardless. Staleness is checked first, so a job whose
 * claimant was killed recovers on the following tick instead of blocking itself forever.
 */
export async function runExclusively(
  repository: ScheduledJobClaimRepository,
  claim: ScheduledJobClaim,
  task: () => Promise<void>,
  options: RunExclusivelyOptions = {},
): Promise<RunExclusivelyResult> {
  let abandonedRuns = 0;
  if (options.overlap === "SKIP") {
    const now = options.now ?? new Date();
    const abandonedAfterMs = options.abandonedAfterMs ?? DEFAULT_ABANDONED_AFTER_MS;
    abandonedRuns = await repository.abandonStaleRuns(
      claim.jobType,
      new Date(now.getTime() - abandonedAfterMs),
      `Presumed abandoned: still RUNNING more than ${Math.round(abandonedAfterMs / 60_000)} minutes `
        + "after it was claimed, so its claimant is gone. No output was captured.",
    );
    if (await repository.countRunning(claim.jobType) > 0) {
      return { ran: false, failed: false, skippedReason: "PREVIOUS_RUN_UNFINISHED", abandonedRuns };
    }
  }

  const won = await repository.claim(claim);
  if (!won) return { ran: false, failed: false, skippedReason: "CLAIMED_BY_PEER", abandonedRuns };

  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.fail({ jobType: claim.jobType, scheduledFor: claim.scheduledFor }, message);
    throw error;
  }

  await repository.complete({ jobType: claim.jobType, scheduledFor: claim.scheduledFor });
  return { ran: true, failed: false, abandonedRuns };
}
