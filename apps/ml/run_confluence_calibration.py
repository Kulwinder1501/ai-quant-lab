"""CLI Runner for CONFLUENCE Exploratory Calibration Backtest.

Tests the intersection of:
1. STRUCTURE-01 Level Proximity (<= 15 bps)
2. VOLUME-01 RVOL Surge (Bin 5 or 6, RVOL >= 1.50)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
import numpy as np
import pandas as pd

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import argparse
from ai_quant_lab_ml.structure_intelligence import (
    fetch_candles,
    compute_daily_levels,
    compute_4h_levels_from_5m,
    StructuralLevel
)
from ai_quant_lab_ml.volume_intelligence import assign_rvol_bin

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")

def main() -> None:
    parser = argparse.ArgumentParser(description="CONFLUENCE Exploratory Calibration Backtest")
    parser.add_argument("--symbol", type=str, default="BANKNIFTY")
    parser.add_argument("--start-date", type=str, default="2026-01-01")
    parser.add_argument("--end-date", type=str, default="2026-06-30")
    args = parser.parse_args()

    s_date = date.fromisoformat(args.start_date)
    e_date = date.fromisoformat(args.end_date)

    print("================================================================================")
    print(f"   CONFLUENCE EXPLORATORY CALIBRATION BACKTEST ({args.symbol})")
    print(f"   Period: {s_date} to {e_date} (Calibration Only - OOS Blind)")
    print("================================================================================\n", flush=True)

    # 1. Fetch data
    warmup_start = datetime(2025, 11, 1, 0, 0, tzinfo=zoneinfo.ZoneInfo("UTC"))
    cal_end = datetime(e_date.year, e_date.month, e_date.day, 23, 59, 59, tzinfo=zoneinfo.ZoneInfo("UTC"))

    bars_5m = fetch_candles(args.symbol, timeframe="5m", start_dt=warmup_start, end_dt=cal_end)
    daily_candles = fetch_candles(args.symbol, timeframe="1d", start_dt=warmup_start, end_dt=cal_end)

    print(f"Loaded {len(bars_5m)} 5m candles and {len(daily_candles)} 1d candles.", flush=True)

    # 2. Compute Structure Levels
    daily_levels = compute_daily_levels(daily_candles)
    levels_4h = compute_4h_levels_from_5m(bars_5m)

    # 3. Process into DataFrame and compute RVOL
    records = []
    for idx, c in enumerate(bars_5m):
        ot = c["open_time"]
        if isinstance(ot, str):
            ot = datetime.fromisoformat(ot)
        if ot.tzinfo is None:
            ot = ot.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ot_ist = ot.astimezone(INDIA_TZ)
        day = ot_ist.date()
        minutes_since_open = (ot_ist.hour * 60 + ot_ist.minute) - (9 * 60 + 15)
        bucket_idx = (minutes_since_open // 5) + 1
        
        if 1 <= bucket_idx <= 75:
            records.append({
                "global_idx": idx,
                "trading_date": day,
                "bucket_idx": bucket_idx,
                "open_time": ot_ist,
                "open": float(c["open"]),
                "high": float(c["high"]),
                "low": float(c["low"]),
                "close": float(c["close"]),
                "volume": float(c["volume"]),
            })
            
    df = pd.DataFrame(records)
    sorted_dates = sorted(df["trading_date"].unique())
    daily_buckets: dict[date, dict[int, float]] = {}

    for d, group in df.groupby("trading_date"):
        daily_buckets[d] = dict(zip(group["bucket_idx"], group["volume"]))

    # Walk-forward RVOL
    rvol_list = []
    rvol_bin_list = []
    for _, row in df.iterrows():
        d = row["trading_date"]
        b_idx = int(row["bucket_idx"])
        d_idx = sorted_dates.index(d)

        if d_idx < 20:
            rvol_list.append(np.nan)
            rvol_bin_list.append(np.nan)
        else:
            past_20_dates = sorted_dates[d_idx - 20 : d_idx]
            past_vols = [
                daily_buckets[p_date][b_idx]
                for p_date in past_20_dates
                if b_idx in daily_buckets[p_date]
            ]
            if len(past_vols) >= 10:
                expected_vol = float(np.median(past_vols))
                if expected_vol > 0:
                    rvol = row["volume"] / expected_vol
                    rvol_list.append(rvol)
                    rvol_bin_list.append(assign_rvol_bin(rvol))
                else:
                    rvol_list.append(np.nan)
                    rvol_bin_list.append(np.nan)
            else:
                rvol_list.append(np.nan)
                rvol_bin_list.append(np.nan)

    df["rvol"] = rvol_list
    df["rvol_bin"] = rvol_bin_list

    # Filter to Calibration period
    df_cal = df[(df["trading_date"] >= s_date) & (df["trading_date"] <= e_date)].copy()
    
    # 4. Find Proximity and Confluence Events
    proximity_bandwidth_bps = 15.0
    forward_window_bars = 3
    
    confluence_events = []
    structure_only_events = []
    volume_only_events = []
    control_events = []

    confluence_rejections = 0
    confluence_sweeps = 0
    reaction_threshold_bps = 10.0

    for s_date_iter in df_cal["trading_date"].unique():
        d_lvl = daily_levels.get(s_date_iter, {})
        h_lvl = levels_4h.get(s_date_iter, {})

        active_levels: list[StructuralLevel] = []
        if d_lvl or h_lvl:
            pdh = d_lvl.get("PDH")
            p4hh = h_lvl.get("P4HH")
            pdl = d_lvl.get("PDL")
            p4hl = h_lvl.get("P4HL")

            if pdh and p4hh and abs(pdh - p4hh) / min(pdh, p4hh) <= 0.0005:
                active_levels.append(StructuralLevel("CONFLUENCE_HIGH", (pdh + p4hh) / 2.0, s_date_iter, "1d+4h"))
            else:
                if pdh: active_levels.append(StructuralLevel("PDH", pdh, s_date_iter, "1d"))
                if p4hh: active_levels.append(StructuralLevel("P4HH", p4hh, s_date_iter, "4h"))

            if pdl and p4hl and abs(pdl - p4hl) / min(pdl, p4hl) <= 0.0005:
                active_levels.append(StructuralLevel("CONFLUENCE_LOW", (pdl + p4hl) / 2.0, s_date_iter, "1d+4h"))
            else:
                if pdl: active_levels.append(StructuralLevel("PDL", pdl, s_date_iter, "1d"))
                if p4hl: active_levels.append(StructuralLevel("P4HL", p4hl, s_date_iter, "4h"))

        triggered_levels_this_session: set[str] = set()
        
        s_bars = df_cal[df_cal["trading_date"] == s_date_iter]
        for _, row in s_bars.iterrows():
            g_idx = int(row["global_idx"])
            b_high = row["high"]
            b_low = row["low"]
            b_close = row["close"]
            rvol_bin = row["rvol_bin"]
            
            fwd_idx = g_idx + forward_window_bars
            fwd_return_bps = None
            if fwd_idx < len(bars_5m):
                fwd_close = float(bars_5m[fwd_idx]["close"])
                fwd_return_bps = ((fwd_close - b_close) / b_close) * 10000.0

            if fwd_return_bps is None:
                continue
                
            abs_ret = abs(fwd_return_bps)
            
            is_structure_prox = False
            triggered_level_type = None
            for lvl in active_levels:
                if lvl.level_type in triggered_levels_this_session:
                    continue
                if b_low <= lvl.price <= b_high:
                    dist_bps = 0.0
                else:
                    dist_bps = (min(abs(b_high - lvl.price), abs(b_low - lvl.price), abs(b_close - lvl.price)) / lvl.price) * 10000.0
                if dist_bps <= proximity_bandwidth_bps:
                    triggered_levels_this_session.add(lvl.level_type)
                    is_structure_prox = True
                    triggered_level_type = lvl.level_type
                    break
                    
            is_volume_surge = rvol_bin in [5, 6]
            
            if is_structure_prox and is_volume_surge:
                confluence_events.append(abs_ret)
                if triggered_level_type:
                    is_high = "HIGH" in triggered_level_type or triggered_level_type in ("PDH", "P4HH")
                    is_low = "LOW" in triggered_level_type or triggered_level_type in ("PDL", "P4HL")
                    if is_high:
                        if fwd_return_bps <= -reaction_threshold_bps:
                            confluence_rejections += 1
                        elif fwd_return_bps >= reaction_threshold_bps:
                            confluence_sweeps += 1
                    elif is_low:
                        if fwd_return_bps >= reaction_threshold_bps:
                            confluence_rejections += 1
                        elif fwd_return_bps <= -reaction_threshold_bps:
                            confluence_sweeps += 1
            elif is_structure_prox:
                structure_only_events.append(abs_ret)
            elif is_volume_surge:
                volume_only_events.append(abs_ret)
            else:
                control_events.append(abs_ret)

    # 5. Output Results
    print("--- Event Frequency & Volatility Returns ---", flush=True)
    header = f"{'Condition':<25} | {'Events':<8} | {'Ev/Sess':<8} | {'Median Ret (bps)':<16} | {'Ratio vs Control':<16}"
    print(header, flush=True)
    print("-" * len(header), flush=True)
    
    total_sessions = len(df_cal["trading_date"].unique())
    
    def print_row(name: str, events: list[float], control_med: float):
        count = len(events)
        ev_sess = count / max(1, total_sessions)
        med_ret = float(np.median(events)) if count > 0 else 0.0
        ratio = med_ret / control_med if control_med > 0 else 1.0
        print(f"{name:<25} | {count:<8} | {ev_sess:<8.2f} | {med_ret:<16.2f} | {ratio:<16.2f}x", flush=True)
        
    ctrl_med = float(np.median(control_events)) if control_events else 0.0
    
    print_row("Control (No Proximity, No Surge)", control_events, ctrl_med)
    print_row("Volume Only (Bin 5/6)", volume_only_events, ctrl_med)
    print_row("Structure Only (<=15bps)", structure_only_events, ctrl_med)
    print_row("CONFLUENCE (Both)", confluence_events, ctrl_med)
    
    print("\n--- Directional Bias of Confluence Events ---", flush=True)
    confluence_total = len(confluence_events)
    if confluence_total > 0:
        rej_pct = (confluence_rejections / confluence_total) * 100.0
        sweep_pct = (confluence_sweeps / confluence_total) * 100.0
        neutral_pct = 100.0 - rej_pct - sweep_pct
        print(f"Total Confluence Events: {confluence_total}", flush=True)
        print(f"Rejections: {confluence_rejections} ({rej_pct:.1f}%)", flush=True)
        print(f"Sweeps:     {confluence_sweeps} ({sweep_pct:.1f}%)", flush=True)
        print(f"Neutral:    {confluence_total - confluence_rejections - confluence_sweeps} ({neutral_pct:.1f}%)", flush=True)
        
        from scipy import stats
        n_directional = confluence_rejections + confluence_sweeps
        if n_directional >= 10:
            p_val = stats.binomtest(confluence_rejections, n_directional, 0.5).pvalue
            print(f"Binomial p-value (Rejections vs Sweeps): {p_val:.4f}", flush=True)
        else:
            print("Not enough directional events for statistical significance test (<10).", flush=True)

    print("\n================================================================================")
    print("   CONFLUENCE CALIBRATION COMPLETE")
    print("================================================================================\n", flush=True)

if __name__ == "__main__":
    main()
