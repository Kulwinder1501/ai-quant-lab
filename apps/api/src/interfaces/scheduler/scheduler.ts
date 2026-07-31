import "dotenv/config";
import cron from "node-cron";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
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

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: true });
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

  cron.schedule("30 18 * * 1-5", () => {
    void schedule("INSTITUTIONAL_FLOWS", () => runCommand("npm", ["run", "data:collect:institutional"]));
  }, { timezone: IST });

  // Every three minutes, matching the interval this replaced. It claims its due minute
  // like everything else, so replicas share the work rather than each ingesting the same
  // feeds and racing on the same article rows.
  cron.schedule("*/3 * * * *", () => {
    void schedule("RSS_NEWS_INGESTION", async () => { await ingestNews.execute(); });
  });

  log("Scheduler started", {
    jobs: ["EOD_PIPELINE", "INSTITUTIONAL_FLOWS", "RSS_NEWS_INGESTION"],
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
