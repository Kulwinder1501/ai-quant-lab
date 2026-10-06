import type { Migration } from "../migration-runner.js";

// Writes off scheduled runs that were left RUNNING by a claimant that is gone.
//
// A row is only ever moved out of RUNNING by the process that claimed it, so a container
// restart -- or, here, a job that never finished -- strands it permanently. On 2026-08-07
// there were 330 such rows for INDICES_INTRADAY, from 06 Aug 04:34 UTC onward, against a
// single COMPLETED run in 72 hours: a `*/1` cron over a job that took longer than a minute,
// with nothing stopping each tick from starting another copy.
//
// The scheduler now skips a due minute while a previous run is unfinished, and sweeps rows
// older than the job's abandonment horizon on the way in, so this cannot re-accumulate.
// That sweep would eventually clear these too; doing it here means the job-health endpoint
// stops reporting hundreds of phantom running jobs immediately, rather than on whichever
// tick happens to run first.
//
// One hour is well past every job's horizon in the scheduler (the longest is EOD_PIPELINE at
// six, but it is daily and cannot have a legitimate run this old at migration time), so a
// genuinely-working run cannot be caught by this.
export const reconcileAbandonedJobRunsMigration: Migration = {
  id: "049-reconcile-abandoned-job-runs",
  sql: `
    UPDATE scheduled_job_runs
    SET status = 'FAILED',
        completed_at = CURRENT_TIMESTAMP,
        error_details = COALESCE(error_details, '')
          || 'Presumed abandoned: still RUNNING more than an hour after it was claimed, so '
          || 'its claimant is gone. Written off by migration 049. No output was captured.'
    WHERE status = 'RUNNING'
      AND claimed_at < CURRENT_TIMESTAMP - INTERVAL '1 hour';
  `,
};
