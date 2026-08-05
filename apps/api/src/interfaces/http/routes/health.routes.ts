import type { Express } from "express";
import { checkDatabaseReadiness } from "../../../infrastructure/database/database.js";
import type { HttpDependencies } from "../dependencies.js";

/** Jobs that stop data arriving, rather than merely delaying a report. */
const CRITICAL_JOB_TYPES = ["OPTION_CHAIN", "EOD_PIPELINE"];

export function registerHealthRoutes(app: Express, { database }: Pick<HttpDependencies, "database">): void {
  app.get("/api/v1/health", (_request, response) => {
    response.status(200).json({ status: "ok", service: "ai-quant-lab-api" });
  });

  app.get("/api/v1/health/ready", async (_request, response) => {
    try {
      const databaseStatus = await checkDatabaseReadiness(database);
      response.status(200).json({ status: "ready", database: databaseStatus });
    } catch {
      response.status(503).json({ status: "not_ready", database: { ready: false } });
    }
  });

  /**
   * Failed scheduled jobs, so something outside the process can notice them.
   *
   * The scheduler already logs a failure at error level and records the child's output, but an
   * error line in a container log is found only by someone already looking. This is the read
   * side: a userwatch, uptime check or dashboard can poll it. It deliberately does not send
   * anything itself — that needs a channel and credentials, which belong to the operator.
   *
   * Answers 503 when a critical job has failed. OPTION_CHAIN is critical because that series
   * is forward-accumulating with no backfill, so a lost interval is lost permanently; a late
   * report is recoverable, a missing observation is not.
   */
  app.get("/api/v1/health/jobs", async (request, response) => {
    const lookbackHours = Number(request.query.lookbackHours ?? 24);
    if (!Number.isFinite(lookbackHours) || lookbackHours <= 0 || lookbackHours > 720) {
      response.status(400).json({ error: "lookbackHours must be a positive number of hours up to 720." });
      return;
    }

    try {
      const result = await database.query(`
        SELECT job_type,
               count(*) FILTER (WHERE status = 'FAILED')::int    AS failed,
               count(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
               count(*) FILTER (WHERE status = 'RUNNING')::int   AS running,
               max(claimed_at) FILTER (WHERE status = 'FAILED')  AS last_failure_at,
               (array_agg(error_details ORDER BY claimed_at DESC)
                  FILTER (WHERE status = 'FAILED' AND error_details IS NOT NULL))[1] AS last_error
        FROM scheduled_job_runs
        WHERE claimed_at >= NOW() - make_interval(hours => $1::int)
        GROUP BY job_type
        ORDER BY job_type
      `, [Math.floor(lookbackHours)]);

      const jobs = result.rows.map((row) => ({
        jobType: String(row.job_type),
        failed: Number(row.failed),
        completed: Number(row.completed),
        running: Number(row.running),
        lastFailureAt: row.last_failure_at === null ? null : new Date(row.last_failure_at as string | Date).toISOString(),
        // The captured child output. Truncated here only for transport; the row keeps it all.
        lastError: row.last_error === null ? null : String(row.last_error).slice(0, 2_000),
        critical: CRITICAL_JOB_TYPES.includes(String(row.job_type)),
      }));

      const failing = jobs.filter((job) => job.failed > 0);
      const criticalFailing = failing.filter((job) => job.critical);
      response.status(criticalFailing.length > 0 ? 503 : 200).json({
        status: criticalFailing.length > 0 ? "degraded" : failing.length > 0 ? "warning" : "ok",
        lookbackHours: Math.floor(lookbackHours),
        // Named explicitly rather than left for the caller to work out from the list, so an
        // alert rule can key on one field.
        criticalFailures: criticalFailing.map((job) => job.jobType),
        jobs,
      });
    } catch (error) {
      response.status(500).json({
        status: "unknown",
        error: error instanceof Error ? error.message : "Job health could not be read.",
      });
    }
  });
}
