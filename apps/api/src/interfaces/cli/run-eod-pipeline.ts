import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ML_ALGORITHMS = ["xgboost", "lightgbm"];

// apps/api/{src|dist}/interfaces/cli → five levels up is the repo root. Every
// step runs a root-level npm script from there, so the pipeline behaves the
// same whether it was spawned from apps/api (host) or /app (container).
const REPO_ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

async function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.info(`\n🚀 Running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: "inherit", shell: true, cwd: REPO_ROOT });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const nowIso = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    console.info("============== EOD PIPELINE STARTED ==============");

    // 1. Fetch EOD Historical Data for NIFTY50 via Yahoo Finance (last 7 days to ensure safety)
    await runCommand("npm", [
      "run", "data:collect:historical", "--",
      "--provider", "yahoo",
      "--instrument", "NIFTY50",
      "--timeframe", "15m",
      "--from", sevenDaysAgo,
      "--to", today,
      "--skip-existing"
    ]);

    // 2. Settle matured shadow predictions against the candles just collected,
    // updating each pool model's live daily scoreboard.
    await runCommand("npm", ["run", "models:settle-predictions"]);

    // 3. Train fresh candidates. Deliberately *without* --promote: a one-shot
    // holdout comparison no longer decides production. New candidates enter the
    // competition pool (step 5) and must outperform the champion on live,
    // settled outcomes before the title changes hands.
    for (const algo of ML_ALGORITHMS) {
      await runCommand("npm", [
        "run", `ml:train:${algo}`, "--",
        "--instrument", "NIFTY50",
        "--timeframe", "15m",
        "--from", "2024-01-01",
        "--to", nowIso,
      ]);
    }

    // 4. Shadow-predict once for the whole pool so a day with no intraday runs
    // still records at least one prediction per model (idempotent per candle).
    await runCommand("npm", ["run", "ml:predict", "--", "--competition-pool"]);

    // 5. Daily competition: enroll qualifying fresh candidates, rank the pool on
    // rolling settled macro-F1, and promote the challenger only after consistent
    // live outperformance.
    await runCommand("npm", ["run", "models:compete"]);

    console.info("============== EOD PIPELINE COMPLETE ==============");
  } catch (error) {
    console.error("EOD Pipeline failed:", error);
    process.exitCode = 1;
  }
}

void main();
