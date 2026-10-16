import "dotenv/config";
import cron from "node-cron";
import { runCommand as runChildCommand } from "./run-command.js";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool, type DatabasePool } from "../../infrastructure/database/database.js";
import {
  countUnrecoveredScheduledJobFailures,
  findLatestScheduledJobCompletions,
} from "../../infrastructure/database/repositories/postgres-scheduled-job-health-repository.js";
import {
  findOverdueScheduledJobs,
  type ScheduledJobExpectation,
} from "../../modules/scheduling/domain/scheduled-job-liveness.js";
import {
  assessCronStall,
  canaryCronExpression,
  canaryShouldBeFiring,
  canaryWindowOpenedAt,
} from "../../modules/scheduling/domain/cron-liveness.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { PostgresNewsRepository } from "../../infrastructure/database/repositories/postgres-news-repository.js";
import { PostgresScheduledJobClaimRepository } from "../../infrastructure/database/repositories/postgres-scheduled-job-claim-repository.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { PostgresOpenPositionContractRepository } from "../../infrastructure/database/repositories/postgres-open-position-contract-repository.js";
import { PostgresOpenTradeAccountRepository } from "../../infrastructure/database/repositories/postgres-open-trade-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { SweepOpenPaperTradeExits } from "../../modules/paper-trading/application/sweep-open-paper-trade-exits.js";
import { FyersLiveStreamer } from "../../infrastructure/market-data/fyers-live-streamer.js";
import { OptionPremiumTickStreamer } from "../../infrastructure/market-data/option-premium-tick-streamer.js";
import { assessFyersAuthHealth } from "../../modules/market-data/domain/fyers-auth-health.js";
import { IngestRssNewsService } from "../../modules/news-sentiment/application/ingest-rss-news.js";
import { runExclusively, toDueMinute } from "../../modules/scheduling/domain/scheduled-job.js";
import { createSchedulerLogSink } from "./scheduler-log-sink.js";
import {
  FYERS_REST_JOB_TYPES,
  classifyFyersRateLimitFromText,
  fyersRateLimitGate,
} from "../../modules/market-data/domain/fyers-rate-limit.js";
import { PostgresPremarketBiasRepository } from "../../infrastructure/database/repositories/postgres-premarket-repository.js";
import { isNseHoliday } from "../../modules/market-data/domain/nse-session-calendar.js";
import { assessPremarketRun } from "../../modules/premarket-intelligence/domain/run-check.js";

/** Jobs that fail whenever the Fyers credential is unusable; folded into the daily auth health check. */
const FYERS_DEPENDENT_JOB_TYPES = ["OPTION_CHAIN", "OPTION_PREMIUM_TICKS"];

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

/**
 * A copy of this process's own log lines, on a bind mount that outlives the container.
 *
 * Docker deletes `json-file` logs with the container, so `--force-recreate` destroys the
 * `Scheduled job skipped` lines that are the only record of a skip -- `runExclusively`
 * deliberately writes no row for a run that did not happen. That is precisely how the
 * 2026-08-17 OPTION_CHAIN stall became unexplainable: the container was recreated before anyone
 * read its log. Set SCHEDULER_LOG_FILE to keep the evidence.
 */
const logSink = createSchedulerLogSink(process.env.SCHEDULER_LOG_FILE, {
  onError: (message) => {
    console.error(JSON.stringify({
      level: "error",
      message: "Could not write the scheduler log file; continuing without it",
      error: message,
    }));
  },
});

function emit(line: Record<string, unknown>): string {
  const serialized = JSON.stringify(line);
  logSink.write(serialized);
  return serialized;
}

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.info(emit({ level: "info", message, process: processIdentity, ...extra }));
}

/** The error counterpart of `log`, so failures reach the durable sink too. */
function logError(message: string, extra: Record<string, unknown> = {}): void {
  console.error(emit({ level: "error", message, process: processIdentity, ...extra }));
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
  const recentJobFailures = await countUnrecoveredScheduledJobFailures(
    database,
    FYERS_DEPENDENT_JOB_TYPES,
  );

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
    throw new Error(`Fyers credential is not session-usable (${assessment.status}): ${assessment.reasons.join(" ")}`);
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
    // Two Yahoo quotes and an upsert; a dead claimant should not hold the next day's slot.
    OPENING_GAP_PREDICTION: 5 * 60 * 1000,
    // Reads stored candles only, same patience as AUXILIARY_PREDICTION_SETTLEMENT.
    OPENING_GAP_SETTLEMENT: 10 * 60 * 1000,
    // Includes up to two Gemini round trips (45s timeout each) plus the quote fetches.
    PREMARKET_BIAS: 6 * 60 * 1000,
    PREMARKET_PREOPEN_UPDATE: 4 * 60 * 1000,
    // Reads stored 1m bars for two instruments; same patience as the other settlement sweeps.
    SESSION_OUTCOME_SETTLEMENT: 10 * 60 * 1000,
    // Loads one bar's ICT state for four series on a five-minute cron; a run that outlives the next
    // tick has been superseded by it.
    ICT_SHADOW_CAPTURE: 4 * 60 * 1000,
    // Reads stored 1m bars only.
    ICT_SHADOW_RESOLVE: 10 * 60 * 1000,
    // Three small reads of one day's snapshots, ideas and trades.
    ICT_GATE_REPORT: 5 * 60 * 1000,
    // Three indexed reads and a comparison; nothing is fetched or computed.
    PREMARKET_RUN_CHECK: 2 * 60 * 1000,
    // Every intraday job below is on a cron faster than this, so a run that outlives its
    // horizon has stopped being useful anyway -- the next tick's data supersedes it.
    INDICES_INTRADAY: 10 * 60 * 1000,
    INDIA_VIX_INTRADAY: 10 * 60 * 1000,
    OPTION_CHAIN: 10 * 60 * 1000,
    // Two collects + ~25s sleep fits under a minute; 90s recovers the next tick after a dead claimant.
    OPTION_PREMIUM_TICKS: 90 * 1000,
    PAPER_TRADING_BOT: 10 * 60 * 1000,
    // Two instruments, one bar each, no execution. Short because a dead claimant should not hold
    // the next tick: a missed shadow decision is a gap in the differential record, and P13 counts
    // comparisons.
    SHADOW_DECISION: 4 * 60 * 1000,
    // One spawn per account holding an open position, on a per-minute cron. Kept short on
    // purpose: this is the job that closes positions, so a dead claimant must not block the
    // next minute's sweep for anything like the ten minutes the other intraday jobs allow.
    PAPER_TRADE_EXIT_SWEEP: 3 * 60 * 1000,
    AI_AGENT_TICK: 10 * 60 * 1000,
    VOLATILITY_STRADDLE: 10 * 60 * 1000,
    // Full-series recompute over both engines; slower than the other intraday jobs by nature.
    PATTERN_DETECTION_INTRADAY: 20 * 60 * 1000,
    // Same shape of work as above -- a full-series rescan per instrument and timeframe -- so it
    // carries the same patience.
    PATTERN_INTELLIGENCE_INTRADAY: 20 * 60 * 1000,
    // Reads one session of ticks and classifies them; the shortest horizon here on purpose, because
    // a stalled health check is itself a loss of the signal it exists to provide.
    COLLECTOR_HEALTH: 5 * 60 * 1000,
    // Same reasoning as COLLECTOR_HEALTH, and the shortest horizon here for a sharper reason: what it
    // watches cannot be repaired. depth_frames has no heal path, so a stalled claim on this check is a
    // window in which unbackfillable data is being lost without anyone knowing.
    DEPTH_FRAME_STALENESS: 5 * 60 * 1000,
    RSS_NEWS_INGESTION: 10 * 60 * 1000,
    // Research only, and deliberately the most patient claim here: a candidate cannot be settled
    // before its horizon elapses, so a stalled claimant costs nothing but a later sweep.
    CANDIDATE_SETTLEMENT: 30 * 60 * 1000,
    // Once-a-day integrity check; a stalled claim just means the next EOD run does the looking.
    CANDLE_GAP_CHECK: 30 * 60 * 1000,
    // Once-a-day append-only backfill of confirmed gaps; same patience as the check it precedes.
    CANDLE_GAP_HEAL: 30 * 60 * 1000,
    // Four Fyers history requests (two contracts per index) over five days of 1m bars.
    INDEX_FUTURES_EOD: 15 * 60 * 1000,
    INDEX_FUTURES_EOD_RETRY: 15 * 60 * 1000,
    // Every five minutes in-session; a run that outlives its slot is superseded by the next.
    INDEX_FUTURES_INTRADAY: 4 * 60 * 1000,
    // XAU_CANDLE_COLLECTION moved to a 15-minute cron 2026-10-07 (see that job's own docstring --
    // Twelve Data's daily free-tier credit cap, not this timeout); PAPER_TRADING_BOT_GOLD still
    // fires inside the same tick. Same reasoning as PAPER_TRADING_BOT's 10-minute allowance scaled
    // down: a dead claimant should not hold up more than one tick's worth of gold data or signal
    // generation, and 4 minutes clears well inside a 15-minute tick with margin to spare.
    XAU_CANDLE_COLLECTION: 4 * 60 * 1000,
    PAPER_TRADING_BOT_GOLD: 4 * 60 * 1000,
    // Hourly backfill of OANDA holes the 45-minute collection window cannot reach (XAU_USD, the six
    // FX legs of DXY, and DXY itself); most runs only scan, but a real heal fetches up to seven series,
    // rebuilds DXY and recomputes indicators, so it gets far more room than a collection tick.
    XAU_GAP_HEAL: 30 * 60 * 1000,
    // Follows gold shadow brackets to a target or stop on 1m bars; reads one series and writes a handful of rows.
    GOLD_SHADOW_RESOLVE: 10 * 60 * 1000,
    // Once-a-day, after CANDLE_GAP_CHECK confirms the day's bars are final. Both scripts do a
    // full idempotent re-walk (INSERT ... ON CONFLICT DO NOTHING), not an incremental one, so a
    // stalled claimant just means the next day's run picks up everything since the last success.
    LIQUIDITY_CANDIDATE_GENERATION: 30 * 60 * 1000,
    LIQUIDITY_CONTACT_LABELING: 30 * 60 * 1000,
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

  /** When each gated job last logged a skip, so a cooldown does not write a line per job per minute. */
  const gateSkipLoggedAt = new Map<string, number>();

  async function schedule(jobType: string, task: () => Promise<void>): Promise<void> {
    const scheduledFor = toDueMinute(new Date());
    const runKey = `${jobType}@${scheduledFor.toISOString()}`;
    /*
     * While Fyers is refusing -- the 5,000-a-day quota ran out at 11:04 IST on 2026-10-16 -- a polling job cannot
     * succeed, and starting it only spends a request and an npm process to be told so. The cooldown is set when one
     * of them fails with the provider's own rate-limit text (below); the exit sweep is not gated, it reads stored ticks.
     */
    if (FYERS_REST_JOB_TYPES.has(jobType)) {
      const gate = fyersRateLimitGate.state();
      if (gate.blocked) {
        const last = gateSkipLoggedAt.get(jobType) ?? 0;
        if (Date.now() - last > 5 * 60_000) {
          gateSkipLoggedAt.set(jobType, Date.now());
          log("Scheduled job skipped", {
            jobType,
            scheduledFor: scheduledFor.toISOString(),
            skippedReason: `FYERS_RATE_LIMIT_${gate.kind}`,
            retryAt: new Date(gate.retryAtMs).toISOString(),
          });
        }
        return;
      }
    }
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
        logError("Reconciled scheduled runs whose claimant is gone", {
          jobType,
          abandonedRuns: result.abandonedRuns,
        });
      }
      log(result.ran ? "Scheduled job completed" : "Scheduled job skipped", {
        jobType,
        scheduledFor: scheduledFor.toISOString(),
        ...(result.ran ? {} : { skippedReason: result.skippedReason }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (FYERS_REST_JOB_TYPES.has(jobType)) {
        const limit = classifyFyersRateLimitFromText(message);
        if (limit !== null && limit !== "UNKNOWN") fyersRateLimitGate.open(limit);
      }
      logError("Scheduled job failed", {
        jobType,
        scheduledFor: scheduledFor.toISOString(),
        error: message,
      });
    }
  }

  /**
   * Every cron registration goes through here so the watchdog can see whether timers are firing.
   *
   * Wrapping the registration rather than `schedule()` is deliberate. Several crons decide not to run
   * their job -- `PAPER_TRADE_EXIT_SWEEP` returns early without a Fyers token, for one -- so a
   * `schedule()`-level hook would read "no claim" as "timer dead" and restart a healthy container.
   * The timestamp is stamped before the handler, so a handler that throws still counts as a fire:
   * the timer worked, and a broken job is a different problem with its own FAILED row.
   *
   * `timezone: IST` is applied here for all of them, which also removes the chance of a future
   * registration forgetting it.
   */
  const cronLastFiredAt = new Map<string, Date>();
  const registeredCronExpressions = new Set<string>();
  function cronSchedule(expression: string, handler: () => void): void {
    registeredCronExpressions.add(expression);
    cron.schedule(expression, () => {
      cronLastFiredAt.set(expression, new Date());
      handler();
    }, { timezone: IST });
  }

  cronSchedule("5 16 * * 1-5", () => {
    void schedule("EOD_PIPELINE", () => runCommand("npm", ["run", "pipeline:eod"]));
  });

  // Intraday shadow predictions for the volatility competition pool. Labels are
  // session-partitioned (a bar near the close has no same-session forward bars),
  // so predictions must be made during the session to ever settle; a single EOD
  // prediction on the day's final bar would never mature. Each run ingests the
  // session's completed 15m bars so far, then predicts once per pool model on
  // the latest one — idempotent per (model, candle), so overlapping runs and
  // out-of-hours no-ops are harmless.
  cronSchedule("*/15 9-15 * * 1-5", () => {
    void schedule("INTRADAY_MODEL_PREDICTIONS", async () => {
      const todayIst = new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date());
      for (const instrument of ["NIFTY50", "BANKNIFTY"]) {
        await runCommand("npm", [
          "run", "data:collect:historical", "--",
          "--provider", "fyers",
          "--instrument", instrument,
          "--timeframe", "15m",
          "--from", todayIst,
          "--to", todayIst,
          "--skip-existing",
        ]);
      }
      // Same-day Fyers history returns no intraday rows. NIFTYBEES 1m bars are
      // written continuously by live-collector-scalp-v2; refresh their overlays
      // before scoring instead of reporting a successful zero-row backfill.
      await runCommand("npm", [
        "run", "analysis:calculate-indicators", "--",
        "--instrument", "NIFTYBEES",
        "--timeframe", "1m",
        "--from", todayIst,
      ]);
      await runCommand("npm", ["run", "ml:predict:volatility-shadow"]);
      await runCommand("npm", ["run", "ml:predict", "--", "--competition-pool"]);
    });
  });

  cronSchedule("30 18 * * 1-5", () => {
    void schedule("INSTITUTIONAL_FLOWS", () => runCommand("npm", ["run", "data:collect:institutional"]));
  });

  // NSE sometimes publishes the provisional cash print late. These idempotent
  // retries close the gap the original one-shot 18:30 schedule left overnight.
  cronSchedule("15 19,20 * * 1-5", () => {
    void schedule("INSTITUTIONAL_FLOWS_RETRY", () => runCommand("npm", ["run", "data:collect:institutional"]));
  });

  /**
   * Predicts NIFTY50/BANKNIFTY's opening gap from GIFT Nifty's overnight change, 25 minutes
   * before the 09:15 IST open -- see `opening-gap-classifier.ts` and `nse-ix-client.ts` for where
   * that quote comes from. Writes one row per instrument; ungated, like `INSTITUTIONAL_FLOWS`,
   * since it depends on neither the Fyers token nor the option chain.
   */
  cronSchedule("50 8 * * 1-5", () => {
    void schedule("OPENING_GAP_PREDICTION", () => runCommand("npm", ["run", "data:predict:opening-gap"]));
  });

  /**
   * Settles opening-gap predictions against the real 09:15 IST open once the session's first
   * 1-minute candle has landed. Three tries through the morning (the candle can lag the open
   * by a minute or two under load) plus one EOD catch-all, the same shape as
   * `AUXILIARY_PREDICTION_SETTLEMENT` and for the same reason: a stalled claim must not block
   * the next day's prediction, so it gets its own job type rather than riding on another one.
   */
  cronSchedule("20,30,45 9 * * 1-5", () => {
    void schedule("OPENING_GAP_SETTLEMENT", () => runCommand("npm", ["run", "data:settle:opening-gap"]));
  });
  cronSchedule("20 16 * * 1-5", () => {
    void schedule("OPENING_GAP_SETTLEMENT", () => runCommand("npm", ["run", "data:settle:opening-gap"]));
  });

  /**
   * The Asia-to-India pre-market engine: a deterministic snapshot (GIFT Nifty, Asian and global
   * cues, candidate levels), the benchmark baselines, and -- when GEMINI_API_KEY and GEMINI_MODEL
   * are set -- a strictly validated model interpretation of that snapshot. Without the key it still
   * stores snapshot and baselines, so the benchmark population accrues from day one.
   *
   * Two tries, five minutes apart and both before the 09:08 pre-open, so a transient outage can
   * recover; only the second (`--final`) may record a no-data day, or a failed model call, as
   * terminal. The second is a no-op once the first has recorded. NSE holidays are skipped.
   */
  // Named because the run check reads these timers' last fire times; one literal each, so they cannot drift apart.
  const PREMARKET_FIRST_SLOT_CRON = "52 8 * * 1-5";
  const PREMARKET_FINAL_SLOT_CRON = "57 8 * * 1-5";
  cronSchedule(PREMARKET_FIRST_SLOT_CRON, () => {
    void schedule("PREMARKET_BIAS", () => runCommand("npm", ["run", "data:premarket-bias", "--", "--slot", "0850"]));
  });
  cronSchedule(PREMARKET_FINAL_SLOT_CRON, () => {
    void schedule("PREMARKET_BIAS", () => runCommand("npm", ["run", "data:premarket-bias", "--", "--slot", "0850", "--final"]));
  });

  /**
   * The conditional 09:10 update. It records a probe of NSE's allIndices `indicativeClose` every
   * day, and writes a second snapshot only when that feed carries a time-stamped pre-open print
   * inside the pre-open window -- see `evaluatePreOpenGate`.
   */
  cronSchedule("10 9 * * 1-5", () => {
    void schedule("PREMARKET_PREOPEN_UPDATE", () => runCommand("npm", ["run", "data:premarket-bias", "--", "--slot", "0910"]));
  });

  /**
   * Measures the gap / first-hour / full-session outcomes the snapshots are scored against. After
   * the close with margin (the closing-window bars land late), plus a morning catch-up for a day
   * the evening run missed.
   */
  cronSchedule("40 16 * * 1-5", () => {
    void schedule("SESSION_OUTCOME_SETTLEMENT", () => runCommand("npm", ["run", "data:settle:session-outcomes"]));
  });
  cronSchedule("30 8 * * 1-5", () => {
    void schedule("SESSION_OUTCOME_SETTLEMENT", () => runCommand("npm", ["run", "data:settle:session-outcomes"]));
  });

  /**
   * Shadow variants of the live ICT strategy: records what each would have proposed on every closed
   * 5m and 15m bar of NIFTY50 and BANKNIFTY, then follows each bracket to a target, a stop or the
   * 15:15 square-off. It creates no idea and opens no position -- see `ict-shadow-variant.ts`.
   *
   * Two minutes past the five-minute boundaries, so a bar that has just closed has been collected;
   * repeating a bar is a no-op. Resolution runs after the square-off with margin, plus a morning
   * catch-up for a session whose last bars arrived late.
   */
  cronSchedule("2-59/5 9-15 * * 1-5", () => {
    void schedule("ICT_SHADOW_CAPTURE", () => runCommand("npm", ["run", "research:ict-shadow:capture"]));
  });
  cronSchedule("45 15 * * 1-5", () => {
    void schedule("ICT_SHADOW_RESOLVE", () => runCommand("npm", ["run", "research:ict-shadow:resolve"]));
  });
  cronSchedule("35 8 * * 1-5", () => {
    void schedule("ICT_SHADOW_RESOLVE", () => runCommand("npm", ["run", "research:ict-shadow:resolve"]));
  });

  /**
   * One log line per ICT bot after the close: which pillar blocked how many bars, the higher-timeframe bias and the
   * ideas and trades that resulted. Read-only. A quiet day for `ict-structure-v1` is normal (about 5-6 signals a
   * month), so the line is what tells waiting from broken. Run at 15:50, after the last 15m bar's state is stored.
   */
  cronSchedule("50 15 * * 1-5", () => {
    void schedule("ICT_GATE_REPORT", () => runCommand("npm", ["run", "research:ict-gates:report"]));
  });

  const collectIndiaVix = async (timeframes: readonly string[], lookbackDays: number): Promise<void> => {
    const now = new Date();
    const lookback = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    for (const timeframe of timeframes) {
      await runCommand("npm", [
        "run", "data:collect:historical", "--",
        "--provider", "fyers",
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

  cronSchedule("30 16 * * 1-5", () => {
    void schedule("INDIA_VIX_EOD", () => collectIndiaVix(["1d"], 10));
  });
  cronSchedule("15 17,18 * * 1-5", () => {
    void schedule("INDIA_VIX_EOD_RETRY", () => collectIndiaVix(["1d"], 10));
  });

  // Exact-timeframe VIX bars keep the existing point-in-time feature contract
  // valid for intraday and scalp models; no daily value is silently borrowed.
  cronSchedule("*/5 9-15 * * 1-5", () => {
    void schedule("INDIA_VIX_INTRADAY", () => collectIndiaVix(["1m", "5m", "15m"], 2));
  });

  /**
   * How far back an intraday indicator recompute writes.
   *
   * Indicators are still *computed* over the full series -- EMA and the SMC pivots need
   * the history -- but writing all of it every minute was the job's real cost: 54,006
   * NIFTY50 1m bars times fifteen definitions is ~810,000 upserts per run, on an
   * every-minute cron. Bounding the write leaves the values identical and the work
   * proportional to what actually changed.
   *
   * Five days rather than one so a missed intraday run heals on the next pass,
   * including over a long weekend; EOD provides a second recovery path.
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

  /**
   * Pattern detection, which had no scheduled caller at all.
   *
   * `analysis:detect-patterns` was invoked only by hand -- not here, not in the EOD pipeline -- so
   * pattern evidence was as fresh as the last time someone remembered to run it. Measured
   * 2026-08-10: BANKNIFTY 15m had *zero* detections ever recorded, and NIFTY50 15m stopped at
   * 2026-08-04 while its candles ran to the 10th.
   *
   * That is not cosmetic. The strategies read pattern evidence, and the autonomous agent's 80 gate
   * effectively requires a pattern -- so an entire evidence source decayed silently while the
   * indicators computed beside it stayed current, and the agent had never once qualified a setup
   * on BANKNIFTY.
   *
   * Deliberately **not** folded into INDICES_INTRADAY above, which runs every minute. `--from`
   * bounds what this writes, but both engines still run over the whole completed series every
   * invocation (multi-bar patterns and swing pivots need the history) -- 22k candles for NIFTY50
   * 15m. Six full-series passes a minute is how INDICES_INTRADAY previously accumulated 330
   * concurrent runs and completed once in 72 hours. Every 15 minutes is ample: the agent reads
   * completed 15m bars, so a pattern set at most one bar stale changes nothing it could act on.
   */
  const detectPatternsIntraday = async (timeframes: readonly string[]): Promise<void> => {
    const writeFrom = istDateKey(
      new Date(Date.now() - INDICATOR_WRITE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    );
    for (const instrument of ["NIFTY50", "BANKNIFTY"]) {
      for (const timeframe of timeframes) {
        await runCommand("npm", [
          "run", "analysis:detect-patterns", "--",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", writeFrom,
        ]);
      }
    }
  };

  /*
   * 1m and 5m are here for the scalp bots, and their absence was a silent dead end.
   *
   * Patterns existed on exactly the autonomous agent's band -- 15m, 30m, 60m, 1d -- and on nothing
   * the bots trade. Measured 2026-08-17: 24,178 index 5m bars and 111,340 index 1m bars with zero
   * pattern detections between them. AutoBot-Sniper's whole premise is pattern-gated scalping on
   * 1m/5m, so it could not have fired a single signal no matter how its rules were tuned, and it
   * reported RULES_NOT_MET on every evaluation -- indistinguishable from a genuinely quiet market.
   *
   * Cost measured before adding them, because this helper rescans the full completed series on
   * every invocation and that is what once let a per-minute job reach 330 concurrent runs: 5m is
   * 5-6s per instrument over ~12k bars, 1m is 14s per instrument over ~56k. That cost was measured
   * for a fifteen-minute cadence; 1m and 5m now run every five minutes -- see the next block.
   */
  /*
   * Pattern detection for the 1m and 5m series runs every five minutes, immediately ahead of the
   * shadow decision pass in the same tick; 15m stays on the quarter hour.
   *
   * It used to run every fifteen minutes for all three timeframes while `SHADOW_DECISION` decided a
   * fresh 1m and 5m bar every five. A bar closing off the quarter hour had no pattern coverage yet,
   * so V2.2's opportunity resolver deferred it (`PATTERN_LAYER_NOT_COMPUTED`) and nothing ever
   * retried it. Measured 2026-10-11 over the ledger since Oct 1: every decision at :04, :05, :09,
   * :10 and :14 deferred (about 69% of resolved candidates), and even at the :00 mark 106 of 302
   * deferred because detection and the shadow pass started together.
   *
   * Detection is deterministic for a closed bar -- every engine reads indices at or before the bar --
   * so running it sooner changes when the layer becomes available, never what it contains.
   *
   * Sequenced with `await`, not fired as independent `void schedule(...)` calls: that is the
   * read-before-write race this closes, the same one the XAU block's own comment describes. The
   * shadow pass runs whether or not detection succeeded, because a deferral recorded honestly is
   * better than a missing decision, and `schedule()` already contains a failed run.
   *
   * Cost: 1m + 5m for both indices measured about 25s on average (77s worst) per run, well inside
   * the five-minute cadence and the 3-minute (1m) / 7-minute (5m) bar-age ceilings the shadow pass
   * enforces.
   *
   * Side effect to know about: the same pattern tables feed the pattern-gated live bots, so their 1m
   * and 5m patterns are now at most one tick old instead of up to fifteen minutes old.
   */
  cronSchedule("*/5 9-15 * * 1-5", () => {
    void (async () => {
      const onQuarterHour = new Date().getMinutes() % 15 === 0;
      await schedule("PATTERN_DETECTION_INTRADAY", () => detectPatternsIntraday(
        onQuarterHour ? ["1m", "5m", "15m"] : ["1m", "5m"],
      ));
      /*
       * V2.2's shadow decision pass (Brain step 2 of retiring V1). Records decisions; executes nothing.
       *
       * Same five-minute cadence as PAPER_TRADING_BOT deliberately: P13 compares the two systems at the
       * same decision points, and a shadow run on a different rhythm would produce records V1 has no
       * counterpart for -- unpairable rows that look like coverage.
       *
       * Not gated on `fyersTokenService`, unlike the bot. It reads stored contexts and places no
       * orders, so a broker token is irrelevant to it -- and gating it there would silently stop the
       * differential record on exactly the days the token lapses, which are the days worth comparing.
       */
      await schedule("SHADOW_DECISION", () => runCommand("npm", ["run", "shadow:decisions"]));
    })();
  });

  /**
   * Pattern Intelligence V1.0.1 detection, which is what feeds `pattern-v4-research-v2`.
   *
   * Separate from `detectPatternsIntraday` because the two write different stores and neither reads
   * the other: the incumbent writes `pattern_detections`, this writes the `*_v2` namespace. Folding
   * them together would only produce a run where half the flags do nothing.
   *
   * ## `--mode backfill` is deliberate, and `live` would silently break the cohort
   *
   * Backfill takes the data vintage from the first bar of the window, so `knownAt` collapses to
   * `detectedAt` -- the bar's own open. The harness reads observations POINT_IN_TIME at the decision
   * instant, which is that bar's *close*, so `knownAt <= decisionAt` holds and the observations are
   * visible to the decision they belong to.
   *
   * Under `--mode live`, `knownAt` would be this run's wall clock. A bar closing at 09:46 whose
   * patterns are computed at 10:00 would carry `knownAt = 10:00`, the point-in-time filter would
   * exclude it from its own decision, and the cohort would capture nothing -- permanently, and
   * silently, looking exactly like a market with no patterns in it. Live mode would also derive
   * Bar 0 from the run time rather than the next bar, which is the defect the store was rebuilt to
   * fix. Anyone "correcting" this to `live` should read that note first.
   *
   * The claim backfill makes is *computability*, not that something actually computed it at the bar:
   * every engine reads indices at or before its detection bar, and the one that inspects a forward
   * window stamps the pivot at its confirmation bar, so a pattern on a closed bar was derivable the
   * moment that bar closed. Whether the pipeline was fast enough is a separate operational question,
   * and `pattern_coverage_v2` is what answers it.
   *
   * Offset seven minutes from the incumbent's quarter-hour so two full-series rescans of the same
   * candles do not start together.
   */
  const detectPatternIntelligenceIntraday = async (timeframes: readonly string[]): Promise<void> => {
    const from = istDateKey(new Date(Date.now() - INDICATOR_WRITE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
    for (const instrument of ["NIFTY50", "BANKNIFTY"]) {
      for (const timeframe of timeframes) {
        await runCommand("npm", [
          "run", "analysis:detect-pattern-intelligence", "--",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", from,
          "--mode", "backfill",
        ]);
      }
    }
  };

  cronSchedule("7,22,37,52 9-15 * * 1-5", () => {
    void schedule("PATTERN_INTELLIGENCE_INTRADAY", () => detectPatternIntelligenceIntraday(["1m", "5m"]));
  });

  /*
   * Collector health, in-session and every ten minutes.
   *
   * Operational monitoring only: it warns, and nothing in the research path may read it. The point
   * of running it during the session rather than after the close is that a silence is actionable
   * while the session is still open -- the daily 11:00-12:45 outage was only ever discovered
   * afterwards, by which time the session's premium coverage was already unrecoverable.
   *
   * Runs to hour 15 inclusive so it spans the 15:40 derivatives close, which the cash-session
   * schedule of the jobs above does not reach.
   */
  cronSchedule("3,13,23,33,43,53 9-15 * * 1-5", () => {
    void schedule("COLLECTOR_HEALTH", () => runCommand("npm", ["run", "ops:collector-health"]));
  });

  /**
   * Is the raw L2 depth capture actually producing rows? Asked from outside the collector.
   *
   * The collector has its own in-process staleness guard and it fired correctly for two full sessions
   * on 2026-08-26/27, into a container's stderr, where nothing was watching. That guard also cannot
   * report the cases that matter most -- a crashed, OOM-killed or never-started collector has no
   * process left to log with. This runs in the scheduler instead, so a silent depth outage becomes a
   * FAILED row in `scheduled_job_runs` and shows up in `GET /api/v1/health/jobs`.
   *
   * Offset from COLLECTOR_HEALTH by four minutes so the two monitoring jobs do not contend for the
   * same claim window, and run to hour 15 inclusive to span the 15:40 derivatives close.
   *
   * It passes no --symbols on purpose. A checker naming the front-month contract would roll into the
   * exact bug it detects; see `depth-frame-staleness.ts`.
   */
  cronSchedule("7,17,27,37,47,57 9-15 * * 1-5", () => {
    void schedule("DEPTH_FRAME_STALENESS", () => runCommand("npm", ["run", "ops:depth-staleness"]));
  });

  // Higher-timeframe models consume completed 30m/60m candles. Refreshing their
  // derived features every minute would repeatedly traverse the same history with
  // no new completed input, so keep this on the 15-minute boundary. The commands
  // are idempotent and the five-day write window heals missed runs after restarts.
  // Offset from the quarter-hour jobs so prediction, 15m pattern detection, and
  // these heavier full-history calculations do not contend at the same second.
  cronSchedule("7,22,37,52 9-15 * * 1-5", () => {
    if (fyersTokenService) {
      void schedule("HIGHER_TIMEFRAME_ANALYSIS", async () => {
        // live-collector-v2 supplies these candles; EOD owns gap healing.
        await calculateIndexIndicatorsIntraday(["30m", "60m"]);
        await detectPatternsIntraday(["30m", "60m"]);
      });
    }
  });

  cronSchedule("*/1 9-15 * * 1-5", () => {
    // Requires a healthy Fyers token, which FYERS_AUTH_HEALTH_CHECK ensures is available
    if (fyersTokenService) {
      // 15m is here for its **indicators**, not its bars. The history endpoint publishes no
      // same-day intraday data -- a 15m fetch for today returns zero candles, measured -- so
      // those bars come from the live collector. But trend-breakout is the only strategy the
      // paper-trading bot can use, it reads 15m, and it resolves EMA/RSI/ATR snapshots that
      // nothing else recomputes intraday. Without this the bot sees fresh bars and stale
      // indicators.
      void schedule("INDICES_INTRADAY", () => collectIndicesIntraday(["1m", "5m", "15m"]));
    }
  });

  cronSchedule("*/5 9-15 * * 1-5", () => {
    if (fyersTokenService) {
      void schedule("PAPER_TRADING_BOT", () => runCommand("npm", ["run", "trading:paper:bot"]));
    }
  });

  /**
   * XAU_USD (gold): a Twelve Data instrument, not an NSE one, so it runs on its own cron rather
   * than joining the block above -- it is not gated on `fyersTokenService` (irrelevant to a
   * non-Fyers instrument) and it is not restricted to `9-15 * * 1-5` (XAU_USD trades Sun 22:00
   * UTC - Fri 22:00 UTC; `run-gold-paper-trading-bot.ts` and its collection window below both
   * check the real session themselves and no-op outside it, the same way every job here is
   * written to be a safe no-op off-session rather than relying on the cron pattern alone).
   *
   * Every 15 minutes, every day: collect fresh 1m candles, derive 5m/15m from them locally,
   * recompute indicators over all three (both `ta-v1` -- EMA/RSI/Supertrend/ATR, what
   * `momentum-scalp-gold` reads -- and `smc-v2` -- FVG/BOS/CHoCH/order-block/liquidity-sweep, the
   * default `--family all` computes both), then run the bot. Without this step
   * `indicator_snapshots` stays empty for XAU_USD and `momentum-scalp-gold` can never actually
   * evaluate a bar -- confirmed live 2026-09-22: the first deploy ran clean but every tick's
   * "RULES_NOT_MET" was indicators-absent, not conditions-failed, since nothing computed them.
   * `applySmcConfluenceToProposal` in `generate-trade-ideas.ts` already runs unconditionally for
   * every non-ICT strategy, so once `smc-v2` indicators exist here SMC confluence nudges gold's
   * proposals with no further wiring.
   *
   * `--skip-existing` makes candle collection idempotent, and a 45-minute lookback window
   * comfortably covers one tick's gap plus retry margin. `INDICATOR_WRITE_LOOKBACK_DAYS` bounds
   * the indicator *write*, mirroring `collectIndicesIntraday`'s own reasoning above: computed
   * over the full series, written only for the last few days, so a missed run heals on the next
   * pass.
   *
   * Only 1m is fetched from Twelve Data for XAU_USD itself -- 5m and 15m are derived locally via
   * `data:derive:higher-timeframes` (see that file's docstring) rather than fetched as their own
   * `/time_series` calls. Confirmed live 2026-10-07: fetching all three separately, every 5
   * minutes, cost 9 Twelve Data calls a tick (3 XAU timeframes + 6 DXY component pairs) -- 288
   * ticks/day * 9 = 2,592 calls against an 800/day free-tier cap, 3.24x over budget regardless of
   * how well the per-minute spacing below is tuned (996 of 800 daily credits used, HTTP 429 for
   * the rest of the day, leaving `momentum-scalp-gold` and the settlement sweep both running on
   * stale data). Dropping to one XAU fetch a tick and widening the cron to 15 minutes brings this
   * to 96 ticks/day * 7 calls (1 XAU + 6 DXY components) = 672/day, with headroom left for the
   * quote client's own polling. Only the collection cadence changed -- `momentum-scalp-gold`'s own
   * entry-side freshness check (`PrepareDirectEntry`'s `MAXIMUM_EXECUTABLE_QUOTE_AGE_MS`) reads a
   * live quote via a separate, independently-throttled client, not these stored candles, so it is
   * unaffected by this.
   *
   * The `schedule()` calls are sequenced with `await`, not fired as independent `void
   * schedule(...)` calls the way `PAPER_TRADING_BOT`/`SHADOW_DECISION` are above. Those two
   * are safe to run concurrently because they are temporally decoupled by construction --
   * `INDICES_INTRADAY` runs on its own every-minute cron, so by the time `PAPER_TRADING_BOT` fires every
   * five minutes the candles it reads are already several collections old and settled. This block
   * folds collection and the bot into the *same* tick, so nothing separates them in
   * time -- confirmed live 2026-09-22: firing both as `void schedule(...)` let
   * "Gold paper trading bot run complete" print while that tick's own XAU_USD indicator
   * calculation was still running, which is exactly the read-before-write race this sequencing
   * closes.
   *
   * Disabled 2026-09-23 by explicit user request, after `momentum-scalp-gold` had produced no
   * ideas worth trusting yet and the user asked to pause the bot rather than let it keep running
   * unmeasured. The application code (the strategy, `PrepareDirectEntry`, the runner script) is
   * left intact -- only the schedule is turned off -- so re-enabling is flipping `XAU_BOT_ENABLED`
   * back to `true`, not rebuilding anything.
   */
  const XAU_BOT_ENABLED = true;
  cronSchedule("*/15 * * * *", () => {
    if (!XAU_BOT_ENABLED || !process.env.OANDA_ACCESS_TOKEN) return;
    void (async () => {
      await schedule("XAU_CANDLE_COLLECTION", async () => {
        const to = new Date();
        const from = new Date(to.getTime() - 45 * 60 * 1000);
        const indicatorsFrom = new Date(to.getTime() - INDICATOR_WRITE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

        /*
         * Spaced to stay under Twelve Data's per-minute credit cap. This loop plus the DXY
         * component loop below fire 7 `data:collect:historical` calls in total (XAU_USD's own 1m
         * plus 6 FX pairs) and, with no spacing, all of them landed inside the same rolling minute
         * -- measured 2026-10-07 as repeated HTTP 429s ("14 API credits were used, with the
         * current limit being 8"), which left XAU_USD's own candle stale past
         * `momentum-scalp-gold`'s 300-second freshness window and blocked every direct-entry idea
         * with NO_FRESH_QUOTE. Indicator calculation and the local 5m/15m derivation both read
         * already-stored candles rather than calling Twelve Data, so neither is throttled here.
         */
        const TWELVEDATA_CALL_SPACING_MS = 8_000;
        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        await runCommand("npm", [
          "run", "data:collect:historical", "--",
          "--provider", "oanda",
          "--exchange", "OANDA",
          "--instrument", "XAU_USD",
          "--timeframe", "1m",
          "--from", from.toISOString(),
          "--to", to.toISOString(),
          "--skip-existing",
        ]);
        // Guaranteed spacing before the next Twelve Data call (the FX component loop below),
        // rather than relying on however long the Twelve-Data-free derive/indicator steps in
        // between happen to take.
        await sleep(TWELVEDATA_CALL_SPACING_MS);
        await runCommand("npm", [
          "run", "data:derive:higher-timeframes", "--",
          "--exchange", "OANDA",
          "--instrument", "XAU_USD",
          "--timeframes", "5,15",
          "--from", from.toISOString(),
          "--to", to.toISOString(),
        ]);
        for (const timeframe of ["1m", "5m", "15m"]) {
          await runCommand("npm", [
            "run", "analysis:calculate-indicators", "--",
            "--exchange", "OANDA",
            "--instrument", "XAU_USD",
            "--timeframe", timeframe,
            "--from", indicatorsFrom.toISOString(),
          ]);
        }

        // DXY has no real Twelve Data ticker (confirmed 2026-10-06 against their live /indices
        // catalog -- see synthetic-dxy.ts). Collect its 6 real component pairs at 1m instead,
        // then reconstruct DXY's 1m/5m/15m series from them via the real ICE formula.
        for (const component of ["EUR_USD", "USD_JPY", "GBP_USD", "USD_CAD", "USD_SEK", "USD_CHF"]) {
          await runCommand("npm", [
            "run", "data:collect:historical", "--",
            "--provider", "oanda",
            "--exchange", "OANDA",
            "--instrument", component,
            "--timeframe", "1m",
            "--from", from.toISOString(),
            "--to", to.toISOString(),
            "--skip-existing",
          ]);
          await sleep(TWELVEDATA_CALL_SPACING_MS);
        }
        await runCommand("npm", [
          "run", "data:compute:synthetic-dxy", "--",
          "--from", from.toISOString(),
          "--to", to.toISOString(),
        ]);
        for (const timeframe of ["1m", "5m", "15m"]) {
          await runCommand("npm", [
            "run", "analysis:calculate-indicators", "--",
            "--exchange", "OANDA",
            "--instrument", "DXY",
            "--timeframe", timeframe,
            "--from", indicatorsFrom.toISOString(),
          ]);
        }
      });
      await schedule("PAPER_TRADING_BOT_GOLD", () => runCommand("npm", ["run", "trading:paper:bot:gold"]));
    })();
  });

  /**
   * Hourly backfill of OANDA 1m holes: XAU_USD, the six FX pairs DXY is rebuilt from, and DXY.
   *
   * `XAU_CANDLE_COLLECTION` above only ever fetches the last 45 minutes, so any outage longer than
   * that (the host sleeping overnight, a scheduler restart) leaves the missed bars missing
   * permanently, and the 5m/15m series and indicators the gold strategies read inherit the hole --
   * including their DXY intermarket filter, which cannot be rebuilt for a day unless all six FX legs
   * exist for it. `data:heal-gold-gaps` finds missing minutes inside each series' own session (gold
   * has a daily New York break, FX does not; the weekend close is never a gap), fetches them
   * append-only, derives and recomputes indicators for gold, and rebuilds DXY from the healed legs.
   * A run with nothing to heal is a handful of queries.
   *
   * Offset to :07 so it never lands inside the :00/:15/:30/:45 collection ticks it complements.
   */
  cronSchedule("7 * * * *", () => {
    if (!XAU_BOT_ENABLED || !process.env.OANDA_ACCESS_TOKEN) return;
    void schedule("XAU_GAP_HEAL", () => runCommand("npm", [
      "run", "data:heal-gold-gaps", "--", "--apply", "--lookback-days", "7",
    ]));
  });

  /**
   * Gold shadow follow-through. The regular candidate sweep gives a gold scalp about ten minutes to hit a level
   * and records the rest as UNRESOLVED; a live position would still be open, so this follows each bracket to its
   * target or stop for as long as that takes (`research:gold:resolve-shadow`). Ideas that were running when the
   * machine slept are DEFERRED until `XAU_GAP_HEAL` fills the missing bars, then resolve on a later run.
   *
   * Minute 17 in IST is :47 past the UTC hour -- ten minutes after XAU_GAP_HEAL's :37 -- so a hole it just healed
   * is already filled when this reads the series. Idempotent and cheap when there is nothing to resolve.
   */
  cronSchedule("17 * * * *", () => {
    if (!XAU_BOT_ENABLED) return;
    void schedule("GOLD_SHADOW_RESOLVE", () => runCommand("npm", [
      "run", "research:gold:resolve-shadow", "--", "--apply",
    ]));
  });

  /**
   * Liquidity Intelligence Engine v1 -- daily candidate + contact-label recompute for BANKNIFTY.
   *
   * `generate-liquidity-candidates.ts`/`generate-contact-labels.ts` were built and run once by
   * hand on 2026-09-25 (see docs/2026-09-25-orderbook-directional-gate-confluence.md), producing
   * a single generation/labeling run each, frozen at `known_at_time`/`contact_time` no later than
   * 2026-09-24. Neither script was ever wired into anything that would rerun them, so BANKNIFTY's
   * liquidity candidates and contact labels went stale from that one-off run while candles and
   * depth_frames kept advancing normally underneath them. Both scripts are idempotent
   * (`INSERT ... ON CONFLICT DO NOTHING` keyed on the candidate's/label's natural identity), so a
   * full re-walk here only ever inserts what is new since the last run -- there is no `--since`
   * flag to thread through instead.
   *
   * Runs at 16:25 IST, after CANDLE_GAP_CHECK (16:20) confirms the day's BANKNIFTY bars are final
   * and before INDIA_VIX_EOD (16:30). Labels can only be generated for candidates that already
   * exist, so the two are sequenced with `await` rather than fired independently -- the same
   * reasoning as XAU_CANDLE_COLLECTION/PAPER_TRADING_BOT_GOLD directly above.
   *
   * `generate-contact-labels.ts` hardcodes its forward price-path lookup to BANKNIFTY 1m candles
   * regardless of which timeframe's candidates it is labeling -- a pre-existing limitation of the
   * script itself, not something this scheduling changes.
   */
  cronSchedule("25 16 * * 1-5", () => {
    void (async () => {
      await schedule("LIQUIDITY_CANDIDATE_GENERATION", async () => {
        for (const timeframe of ["1m", "5m"]) {
          await runCommand("npm", [
            "run", "research:liquidity:candidates", "--",
            "--symbol", "BANKNIFTY",
            "--timeframe", timeframe,
          ]);
        }
      });
      await schedule("LIQUIDITY_CONTACT_LABELING", async () => {
        for (const timeframe of ["1m", "5m"]) {
          await runCommand("npm", ["run", "research:liquidity:labels", "--", "--timeframe", timeframe]);
        }
      });
    })();
  });

  /**
   * The floor under tick-driven exit evaluation, not the primary path.
   *
   * `onTicksWritten` above evaluates exits within a flush of the quote that crossed the barrier,
   * which is a few seconds. This remains because a socket fails by going quiet: if the stream
   * drops, stalls, or never connected, nothing would evaluate at all, and an exit path that
   * stops silently is the worst version of this bug rather than a fixed one. It is also the only
   * path when the process starts with positions already open and the market already moving.
   *
   * The bot evaluates its open trades at the end of its own five-minute run, so a barrier
   * crossed at :49:03 stayed open until :50:01 -- measured, on a target that filled correctly at
   * 405.20 but sat visibly unclosed for 58 seconds first. The exit price and time are right
   * either way, because the evaluator replays the observed tick series and books the crossing at
   * the tick that caused it. What was wrong is how long the position stays live in between:
   * capital is committed, the dashboard shows a position that has already hit its target, and
   * anyone watching reasonably concludes the stop did not fire.
   *
   * Running the whole bot every minute is the wrong fix -- that is the path that opens
   * positions, and it would quintuple entries to speed up exits. This runs only
   * `EvaluateOpenPaperTrades`, which closes and never opens.
   *
   * Accounts are read from the open positions themselves rather than from the bot's roster.
   * `run-paper-trading-bot.ts` calls `main()` at module scope, so importing its `DUAL_BOT_SANDBOX`
   * would run the whole bot inside this process on startup -- opening positions and closing the
   * pool out from under the scheduler. Deriving the list from the data also sweeps an account the
   * bot does not own, which is what an operator's manually opened position is.
   *
   * Nothing to do on a quiet minute: with no open trades this costs one indexed query and spawns
   * no process at all.
   */
  /**
   * Settles candidates as soon as they resolve (or, failing that, once their horizon elapses), so the
   * ledger can say what the trades nobody took would have done.
   *
   * Research only: nothing reads a settlement at decision time, so this is scheduled where it cannot
   * compete with execution. Deliberately not gated on `fyersTokenService`: this reads stored bars, so
   * it works on a day the feed never authenticated -- which is exactly a day worth measuring.
   *
   * Every 5 minutes, every day of the week -- not NSE-hours-only like the original "15,45 9-15 * * 1-5"
   * (half-hourly, weekdays, 9am-4pm IST). That schedule was sized for the NIFTY50/BANKNIFTY options
   * research it was built for, but XAU_USD trades a near-24/5 session: a gold candidate settling (or
   * resolving its bracket) at 9pm IST, or on a Saturday IST morning that is still Friday in NY, used to
   * sit unsettled until the next weekday 9:15 IST run -- hours of dashboard-visible lag that had
   * nothing to do with `settle-candidates` itself being slow. `settle-candidates.ts` now also settles a
   * candidate the moment its bracket resolves rather than waiting out its full nominal window (see its
   * own docstring), so a tighter, round-the-clock cadence is what actually gets that improvement onto
   * the dashboard quickly instead of leaving it to be discovered by the next half-hourly tick.
   */
  cronSchedule("*/5 * * * *", () => {
    void schedule("CANDIDATE_SETTLEMENT", async () => {
      await runCommand("npm", ["run", "research:settle-candidates", "--", "--limit", "1000"]);
    });
  });

  // A generous once-daily backstop in case a backlog ever exceeds the 5-minute sweep's own limit.
  cronSchedule("10 16 * * 1-5", () => {
    void schedule("CANDIDATE_SETTLEMENT", async () => {
      await runCommand("npm", ["run", "research:settle-candidates", "--", "--limit", "5000"]);
    });
  });

  /**
   * Grades the volatility shadow predictions.
   *
   * `CANDIDATE_SETTLEMENT` above settles the research candidate ledger and nothing else. The
   * volatility alphabet lives in its own table and has its own settler, and that settler was never
   * scheduled -- `models:settle-auxiliary` existed as an npm script and ran only when somebody typed
   * it. Measured 2026-09-08: 4,869 predictions written on a schedule, graded by hand, and the
   * settled share varied 50%-95% BY MODEL according to when the command had last been run with a
   * limit. Accuracy compared across models was therefore partly a comparison of who had been graded.
   *
   * Its own job type, not folded into `CANDIDATE_SETTLEMENT`: a stall in one must not be invisible
   * behind the other's run rows, which is exactly how the `OPTION_CHAIN` stall hid.
   *
   * Same cadence as the candidate ledger, and for the same reason -- half-hourly picks up short
   * horizons while they are fresh. The EOD pass is at :20 rather than :10 so it lands after the
   * 16:06 shadow-predict write and does not contend with the candidate settlement at 16:10.
   *
   * Not gated on the Fyers token: it reads stored bars, so it works on a day the feed never
   * authenticated, which is a day worth grading.
   */
  cronSchedule("15,45 9-15 * * 1-5", () => {
    void schedule("AUXILIARY_PREDICTION_SETTLEMENT", async () => {
      await runCommand("npm", ["run", "models:settle-auxiliary"]);
    });
  });

  cronSchedule("20 16 * * 1-5", () => {
    void schedule("AUXILIARY_PREDICTION_SETTLEMENT", async () => {
      await runCommand("npm", ["run", "models:settle-auxiliary"]);
    });
  });

  /**
/**
   * The timeframes the nightly gap check and heal actually scan.
   *
   * Both jobs previously passed no `--timeframe`, and the CLIs default to `1m` — so for as long as
   * they have run, only the 1m series was ever checked or healed. Measured 2026-08-26: a scan of 5m
   * over the same 25-day window found **11 confirmed collection gaps** across NIFTY50 and BANKNIFTY,
   * including three whole missing sessions, while 1m was complete for every one of those dates and
   * the nightly job passed clean every night.
   *
   * That is the failure this list exists to close, and it is the same lesson as
   * `candle_feature_coverage`: a check that silently covers less than a reader assumes is worse than
   * no check, because it produces a green signal over unexamined ground. 5m is here because the
   * scalp research harness and `pattern-v4-research-v2` both read it.
   */
  const GAP_SCANNED_TIMEFRAMES = ["1m", "5m"] as const;

  /**
   * Index-futures 1m bars, which the volume-profile observation reads as the *prior* session's profile.
   *
   * Runs at 16:08 IST, after the futures session (it runs to 15:40) and before the 16:38 token expiry,
   * and again at 09:12 the next morning as a repair for a night that failed: the first entries of the
   * day are stamped from yesterday's bars. `--auto` derives the live contracts from the date, so the
   * month roll needs no deploy. Only stored bars are written and existing ones are skipped, so a re-run
   * is harmless. Needs the Fyers credential, so it is gated like the other collecting jobs. It feeds a
   * log-only research stamp and nothing else: if it fails, entries are stamped NO_PRIOR_SESSION_FUTURES
   * and still open normally.
   */
  cronSchedule("8 16 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("INDEX_FUTURES_EOD", () => runCommand("npm", ["run", "data:collect:index-futures", "--", "--auto"]));
  });
  cronSchedule("12 9 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("INDEX_FUTURES_EOD_RETRY", () => runCommand("npm", ["run", "data:collect:index-futures", "--", "--auto"]));
  });

  /**
   * Today's futures minutes, in-session, for the *developing* volume profile (d0 in the FRVP_OBS stamp).
   *
   * At :04, :09, :14 ... so it finishes before the bot's :00/:05 run reads it; the minute still forming
   * is dropped by the provider, so the stamp lags the clock by a minute or two, and says which minute it
   * used. Fyers' history endpoint is not known to publish same-day bars mid-session (the index series
   * need the live collector for that reason), so this may deliver nothing: then entries are stamped
   * NO_TODAY_FUTURES and nothing else changes. Log-only research input; never on a path that trades.
   */
  cronSchedule("4-59/5 9-15 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("INDEX_FUTURES_INTRADAY", () => runCommand("npm", ["run", "data:collect:index-futures", "--", "--auto", "--intraday"]));
  });

  /**
   * End-of-day append-only backfill of any confirmed collection gap.
   *
   * Runs at 16:18 IST, a hair before the detector below, so a recoverable gap is repaired before it
   * would page anyone. `data:heal-gaps --apply` fetches only the sessions the shared scan flags as
   * unambiguous misses, only from Fyers, and only with `--skip-existing`, so it can add the missing
   * minutes but never revise a bar the collector already wrote. It re-scans afterwards and exits
   * non-zero if a gap survived the repair — a venue gap or an unauthenticated feed still surfaces.
   *
   * Needs the Fyers credential, so it is gated like the other collecting jobs; when there is no token
   * the detector below still runs and still alarms, it simply cannot self-heal.
   */
  cronSchedule("18 16 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("CANDLE_GAP_HEAL", async () => {
      for (const timeframe of GAP_SCANNED_TIMEFRAMES) {
        await runCommand("npm", ["run", "data:heal-gaps", "--", "--apply", "--timeframe", timeframe, "--lookback-days", "5"]);
      }
    });
  });

  /**
   * End-of-day check that the day's index bars actually all arrived.
   *
   * Runs at 16:20 IST, after the session has closed and the collector has stopped, so today's bars are
   * final, and just after the healer above. Its whole job is to make a silent collection gap loud the
   * same day: the August 2026 gaps went unnoticed for weeks because nothing looked. `data:detect-gaps`
   * exits non-zero on an unambiguous miss, so a gap surfaces here as a FAILED job rather than in a
   * backtest months later.
   *
   * It writes nothing itself. With the healer running first, a routine gap is already repaired by the
   * time this runs and it passes; anything it still reports is a gap the healer could not fix (or one it
   * was not configured to reach), which is exactly what deserves attention. It is also the independent
   * no-write safety net: if the healer has a fault, this still catches the gap.
   */
  cronSchedule("20 16 * * 1-5", () => {
    void schedule("CANDLE_GAP_CHECK", async () => {
      for (const timeframe of GAP_SCANNED_TIMEFRAMES) {
        await runCommand("npm", ["run", "data:detect-gaps", "--", "--timeframe", timeframe, "--lookback-days", "5"]);
      }
    });
  });

  cronSchedule("* 9-15 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("PAPER_TRADE_EXIT_SWEEP", async () => {
      const accounts = await database.query<{ name: string }>(
        `SELECT DISTINCT account.name
           FROM paper_trades trade
           JOIN paper_accounts account ON account.id = trade.account_id
          WHERE trade.status IN ('OPEN', 'PENDING')`,
      );
      for (const account of accounts.rows) {
        await runCommand("npm", ["run", "paper:trades:evaluate", "--", "--account", account.name]);
      }
    });
  });

  /**
   * The autonomous agent's evaluation pass.
   *
   * This used to be driven from inside `GET /api/v1/stream/live-agent`, once per second per
   * connected browser tab -- so open positions were only evaluated while someone was watching,
   * and the one code path that mutates paper trades sat on the method the mutation rate limiter
   * exempts. See `run-agent-tick.ts` for the full account.
   *
   * Every two minutes rather than every second. The agent's own proposal throttle is 15s and
   * its evidence is a completed 15m bar, so a faster cadence re-reads the same context and
   * cannot reach a different conclusion; what it does change is the number of Yahoo quotes and
   * the size of the journal. Stop and target evaluation still runs on every pass, which is the
   * part that wants to be prompt.
   */
  /*
   * 15m, which is the timeframe this agent was actually measured on.
   *
   * The arg said `5m` while the comment above described "a completed 15m bar", so the running
   * configuration had drifted from its own documented design. 15m is the side that has evidence:
   * `measure:directional-scorer` replayed the scorer on 15m and produced the table in
   * `ai-autonomous-agent.ts` -- LONG at +0.005R on NIFTY50 (367) and +0.182R on BANKNIFTY (413),
   * which is what justifies leaving LONG enabled and SHORT scored-but-not-traded. No equivalent
   * measurement exists for 5m, so running there executed a gate validated somewhere else.
   *
   * Brackets follow automatically: the agent sizes from the ticked timeframe's own ATR
   * (`AGENT_ATR_STOP_MULTIPLE`), and refuses the trade outright when that ATR is missing rather
   * than falling back to the flat 1.5%/3% it used to use -- the version that produced a ~370-point
   * NIFTY stop against a ~30-point 15m ATR. Verified 2026-09-07 that 15m ATR is present and current
   * for both symbols before this switch.
   *
   * The every-two-minutes cadence stays. It is deliberately faster than the bar, because stop and
   * target evaluation runs on every pass and that is the part that wants to be prompt.
   */
  cronSchedule("*/2 9-15 * * 1-5", () => {
    void schedule("AI_AGENT_TICK", () => runCommand("npm", [
      "run", "agent:tick", "--", "--symbols=NIFTY50,BANKNIFTY", "--timeframe=15m",
    ]));
  });

  // Before open and throughout the session: a credential can become unusable after 08:00.
  // `getAccessToken` is a database-only read while the token remains comfortably valid, so
  // this cadence does not add provider traffic in the healthy case.
  if (fyersTokenService) {
    cronSchedule("0 8 * * 1-5", () => {
      void schedule("FYERS_AUTH_HEALTH_CHECK", () => checkFyersAuthHealth(fyersTokenService, database));
    });
    cronSchedule("*/15 9-15 * * 1-5", () => {
      void schedule("FYERS_AUTH_HEALTH_CHECK", () => checkFyersAuthHealth(fyersTokenService, database));
    });
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
  //
  // ## Why these minutes rather than `*/15`
  //
  // On `*/15` this ran at :00, which is the busiest minute in the schedule: ten jobs claim
  // there, four of them calling Fyers -- this, INDICES_INTRADAY's six history requests,
  // OPTION_PREMIUM_TICKS, and FYERS_AUTH_HEALTH_CHECK's token refresh -- plus the trading bot
  // and the agent tick. Measured 2026-08-17 at both 06:00 and 07:00: all four underlyings came
  // back `HTTP 429, code 429. request limit reached`, and this job lost the burst it was
  // sharing. That is not a harmless retry, because the failure cascades: the snapshot ages past
  // the forty-minute freshness guard in `selectAtmPremiumContracts`, so OPTION_PREMIUM_TICKS
  // then refuses every run with NO_FRESH_ATM_CONTRACTS, the socket falls back to subscribing the
  // underlyings alone, and the tick series every option exit resolves against stops being
  // written. On 2026-08-17 that ran for fifty minutes.
  //
  // The minutes are odd, not multiples of 3 or 5, and not HIGHER_TIMEFRAME_ANALYSIS's
  // 7,22,37,52 -- which between them clear `*/2` (AI_AGENT_TICK), `*/3` (RSS_NEWS_INGESTION),
  // `*/5` (PAPER_TRADING_BOT, the liveness check), `5,20,35,50` (VOLATILITY_STRADDLE) and every
  // `*/15` job. Only the every-minute jobs still coincide, and those cannot be avoided.
  //
  // Spacing is 12/18/12/18 rather than an even 15 because `*/2` claims every even minute, so no
  // all-odd set can be evenly spaced. The widest gap is 18 minutes, still less than half the
  // forty-minute guard, so a single missed run cannot starve the tick collector the way a
  // failed `*/15` run could once the next one was 30 minutes out.
  cronSchedule("11,23,41,53 9-15 * * 1-5", () => {
    void schedule("OPTION_CHAIN", () => runCommand("npm", [
      "run", "data:collect:option-chain", "--",
      "--underlyings", "NIFTY50,BANKNIFTY,SBIN,RELIANCE",
      "--strike-count", "15",
    ]));
  });

  /**
   * The socket-fed premium tick writer, which owns this series while it is connected.
   *
   * Hosted here rather than in the API process on purpose. Collection is this process's job, and
   * the API restarts on its own schedule — a UI deploy should not punch a hole in the series the
   * paper-trading bot resolves its stops against.
   */
  /**
   * Exit evaluation, driven by the tick writer below rather than by a cron.
   *
   * Built here because this process is the one holding the stream: the barrier a position cares
   * about becomes knowable the instant its quote is persisted, so the shortest honest path from
   * quote to exit is to evaluate right after the write. The per-minute PAPER_TRADE_EXIT_SWEEP
   * cron stays as the floor under it -- a socket fails by going quiet, and a feed that stops
   * without erroring would otherwise stop enforcing stops without erroring either.
   */
  const sweepOpenPaperTradeExits = new SweepOpenPaperTradeExits(
    new PostgresOpenTradeAccountRepository(database),
    new EvaluateOpenPaperTrades(
      new PostgresPaperTradeRepository(database),
      new PostgresCandleRepository(database),
      new PostgresIndiaVixImpliedVolatilitySource(database),
      new PostgresOptionPremiumTickRepository(database),
    ),
  );

  let premiumTickStreamer: OptionPremiumTickStreamer | null = null;
  // Held outside the block so shutdown can close the socket. The tick streamer stops its own
  // timers but does not own the connection, so without this reference nothing ever closes it.
  let premiumTickSocket: FyersLiveStreamer | null = null;
  if (fyersTokenService && fyersAppId) {
    const liveStreamer = new FyersLiveStreamer({
      appId: fyersAppId,
      tokenService: fyersTokenService,
    });
    premiumTickSocket = liveStreamer;
    premiumTickStreamer = new OptionPremiumTickStreamer({
      underlyingSymbols: ["NIFTY50", "BANKNIFTY"],
      streamer: liveStreamer,
      chainRepository: new PostgresOptionChainRepository(database),
      tickRepository: new PostgresOptionPremiumTickRepository(database),
      // Without this the subscription is only the ATM band, which tracks spot while a position
      // does not. A strike that drifts out of the band is exactly the one whose stop still has
      // to resolve, and its tick series would go quiet at the moment it matters most.
      requiredContracts: new PostgresOpenPositionContractRepository(database),
      // The pin above covers open *paper trades*. A research strategy's opportunity is not a paper
      // trade, so nothing pinned it, and Phase 29 D2 lost exits to precisely the drift that comment
      // describes: on NIFTY50 2026-08-18 the strikes it was holding stopped being quoted at
      // 15:12:36 for an exit due at 15:15. Retention covers any hold opened while a contract was
      // ATM, without collection needing to know which studies are running. Sized for D2's
      // 30-minute hold plus its 60-second quote-lag allowance; a longer study must raise it.
      contractRetentionMs: 35 * 60_000,
      onTicksWritten: async () => {
        const result = await sweepOpenPaperTradeExits.execute();
        // Silent on the common case. This runs every few seconds all session, so logging every
        // pass would bury the two things worth seeing: a position closing, and a stop that could
        // not be evaluated -- which means it is not being enforced.
        if (result.tradesClosed > 0 || result.failures.length > 0) {
          console.info(JSON.stringify({
            level: result.failures.length > 0 ? "warn" : "info",
            message: "Tick-driven exit sweep",
            accountsSwept: result.accountsSwept,
            tradesClosed: result.tradesClosed,
            closedTradeIds: result.closedTradeIds,
            failures: result.failures,
          }));
        }
      },
    });
    try {
      await liveStreamer.connect();
      await premiumTickStreamer.start();
    } catch (error) {
      // A socket that will not connect is a degradation, not a reason to start no scheduler at
      // all. The HTTP poller below still runs, so the series continues at its old resolution.
      console.error(JSON.stringify({
        level: "error",
        message: "Could not start the option premium tick stream; falling back to polling only",
        error: error instanceof Error ? error.message : String(error),
      }));
      premiumTickStreamer = null;
    }
  }

  // Dense ATM premium ticks over HTTP. This used to run twice per claimed minute (~25s apart),
  // which is what exhausted the provider's rate limit: 97 of 1,038 runs in the week to
  // 2026-08-16 failed on `HTTP 429 request limit reached`, and on 2026-08-12 those failures also
  // drove 16 of 24 auth health checks to declare a valid credential unusable.
  //
  // With the socket writing the same table continuously, this drops to a single run and becomes
  // the floor under it rather than the source. That matters because a socket fails by going
  // quiet: if it drops, this still deposits a quote on every cron tick, so the series degrades
  // to its old resolution instead of stopping. Forward-only like OPTION_CHAIN.
  const schedulePremiumTicks = () => {
    if (fyersTokenService) {
      void schedule("OPTION_PREMIUM_TICKS", async () => {
        const args = [
          "run", "data:collect:option-premium-ticks", "--",
          "--underlyings", "NIFTY50,BANKNIFTY",
        ];
        await runCommand("npm", args);
        if (premiumTickStreamer === null) {
          await new Promise<void>((resolve) => setTimeout(resolve, 25_000));
          await runCommand("npm", args);
        }
      });
    }
  };

  const calculateIndexIndicatorsIntraday = async (timeframes: readonly string[]): Promise<void> => {
    const indicatorsFrom = istDateKey(
      new Date(Date.now() - INDICATOR_WRITE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000),
    );
    for (const instrument of ["NIFTY50", "BANKNIFTY"]) {
      for (const timeframe of timeframes) {
        await runCommand("npm", [
          "run", "analysis:calculate-indicators", "--",
          "--instrument", instrument,
          "--timeframe", timeframe,
          "--from", indicatorsFrom,
        ]);
      }
    }
  };
  // Exactly 09:15-15:30 IST; do not fill the research table with pre-open/post-close repeats.
  for (const expression of ["15-59 9 * * 1-5", "* 10-14 * * 1-5", "0-30 15 * * 1-5"]) {
    cronSchedule(expression, schedulePremiumTicks);
  }

  // Vol-expansion long-straddle path: propose + gated open attempt. Refusals dominate.
  //
  // Runs five minutes after each intraday prediction, not once an hour. The hourly version
  // (`5 10-14`) could not work and never did: it opened zero positions across thirteen runs, and
  // the account it trades from was never even created. The cause was arithmetic, not the gate --
  // `INTRADAY_MODEL_PREDICTIONS` writes on `*/15`, a prediction is only usable for
  // `MAXIMUM_PREDICTION_AGE_MINUTES` (20), and an hourly sampler therefore arrived after most of
  // them had expired. Measured 2026-08-16, NIFTY50 held 204 EXPANSION predictions, 122 of them at
  // or above the 0.44 confidence bar and 128 unsettled, while the straddle refused every run with
  // NO_EXPANSION_PREDICTION. Supply was never the problem.
  //
  // The heaviest write bucket is 16:06 IST -- the EOD shadow-predict pass, 278 rows -- which sits
  // two hours past the old window's last run and stays out of reach either way. Extending the
  // session window here would not capture it, because those predictions are for the *next*
  // session's open, not a mid-session entry.
  //
  // The `:05` offset is kept deliberately. Matching `*/15` exactly would race the prediction
  // writer on the same minute and read the grid slot before it was filled.
  cronSchedule("5,20,35,50 9-15 * * 1-5", () => {
    void schedule("VOLATILITY_STRADDLE", () => runCommand("npm", [
      "run", "paper:volatility-straddle",
    ]));
  });

  /**
   * Reports a job that has stopped completing, which nothing else notices.
   *
   * The auth health check counts FAILED rows, so a failing job is visible. A job that stops
   * claiming writes no row at all, produces no failure, and therefore looks healthy: on
   * 2026-08-17 OPTION_CHAIN completed every fifteen minutes until 05:45, then produced nothing at
   * 06:15 or 06:30 while every-minute jobs in the same process kept claiming. The chain snapshot
   * went an hour stale, OPTION_PREMIUM_TICKS refused with NO_FRESH_ATM_CONTRACTS for fifty
   * minutes, and it was found by hand. The cause is still unknown -- the container's logs, which
   * held the `skippedReason`, were gone by the time anyone looked -- so this exists to make the
   * next occurrence loud and dated rather than to explain that one.
   *
   * Deliberately not raised as a job failure: it reports on other jobs, so recording its own
   * findings as failures would make the health signal circular.
   *
   * `since` is process start, not market open. A job cannot be expected to have completed before
   * the process that schedules it existed, and using market open would report every job as
   * overdue for the first minutes after a mid-session deploy.
   */
  const LIVENESS_EXPECTATIONS: readonly ScheduledJobExpectation[] = [
    { jobType: "OPTION_CHAIN", intervalMs: 15 * 60_000 },
    { jobType: "OPTION_PREMIUM_TICKS", intervalMs: 60_000, toleratedIntervals: 10 },
    { jobType: "PAPER_TRADE_EXIT_SWEEP", intervalMs: 60_000, toleratedIntervals: 10 },
    { jobType: "PAPER_TRADING_BOT", intervalMs: 5 * 60_000, toleratedIntervals: 4 },
    /*
     * Watched for the reason COLLECTOR_HEALTH had to be: a shadow job that dies silently produces an
     * empty differential record, and "V2.2 made no decisions" is indistinguishable from "the job has
     * not run" unless something says so. That job failed all 38 of its runs unnoticed.
     */
    { jobType: "SHADOW_DECISION", intervalMs: 5 * 60_000, toleratedIntervals: 4 },
    { jobType: "INDICES_INTRADAY", intervalMs: 60_000, toleratedIntervals: 10 },
  ];
  const processStartedAt = new Date();

  cronSchedule("*/5 9-15 * * 1-5", () => {
    void (async () => {
      try {
        const overdue = findOverdueScheduledJobs({
          expectations: LIVENESS_EXPECTATIONS,
          lastCompletedAt: await findLatestScheduledJobCompletions(
            database,
            LIVENESS_EXPECTATIONS.map((expectation) => expectation.jobType),
          ),
          now: new Date(),
          since: processStartedAt,
        });
        if (overdue.length === 0) return;
        logError("Scheduled jobs have stopped completing", {
          overdue: overdue.map((job) => ({
            jobType: job.jobType,
            lastCompletedAt: job.lastCompletedAt?.toISOString() ?? null,
            silentForMinutes: Math.round(job.silentForMs / 60_000),
            toleratedMinutes: Math.round(job.toleratedSilenceMs / 60_000),
          })),
        });
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "Could not check scheduled job liveness",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
  });

  // Every three minutes, matching the interval this replaced. It claims its due minute
  // like everything else, so replicas share the work rather than each ingesting the same
  // feeds and racing on the same article rows.
  cronSchedule("*/3 * * * *", () => {
    void schedule("RSS_NEWS_INGESTION", async () => { await ingestNews.execute(); });
  });

  /*
   * The watchdog watches one expression, so its existence is asserted rather than assumed.
   *
   * Without this, editing or removing that cron would leave the watchdog silently watching an
   * expression nobody registers -- it would never see a fire, and either restart the container
   * forever or (with the window guard) never fire at all. Failing at startup is the only honest
   * option: a watchdog that cannot see its subject must not pretend to.
   */
  if (!registeredCronExpressions.has(canaryCronExpression)) {
    throw new Error(
      `The cron-stall watchdog watches "${canaryCronExpression}", which is not registered. Point `
      + "`canaryCronExpression` at the densest surviving hour-restricted schedule, or the scheduler "
      + "runs with no protection against the timer stall of 2026-08-28.",
    );
  }

  /*
   * Hand-maintained, and it drifts: this list gates nothing, so adding a `cronSchedule` without
   * adding its name here leaves the scheduler running a job its own startup log denies. Caught on
   * 2026-09-08 when AUXILIARY_PREDICTION_SETTLEMENT ran but the log advertised 24 jobs. That matters
   * because the symptom of a stalled job is silence, and a job missing from the manifest is silent
   * by construction.
   */
  log("Scheduler started", {
    jobs: [
      "EOD_PIPELINE",
      "INTRADAY_MODEL_PREDICTIONS",
      "INDICES_INTRADAY",
      "INSTITUTIONAL_FLOWS",
      "INSTITUTIONAL_FLOWS_RETRY",
      "OPENING_GAP_PREDICTION",
      "OPENING_GAP_SETTLEMENT",
      "PREMARKET_BIAS",
      "PREMARKET_PREOPEN_UPDATE",
      "SESSION_OUTCOME_SETTLEMENT",
      "ICT_SHADOW_CAPTURE",
      "ICT_SHADOW_RESOLVE",
      "ICT_GATE_REPORT",
      "PREMARKET_RUN_CHECK",
      "INDIA_VIX_EOD",
      "INDIA_VIX_EOD_RETRY",
      "INDIA_VIX_INTRADAY",
      "AI_AGENT_TICK",
      "PATTERN_DETECTION_INTRADAY",
      // Hand-maintained for the startup log only -- it gates nothing, so an omission here does not
      // stop a job running, it just makes the inventory lie about what is scheduled.
      "PATTERN_INTELLIGENCE_INTRADAY",
      "COLLECTOR_HEALTH",
      // Reads depth_frames, not the feed, so it runs ungated -- and must, since the outage it detects
      // includes "the collector never started".
      "DEPTH_FRAME_STALENESS",
      // Listed outside the Fyers-gated group: it reads stored bars, so it runs without a live feed.
      "CANDIDATE_SETTLEMENT",
      "AUXILIARY_PREDICTION_SETTLEMENT",
      "CANDLE_GAP_CHECK",
      // Ungated for the same reason as the two above: it reads stored contexts and places no orders,
      // so it runs without a live feed. Listing it inside the Fyers-gated group below would
      // misrepresent when it runs.
      "SHADOW_DECISION",
      ...(fyersTokenService
        ? ["FYERS_AUTH_HEALTH_CHECK", "PAPER_TRADING_BOT", "PAPER_TRADE_EXIT_SWEEP", "OPTION_PREMIUM_TICKS",
           // Collects to backfill gaps, so it is gated on the Fyers token like the other collectors.
           "CANDLE_GAP_HEAL", "INDEX_FUTURES_EOD", "INDEX_FUTURES_EOD_RETRY", "INDEX_FUTURES_INTRADAY"]
        : []),
      "OPTION_CHAIN",
      "VOLATILITY_STRADDLE",
      "RSS_NEWS_INGESTION",
      "LIQUIDITY_CANDIDATE_GENERATION",
      "LIQUIDITY_CONTACT_LABELING",
      // Mirrors the runtime gate at this job's own `cronSchedule` callback (`!XAU_BOT_ENABLED ||
      // !process.env.OANDA_ACCESS_TOKEN`) so the inventory can't drift the way it did when
      // `XAU_BOT_ENABLED` flipped back to `true` here but this array was left saying "false" --
      // same class of silent lie the array's own header comment warns about.
      ...(XAU_BOT_ENABLED && process.env.OANDA_ACCESS_TOKEN
        ? ["XAU_CANDLE_COLLECTION", "PAPER_TRADING_BOT_GOLD", "XAU_GAP_HEAL", "GOLD_SHADOW_RESOLVE"]
        : []),
    ],
    timezone: IST,
  });

  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
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
    // Stopped before the pool closes: its final flush writes the quotes already in hand, and
    // that write needs the connection.
    if (premiumTickStreamer) {
      try {
        await premiumTickStreamer.stop();
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "Could not stop the option premium tick stream cleanly",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    // Closed after the final flush but before the pool: a live socket outlasting the pool
    // reconnects, and the reconnect asks the closed pool for a token.
    premiumTickSocket?.close();
    await database.end();
    process.exit(exitCode);
  };
  /**
   * The cron-stall watchdog.
   *
   * Three things make it survive what it detects, and each is a correction of the previous attempt:
   *
   * 1. **A plain interval, not a cron.** `findOverdueScheduledJobs` sits on `*\/5 9-15 * * 1-5` in
   *    this same process, so on 2026-08-28 it died of the exact condition it existed to report.
   * 2. **Wall-clock decisions.** `assessCronStall` compares timestamps, so a timer that fires late
   *    after a VM suspend still reaches the right conclusion. Nothing here trusts the timer.
   * 3. **An exit, not a log.** The previous check logged an error into container logs that were gone
   *    as soon as the container was recreated. With `restart: unless-stopped`, exiting is what
   *    actually re-arms the timers -- and it is the only action that can help, since the process
   *    cannot repair its own schedules.
   *
   * The stall needs no separate audit table: a restart is visible as a new `claimed_by` process
   * identity in `scheduled_job_runs`, with the silence before it in the same rows.
   */
  const CRON_STALL_TOLERANCE_MS = 10 * 60_000;
  /** Distinct from 0 (clean) and 1 (crash), so `docker inspect` says which of the three happened. */
  const CRON_STALL_EXIT_CODE = 75;
  const cronWatchdog = setInterval(() => {
    let verdict;
    try {
      verdict = assessCronStall({
        lastFiredAt: cronLastFiredAt.get(canaryCronExpression) ?? null,
        now: new Date(),
        processStartedAt: processStartedAt,
        toleranceMs: CRON_STALL_TOLERANCE_MS,
        window: { shouldBeFiring: canaryShouldBeFiring, windowOpenedAt: canaryWindowOpenedAt },
        canaryLabel: canaryCronExpression,
      });
    } catch (error) {
      // A throw here must not take the scheduler down: the watchdog failing is not a stall.
      console.error(JSON.stringify({
        level: "error",
        message: "Could not assess cron liveness",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    if (!verdict.stalled) return;

    logError("Cron timers have stalled; exiting so the container restarts", {
      canary: canaryCronExpression,
      reason: verdict.reason,
      silentForMinutes: verdict.silentForMs === null ? null : Math.round(verdict.silentForMs / 60_000),
      // What still fires is the diagnostic half: on 2026-08-28 only the hour-unrestricted schedule
      // did, which is the signature of a suspend-resume rather than of a dead process.
      stillFiring: [...cronLastFiredAt.entries()]
        .filter(([, at]) => Date.now() - at.getTime() < CRON_STALL_TOLERANCE_MS)
        .map(([expression]) => expression),
      exitCode: CRON_STALL_EXIT_CODE,
    });
    clearInterval(cronWatchdog);
    void shutdown("CRON_STALL", CRON_STALL_EXIT_CODE);
  }, 60_000);

  /**
   * The pre-market run check. Once each trading morning, after the 08:57 slot has had time to finish, it decides from
   * the database and this process's own timers whether the pre-market run happened and, if not, why -- see
   * `assessPremarketRun`. On 2026-10-14 the run left no trace at all and the container's logs were gone before anyone
   * looked.
   *
   * A plain interval deciding on wall-clock time, not a cron, for the reason the watchdog above is one: a cron in the
   * hour window is exactly what stops firing after a host suspend, and a check that dies of the thing it checks for
   * reports nothing. A miss is thrown, so the job row is FAILED with the diagnosis in `error_details`, which outlives
   * the logs. A scheduler that starts after 09:05 checks once on start-up and finds the earlier process's rows.
   */
  const PREMARKET_CHECK_FROM_IST_MINUTE = 9 * 60 + 5;
  const PREMARKET_CHECK_UNTIL_IST_MINUTE = 15 * 60 + 30;
  let premarketCheckedDate: string | null = null;
  setInterval(() => {
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 60 * 60_000);
    const sessionDate = ist.toISOString().slice(0, 10);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const weekday = ist.getUTCDay();
    if (weekday === 0 || weekday === 6 || premarketCheckedDate === sessionDate) return;
    if (minute < PREMARKET_CHECK_FROM_IST_MINUTE || minute > PREMARKET_CHECK_UNTIL_IST_MINUTE) return;
    premarketCheckedDate = sessionDate;
    void schedule("PREMARKET_RUN_CHECK", async () => {
      const stored = await new PostgresPremarketBiasRepository(database).loadRunEvidence(sessionDate);
      const verdict = assessPremarketRun({
        sessionDate,
        holiday: (await isNseHoliday(database, now)).name,
        ...stored,
        firstSlotTimerFiredAt: cronLastFiredAt.get(PREMARKET_FIRST_SLOT_CRON) ?? null,
        finalSlotTimerFiredAt: cronLastFiredAt.get(PREMARKET_FINAL_SLOT_CRON) ?? null,
        processStartedAt,
        firstSlotDueAt: new Date(`${sessionDate}T08:52:00+05:30`),
        finalSlotDueAt: new Date(`${sessionDate}T08:57:00+05:30`),
      });
      log("Pre-market run check", { sessionDate, outcome: verdict.outcome, detail: verdict.detail });
      if (verdict.outcome === "MISSED" || verdict.outcome === "RAN_NO_RESULT") throw new Error(verdict.detail);
    });
  }, 60_000);

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
