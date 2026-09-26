"""Re-run ORDERBOOK-01 calibration using L1-3 DI instead of total_buy/total_sell.

Compares two features:
- total_DI = (total_buy_qty - total_sell_qty) / total
- l1_3_DI  = (sum(bid_qty[1:3]) - sum(ask_qty[1:3])) / sum  [immediately tradeable book]

Also splits analysis into Tier 1 (Reversal) and Tier 2 (Momentum) level types.
"""

from __future__ import annotations
import sys, os
from pathlib import Path
from datetime import date, datetime, timedelta
from bisect import bisect_left
import zoneinfo
import numpy as np
from scipy import stats

REPO_ROOT = Path(r"c:\Users\Kulwinder Singh\Desktop\personal\AI Quant Lab")
sys.path.insert(0, str(REPO_ROOT / "apps/ml"))

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
REVERSAL_TYPES  = {"SWING_HIGH", "SWING_LOW", "ITH", "ITL", "SESSION_HIGH", "SESSION_LOW"}
MOMENTUM_TYPES  = {"PDH", "PDL"}
UP_SIDES   = {"UP"}
DOWN_SIDES = {"DOWN"}


def fetch_contact_events(conn, start, end):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT lcl.contact_time, lcl.breached,
                   lpc.pool_type, lpc.side
            FROM liquidity_contact_labels lcl
            JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
            WHERE lcl.contact_time >= %s AND lcl.contact_time <= %s
              AND lcl.contacted = TRUE AND lcl.horizon_seconds = 30
            ORDER BY lcl.contact_time ASC
        """, (start, end))
        return [{"contact_time": r[0], "breached": r[1], "pool_type": r[2], "side": r[3]}
                for r in cur.fetchall()]


def fetch_day_frames(conn, day: date):
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=zoneinfo.ZoneInfo("UTC"))
    day_end = day_start + timedelta(days=1)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT received_at, total_buy_qty, total_sell_qty,
                   bid_qty, ask_qty
            FROM depth_frames
            WHERE received_at >= %s AND received_at < %s
              AND is_duplicate = FALSE AND is_regression = FALSE
            ORDER BY received_at ASC
        """, (day_start, day_end))
        rows = cur.fetchall()
    frames = []
    for r in rows:
        buy_qty  = float(r[1]) if r[1] else 0.0
        sell_qty = float(r[2]) if r[2] else 0.0
        bid_arr = r[3] or []
        ask_arr = r[4] or []
        l1_3_buy  = sum(float(x) for x in bid_arr[:3] if x is not None)
        l1_3_sell = sum(float(x) for x in ask_arr[:3] if x is not None)
        frames.append((r[0], buy_qty, sell_qty, l1_3_buy, l1_3_sell))
    return frames


def find_nearest(frames, ct, max_gap=5.0):
    if not frames:
        return None
    times = [f[0] for f in frames]
    pos = bisect_left(times, ct)
    best, best_gap = None, float("inf")
    for idx in [pos - 1, pos]:
        if 0 <= idx < len(frames):
            gap = abs((frames[idx][0] - ct).total_seconds())
            if gap <= max_gap and gap < best_gap:
                best_gap = gap
                best = frames[idx][1:]
    return best


def compute_dis(buy, sell, l1_3_buy, l1_3_sell):
    total_di = (buy - sell) / (buy + sell) if (buy + sell) > 0 else None
    l1_3_di  = (l1_3_buy - l1_3_sell) / (l1_3_buy + l1_3_sell) if (l1_3_buy + l1_3_sell) > 0 else None
    return total_di, l1_3_di


def aligned(di_val, side, tier):
    """
    Tier 1 (Reversal): UP side: aligned_di = -di (sell dominance at resistance -> rejection)
                        DOWN side: aligned_di = -di (sell dominance at support -> rejection; calibration confirmed same sign)
    Tier 2 (Momentum): UP (PDH): positive DI (buy pressure) -> sweep. aligned_di = di  
                        DOWN (PDL): negative DI (sell pressure) -> sweep. aligned_di = -di
    For simplicity use:
    - Tier 1: aligned = -di for ALL (sell dominance -> rejection)
    - Tier 2: PDH aligned = di (buy dominance -> sweep, i.e., NOT rejection)
              PDL aligned = -di (sell dominance -> sweep)
    For Tier 2 we predict SWEEP (not rejection) so aligned_di > 0 -> predict sweep -> correct if breached=True
    """
    if tier == "reversal":
        return -di_val  # positive = sell dominates = predicts rejection
    else:  # momentum
        if side == "UP":   # PDH
            return di_val   # positive = buy dominates = predicts sweep (breach)
        else:              # PDL
            return -di_val  # positive = sell dominates = predicts sweep (breach)


def accuracy_for(results, tier):
    correct = 0
    total = 0
    for r in results:
        adi_total = r["aligned_total"]
        adi_l1_3  = r["aligned_l1_3"]
        if adi_total is None or adi_l1_3 is None:
            continue
        total += 1
        if tier == "reversal":
            # predict rejection (not breached)
            pred_total = adi_total > 0
            pred_l1_3  = adi_l1_3 > 0
            actual = not r["breached"]
        else:
            # predict sweep (breached)
            pred_total = adi_total > 0
            pred_l1_3  = adi_l1_3 > 0
            actual = r["breached"]
        if pred_l1_3 == actual:
            correct += 1
    return correct, total


def main():
    print("=" * 72)
    print("   ORDERBOOK-01: FEATURE COMPARISON — total_DI vs L1-3_DI")
    print("=" * 72 + "\n", flush=True)

    conn_str = get_db_connection_string()
    window_start = datetime(2026, 8, 21, 0, 0, tzinfo=zoneinfo.ZoneInfo("UTC"))
    window_end   = datetime(2026, 9, 25, 23, 59, 59, tzinfo=zoneinfo.ZoneInfo("UTC"))

    print("Fetching contact events...", flush=True)
    with psycopg.connect(conn_str) as conn:
        events = fetch_contact_events(conn, window_start, window_end)
    print(f"Loaded {len(events):,} events.\n", flush=True)

    days_map: dict[date, list[dict]] = {}
    for ev in events:
        ct = ev["contact_time"]
        if ct.tzinfo is None:
            ct = ct.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ev["contact_time"] = ct
        d = ct.astimezone(INDIA_TZ).date()
        days_map.setdefault(d, []).append(ev)

    results: list[dict] = []
    with psycopg.connect(conn_str) as conn:
        for day in sorted(days_map.keys()):
            day_events = days_map[day]
            frames = fetch_day_frames(conn, day)
            if not frames:
                continue
            for ev in day_events:
                match = find_nearest(frames, ev["contact_time"])
                if not match:
                    continue
                buy, sell, l1_3_buy, l1_3_sell = match
                total_di, l1_3_di = compute_dis(buy, sell, l1_3_buy, l1_3_sell)
                if total_di is None and l1_3_di is None:
                    continue
                pt = ev["pool_type"]
                side = ev["side"]
                tier = "reversal" if pt in REVERSAL_TYPES else "momentum"
                results.append({
                    "pool_type": pt, "side": side, "tier": tier,
                    "breached": ev["breached"],
                    "total_di": total_di, "l1_3_di": l1_3_di,
                    "aligned_total": aligned(total_di, side, tier) if total_di is not None else None,
                    "aligned_l1_3":  aligned(l1_3_di, side, tier) if l1_3_di is not None else None,
                })
            print(f"  {day}: {len(day_events)} events", flush=True)

    print(f"\nMatched {len(results):,} events.\n", flush=True)

    # --- Overall comparison: total_DI vs L1-3_DI ---
    print("--- Feature Comparison: total_DI vs L1-3_DI (All Events) ---", flush=True)
    print(f"{'Feature':<12} {'Correct':>8} {'Total':>8} {'Accuracy':>10} {'p-value':>10}", flush=True)
    print("-" * 52, flush=True)
    for feat in ["total", "l1_3"]:
        correct = 0; total = 0
        for r in results:
            adi = r[f"aligned_{feat}"]
            if adi is None:
                continue
            total += 1
            if r["tier"] == "reversal":
                pred = adi > 0
                actual = not r["breached"]
            else:
                pred = adi > 0
                actual = r["breached"]
            if pred == actual:
                correct += 1
        acc = correct / total if total > 0 else 0.0
        p = stats.binomtest(correct, total, 0.5).pvalue if total > 0 else 1.0
        print(f"{feat:<12} {correct:>8,} {total:>8,} {acc:>10.1%} {p:>10.4f}", flush=True)

    # --- Tier 1: Reversal ---
    print("\n--- Tier 1: Reversal Levels (SWING/ITH/ITL/SESSION) ---", flush=True)
    print(f"{'Pool Type':<16} {'N':>7} {'Rej%':>7} | {'total_DI Acc':>12} | {'L1-3_DI Acc':>12} | {'Winner':>8}", flush=True)
    print("-" * 65, flush=True)
    pool_types_r = sorted(set(r["pool_type"] for r in results if r["tier"] == "reversal"))
    for pt in pool_types_r:
        pr = [r for r in results if r["pool_type"] == pt]
        n = len(pr)
        n_rej = sum(1 for r in pr if not r["breached"])
        # total_DI accuracy
        t_corr = sum(1 for r in pr if r["aligned_total"] is not None and (r["aligned_total"] > 0) == (not r["breached"]))
        t_n    = sum(1 for r in pr if r["aligned_total"] is not None)
        t_acc  = t_corr / t_n if t_n > 0 else 0
        # l1_3_DI accuracy
        l_corr = sum(1 for r in pr if r["aligned_l1_3"] is not None and (r["aligned_l1_3"] > 0) == (not r["breached"]))
        l_n    = sum(1 for r in pr if r["aligned_l1_3"] is not None)
        l_acc  = l_corr / l_n if l_n > 0 else 0
        winner = "L1-3" if l_acc > t_acc else "total"
        print(f"{pt:<16} {n:>7,} {n_rej/n:>7.1%} | {t_acc:>12.1%} | {l_acc:>12.1%} | {winner:>8}", flush=True)

    # --- Tier 2: Momentum ---
    print("\n--- Tier 2: Momentum Levels (PDH/PDL) ---", flush=True)
    print(f"{'Pool Type':<16} {'N':>7} {'Sweep%':>8} | {'total_DI Acc':>12} | {'L1-3_DI Acc':>12} | {'Winner':>8}", flush=True)
    print("-" * 65, flush=True)
    for pt in ["PDH", "PDL"]:
        pr = [r for r in results if r["pool_type"] == pt]
        if not pr:
            continue
        n = len(pr)
        n_sweep = sum(1 for r in pr if r["breached"])
        t_corr = sum(1 for r in pr if r["aligned_total"] is not None and (r["aligned_total"] > 0) == r["breached"])
        t_n    = sum(1 for r in pr if r["aligned_total"] is not None)
        t_acc  = t_corr / t_n if t_n > 0 else 0
        l_corr = sum(1 for r in pr if r["aligned_l1_3"] is not None and (r["aligned_l1_3"] > 0) == r["breached"])
        l_n    = sum(1 for r in pr if r["aligned_l1_3"] is not None)
        l_acc  = l_corr / l_n if l_n > 0 else 0
        winner = "L1-3" if l_acc > t_acc else "total"
        print(f"{pt:<16} {n:>7,} {n_sweep/n:>8.1%} | {t_acc:>12.1%} | {l_acc:>12.1%} | {winner:>8}", flush=True)

    print("\n" + "=" * 72)
    print("   FEATURE SELECTION COMPLETE")
    print("=" * 72 + "\n", flush=True)


if __name__ == "__main__":
    main()
