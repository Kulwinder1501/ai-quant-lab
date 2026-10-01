import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import { loadEnvironment } from "../../config/environment.js";
import { requireIsolatedResearchDatabaseUrl } from "../cli/scalp-research-database.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPathStudyRepository } from "../../infrastructure/database/repositories/postgres-path-study-repository.js";
import {
  isTransientDatabaseConnectionError,
  isWeeklyStudyOverdue,
} from "../../modules/research/scalp-harness/domain/weekly-study-catch-up.js";
import {
  assessCronStall,
  scalpResearchTickCanaryExpression,
  scalpResearchTickShouldBeFiring,
  scalpResearchTickWindowOpenedAt,
} from "../../modules/scheduling/domain/cron-liveness.js";

const IST = "Asia/Kolkata";
const PATH_STUDY_KEY = "PATH_STUDY_V2";
let running = false;
let studyRunning = false;
const cli = (name: string): string => fileURLToPath(new URL(`../cli/${name}.js`, import.meta.url));

function run(name: string, args: readonly string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli(name), ...args], { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${name} exited with ${code}.`)));
  });
}

async function tick(): Promise<void> {
  if (running) {
    console.warn(JSON.stringify({ level: "warn", message: "Skipped overlapping scalp research tick" }));
    return;
  }
  running = true;
  try {
    await run("run-scalp-research-harness", ["--instruments", "NIFTY50,BANKNIFTY"]);
    await run("match-scalp-research-controls");
    await run("settle-scalp-research");
  } finally {
    running = false;
  }
}

/**
 * The weekly exit-geometry read: register the studies, then run the authoritative path study.
 *
 * ## Why weekly, and why Saturday
 *
 * A path study reads settled rows and adds nothing to them, so it gains information only when a session
 * completes. Saturday 07:00 IST sits after Friday's 15:31 drain and after Friday night's candle heal, so
 * the week's data is final; running it intraday would only re-examine an unchanged dataset.
 *
 * ## Why re-registering every week is safe
 *
 * Registration is idempotent for an unchanged definition and *refuses* a changed one. Running it here
 * means a deploy that edits a specification fails loudly on the next scheduled run rather than at
 * whatever future moment someone next looks — which is the earliest this class of drift can be caught.
 *
 * ## Why only PATH_STUDY_V2
 *
 * V2 is the registered authority; V1's pointwise verdict is superseded, and scheduling it would produce
 * a weekly stream of readings we have already established overfire. It also halves the number of looks
 * at a growing dataset, which matters: repeatedly examining nested datasets is itself a form of multiple
 * testing, and every look is a row in the ledger the eventual correction has to account for. A
 * V1-versus-V2 comparison remains available on demand — the runner is deterministic, so it reproduces
 * any past window exactly.
 *
 * The run is idempotent across weeks with no new sessions: the trial key is derived from the session set
 * and input snapshot, so an unchanged dataset recovers the same trials rather than declaring new ones.
 */
async function weeklyPathStudy(): Promise<void> {
  if (studyRunning) {
    console.warn(JSON.stringify({ level: "warn", message: "Skipped overlapping weekly path study" }));
    return;
  }
  studyRunning = true;
  try {
    await run("register-research-studies");
    await run("run-path-study", ["--study", "PATH_STUDY_V2"]);
  } finally {
    studyRunning = false;
  }
}

/**
 * Whether this week's `PATH_STUDY_V2` run is already overdue, checked once at startup so a missed
 * Saturday recovers the moment the container next comes up rather than waiting out a full week.
 *
 * See `weekly-study-catch-up.ts` for why the frequent-tick watchdog below cannot substitute for this:
 * restarting after a missed weekly slot only re-arms next Saturday's cron, it does not recover the
 * week that was already lost.
 *
 * A short-lived pool: this check runs once at startup and the connection is not needed again, since
 * every actual job below does its own work in a spawned child process with its own connection.
 *
 * Retries a bounded number of times on a transient connection failure before giving up. Measured
 * 2026-09-16: a host-standby restart brings every container in the stack back at once, and this
 * check ran (and failed with `ECONNREFUSED`) before `database-v2` had finished starting up -- with no
 * retry, that whole-stack-restart race silently skipped the one check this exists for, every time it
 * happened to lose the race. See `isTransientDatabaseConnectionError` for which failures qualify; a
 * real query/schema defect is not one of them and still surfaces on the first attempt.
 */
const PATH_STUDY_CATCH_UP_STALE_AFTER_MS = 8 * 24 * 60 * 60_000; // a week, plus a day of slack
const PATH_STUDY_CATCH_UP_CONNECT_ATTEMPTS = 5;
const PATH_STUDY_CATCH_UP_RETRY_DELAY_MS = 5_000;
async function checkAndCatchUpMissedWeeklyStudy(researchDatabaseUrl: string): Promise<void> {
  const pool = createDatabasePool(researchDatabaseUrl);
  try {
    const repository = new PostgresPathStudyRepository(pool);
    let lastDeclaredAt: Date | null = null;
    for (let attempt = 1; ; attempt++) {
      try {
        lastDeclaredAt = await repository.findLatestDeclaredAt(PATH_STUDY_KEY);
        break;
      } catch (error) {
        if (attempt >= PATH_STUDY_CATCH_UP_CONNECT_ATTEMPTS || !isTransientDatabaseConnectionError(error)) {
          throw error;
        }
        console.info(JSON.stringify({
          level: "info",
          message: "Weekly path study catch-up check found the database not ready yet; retrying",
          attempt, ofAttempts: PATH_STUDY_CATCH_UP_CONNECT_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error),
        }));
        await new Promise((resolve) => setTimeout(resolve, PATH_STUDY_CATCH_UP_RETRY_DELAY_MS));
      }
    }
    const overdue = isWeeklyStudyOverdue({
      lastDeclaredAt, now: new Date(), staleAfterMs: PATH_STUDY_CATCH_UP_STALE_AFTER_MS,
    });
    console.info(JSON.stringify({
      level: "info",
      message: overdue ? "Weekly path study is overdue; running it now" : "Weekly path study is current",
      studyKey: PATH_STUDY_KEY,
      lastDeclaredAt: lastDeclaredAt?.toISOString() ?? null,
    }));
    if (overdue) {
      await weeklyPathStudy();
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const researchDatabaseUrl = requireIsolatedResearchDatabaseUrl(
    environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL,
  );
  const processStartedAt = new Date();

  const cronLastFiredAt = new Map<string, Date>();
  const registeredCronExpressions = new Set<string>();
  /**
   * Wraps registration rather than the handler, matching `scheduler.ts`'s own cron-stall watchdog --
   * the timestamp is stamped before the job runs, so a throwing job still counts as the timer having
   * fired (a broken job is a different problem, with its own error log, not a stalled timer).
   */
  function cronSchedule(expression: string, handler: () => void): void {
    registeredCronExpressions.add(expression);
    cron.schedule(expression, () => {
      cronLastFiredAt.set(expression, new Date());
      handler();
    }, { timezone: IST });
  }

  // Fifty seconds after each decision minute gives the 1m collector time to persist the completed bar.
  for (const expression of ["50 16-59 9 * * 1-5", "50 * 10-14 * * 1-5", "50 0-30 15 * * 1-5"]) {
    cronSchedule(expression, () => void tick().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", message: "Scalp research tick failed", error: error instanceof Error ? error.message : String(error) }));
    }));
  }
  // Final drain after the close; capture is idempotent and settles all mature same-session paths.
  cronSchedule("50 31 15 * * 1-5", () => void tick().catch((error: unknown) => {
    console.error(JSON.stringify({ level: "error", message: "Scalp research drain failed", error: error instanceof Error ? error.message : String(error) }));
  }));
  // Saturday 07:00 IST: after Friday's drain and after the overnight candle heal, so the week is final.
  cronSchedule("0 0 7 * * 6", () => void weeklyPathStudy().catch((error: unknown) => {
    console.error(JSON.stringify({ level: "error", message: "Weekly path study failed", error: error instanceof Error ? error.message : String(error) }));
  }));

  /**
   * The cron-stall watchdog -- see `cron-liveness.ts`. Measured 2026-09-15: this scheduler's own
   * process logged dozens of `[NODE-CRON] missed execution` warnings in ~14-minute bursts across a
   * single trading day, and separately `PATH_STUDY_V2` had not run since 2026-08-25, three weeks with
   * no restart in between. This container had no protection against either failure mode until now.
   *
   * A plain interval (not a cron, for the same reason `scheduler.ts`'s does not sit on a cron), wall
   * clock decisions via `assessCronStall`, and an exit rather than a log -- `restart: unless-stopped`
   * is what actually re-arms the timers, since the process cannot repair its own schedule.
   */
  if (!registeredCronExpressions.has(scalpResearchTickCanaryExpression)) {
    throw new Error(
      `The cron-stall watchdog watches "${scalpResearchTickCanaryExpression}", which is not `
      + "registered. Point it at the densest surviving tick schedule, or this scheduler runs with no "
      + "protection against the timer stall measured 2026-09-15.",
    );
  }
  const CRON_STALL_TOLERANCE_MS = 10 * 60_000;
  /** Distinct from 0 (clean) and 1 (crash), matching `scheduler.ts`'s own convention. */
  const CRON_STALL_EXIT_CODE = 75;
  const cronWatchdog = setInterval(() => {
    let verdict;
    try {
      verdict = assessCronStall({
        lastFiredAt: cronLastFiredAt.get(scalpResearchTickCanaryExpression) ?? null,
        now: new Date(),
        processStartedAt,
        toleranceMs: CRON_STALL_TOLERANCE_MS,
        window: { shouldBeFiring: scalpResearchTickShouldBeFiring, windowOpenedAt: scalpResearchTickWindowOpenedAt },
        canaryLabel: scalpResearchTickCanaryExpression,
      });
    } catch (error) {
      // A throw here must not take the scheduler down: the watchdog failing is not a stall.
      console.error(JSON.stringify({
        level: "error", message: "Could not assess cron liveness",
        error: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    if (!verdict.stalled) return;

    console.error(JSON.stringify({
      level: "error",
      message: "Cron timers have stalled; exiting so the container restarts",
      canary: scalpResearchTickCanaryExpression,
      reason: verdict.reason,
      silentForMinutes: verdict.silentForMs === null ? null : Math.round(verdict.silentForMs / 60_000),
      exitCode: CRON_STALL_EXIT_CODE,
    }));
    clearInterval(cronWatchdog);
    process.exit(CRON_STALL_EXIT_CODE);
  }, 60_000);

  console.info(JSON.stringify({
    level: "info",
    message: "Physically isolated scalp research scheduler started",
    timezone: IST,
    weeklyPathStudy: "PATH_STUDY_V2 — Saturday 07:00 IST",
  }));

  // After the schedule is registered and logged, so a catch-up run's own log lines are legible
  // against "the scheduler started" rather than appearing to precede it. Caught and logged rather
  // than left to propagate: a failed catch-up attempt (e.g. the DB not yet reachable at startup) is
  // not fatal, the same posture every other job in this file already takes -- next Saturday's cron
  // gets another chance regardless.
  await checkAndCatchUpMissedWeeklyStudy(researchDatabaseUrl).catch((error: unknown) => {
    console.error(JSON.stringify({
      level: "error", message: "Weekly path study catch-up check failed",
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
