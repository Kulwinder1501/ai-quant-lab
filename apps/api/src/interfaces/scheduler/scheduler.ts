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
    // Every intraday job below is on a cron faster than this, so a run that outlives its
    // horizon has stopped being useful anyway -- the next tick's data supersedes it.
    INDICES_INTRADAY: 10 * 60 * 1000,
    INDIA_VIX_INTRADAY: 10 * 60 * 1000,
    OPTION_CHAIN: 10 * 60 * 1000,
    // Two collects + ~25s sleep fits under a minute; 90s recovers the next tick after a dead claimant.
    OPTION_PREMIUM_TICKS: 90 * 1000,
    PAPER_TRADING_BOT: 10 * 60 * 1000,
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
    RSS_NEWS_INGESTION: 10 * 60 * 1000,
    // Research only, and deliberately the most patient claim here: a candidate cannot be settled
    // before its horizon elapses, so a stalled claimant costs nothing but a later sweep.
    CANDIDATE_SETTLEMENT: 30 * 60 * 1000,
    // Once-a-day integrity check; a stalled claim just means the next EOD run does the looking.
    CANDLE_GAP_CHECK: 30 * 60 * 1000,
    // Once-a-day append-only backfill of confirmed gaps; same patience as the check it precedes.
    CANDLE_GAP_HEAL: 30 * 60 * 1000,
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
      logError("Scheduled job failed", {
        jobType,
        scheduledFor: scheduledFor.toISOString(),
        error: message,
      });
    }
  }

  cron.schedule("5 16 * * 1-5", () => {
    void schedule("EOD_PIPELINE", () => runCommand("npm", ["run", "pipeline:eod"]));
  }, { timezone: IST });

  // Intraday shadow predictions for the volatility competition pool. Labels are
  // session-partitioned (a bar near the close has no same-session forward bars),
  // so predictions must be made during the session to ever settle; a single EOD
  // prediction on the day's final bar would never mature. Each run ingests the
  // session's completed 15m bars so far, then predicts once per pool model on
  // the latest one — idempotent per (model, candle), so overlapping runs and
  // out-of-hours no-ops are harmless.
  cron.schedule("*/15 9-15 * * 1-5", () => {
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
   * 5-6s per instrument over ~12k bars, 1m is 14s per instrument over ~56k. Four passes at a
   * fifteen-minute cadence is well inside the 20-minute abandoned-claim horizon for this job.
   */
  cron.schedule("*/15 9-15 * * 1-5", () => {
    void schedule("PATTERN_DETECTION_INTRADAY", () => detectPatternsIntraday(["1m", "5m", "15m"]));
  }, { timezone: IST });

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

  cron.schedule("7,22,37,52 9-15 * * 1-5", () => {
    void schedule("PATTERN_INTELLIGENCE_INTRADAY", () => detectPatternIntelligenceIntraday(["1m", "5m"]));
  }, { timezone: IST });

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
  cron.schedule("3,13,23,33,43,53 9-15 * * 1-5", () => {
    void schedule("COLLECTOR_HEALTH", () => runCommand("npm", ["run", "ops:collector-health"]));
  }, { timezone: IST });

  // Higher-timeframe models consume completed 30m/60m candles. Refreshing their
  // derived features every minute would repeatedly traverse the same history with
  // no new completed input, so keep this on the 15-minute boundary. The commands
  // are idempotent and the five-day write window heals missed runs after restarts.
  // Offset from the quarter-hour jobs so prediction, 15m pattern detection, and
  // these heavier full-history calculations do not contend at the same second.
  cron.schedule("7,22,37,52 9-15 * * 1-5", () => {
    if (fyersTokenService) {
      void schedule("HIGHER_TIMEFRAME_ANALYSIS", async () => {
        // live-collector-v2 supplies these candles; EOD owns gap healing.
        await calculateIndexIndicatorsIntraday(["30m", "60m"]);
        await detectPatternsIntraday(["30m", "60m"]);
      });
    }
  }, { timezone: IST });

  cron.schedule("*/1 9-15 * * 1-5", () => {
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
  }, { timezone: IST });

  cron.schedule("*/5 9-15 * * 1-5", () => {
    if (fyersTokenService) {
      void schedule("PAPER_TRADING_BOT", () => runCommand("npm", ["run", "trading:paper:bot"]));
    }
  }, { timezone: IST });

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
   * Settles candidates whose horizon has elapsed, so the ledger can say what the trades nobody took
   * would have done.
   *
   * Research only: nothing reads a settlement at decision time, so this is scheduled where it cannot
   * compete with execution. Half-hourly through the session picks up short horizons while they are
   * fresh, and the 16:10 run catches every candidate whose horizon crossed the close.
   *
   * Deliberately not gated on `fyersTokenService`: this reads stored bars, so it works on a day the
   * feed never authenticated -- which is exactly a day worth measuring.
   */
  cron.schedule("15,45 9-15 * * 1-5", () => {
    void schedule("CANDIDATE_SETTLEMENT", async () => {
      await runCommand("npm", ["run", "research:settle-candidates", "--", "--limit", "1000"]);
    });
  }, { timezone: IST });

  cron.schedule("10 16 * * 1-5", () => {
    void schedule("CANDIDATE_SETTLEMENT", async () => {
      await runCommand("npm", ["run", "research:settle-candidates", "--", "--limit", "5000"]);
    });
  }, { timezone: IST });

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
  cron.schedule("18 16 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("CANDLE_GAP_HEAL", async () => {
      for (const timeframe of GAP_SCANNED_TIMEFRAMES) {
        await runCommand("npm", ["run", "data:heal-gaps", "--", "--apply", "--timeframe", timeframe, "--lookback-days", "5"]);
      }
    });
  }, { timezone: IST });

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
  cron.schedule("20 16 * * 1-5", () => {
    void schedule("CANDLE_GAP_CHECK", async () => {
      for (const timeframe of GAP_SCANNED_TIMEFRAMES) {
        await runCommand("npm", ["run", "data:detect-gaps", "--", "--timeframe", timeframe, "--lookback-days", "5"]);
      }
    });
  }, { timezone: IST });

  cron.schedule("* 9-15 * * 1-5", () => {
    if (!fyersTokenService) return;
    void schedule("PAPER_TRADE_EXIT_SWEEP", async () => {
      const accounts = await database.query<{ name: string }>(
        `SELECT DISTINCT account.name
           FROM paper_trades trade
           JOIN paper_accounts account ON account.id = trade.account_id
          WHERE trade.status = 'OPEN'`,
      );
      for (const account of accounts.rows) {
        await runCommand("npm", ["run", "paper:trades:evaluate", "--", "--account", account.name]);
      }
    });
  }, { timezone: IST });

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
  cron.schedule("*/2 9-15 * * 1-5", () => {
    void schedule("AI_AGENT_TICK", () => runCommand("npm", [
      "run", "agent:tick", "--", "--symbols=NIFTY50,BANKNIFTY", "--timeframe=5m",
    ]));
  }, { timezone: IST });

  // Before open and throughout the session: a credential can become unusable after 08:00.
  // `getAccessToken` is a database-only read while the token remains comfortably valid, so
  // this cadence does not add provider traffic in the healthy case.
  if (fyersTokenService) {
    cron.schedule("0 8 * * 1-5", () => {
      void schedule("FYERS_AUTH_HEALTH_CHECK", () => checkFyersAuthHealth(fyersTokenService, database));
    }, { timezone: IST });
    cron.schedule("*/15 9-15 * * 1-5", () => {
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
  cron.schedule("11,23,41,53 9-15 * * 1-5", () => {
    void schedule("OPTION_CHAIN", () => runCommand("npm", [
      "run", "data:collect:option-chain", "--",
      "--underlyings", "NIFTY50,BANKNIFTY,SBIN,RELIANCE",
      "--strike-count", "15",
    ]));
  }, { timezone: IST });

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
    cron.schedule(expression, schedulePremiumTicks, { timezone: IST });
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
  cron.schedule("5,20,35,50 9-15 * * 1-5", () => {
    void schedule("VOLATILITY_STRADDLE", () => runCommand("npm", [
      "run", "paper:volatility-straddle",
    ]));
  }, { timezone: IST });

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
    { jobType: "INDICES_INTRADAY", intervalMs: 60_000, toleratedIntervals: 10 },
  ];
  const processStartedAt = new Date();

  cron.schedule("*/5 9-15 * * 1-5", () => {
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
      "AI_AGENT_TICK",
      "PATTERN_DETECTION_INTRADAY",
      "COLLECTOR_HEALTH",
      // Listed outside the Fyers-gated group: it reads stored bars, so it runs without a live feed.
      "CANDIDATE_SETTLEMENT",
      "CANDLE_GAP_CHECK",
      ...(fyersTokenService
        ? ["FYERS_AUTH_HEALTH_CHECK", "PAPER_TRADING_BOT", "PAPER_TRADE_EXIT_SWEEP", "OPTION_PREMIUM_TICKS",
           // Collects to backfill gaps, so it is gated on the Fyers token like the other collectors.
           "CANDLE_GAP_HEAL"]
        : []),
      "OPTION_CHAIN",
      "VOLATILITY_STRADDLE",
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
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
