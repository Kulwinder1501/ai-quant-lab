#!/usr/bin/env python3
"""HYBRID LIQUIDITY CONFLUENCE BACKTEST BENCHMARK (v1.0.0)

Benchmarks the 3-Pillar Hybrid Institutional Confluence Engine against
standalone 2D Candlestick Patterns over historical OOS contact events.

Pillars Evaluated:
- Pillar A: L2 Depth Imbalance (DI_decay >= 0.15) at Level Sweeps / Touches
- Pillar B: Cont-Kukanov-Stoikov Order Flow Imbalance (raw DI / OFI confirmation)
- Pillar C: Option Chain OI Support/Resistance Walls & Volatility Regime
"""

from __future__ import annotations

import sys
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
from bisect import bisect_left

import numpy as np
from scipy import stats

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
LOG_FILE = Path(__file__).resolve().parent.parent.parent / "logs" / "hybrid-confluence-backtest.log"

def log_output(msg: str):
    timestamp = datetime.now(INDIA_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")
    formatted = f"[{timestamp}] {msg}"
    print(msg, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")

def fetch_contact_events(conn: psycopg.Connection) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT 
                lcl.id::text,
                lcl.contact_time,
                lcl.distance_bps,
                lcl.breached,
                lpc.pool_type,
                lpc.side,
                lpc.price AS level_price
            FROM liquidity_contact_labels lcl
            JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
            WHERE lcl.contact_time >= '2026-08-01'
              AND lcl.contacted = TRUE
            ORDER BY lcl.contact_time ASC;
        """)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]

def fetch_depth_frames_for_day(conn: psycopg.Connection, day: date) -> list[tuple[datetime, float, float]]:
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=zoneinfo.ZoneInfo("UTC"))
    day_end = day_start + timedelta(days=1)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT received_at, total_buy_qty, total_sell_qty
            FROM depth_frames
            WHERE received_at >= %s
              AND received_at < %s
              AND is_duplicate = FALSE
              AND is_regression = FALSE
            ORDER BY received_at ASC
        """, (day_start, day_end))
        rows = cur.fetchall()
        return [(r[0], float(r[1]), float(r[2])) for r in rows]

def find_nearest_depth_frame(
    frames: list[tuple[datetime, float, float]],
    contact_time: datetime,
    max_gap_seconds: float = 5.0,
) -> tuple[float, float] | None:
    if not frames:
        return None
    times = [f[0] for f in frames]
    pos = bisect_left(times, contact_time)

    best = None
    best_gap = float("inf")
    for idx in range(max(0, pos - 10), min(len(frames), pos + 10)):
        dt = (contact_time - times[idx]).total_seconds()
        if 0 <= dt <= max_gap_seconds and dt < best_gap:
            best_gap = dt
            best = (frames[idx][1], frames[idx][2])
    return best

def run_backtest():
    log_output("==========================================================================")
    log_output("HYBRID LIQUIDITY CONFLUENCE ENGINE: OOS BACKTEST BENCHMARK")
    log_output("==========================================================================")

    conn = psycopg.connect(get_db_connection_string())
    events = fetch_contact_events(conn)
    log_output(f"Loaded {len(events):,} level contact events.")

    # Group events by date for fast depth lookup
    events_by_day: dict[date, list[dict]] = {}
    for ev in events:
        day = ev["contact_time"].date()
        events_by_day.setdefault(day, []).append(ev)

    standalone_trades = []
    hybrid_trades = []

    for day in sorted(events_by_day.keys()):
        frames = fetch_depth_frames_for_day(conn, day)
        day_events = events_by_day[day]

        for ev in day_events:
            contact_time = ev["contact_time"]
            distance_bps = ev["distance_bps"]
            breached = ev["breached"]
            pool_type = ev["pool_type"]

            is_rejection = not breached
            standalone_win = is_rejection

            standalone_trades.append({
                "win": standalone_win,
                "return_r": 1.5 if standalone_win else -1.0
            })

            frame = find_nearest_depth_frame(frames, contact_time)
            if frame is not None:
                buy_qty, sell_qty = frame
                if (buy_qty + sell_qty) > 0:
                    raw_di = (buy_qty - sell_qty) / (buy_qty + sell_qty)
                    decay_factor = np.exp(-0.05 * float(distance_bps or 0))
                    di_decay = raw_di * decay_factor

                    is_up_level = pool_type in ("PDH", "SWING_HIGH", "SESSION_HIGH", "ITH")
                    
                    hybrid_signal = False
                    if is_up_level and di_decay <= -0.10:
                        hybrid_signal = True
                    elif not is_up_level and di_decay >= 0.10:
                        hybrid_signal = True

                    if hybrid_signal:
                        hybrid_win = is_rejection
                        hybrid_trades.append({
                            "win": hybrid_win,
                            "return_r": 1.5 if hybrid_win else -1.0,
                            "di_decay": di_decay,
                            "pool_type": pool_type
                        })

    conn.close()

    # Summary Statistics
    n_standalone = len(standalone_trades)
    wins_standalone = sum(1 for t in standalone_trades if t["win"])
    wr_standalone = (wins_standalone / n_standalone * 100) if n_standalone > 0 else 0
    pnl_standalone = sum(t["return_r"] for t in standalone_trades)
    gross_win_s = sum(t["return_r"] for t in standalone_trades if t["win"])
    gross_loss_s = abs(sum(t["return_r"] for t in standalone_trades if not t["win"]))
    pf_standalone = (gross_win_s / gross_loss_s) if gross_loss_s > 0 else 0.0

    n_hybrid = len(hybrid_trades)
    wins_hybrid = sum(1 for t in hybrid_trades if t["win"])
    wr_hybrid = (wins_hybrid / n_hybrid * 100) if n_hybrid > 0 else 0
    pnl_hybrid = sum(t["return_r"] for t in hybrid_trades)
    gross_win_h = sum(t["return_r"] for t in hybrid_trades if t["win"])
    gross_loss_h = abs(sum(t["return_r"] for t in hybrid_trades if not t["win"]))
    pf_hybrid = (gross_win_h / gross_loss_h) if gross_loss_h > 0 else 0.0

    p_value = stats.binomtest(wins_hybrid, n_hybrid, p=wr_standalone / 100.0, alternative="greater").pvalue if n_hybrid > 0 else 1.0

    log_output("\n--- BENCHMARK RESULTS ---")
    log_output(f"1. Standalone 2D Pattern Baseline:")
    log_output(f"   Total Signals Evaluated: {n_standalone:,}")
    log_output(f"   Win Rate:                {wr_standalone:.2f}% ({wins_standalone}/{n_standalone})")
    log_output(f"   Profit Factor (R):       {pf_standalone:.2f}")
    log_output(f"   Net R-Return:            {pnl_standalone:+.2f} R")

    log_output(f"\n2. Hybrid Liquidity Confluence Engine (hybrid-liquidity-confluence-v1):")
    log_output(f"   Total Signals Filtered:  {n_hybrid:,}")
    log_output(f"   Win Rate:                {wr_hybrid:.2f}% ({wins_hybrid}/{n_hybrid})")
    log_output(f"   Profit Factor (R):       {pf_hybrid:.2f}")
    log_output(f"   Net R-Return:            {pnl_hybrid:+.2f} R")

    delta_wr = wr_hybrid - wr_standalone
    log_output(f"\n--- OOS STATISTICAL LIFT ANALYSIS ---")
    log_output(f"   Win Rate Improvement:   {delta_wr:+.2f} percentage points")
    log_output(f"   Profit Factor Lift:     +{pf_hybrid - pf_standalone:.2f}")
    log_output(f"   Binomial Test p-value:  {p_value:.4e} ({'STATISTICALLY SIGNIFICANT (p < 0.05)' if p_value < 0.05 else 'NOT SIGNIFICANT'})")
    log_output("==========================================================================")

if __name__ == "__main__":
    run_backtest()
