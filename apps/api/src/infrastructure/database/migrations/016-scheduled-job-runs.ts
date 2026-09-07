import type { Migration } from "../migration-runner.js";

// A claim table so a scheduled job runs once per due time, not once per process.
//
// `cron.schedule` lived inside the Express app, so every API instance registered every
// job and each one fired its own copy at the due minute -- including spawning
// `npm run pipeline:eod` as a child process. `docker-compose.v2.yml` runs a second stack
// against the same database, so this was not hypothetical: two EOD pipelines could
// train and promote concurrently.
//
// The lock is the unique index on (job_type, scheduled_for) rather than an advisory
// lock. An advisory lock is held only for the life of a connection, so a crashed worker
// releases its claim and a peer re-runs the job; a row persists, which is the correct
// semantics for "this due time has already been handled". It also leaves an audit trail
// of what ran when, and what failed.
//
// `scheduled_for` is the *due* timestamp truncated to the minute, not the moment the job
// started, so two instances firing milliseconds apart compute the same key and exactly
// one insert wins.
export const scheduledJobRunsMigration: Migration = {
  id: "016-scheduled-job-runs",
  sql: `
    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_type TEXT NOT NULL CHECK (length(trim(job_type)) > 0),
      scheduled_for TIMESTAMPTZ NOT NULL,

      status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED')),
      -- Which process holds the claim, so a stuck run can be attributed.
      claimed_by TEXT NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ,
      error_details TEXT,

      CONSTRAINT scheduled_job_runs_completion_consistent CHECK (
        (status = 'RUNNING' AND completed_at IS NULL)
        OR (status <> 'RUNNING' AND completed_at IS NOT NULL)
      )
    );

    -- The lock itself. One row per job per due minute; a second claimant conflicts.
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_runs_claim_idx
    ON scheduled_job_runs (job_type, scheduled_for);

    CREATE INDEX IF NOT EXISTS scheduled_job_runs_recent_idx
    ON scheduled_job_runs (job_type, claimed_at DESC);
  `,
};
