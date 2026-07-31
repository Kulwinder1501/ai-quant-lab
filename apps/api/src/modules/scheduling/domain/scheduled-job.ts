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
}

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
 */
export async function runExclusively(
  repository: ScheduledJobClaimRepository,
  claim: ScheduledJobClaim,
  task: () => Promise<void>,
): Promise<RunExclusivelyResult> {
  const won = await repository.claim(claim);
  if (!won) return { ran: false, failed: false };

  try {
    await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repository.fail({ jobType: claim.jobType, scheduledFor: claim.scheduledFor }, message);
    throw error;
  }

  await repository.complete({ jobType: claim.jobType, scheduledFor: claim.scheduledFor });
  return { ran: true, failed: false };
}
