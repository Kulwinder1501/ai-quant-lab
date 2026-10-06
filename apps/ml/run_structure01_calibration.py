"""CLI Runner for STRUCTURE-01 Exploratory Calibration Backtest.

RESTRICTED STRICTLY TO CALIBRATION DATA: Jan 01, 2026 to Jun 30, 2026.
Out-of-sample data (Jul 2026+) remains BLIND and untouched.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from datetime import date

# Ensure apps/ml is in sys.path
script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import argparse
from ai_quant_lab_ml.structure_intelligence import run_calibration_experiment

def main() -> None:
    parser = argparse.ArgumentParser(description="STRUCTURE-01 Exploratory Calibration Backtest")
    parser.add_argument("--symbol", type=str, default="BANKNIFTY", help="Instrument symbol (default: BANKNIFTY)")
    parser.add_argument("--start-date", type=str, default="2026-01-01", help="Calibration start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=str, default="2026-06-30", help="Calibration end date (YYYY-MM-DD)")
    args = parser.parse_args()

    s_date = date.fromisoformat(args.start_date)
    e_date = date.fromisoformat(args.end_date)

    # Hard safety guard: enforce calibration period end limit
    max_allowed_end = date(2026, 6, 30)
    if e_date > max_allowed_end:
        print(f"[FATAL SAFETY VIOLATION] Calibration end date {e_date} exceeds frozen limit {max_allowed_end}.")
        print("Out-of-sample data (Jul 2026+) MUST remain strictly blind until spec pre-registration.")
        sys.exit(1)

    print("================================================================================")
    print(f"   STRUCTURE-01 EXPLORATORY CALIBRATION BACKTEST ({args.symbol})")
    print(f"   Period: {s_date} to {e_date} (Calibration Only - OOS Blind)")
    print("================================================================ algorithm\n", flush=True)

    # Grid search across proximity bandwidths
    proximity_grid = [5.0, 10.0, 15.0, 20.0, 25.0]
    reaction_threshold = 10.0  # bps

    print("--- 1. Proximity Bandwidth Sensitivity Grid (Reaction Threshold = 10 bps) ---", flush=True)
    header = f"{'Band (bps)':<12} | {'Events':<8} | {'Ev/Sess':<8} | {'Event Ret':<10} | {'Ctrl Ret':<10} | {'Ratio':<6} | {'Rej %':<8} | {'Sweep %':<8}"
    print(header, flush=True)
    print("-" * len(header), flush=True)

    summaries = []
    for band in proximity_grid:
        res = run_calibration_experiment(
            symbol=args.symbol,
            start_date=s_date,
            end_date=e_date,
            proximity_bandwidth_bps=band,
            reaction_threshold_bps=reaction_threshold,
        )
        summaries.append(res)
        print(
            f"{band:<12.1f} | {res.total_proximity_events:<8} | {res.events_per_session:<8.2f} | "
            f"{res.median_abs_return_15m_event_bps:<10.2f} | {res.median_abs_return_15m_control_bps:<10.2f} | "
            f"{res.return_ratio_event_vs_control:<6.2f} | {res.rejection_rate_pct:<8.1f} | {res.sweep_rate_pct:<8.1f}",
            flush=True,
        )

    print("\n--- 2. Detailed Level Breakdown for Baseline Proximity Band (15.0 bps) ---", flush=True)
    base_res = run_calibration_experiment(
        symbol=args.symbol,
        start_date=s_date,
        end_date=e_date,
        proximity_bandwidth_bps=15.0,
        reaction_threshold_bps=10.0,
    )

    lvl_header = f"{'Level Type':<18} | {'Events':<8} | {'Med Ret (bps)':<14} | {'Rej Rate %':<12} | {'Sweep Rate %':<12}"
    print(lvl_header, flush=True)
    print("-" * len(lvl_header), flush=True)
    for lt, info in base_res.by_level_type.items():
        print(
            f"{lt:<18} | {info['total_events']:<8} | {info['median_abs_return_15m_bps']:<14.2f} | "
            f"{info['rejection_rate_pct']:<12.1f} | {info['sweep_rate_pct']:<12.1f}",
            flush=True,
        )

    print("\n--- 3. Reaction Threshold Grid (Proximity Band = 15.0 bps) ---", flush=True)
    rxn_grid = [5.0, 10.0, 15.0, 20.0]
    rxn_header = f"{'Threshold (bps)':<16} | {'Rejections':<10} | {'Rej %':<8} | {'Sweeps':<8} | {'Sweep %':<8} | {'Neutral %':<10}"
    print(rxn_header, flush=True)
    print("-" * len(rxn_header), flush=True)
    for rxn_t in rxn_grid:
        res_t = run_calibration_experiment(
            symbol=args.symbol,
            start_date=s_date,
            end_date=e_date,
            proximity_bandwidth_bps=15.0,
            reaction_threshold_bps=rxn_t,
        )
        print(
            f"{rxn_t:<16.1f} | {res_t.rejection_count:<10} | {res_t.rejection_rate_pct:<8.1f} | "
            f"{res_t.sweep_count:<8} | {res_t.sweep_rate_pct:<8.1f} | {res_t.neutral_rate_pct:<10.1f}",
            flush=True,
        )

    print("\n================================================================================")
    print("   CALIBRATION COMPLETE - READY FOR SPEC FREEZE")
    print("================================================================================\n", flush=True)

if __name__ == "__main__":
    main()
