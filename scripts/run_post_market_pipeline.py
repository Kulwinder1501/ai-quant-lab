#!/usr/bin/env python3
"""Automated Post-Market Pipeline Orchestrator.

Executes daily post-market data processing and OOS evaluation for ORDERBOOK-01:
1. Generates structural liquidity candidates across configured symbols (BANKNIFTY, NIFTY50, FINNIFTY).
2. Computes forward contact/breach labels across 30s, 120s, 300s, 900s horizons.
3. Evaluates OOS holdout performance metrics and updates orderbook01_verdict.json.
4. Appends structured execution logs to logs/post-market-pipeline.log.
"""

from __future__ import annotations

import json
import os
import sys
import subprocess
from datetime import datetime
from pathlib import Path
import zoneinfo

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_FILE = PROJECT_ROOT / "logs" / "post-market-pipeline.log"
VERDICT_FILE = PROJECT_ROOT / "apps" / "ml" / "orderbook01_verdict.json"

SYMBOLS = ["BANKNIFTY", "NIFTY50", "FINNIFTY"]

def log_message(msg: str):
    timestamp = datetime.now(INDIA_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")
    formatted = f"[{timestamp}] {msg}"
    print(formatted, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")

def run_command(cmd_list: list[str], cwd: Path = PROJECT_ROOT) -> tuple[int, str]:
    log_message(f"Running command: {' '.join(cmd_list)}")
    try:
        # On Windows, wrap npx/node via shell if needed
        use_shell = sys.platform == "win32"
        proc = subprocess.run(
            cmd_list,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            shell=use_shell,
            check=False,
        )
        for line in proc.stdout.splitlines():
            if line.strip():
                log_message(f"  | {line}")
        return proc.returncode, proc.stdout
    except Exception as e:
        log_message(f"  | ERROR executing command: {e}")
        return 1, str(e)

def main():
    log_message("==========================================================================")
    log_message("Starting Automated Post-Market Pipeline Execution")
    log_message("==========================================================================")

    # Step 1: Candidate Generation
    log_message("--- Step 1: Generating Liquidity Candidates ---")
    for sym in SYMBOLS:
        cmd = ["npx", "tsx", "apps/api/src/interfaces/cli/generate-liquidity-candidates.ts", f"--symbol={sym}", "--timeframe=5m"]
        code, _ = run_command(cmd)
        if code != 0:
            log_message(f"WARNING: Candidate generation returned exit code {code} for symbol {sym}")

    # Step 2: Contact Label Generation
    log_message("--- Step 2: Generating Contact & Breach Labels ---")
    label_cmd = ["npx", "tsx", "apps/api/src/interfaces/cli/generate-contact-labels.ts"]
    code, _ = run_command(label_cmd)
    if code != 0:
        log_message(f"WARNING: Contact label generation returned exit code {code}")

    # Step 3: OOS Holdout Evaluation
    log_message("--- Step 3: Running ORDERBOOK-01 OOS Evaluator ---")
    # Resolve python interpreter
    py_exec = sys.executable
    eval_cmd = [py_exec, "-u", "apps/ml/run_orderbook01_oos.py", "--eval-mode", "oos", "--start-oos", "2026-09-25"]
    code, _ = run_command(eval_cmd)
    if code != 0:
        log_message(f"WARNING: OOS evaluator returned exit code {code}")

    # Step 4: Summarize Verdict
    log_message("--- Step 4: Pipeline Execution Summary ---")
    if VERDICT_FILE.exists():
        try:
            with open(VERDICT_FILE, "r", encoding="utf-8") as f:
                vdata = json.load(f)
            log_message(f"Latest OOS Verdict: {vdata.get('verdict')}")
            log_message(f"Verdict Description: {vdata.get('verdict_description')}")
            h1r = vdata.get("h1_r", {})
            log_message(f"H1-R Status: {h1r.get('status')} | N={h1r.get('n')} | Acc={h1r.get('accuracy', 0)*100:.1f}%")
        except Exception as e:
            log_message(f"Could not parse verdict file: {e}")
    else:
        log_message("Verdict file orderbook01_verdict.json not found after run.")

    log_message("==========================================================================")
    log_message("Post-Market Pipeline Completed Successfully")
    log_message("==========================================================================")

if __name__ == "__main__":
    main()
