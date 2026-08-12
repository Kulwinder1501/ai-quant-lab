import type { DatabaseQueryable } from "../database.js";

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
