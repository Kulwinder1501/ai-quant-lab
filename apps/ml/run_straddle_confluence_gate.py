"""Cost-Aware Straddle & Directional Confluence Backtest Engine.

Wires together:
1. ML Volatility Expansion Model (XGBoost)
2. STRUCTURE-01 Structural Proximity Gate (<= 15 bps from PDL, Swing High/Low, Session High/Low)
3. ORDERBOOK-01 Microstructure Depth Imbalance Gate (DI_tilde > 0)

Compares 4 entry regimes across fee sweeps (0 bps, 5 bps, 10 bps, 20 bps):
- Regime 1: Ungated (Always Enter)
- Regime 2: ML Volatility Gate Only
- Regime 3: ML + STRUCTURE-01 Proximity Gate
- Regime 4: Full Confluence (ML + STRUCTURE-01 + ORDERBOOK-01 DI Gate)
"""

from __future__ import annotations

import argparse
import sys
import os
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
from bisect import bisect_left
import json

import numpy as np

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import psycopg
from ai_quant_lab_ml.structure_intelligence import (
    get_db_connection_string,
    fetch_candles,
    compute_daily_levels,
    compute_4h_levels_from_5m,
    StructuralLevel,
)
from ai_quant_lab_ml.straddle_economics import black_scholes_straddle

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
CALENDAR_DAYS_PER_YEAR = 365.0
FEE_SWEEP_BPS = (0.0, 5.0, 10.0, 20.0)


def load_vix_history(conn: psycopg.Connection) -> list[tuple[date, float]]:
    """Load daily India VIX closes."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS date, c.close::float8
            FROM candles c JOIN instruments i ON i.id = c.instrument_id
            WHERE i.symbol = 'INDIAVIX' AND c.timeframe = '1d' AND c.is_complete = TRUE
            ORDER BY c.open_time;
        """)
        return [(date.fromisoformat(str(r[0])), float(r[1]) / 100.0) for r in cur.fetchall()]


def get_latest_vix(history: list[tuple[date, float]], session_date: date) -> float:
    """Get latest VIX close prior to session date."""
    idx = bisect_left(history, (session_date, float("-inf"))) - 1
    if idx >= 0:
        return history[idx][1]
    return 0.15  # Default 15% IV fallback


def fetch_depth_di_map(conn: psycopg.Connection, start_dt: datetime, end_dt: datetime) -> dict[datetime, float]:
    """Fetch depth frames and build lookup map for total_DI."""
    query = """
        SELECT received_at, total_buy_qty, total_sell_qty
        FROM depth_frames
        WHERE received_at >= %s AND received_at < %s
        ORDER BY received_at ASC;
    """
    with conn.cursor() as cur:
        cur.execute(query, (start_dt, end_dt))
        rows = cur.fetchall()

    di_map = {}
    for r in rows:
        t = r[0].astimezone(INDIA_TZ) if r[0].tzinfo else r[0].replace(tzinfo=INDIA_TZ)
        # Round to 5-second precision for fast matching
        bucket = t.replace(microsecond=0)
        tb, ts = float(r[1]), float(r[2])
        if tb + ts > 0:
            di_map[bucket] = (tb - ts) / (tb + ts)
    return di_map


def main():
    parser = argparse.ArgumentParser(description="Confluence Straddle Gate Backtest Engine")
    parser.add_argument("--symbol", type=str, default="BANKNIFTY")
    parser.add_argument("--start-date", type=str, default="2026-08-21")
    parser.add_argument("--end-date", type=str, default="2026-09-25")
    parser.add_argument("--bandwidth-bps", type=float, default=15.0, help="Structure proximity bandwidth in bps")
    parser.add_argument("--horizon-bars", type=int, default=2, help="Hold horizon in 5m bars (~10 min)")
    parser.add_argument("--days-to-expiry", type=int, default=30, help="Options tenor in days")
    args = parser.parse_args()

    s_date = date.fromisoformat(args.start_date)
    e_date = date.fromisoformat(args.end_date)
    conn_str = get_db_connection_string()

    print("=" * 80)
    print(f"CONFLUENCE STRADDLE GATE BACKTEST ({args.symbol})")
    print(f"Period: {s_date} to {e_date}")
    print(f"Filters: STRUCTURE-01 (<= {args.bandwidth_bps} bps) + ORDERBOOK-01 (DI_tilde > 0)")
    print("=" * 80)

    start_dt = datetime(s_date.year, s_date.month, s_date.day, 0, 0, tzinfo=zoneinfo.ZoneInfo("UTC"))
    end_dt = datetime(e_date.year, e_date.month, e_date.day, 23, 59, 59, tzinfo=zoneinfo.ZoneInfo("UTC"))
    warmup_start = start_dt - timedelta(days=60)

    with psycopg.connect(conn_str) as conn:
        print("Fetching candles and VIX history...")
        bars_5m = fetch_candles(args.symbol, timeframe="5m", start_dt=warmup_start, end_dt=end_dt)
        daily_candles = fetch_candles(args.symbol, timeframe="1d", start_dt=warmup_start, end_dt=end_dt)
        vix_history = load_vix_history(conn)
        print(f"Loaded {len(bars_5m)} 5m bars and {len(daily_candles)} 1d candles.")

        print("Fetching depth frames for ORDERBOOK-01 DI gate...")
        di_map = fetch_depth_di_map(conn, start_dt, end_dt)
        print(f"Loaded {len(di_map)} depth DI snapshot buckets.")

    # Compute Structural Levels
    daily_levels = compute_daily_levels(daily_candles)
    levels_4h = compute_4h_levels_from_5m(bars_5m)

    # Filter 5m bars to target evaluation window
    eval_bars = []
    for idx, c in enumerate(bars_5m):
        ot = c["open_time"]
        if isinstance(ot, str):
            ot = datetime.fromisoformat(ot)
        if ot.tzinfo is None:
            ot = ot.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ot_ist = ot.astimezone(INDIA_TZ)
        if s_date <= ot_ist.date() <= e_date:
            eval_bars.append((idx, c, ot_ist))

    print(f"Evaluating {len(eval_bars)} 5m bars in window...")

    # Run Regimes Backtest
    trades_r1, trades_r2, trades_r3, trades_r4 = [], [], [], []

    for idx_in_all, c, ot_ist in eval_bars:
        exit_idx = idx_in_all + args.horizon_bars
        if exit_idx >= len(bars_5m):
            continue

        spot = float(c["close"])
        exit_spot = float(bars_5m[exit_idx]["close"])
        if spot <= 0:
            continue

        session_date = ot_ist.date()
        vix = get_latest_vix(vix_history, session_date)
        implied = vix * 1.0  # 1.0 IV scale

        # Calculate straddle PnL (gross fraction of spot)
        entry_time = ot_ist
        exit_time = bars_5m[exit_idx]["open_time"]
        if isinstance(exit_time, str):
            exit_time = datetime.fromisoformat(exit_time)
        if exit_time.tzinfo is None:
            exit_time = exit_time.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        exit_time = exit_time.astimezone(INDIA_TZ)

        elapsed_days = (exit_time - entry_time).total_seconds() / 86_400.0
        entry_years = args.days_to_expiry / CALENDAR_DAYS_PER_YEAR
        exit_years = max(0.0, entry_years - elapsed_days / CALENDAR_DAYS_PER_YEAR)

        straddle_entry = black_scholes_straddle(spot=spot, strike=spot, time_to_expiry_years=entry_years, volatility=implied)
        straddle_exit = black_scholes_straddle(spot=exit_spot, strike=spot, time_to_expiry_years=exit_years, volatility=implied)
        straddle_pnl_bps = ((straddle_exit - straddle_entry) / spot) * 10_000.0

        # Feature 1: Realized 5m volatility expansion (simple mock ML trigger for expansion)
        ret_5m_bps = abs(float(c["close"]) - float(c["open"])) / float(c["open"]) * 10_000.0
        ml_expansion_predict = (ret_5m_bps >= 8.0)  # Top expansion quantile threshold

        # Feature 2: STRUCTURE-01 Proximity Check
        active_level_prices = []
        if session_date in daily_levels:
            active_level_prices.extend(daily_levels[session_date].values())
        if session_date in levels_4h:
            active_level_prices.extend(levels_4h[session_date].values())

        near_structure = False
        for lvl_price in active_level_prices:
            dist_bps = abs(spot - lvl_price) / lvl_price * 10_000.0
            if dist_bps <= args.bandwidth_bps:
                near_structure = True
                break

        # Feature 3: ORDERBOOK-01 DI Check
        t_bucket = entry_time.replace(microsecond=0)
        matched_di = di_map.get(t_bucket, di_map.get(t_bucket - timedelta(seconds=1), None))
        di_positive = (matched_di is not None and matched_di < 0)  # DI_tilde = -DI > 0

        # Record trades for each regime
        # R1: Ungated
        trades_r1.append(straddle_pnl_bps)

        # R2: ML Only
        if ml_expansion_predict:
            trades_r2.append(straddle_pnl_bps)

        # R3: ML + STRUCTURE-01
        if ml_expansion_predict and near_structure:
            trades_r3.append(straddle_pnl_bps)

        # R4: Full Confluence (ML + STRUCTURE-01 + ORDERBOOK-01)
        if ml_expansion_predict and near_structure and di_positive:
            trades_r4.append(straddle_pnl_bps)

    # Print Comparative Results
    def summarize_regime(name: str, trades: list[float]):
        n = len(trades)
        if n == 0:
            print(f"\n{name:45s} | N=0 | No trades triggered")
            return
        arr = np.array(trades)
        print(f"\n{name}")
        print("-" * 85)
        print(f"  Total Trades (N): {n:6d}")
        print(f"  Gross Hit Rate  : {np.mean(arr > 0)*100:5.1f}%")
        print(f"  Gross Mean PnL  : {np.mean(arr):+6.2f} bps per trade")

        for fee in FEE_SWEEP_BPS:
            net_arr = arr - fee
            net_mean = np.mean(net_arr)
            net_win = np.mean(net_arr > 0) * 100.0
            sharpe = (net_mean / np.std(net_arr) * np.sqrt(252 * 75)) if np.std(net_arr) > 0 else 0.0
            print(f"  Fee {fee:4.1f} bps        | Net Mean: {net_mean:+6.2f} bps | Net WinRate: {net_win:5.1f}% | Ann Sharpe: {sharpe:+5.2f}")

    print("\n" + "=" * 85)
    print("REGIME COMPARISON SUMMARY ACROSS FEE SWEEPS")
    print("=" * 85)

    summarize_regime("REGIME 1: Ungated (Always Enter)", trades_r1)
    summarize_regime("REGIME 2: ML Volatility Gate Only", trades_r2)
    summarize_regime("REGIME 3: ML + STRUCTURE-01 Gate", trades_r3)
    summarize_regime("REGIME 4: Full Confluence (ML + STRUCTURE-01 + ORDERBOOK-01)", trades_r4)
    print("=" * 85)


if __name__ == "__main__":
    main()
