import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import { loadEnvironment } from "../../config/environment.js";
import { requireIsolatedResearchDatabaseUrl } from "../cli/scalp-research-database.js";

const IST = "Asia/Kolkata";
let running = false;
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
  console.info(JSON.stringify({ level: "info", message: "Physically isolated scalp research scheduler started", timezone: IST }));
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
