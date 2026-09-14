#!/usr/bin/env node
/**
 * Cross-platform Python launcher for the ML scripts.
 *
 * The npm scripts used to hardcode `py -3.12`, which only exists on Windows —
 * inside the Linux containers every ML step failed before it started. This
 * launcher prefers an explicit PYTHON environment variable (the Docker image
 * sets it to its virtualenv interpreter), then falls back to the platform's
 * conventional launcher.
 */
import { spawnSync } from "node:child_process";

const forwarded = process.argv.slice(2);
const explicit = process.env.PYTHON?.trim();
const candidates = explicit
  ? [[explicit, []]]
  : process.platform === "win32"
    ? [["py", ["-3.12"]], ["python", []]]
    : [["python3", []], ["python", []]];

for (const [command, prefix] of candidates) {
  const result = spawnSync(command, [...prefix, ...forwarded], { stdio: "inherit" });
  if (result.error && result.error.code === "ENOENT") continue;
  process.exit(result.status ?? 1);
}

console.error(
  "No Python interpreter was found. Install Python 3.12 (Windows: the py launcher) or set the PYTHON environment variable.",
);
process.exit(1);
