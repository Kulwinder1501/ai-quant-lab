import "dotenv/config";
import { spawn } from "node:child_process";

const ML_ALGORITHMS = ["xgboost", "lightgbm"];

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.info(`\n🚀 Running: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, { stdio: "inherit", shell: true, cwd });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  try {
    const today = new Date().toISOString().split("T")[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    console.info("============== EOD PIPELINE STARTED ==============");

    // 1. Fetch EOD Historical Data for NIFTY50 via Yahoo Finance (last 7 days to ensure safety)
    await runCommand("npm", [
      "run", "data:collect:historical", "--",
      "--provider", "yahoo",
      "--instrument", "NIFTY50",
      "--timeframe", "15m",
      "--from", sevenDaysAgo,
      "--to", today
    ]);

    // 2. Train Candidates and Promote
    for (const algo of ML_ALGORITHMS) {
      await runCommand("npm", [
        "run", `ml:train:${algo}`, "--",
        "--promote"
      ], "../../.."); // Run from repo root
    }

    console.info("============== EOD PIPELINE COMPLETE ==============");
  } catch (error) {
    console.error("EOD Pipeline failed:", error);
    process.exitCode = 1;
  }
}

void main();
