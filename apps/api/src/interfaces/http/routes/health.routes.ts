import type { Express } from "express";
import { checkDatabaseReadiness, type DatabasePool } from "../../../infrastructure/database/database.js";
import { countUnrecoveredScheduledJobFailures } from "../../../infrastructure/database/repositories/postgres-scheduled-job-health-repository.js";
import { FyersTokenService } from "../../../infrastructure/market-data/fyers-token-service.js";
import { assessFyersAuthHealth } from "../../../modules/market-data/domain/fyers-auth-health.js";
import type { HttpDependencies } from "../dependencies.js";

/** Jobs that stop data arriving, rather than merely delaying a report. */
const CRITICAL_JOB_TYPES = ["OPTION_CHAIN", "OPTION_PREMIUM_TICKS", "EOD_PIPELINE"];
const MAX_CRITICAL_SUCCESS_AGE_HOURS = 72;
const FYERS_DEPENDENT_JOB_TYPES = ["OPTION_CHAIN", "OPTION_PREMIUM_TICKS"];

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
   * Fyers credential usability for the trading session. Never returns tokens.
   */
  app.get("/api/v1/health/fyers", async (_request, response) => {
    const appId = process.env.FYERS_APP_ID;
    const appSecret = process.env.FYERS_APP_SECRET;
    if (!appId || !appSecret) {
      response.status(503).json({
        status: "MISSING",
        reasons: ["FYERS_APP_ID / FYERS_APP_SECRET are not configured in this environment."],
        accessTokenExpiresAt: null,
        lastError: null,
        recoveryHint: "Connect Fyers in Settings (or npm run data:auth:fyers).",
      });
      return;
    }

    try {
      const tokenService = new FyersTokenService({
        pool: database as DatabasePool,
        appId,
        appSecret,
        pin: process.env.FYERS_PIN ?? "",
      });

      const health = await tokenService.checkCredentialHealth();
      const recentJobFailures = await countUnrecoveredScheduledJobFailures(
        database,
        FYERS_DEPENDENT_JOB_TYPES,
      );
      const now = new Date();
      const sessionClose = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0, 0,
      ));
      const assessment = assessFyersAuthHealth({
        now,
        hasCredential: health.hasCredential,
        accessTokenExpiresAt: health.accessTokenExpiresAt,
        refreshTokenExpiresAt: health.refreshTokenExpiresAt,
        lastError: health.lastError,
        recentJobFailures,
        mustRemainValidUntil: sessionClose.getTime() > now.getTime() ? sessionClose : undefined,
      });

      response.status(assessment.status === "OK" ? 200 : 503).json({
        status: assessment.status,
        reasons: assessment.reasons,
        accessTokenExpiresAt: health.accessTokenExpiresAt?.toISOString() ?? null,
        lastError: health.lastError,
        recoveryHint: "Connect Fyers in Settings (or npm run data:auth:fyers).",
      });
    } catch (error) {
      response.status(500).json({
        status: "ERROR",
        reasons: [error instanceof Error ? error.message : "Fyers health could not be read."],
        accessTokenExpiresAt: null,
        lastError: error instanceof Error ? error.message : String(error),
        recoveryHint: "Connect Fyers in Settings (or npm run data:auth:fyers).",
      });
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
    // A seven-day default spans the previous trading day even on weekends and
    // exchange holidays; the old 24-hour window reported a clean bill of health
    // on Sunday after Friday's critical jobs had failed.
    const lookbackHours = Number(request.query.lookbackHours ?? 168);
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
               max(completed_at) FILTER (WHERE status = 'COMPLETED') AS last_completed_at,
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
        lastCompletedAt: row.last_completed_at === null ? null : new Date(row.last_completed_at as string | Date).toISOString(),
        // The captured child output. Truncated here only for transport; the row keeps it all.
        lastError: row.last_error === null ? null : String(row.last_error).slice(0, 2_000),
        critical: CRITICAL_JOB_TYPES.includes(String(row.job_type)),
      }));

      const failing = jobs.filter((job) => job.failed > 0);
      const now = Date.now();
      const criticalFailing = jobs.filter((job) => {
        if (!job.critical || job.lastFailureAt === null) return false;
        return job.lastCompletedAt === null
          || new Date(job.lastFailureAt).getTime() > new Date(job.lastCompletedAt).getTime();
      });
      const staleCritical = CRITICAL_JOB_TYPES.filter((jobType) => {
        const job = jobs.find((candidate) => candidate.jobType === jobType);
        return job?.lastCompletedAt === null || job?.lastCompletedAt === undefined
          || now - new Date(job.lastCompletedAt).getTime() > MAX_CRITICAL_SUCCESS_AGE_HOURS * 3_600_000;
      });
      const degraded = criticalFailing.length > 0 || staleCritical.length > 0;
      response.status(degraded ? 503 : 200).json({
        status: degraded ? "degraded" : failing.length > 0 ? "warning" : "ok",
        lookbackHours: Math.floor(lookbackHours),
        // Named explicitly rather than left for the caller to work out from the list, so an
        // alert rule can key on one field.
        criticalFailures: criticalFailing.map((job) => job.jobType),
        staleCriticalJobs: staleCritical,
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
