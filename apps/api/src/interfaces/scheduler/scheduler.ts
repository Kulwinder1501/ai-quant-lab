import "dotenv/config";
import cron from "node-cron";
import { runCommand as runChildCommand } from "./run-command.js";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { PostgresNewsRepository } from "../../infrastructure/database/repositories/postgres-news-repository.js";
import { PostgresScheduledJobClaimRepository } from "../../infrastructure/database/repositories/postgres-scheduled-job-claim-repository.js";
import { assessFyersAuthHealth } from "../../modules/market-data/domain/fyers-auth-health.js";
import { IngestRssNewsService } from "../../modules/news-sentiment/application/ingest-rss-news.js";
import { runExclusively, toDueMinute } from "../../modules/scheduling/domain/scheduled-job.js";

/** Jobs that fail whenever the Fyers credential is unusable; folded into the daily auth health check. */
const FYERS_DEPENDENT_JOB_TYPES = ["OPTION_CHAIN"];

/**
 * The scheduler process.
 *
 * These schedules used to be registered inside the Express app, so every API instance
 * ran every one of them -- including spawning `npm run pipeline:eod`. With
 * `docker-compose.v2.yml` running a second stack against the same database, two EOD
 * pipelines could train and promote concurrently. Serving HTTP and owning time are
 * different responsibilities, and only one of them may be replicated freely.
 *
 * Every job still claims its due minute before running, so scaling this process, or
 * briefly running an old and a new one side by side during a deploy, cannot double-fire.
 */

const IST = "Asia/Kolkata";
const processIdentity = `${hostname()}:${process.pid}`;

function istDateKey(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(instant);
}

// apps/api/{src|dist}/interfaces/scheduler → five levels up is the repo root.
// Spawned npm scripts are resolved against the root package.json explicitly,
// because the process cwd differs between host runs (apps/api) and the
// container (/app) — relying on it silently broke every ML job in Docker.
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

/**
 * Child output is captured as well as forwarded, so a FAILED row in `scheduled_job_runs`
 * carries the reason rather than only an exit code. See `run-command.ts`.
 */
function runCommand(command: string, args: string[]): Promise<void> {
  return runChildCommand(command, args, { cwd: REPO_ROOT });
}

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ level: "info", message, process: processIdentity, ...extra }));
}

/**
 * Fyers has no non-interactive re-authorization path, so this never tries to log in on
 * a human's behalf. What it closes: nothing today checks the credential before it lapses,
 * and nothing reads the failures `scheduled_job_runs` already records -- a lapsed token
 * was previously discovered only when the option-chain expiry gate started refusing live
 * trades. Proactively calling `getAccessToken()` also refreshes the access token ahead of
 * the trading session, instead of the first OPTION_CHAIN run at market open finding out.
 */
async function checkFyersAuthHealth(tokenService: FyersTokenService, database: DatabasePool): Promise<void> {
  let refreshError: string | null = null;
  try {
    await tokenService.getAccessToken();
  } catch (error) {
    refreshError = error instanceof Error ? error.message : String(error);
  }

  const health = await tokenService.checkCredentialHealth();
  const failures = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM scheduled_job_runs
     WHERE job_type = ANY($1) AND status = 'FAILED' AND claimed_at >= NOW() - INTERVAL '1 day'`,
    [FYERS_DEPENDENT_JOB_TYPES],
  );
  const recentJobFailures = Number(failures.rows[0]?.count ?? 0);

  // The token must last until the close, because the intervals it would miss cannot be
  // backfilled. 15:30 IST is 10:00 UTC.
  const now = new Date();
  const sessionClose = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 0, 0, 0,
  ));

  const assessment = assessFyersAuthHealth({
    now,
    hasCredential: health.hasCredential,
    accessTokenExpiresAt: health.accessTokenExpiresAt,
    refreshTokenExpiresAt: health.refreshTokenExpiresAt,
    lastError: refreshError ?? health.lastError,
    recentJobFailures,
    // Only meaningful while the close is still ahead; after it, a token dying today has
    // stranded nothing.
    mustRemainValidUntil: sessionClose.getTime() > now.getTime() ? sessionClose : undefined,
  });

  const payload = {
    level: assessment.status === "OK" ? "info" : "error",
    message: "Fyers auth health check",
    process: processIdentity,
    status: assessment.status,
    reasons: assessment.reasons,
  };
  if (assessment.status === "OK") {
    console.info(JSON.stringify(payload));
  } else {
    console.error(JSON.stringify(payload));
  }
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const claims = new PostgresScheduledJobClaimRepository(database);
  const ingestNews = new IngestRssNewsService(new PostgresNewsRepository(database));

  const fyersAppId = process.env.FYERS_APP_ID;
  const fyersAppSecret = process.env.FYERS_APP_SECRET;
  const fyersTokenService = fyersAppId && fyersAppSecret
    ? new FyersTokenService({
      pool: database,
      appId: fyersAppId,
      appSecret: fyersAppSecret,
      pin: process.env.FYERS_PIN ?? "",
    })
    : null;

  /**
   * How long each job may legitimately be RUNNING before it is presumed dead.
   *
   * This has to exceed the job's slowest honest run, not its typical one: declaring a
   * working run abandoned lets the next tick start a second copy, which is the pileup
   * this is here to stop. Absent entries take the 15-minute default.
   *
   * The cost of that direction is paid after a restart: the previous container's rows are
   * still RUNNING and not yet old enough to sweep, so the job stays skipped for up to one
   * horizon. Ten minutes of a per-minute job is the right trade against restarting a
   * pileup, and the alternative -- a heartbeat column -- is more machinery than the
   * failure justifies.
   */
  const ABANDONED_AFTER_MS: Record<string, number> = {
    // Trains and promotes models; measured in hours, not minutes.
    EOD_PIPELINE: 6 * 60 * 60 * 1000,
    INSTITUTIONAL_FLOWS: 30 * 60 * 1000,
    INSTITUTIONAL_FLOWS_RETRY: 30 * 60 * 1000,
    // Every intraday job below is on a cron faster than this, so a run that outlives its
    // horizon has stopped being useful anyway -- the next tick's data supersedes it.
    INDICES_INTRADAY: 10 * 60 * 1000,
    INDIA_VIX_INTRADAY: 10 * 60 * 1000,
    OPTION_CHAIN: 10 * 60 * 1000,
    PAPER_TRADING_BOT: 10 * 60 * 1000,
    RSS_NEWS_INGESTION: 10 * 60 * 1000,
  };

  /**
   * Runs this process has claimed and not yet finished.
   *
   * Only so shutdown can write them off. Age is the general answer to a dead claimant, but
   * it costs a full horizon after every deploy -- the stopped container's rows are still
   * RUNNING and not yet old enough to sweep, so the overlap guard skips until they are. A
   * process that is being asked to stop knows exactly which rows are its own.
   */
  const inFlightRuns = new Map<string, { jobType: string; scheduledFor: Date }>();

  async function schedule(jobType: string, task: () => Promise<void>): Promise<void> {
    const scheduledFor = toDueMinute(new Date());
    const runKey = `${jobType}@${scheduledFor.toISOString()}`;
    try {
      // Every job here skips rather than overlaps itself. None of them is faster for
      // running twice at once, and INDICES_INTRADAY -- a `*/1` cron over a job that takes
      // longer than a minute -- accumulated 330 concurrent runs and completed once in 72
      // hours, each copy slowing the others until none finished.
      const result = await runExclusively(
        claims,
        { jobType, scheduledFor, claimedBy: processIdentity },
        async () => {
          inFlightRuns.set(runKey, { jobType, scheduledFor });
          try {
            await task();
          } finally {
            inFlightRuns.delete(runKey);
          }
        },
        { overlap: "SKIP", abandonedAfterMs: ABANDONED_AFTER_MS[jobType] },
      );
      if (result.abandonedRuns) {
        console.error(JSON.stringify({
          level: "error",
          message: "Reconciled scheduled runs whose claimant is gone",
          process: processIdentity,
          jobType,
          abandonedRuns: result.abandonedRuns,
        }));
      }
      log(result.ran ? "Scheduled job completed" : "Scheduled job skipped", {
        jobType,
        scheduledFor: scheduledFor.toISOString(),
        ...(result.ran ? {} : { skippedReason: result.skippedReason }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        level: "error",
        message: "Scheduled job failed",
        process: processIdentity,
        jobType,
        scheduledFor: scheduledFor.toISOString(),
        error: message,
      }));
    }
  }

  cron.schedule("5 16 * * 1-5", () => {
    void schedule("EOD_PIPELINE", () => runCommand("npm", ["run", "pipeline:eod"]));
  }, { timezone: IST });

  // Intraday shadow predictions for the model-competition pool. Labels are
  // session-partitioned (a bar near the close has no same-session forward bars),
  // so predictions must be made during the session to ever settle; a single EOD
  // prediction on the day's final bar would never mature. Each run ingests the
  // session's completed 15m bars so far, then predicts once per pool model on
  // the latest one — idempotent per (model, candle), so overlapping runs and
  // out-of-hours no-ops are harmless.
  cron.schedule("*/15 9-15 * * 1-5", () => {
    void schedule("INTRADAY_MODEL_PREDICTIONS", async () => {
      const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
      await runCommand("npm", [
        "run", "data:collect:historical", "--",
        "--provider", "fyers",
        "--instrument", "NIFTY50",
        "--timeframe", "15m",
        "--from", todayIst,
        "--to", todayIst,
        "--skip-existing",
      ]);
      await runCommand("npm", ["run", "ml:predict", "--", "--competition-pool"]);
      await runCommand("npm", ["run", "ml:predict:volatility-shadow"]);
    });
  }, { timezone: IST });

  cron.schedule("30 18 * * 1-5", () => {
    void schedule("INSTITUTIONAL_FLOWS", () => runCommand("npm", ["run", "data:collect:institutional"]));
  }, { timezone: IST });

  // NSE sometimes publishes the provisional cash print late. These idempotent
  // retries close the gap the original one-shot 18:30 schedule left overnight.
  cron.schedule("15 19,20 * * 1-5", () => {
    void schedule("INSTITUTIONAL_FLOWS_RETRY", () => runCommand("npm", ["run", "data:collect:institutional"]));
  }, { timezone: IST });

  const collectIndiaVix = async (timeframes: readonly string[], lookbackDays: number): Promise<void> => {
    const now = new Date();
    const lookback = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    for (const timeframe of timeframes) {
      await runCommand("npm", [
        "run", "data:collect:historical", "--",
        "--provider", "yahoo",
        "--instrument", "INDIAVIX",
        "--timeframe", timeframe,
        "--from", istDateKey(lookback),
        "--to", istDateKey(now),
        "--skip-existing",
      ]);
      await runCommand("npm", [
        "run", "analysis:calculate-indicators", "--",
        "--instrument", "INDIAVIX", "--timeframe", timeframe,
      ]);
    }
  };

  cron.schedule("30 16 * * 1-5", () => {
    void schedule("INDIA_VIX_EOD", () => collectIndiaVix(["1d"], 10));
  }, { timezone: IST });
  cron.schedule("15 17,18 * * 1-5", () => {
    void schedule("INDIA_VIX_EOD_RETRY", () => collectIndiaVix(["1d"], 10));
  }, { timezone: IST });

  // Exact-timeframe VIX bars keep the existing point-in-time feature contract
  // valid for intraday and scalp models; no daily value is silently borrowed.
  cron.schedule("*/5 9-15 * * 1-5", () => {
    void schedule("INDIA_VIX_INTRADAY", () => collectIndiaVix(["1m", "5m", "15m"], 2));
  }, { timezone: IST });

  /**
   * How far back an intraday indicator recompute writes.
   *
   * Indicators are still *computed* over the full series -- EMA and the SMC pivots need
   * the history -- but writing all of it every minute was the job's real cost: 54,006
   * NIFTY50 1m bars times fifteen definitions is ~810,000 upserts per run, on an
   * every-minute cron. Bounding the write leaves the values identical and the work
   * proportional to what actually changed.
   *
   * Five days rather than one because nothing else recomputes index indicators -- the EOD
   * pipeline does not -- so a missed session has to heal on the next run, including over
   * a long weekend.
   */
  const INDICATOR_WRITE_LOOKBACK_DAYS = 5;

  const collectIndicesIntraday = async (timeframes: readonly string[]): Promise<void> => {
    const now = new Date();
    const todayIst = istDateKey(now);
    const indicatorsFrom = istDateKey(
      new Date(now.getTime() - INDICATOR_WRITE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    );
    for (const instrument of ["NIFTY50", "BANKNIFTY"]) {
      for (const timeframe of timeframes) {
        await runCommand("npm", [
          "run", "data:collect:historical", "--",
          "--provider", "fyers",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", todayIst,
          "--to", todayIst,
          "--skip-existing",
        ]);
        await runCommand("npm", [
          "run", "analysis:calculate-indicators", "--",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", indicatorsFrom,
        ]);
      }
    }
  };

  cron.schedule("*/1 9-15 * * 1-5", () => {
    // Requires a healthy Fyers token, which FYERS_AUTH_HEALTH_CHECK ensures is available
    if (fyersTokenService) {
      void schedule("INDICES_INTRADAY", () => collectIndicesIntraday(["1m", "5m"]));
    }
  }, { timezone: IST });

  cron.schedule("*/5 9-15 * * 1-5", () => {
    if (fyersTokenService) {
      void schedule("PAPER_TRADING_BOT", () => runCommand("npm", ["run", "trading:paper:bot"]));
    }
  }, { timezone: IST });

  // Once daily, well before the 9:15 open: proactively refresh the Fyers access token and
  // report credential health, so a lapsed or soon-to-lapse refresh token is a visible log
  // line at 8:00 rather than a silent trade refusal discovered mid-session. Skipped
  // entirely (not merely a no-op alert) when Fyers isn't configured in this environment.
  if (fyersTokenService) {
    cron.schedule("0 8 * * 1-5", () => {
      void schedule("FYERS_AUTH_HEALTH_CHECK", () => checkFyersAuthHealth(fyersTokenService, database));
    }, { timezone: IST });
  }

  // Option chain, every 15 minutes through the session.
  //
  // This series is forward-accumulating and cannot be backfilled: a chain endpoint
  // returns the current book, there is no historical source, and Workstream D3 forbids
  // presenting today's page as though it were the past. Every interval not collected is
  // permanently unavailable, which is why this is scheduled rather than run on demand.
  //
  // Fifteen minutes is a deliberate compromise. Change in open interest is the useful
  // figure rather than its level, so intra-session granularity matters; but each run is
  // one request per underlying against a provider that answers 429 after roughly a dozen
  // rapid calls.
  cron.schedule("*/15 9-15 * * 1-5", () => {
    void schedule("OPTION_CHAIN", () => runCommand("npm", [
      "run", "data:collect:option-chain", "--",
      "--underlyings", "NIFTY50,BANKNIFTY,SBIN,RELIANCE",
      "--strike-count", "15",
    ]));
  }, { timezone: IST });

  // Every three minutes, matching the interval this replaced. It claims its due minute
  // like everything else, so replicas share the work rather than each ingesting the same
  // feeds and racing on the same article rows.
  cron.schedule("*/3 * * * *", () => {
    void schedule("RSS_NEWS_INGESTION", async () => { await ingestNews.execute(); });
  });

  log("Scheduler started", {
    jobs: [
      "EOD_PIPELINE",
      "INTRADAY_MODEL_PREDICTIONS",
      "INDICES_INTRADAY",
      "INSTITUTIONAL_FLOWS",
      "INSTITUTIONAL_FLOWS_RETRY",
      "INDIA_VIX_EOD",
      "INDIA_VIX_EOD_RETRY",
      "INDIA_VIX_INTRADAY",
      ...(fyersTokenService ? ["FYERS_AUTH_HEALTH_CHECK", "PAPER_TRADING_BOT"] : []),
      "OPTION_CHAIN",
      "RSS_NEWS_INGESTION",
    ],
    timezone: IST,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("Scheduler shutting down", { signal, inFlightRuns: inFlightRuns.size });
    // Child processes die with this one, so these runs are ending whether or not they
    // finished. Recording that here is what lets the next container start work
    // immediately, instead of waiting out an abandonment horizon on rows only this
    // process could explain. A run killed mid-flight is a failure, not a completion.
    for (const run of inFlightRuns.values()) {
      try {
        await claims.fail(run, `Interrupted by scheduler shutdown (${signal}); the run did not finish.`);
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "Could not record an interrupted run on shutdown",
          process: processIdentity,
          jobType: run.jobType,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    await database.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
