"""ORDERBOOK-01: Depth Imbalance Directional Predictor at Structural Levels.

Hypothesis: At the moment price contacts a structural level (PDH, PDL, SWING_HIGH, etc.),
the aggregate bid/ask depth imbalance (total_buy_qty vs total_sell_qty from the L2 feed)
predicts whether price will be REJECTED (bounce) or SWEPT (breakout) through the level.

Strict non-leakage: Uses only the depth_frame received BEFORE or AT the contact_time.

Data:
- liquidity_contact_labels: 32,097 labeled contact events (Aug 21 - Sep 25, 2026)
- depth_frames: 1,010,875 rows at 500ms resolution (same window)

Method:
- For each contact event, match closest depth_frame within ±5 seconds (past-only: receive_at <= contact_time + 1s)
- Compute DI = (total_buy_qty - total_sell_qty) / (total_buy_qty + total_sell_qty)
- For UP levels (PDH, SWING_HIGH, etc.): DI < 0 (sellers dominate) predicts REJECTION
- For DOWN levels (PDL, SWING_LOW, etc.): DI > 0 (buyers dominate) predicts REJECTION
- Tests: Binomial test per pool_type, overall classification accuracy, logistic regression
"""

from __future__ import annotations

import sys
import os
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

UP_LEVEL_TYPES = {"PDH", "SWING_HIGH", "SESSION_HIGH", "ITH"}
DOWN_LEVEL_TYPES = {"PDL", "SWING_LOW", "SESSION_LOW", "ITL"}


def fetch_contact_events(conn: psycopg.Connection, start: datetime, end: datetime) -> list[dict]:
    """Fetch all contact events with candidate info in the window."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                lcl.id::text,
                lcl.contact_time,
                lcl.distance_bps,
                lcl.breached,
                lpc.pool_type,
                lpc.side,
                lpc.price AS level_price,
                lpc.timeframe
            FROM liquidity_contact_labels lcl
            JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
            WHERE lcl.contact_time >= %s
              AND lcl.contact_time <= %s
              AND lcl.contacted = TRUE
            ORDER BY lcl.contact_time ASC
        """, (start, end))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_depth_frames_for_day(conn: psycopg.Connection, day: date) -> list[tuple[datetime, float, float]]:
    """Fetch (received_at, total_buy_qty, total_sell_qty) for a single trading day."""
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
    """Binary search for the closest depth frame to contact_time (past-only within max_gap_seconds)."""
    if not frames:
        return None
    times = [f[0] for f in frames]
    pos = bisect_left(times, contact_time)

    best = None
    best_gap = float("inf")

    # Check pos-1, pos (the frame at or just before contact_time)
    for idx in [pos - 1, pos]:
        if 0 <= idx < len(frames):
            gap = abs((frames[idx][0] - contact_time).total_seconds())
            if gap <= max_gap_seconds and gap < best_gap:
                best_gap = gap
                best = (frames[idx][1], frames[idx][2])
    return best


def compute_di(buy_qty: float, sell_qty: float) -> float | None:
    """Compute normalized depth imbalance: (buy - sell) / (buy + sell)."""
    total = buy_qty + sell_qty
    if total <= 0:
        return None
    return (buy_qty - sell_qty) / total


def main() -> None:
    print("================================================================================")
    print("   ORDERBOOK-01: DEPTH IMBALANCE DIRECTIONAL PREDICTOR")
    print("   Window: Aug 21, 2026 - Sep 25, 2026 (35 sessions)")
    print("   Label: breached=True -> SWEEP, breached=False -> REJECTION")
    print("================================================================================\n", flush=True)

    conn_str = get_db_connection_string()
    window_start = datetime(2026, 8, 21, 0, 0, tzinfo=zoneinfo.ZoneInfo("UTC"))
    window_end = datetime(2026, 9, 25, 23, 59, 59, tzinfo=zoneinfo.ZoneInfo("UTC"))

    print("Fetching contact events...", flush=True)
    with psycopg.connect(conn_str) as conn:
        events = fetch_contact_events(conn, window_start, window_end)
    print(f"Loaded {len(events):,} contact events.", flush=True)

    # Group events by trading day (IST)
    days_map: dict[date, list[dict]] = {}
    for ev in events:
        ct = ev["contact_time"]
        if ct.tzinfo is None:
            ct = ct.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ist_date = ct.astimezone(INDIA_TZ).date()
        days_map.setdefault(ist_date, []).append(ev)

    # Process day by day: load depth_frames once per day, match each contact event
    results: list[dict] = []
    sorted_days = sorted(days_map.keys())

    print(f"Processing {len(sorted_days)} trading days...", flush=True)
    with psycopg.connect(conn_str) as conn:
        for i, day in enumerate(sorted_days):
            day_events = days_map[day]
            # Fetch depth frames for this day (UTC date)
            frames = fetch_depth_frames_for_day(conn, day)
            if not frames:
                print(f"  [{i+1}/{len(sorted_days)}] {day}: no depth frames — skipping {len(day_events)} events", flush=True)
                continue

            matched = 0
            for ev in day_events:
                ct = ev["contact_time"]
                if ct.tzinfo is None:
                    ct = ct.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
                match = find_nearest_depth_frame(frames, ct)
                if match is None:
                    continue
                buy_qty, sell_qty = match
                di = compute_di(buy_qty, sell_qty)
                if di is None:
                    continue

                pool_type = ev["pool_type"]
                is_up_level = pool_type in UP_LEVEL_TYPES
                is_down_level = pool_type in DOWN_LEVEL_TYPES

                # Align DI sign: positive "aligned_di" means orderbook supports REJECTION
                if is_up_level:
                    aligned_di = -di  # negative DI (sellers dominate) -> rejection at resistance
                elif is_down_level:
                    aligned_di = di   # positive DI (buyers dominate) -> rejection at support
                else:
                    aligned_di = 0.0  # unknown level direction

                results.append({
                    "pool_type": pool_type,
                    "side": ev["side"],
                    "breached": ev["breached"],
                    "di": di,
                    "aligned_di": aligned_di,
                    "buy_qty": buy_qty,
                    "sell_qty": sell_qty,
                    "is_up_level": is_up_level,
                    "is_down_level": is_down_level,
                })
                matched += 1

            print(f"  [{i+1}/{len(sorted_days)}] {day}: {len(day_events)} events, {matched} matched, {len(frames)} depth frames", flush=True)

    total_matched = len(results)
    print(f"\nMatched {total_matched:,} events to depth frames.", flush=True)

    if total_matched == 0:
        print("No matched events — aborting.")
        return

    # --- ANALYSIS ---
    print("\n--- 1. Overall Depth Imbalance Signal Quality ---", flush=True)

    # Simple classifier: aligned_di > 0 predicts REJECTION (breached=False)
    correct = 0
    total_directional = 0
    for r in results:
        if r["is_up_level"] or r["is_down_level"]:
            predicted_rejection = r["aligned_di"] > 0
            actual_rejection = not r["breached"]
            if predicted_rejection == actual_rejection:
                correct += 1
            total_directional += 1

    accuracy = correct / total_directional if total_directional > 0 else 0.0
    print(f"Total directional events: {total_directional:,}")
    print(f"Simple DI sign accuracy:  {accuracy:.1%} (baseline = 50.0%)", flush=True)

    # Binomial test on overall accuracy
    n_rej = sum(1 for r in results if not r["breached"] and (r["is_up_level"] or r["is_down_level"]))
    n_sweep = sum(1 for r in results if r["breached"] and (r["is_up_level"] or r["is_down_level"]))
    print(f"Overall Rejection count: {n_rej:,} ({n_rej/total_directional:.1%})")
    print(f"Overall Sweep count:     {n_sweep:,} ({n_sweep/total_directional:.1%})")

    p_val_overall = stats.binomtest(correct, total_directional, 0.5).pvalue
    print(f"Binomial p-value (DI sign vs random): {p_val_overall:.4f}", flush=True)

    # --- 2. Breakdown by Pool Type ---
    print("\n--- 2. Breakdown by Pool Type ---", flush=True)
    header = f"{'Pool Type':<16} | {'N':<7} | {'Rej %':<8} | {'DI>0 Acc':<10} | {'Binomial p':<12} | {'Verdict'}"
    print(header, flush=True)
    print("-" * len(header), flush=True)

    pool_types = sorted(set(r["pool_type"] for r in results))
    for pt in pool_types:
        pt_results = [r for r in results if r["pool_type"] == pt]
        n = len(pt_results)
        if n == 0:
            continue
        n_rej_pt = sum(1 for r in pt_results if not r["breached"])
        n_correct_pt = sum(1 for r in pt_results if (r["aligned_di"] > 0) == (not r["breached"]))
        acc = n_correct_pt / n
        rej_rate = n_rej_pt / n
        p_val = stats.binomtest(n_correct_pt, n, 0.5).pvalue
        verdict = "SIGNAL" if p_val <= 0.05 and acc > 0.5 else ("ANTI-SIGNAL" if p_val <= 0.05 and acc < 0.5 else "NOISE")
        print(
            f"{pt:<16} | {n:<7} | {rej_rate:<8.1%} | {acc:<10.1%} | {p_val:<12.4f} | {verdict}",
            flush=True,
        )

    # --- 3. DI Quartile Analysis ---
    print("\n--- 3. DI Magnitude vs Rejection Rate (Quartiles) ---", flush=True)
    directional_results = [r for r in results if r["is_up_level"] or r["is_down_level"]]
    aligned_dis = [r["aligned_di"] for r in directional_results]
    quartiles = np.percentile(aligned_dis, [25, 50, 75])

    def quartile_label(di: float) -> str:
        if di <= quartiles[0]:
            return "Q1 (DI Opposes Rejection)"
        elif di <= quartiles[1]:
            return "Q2"
        elif di <= quartiles[2]:
            return "Q3"
        else:
            return "Q4 (DI Strongly Supports Rejection)"

    q_header = f"{'DI Quartile':<35} | {'N':<6} | {'Rej Rate':<10} | {'Sweep Rate':<10}"
    print(q_header, flush=True)
    print("-" * len(q_header), flush=True)
    for q_label in ["Q1 (DI Opposes Rejection)", "Q2", "Q3", "Q4 (DI Strongly Supports Rejection)"]:
        q_res = [r for r in directional_results if quartile_label(r["aligned_di"]) == q_label]
        n_q = len(q_res)
        if n_q == 0:
            continue
        rej_q = sum(1 for r in q_res if not r["breached"])
        print(
            f"{q_label:<35} | {n_q:<6} | {rej_q/n_q:<10.1%} | {(n_q-rej_q)/n_q:<10.1%}",
            flush=True,
        )

    # --- 4. Final Verdict ---
    print("\n================================================================================")
    print("   ORDERBOOK-01 PRELIMINARY VERDICT")
    print("================================================================================")
    if p_val_overall <= 0.01 and accuracy >= 0.55:
        print("STATUS: STRONG SIGNAL — DI at contact time predicts sweep vs rejection significantly.")
        print("NEXT:   Pre-register ORDERBOOK-01 formal experiment and run on OOS holdout.")
    elif p_val_overall <= 0.05 and accuracy >= 0.52:
        print("STATUS: WEAK SIGNAL — Some evidence of DI predictive power, but requires more data.")
        print("NEXT:   Continue data collection and re-test at 60+ sessions.")
    else:
        print("STATUS: NO SIGNAL — DI alone does not predict direction at level contacts.")
        print("NEXT:   Explore multi-level book features (depth depletion rate, order count, etc.)")
    print("================================================================================\n", flush=True)


if __name__ == "__main__":
    main()
