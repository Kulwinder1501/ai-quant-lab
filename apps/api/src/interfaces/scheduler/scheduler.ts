import "dotenv/config";
import cron from "node-cron";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresNewsRepository } from "../../infrastructure/database/repositories/postgres-news-repository.js";
import { PostgresScheduledJobClaimRepository } from "../../infrastructure/database/repositories/postgres-scheduled-job-claim-repository.js";
import { IngestRssNewsService } from "../../modules/news-sentiment/application/ingest-rss-news.js";
import { runExclusively, toDueMinute } from "../../modules/scheduling/domain/scheduled-job.js";

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

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: true, cwd: REPO_ROOT });
    child.on("error", reject);
    child.on("exit", (code) => {
      // A non-zero exit is a failed run, not a completed one. The previous version
      // listened only for "error", so a job that started and then exited 1 was
      // indistinguishable from success.
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ level: "info", message, process: processIdentity, ...extra }));
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const claims = new PostgresScheduledJobClaimRepository(database);
  const ingestNews = new IngestRssNewsService(new PostgresNewsRepository(database));

  async function schedule(jobType: string, task: () => Promise<void>): Promise<void> {
    const scheduledFor = toDueMinute(new Date());
    try {
      const result = await runExclusively(claims, { jobType, scheduledFor, claimedBy: processIdentity }, task);
      log(result.ran ? "Scheduled job completed" : "Scheduled job already claimed by another process", {
        jobType,
        scheduledFor: scheduledFor.toISOString(),
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
        "--provider", "yahoo",
        "--instrument", "NIFTY50",
        "--timeframe", "15m",
        "--from", todayIst,
        "--to", todayIst,
        "--skip-existing",
      ]);
      await runCommand("npm", ["run", "ml:predict", "--", "--competition-pool"]);
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
      "INSTITUTIONAL_FLOWS",
      "INSTITUTIONAL_FLOWS_RETRY",
      "INDIA_VIX_EOD",
      "INDIA_VIX_EOD_RETRY",
      "INDIA_VIX_INTRADAY",
      "RSS_NEWS_INGESTION",
    ],
    timezone: IST,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log("Scheduler shutting down", { signal });
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
