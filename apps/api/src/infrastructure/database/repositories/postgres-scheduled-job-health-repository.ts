import type { DatabaseQueryable } from "../database.js";

/**
 * The most recent COMPLETED run of each job.
 *
 * Completion rather than claim: a claim that failed proves the cron fired but not that the work
 * happened, and this feeds the liveness check that answers "is this job still doing anything".
 * Skips are absent from the table by design, so a gap here is the only durable evidence that a
 * job stopped -- see `scheduled-job-liveness.ts`.
 */
export async function findLatestScheduledJobCompletions(
  database: DatabaseQueryable,
  jobTypes: readonly string[],
): Promise<Map<string, Date>> {
  const result = await database.query<{ job_type: string; last_completed_at: Date | string }>(
    `SELECT job_type, MAX(completed_at) AS last_completed_at
       FROM scheduled_job_runs
      WHERE job_type = ANY($1::text[])
        AND status = 'COMPLETED'
        AND completed_at IS NOT NULL
      GROUP BY job_type`,
    [jobTypes],
  );

  const completions = new Map<string, Date>();
  for (const row of result.rows) {
    const completedAt = row.last_completed_at instanceof Date
      ? row.last_completed_at
      : new Date(row.last_completed_at);
    if (!Number.isNaN(completedAt.getTime())) {
      completions.set(row.job_type, completedAt);
    }
  }
  return completions;
}

/**
 * Counts recent failures that have not been followed by a successful run of the same job.
 *
 * A fixed lookback count is not a current-health signal: one transient failure (or a Docker
 * restart) kept Fyers authentication red for a full day even after re-authorization and
 * dozens of successful provider calls. A later COMPLETED run proves that job has recovered,
 * while consecutive failures after the last success remain visible.
 */
export async function countUnrecoveredScheduledJobFailures(
  database: DatabaseQueryable,
  jobTypes: readonly string[],
): Promise<number> {
  const result = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM scheduled_job_runs failed
     WHERE failed.job_type = ANY($1::text[])
       AND failed.status = 'FAILED'
       AND failed.claimed_at >= NOW() - INTERVAL '1 day'
       AND NOT EXISTS (
         SELECT 1
         FROM scheduled_job_runs recovered
         WHERE recovered.job_type = failed.job_type
           AND recovered.status = 'COMPLETED'
           AND recovered.claimed_at > failed.claimed_at
       )`,
    [jobTypes],
  );

  return Number(result.rows[0]?.count ?? 0);
}
