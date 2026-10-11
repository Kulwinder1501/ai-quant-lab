"""ORDERBOOK-01: Depth Imbalance Directional Predictor at Structural Levels.

Hypothesis: At the moment price contacts a structural level (PDH, PDL, SWING_HIGH, etc.),
the aggregate bid/ask depth imbalance (total_buy_qty vs total_sell_qty from the L2 feed)
predicts whether price will be REJECTED (bounce) or SWEPT (breakout) through the level.

Strict non-leakage: Uses only the depth_frame received BEFORE or AT the contact_time.

AUDIT FIX NOTE (2026-10-10, docs/2026-10-10-orderbook-liquidity-audit-fixes.md): earlier runs of this
script (and any verdict quoted from them) came from defective code: DI was aligned with OPPOSITE signs
for up/down levels (contradicting the frozen di_tilde = -DI convention used by run_orderbook01_oos.py
and the live gate), the nearest-frame lookup accepted frames AFTER the contact (abs() gap), depth came
from every provider_symbol, missing totals crashed/was zero, raw DI is a per-day constant, labels were
the look-ahead v1-legacy ones, and the stored is_regression filter silently dropped whole sessions.
Now: one population (symbol/timeframe/active/labeling_version), front-month futures depth only,
recomputed sequence flags, causal within-day detrended DI, past-only matching, one event per level-day,
and aligned_di = -DI_detrended for EVERY level (positive => predicts REJECTION).

Data:
- liquidity_contact_labels: 32,097 labeled contact events (Aug 21 - Sep 25, 2026)
- depth_frames: 1,010,875 rows at 500ms resolution (same window)

Method:
- For each contact event, match the latest depth_frame received_at <= contact_time (at most 5s old; PAST-ONLY)
- Compute DI = (total_buy_qty - total_sell_qty) / (total_buy_qty + total_sell_qty), then subtract the
  trailing mean of the previous 30 complete minutes (causal; min 10) -- orderbook_di.causal_detrend_di
- For ALL levels (up and down alike): di_tilde = -DI_detrended; di_tilde > 0 predicts REJECTION
- Tests: Binomial test per pool_type, overall classification accuracy, logistic regression
"""

from __future__ import annotations

import sys
import os
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
from bisect import bisect_right

import numpy as np
from scipy import stats

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string
from ai_quant_lab_ml.orderbook_di import (
    DEFAULT_SYMBOL,
    DEFAULT_TIMEFRAME,
    LABELING_VERSION_CAUSAL,
    TIER1_HORIZON_SECONDS,
    causal_detrend_di,
    collapse_to_level_days,
    fetch_front_month_depth_rows,
    latest_value_at_or_before,
    raw_depth_imbalance,
)

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")

UP_LEVEL_TYPES = {"PDH", "SWING_HIGH", "SESSION_HIGH", "ITH"}
DOWN_LEVEL_TYPES = {"PDL", "SWING_LOW", "SESSION_LOW", "ITL"}


def fetch_contact_events(
    conn: psycopg.Connection,
    start: datetime,
    end: datetime,
    symbol: str = DEFAULT_SYMBOL,
    timeframe: str = DEFAULT_TIMEFRAME,
    labeling_version: str = LABELING_VERSION_CAUSAL,
    horizon_seconds: int = TIER1_HORIZON_SECONDS,
) -> list[dict]:
    """Contact events for ONE population (one symbol, one timeframe, one horizon, active candidates,
    one labeling_version). Pooling horizons/timeframes/legacy labels repeats the same contact."""
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
                lpc.timeframe,
                lpc.symbol
            FROM liquidity_contact_labels lcl
            JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
            WHERE lcl.contact_time >= %s
              AND lcl.contact_time <= %s
              AND lcl.contacted = TRUE
              AND lcl.is_active_candidate = TRUE
              AND lcl.breached IS NOT NULL
              AND lcl.labeling_version = %s
              AND lcl.horizon_seconds = %s
              AND lpc.symbol = %s
              AND lpc.timeframe = %s
            ORDER BY lcl.contact_time ASC
        """, (start, end, labeling_version, horizon_seconds, symbol, timeframe))
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_depth_frames_for_day(
    conn: psycopg.Connection, day: date
) -> list[tuple[datetime, float | None, float | None]]:
    """(received_at, total_buy_qty, total_sell_qty) for one IST trading day, FRONT-MONTH future only.

    Missing totals stay None. Duplicates / sequence resets are dropped using flags recomputed from
    sequence_no -- NOT the stored is_regression, which flags every frame after a reset."""
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=INDIA_TZ)
    day_end = day_start + timedelta(days=1)
    rows = fetch_front_month_depth_rows(conn, day_start, day_end, day.isoformat())
    return [(r["received_at"], r["total_buy_qty"], r["total_sell_qty"]) for r in rows]


def find_nearest_depth_frame(
    frames: list[tuple[datetime, float | None, float | None]],
    contact_time: datetime,
    max_gap_seconds: float = 5.0,
) -> tuple[float, float] | None:
    """Latest depth frame with received_at <= contact_time, at most max_gap_seconds old (PAST-ONLY).

    A frame AFTER contact_time is never returned even if it is nearer (the previous implementation
    used abs(gap) and could read the book up to 5s into the future). Frames with a missing total are
    skipped, not zero-filled. Returns (total_buy_qty, total_sell_qty) or None."""
    if not frames:
        return None
    times = [f[0] for f in frames]
    idx = bisect_right(times, contact_time) - 1
    while idx >= 0:
        if (contact_time - times[idx]).total_seconds() > max_gap_seconds:
            return None
        buy, sell = frames[idx][1], frames[idx][2]
        if buy is not None and sell is not None:
            return buy, sell
        idx -= 1
    return None


def compute_di(buy_qty: float | None, sell_qty: float | None) -> float | None:
    """Normalized depth imbalance (buy - sell) / (buy + sell); None if missing / zero total."""
    return raw_depth_imbalance(buy_qty, sell_qty)


def aligned_di_for(detrended_di: float) -> float:
    """di_tilde = -DI_detrended for EVERY level (ORDERBOOK-01 convention; positive predicts REJECTION)."""
    return -detrended_di


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
            frame_times = [f[0] for f in frames]
            frame_raw_dis = [compute_di(f[1], f[2]) for f in frames]
            frame_detrended = causal_detrend_di(frame_times, frame_raw_dis)
            matched_day_events = []
            for ev in day_events:
                ct = ev["contact_time"]
                if ct.tzinfo is None:
                    ct = ct.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
                hit = latest_value_at_or_before(frame_times, frame_detrended, ct, max_gap_seconds=5.0)
                if hit is None:
                    continue  # UNAVAILABLE (no past frame / insufficient history) -- never DI = 0
                matched_day_events.append({**ev, "contact_time": ct, "level_price": float(ev["level_price"]), "_di": hit[0]})

            # One event per level-day: repeat contacts of a level on one day are not independent.
            for ev in collapse_to_level_days(matched_day_events):
                di = ev["_di"]
                pool_type = ev["pool_type"]
                is_up_level = pool_type in UP_LEVEL_TYPES
                is_down_level = pool_type in DOWN_LEVEL_TYPES

                # ORDERBOOK-01 convention, uniform across levels: positive aligned_di predicts REJECTION.
                aligned_di = aligned_di_for(di)

                results.append({
                    "pool_type": pool_type,
                    "side": ev["side"],
                    "breached": ev["breached"],
                    "di": di,
                    "aligned_di": aligned_di,
                    "detrended_di": di,
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
