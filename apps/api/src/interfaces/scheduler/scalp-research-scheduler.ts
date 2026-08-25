import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import { loadEnvironment } from "../../config/environment.js";
import { requireIsolatedResearchDatabaseUrl } from "../cli/scalp-research-database.js";

const IST = "Asia/Kolkata";
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

async function main(): Promise<void> {
  const environment = loadEnvironment();
  requireIsolatedResearchDatabaseUrl(environment.DATABASE_URL, environment.SCALP_RESEARCH_DATABASE_URL);
  // Fifty seconds after each decision minute gives the 1m collector time to persist the completed bar.
  for (const expression of ["50 16-59 9 * * 1-5", "50 * 10-14 * * 1-5", "50 0-30 15 * * 1-5"]) {
    cron.schedule(expression, () => void tick().catch((error: unknown) => {
      console.error(JSON.stringify({ level: "error", message: "Scalp research tick failed", error: error instanceof Error ? error.message : String(error) }));
    }), { timezone: IST });
  }
  // Final drain after the close; capture is idempotent and settles all mature same-session paths.
  cron.schedule("50 31 15 * * 1-5", () => void tick().catch((error: unknown) => {
    console.error(JSON.stringify({ level: "error", message: "Scalp research drain failed", error: error instanceof Error ? error.message : String(error) }));
  }), { timezone: IST });
  // Saturday 07:00 IST: after Friday's drain and after the overnight candle heal, so the week is final.
  cron.schedule("0 0 7 * * 6", () => void weeklyPathStudy().catch((error: unknown) => {
    console.error(JSON.stringify({ level: "error", message: "Weekly path study failed", error: error instanceof Error ? error.message : String(error) }));
  }), { timezone: IST });
  console.info(JSON.stringify({
    level: "info",
    message: "Physically isolated scalp research scheduler started",
    timezone: IST,
    weeklyPathStudy: "PATH_STUDY_V2 — Saturday 07:00 IST",
  }));
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
