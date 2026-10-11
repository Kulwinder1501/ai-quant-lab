"""Re-run ORDERBOOK-01 calibration using L1-3 DI instead of total_buy/total_sell.

Compares two features:
- total_DI = (total_buy_qty - total_sell_qty) / total
- l1_3_DI  = (sum(bid_qty[:3]) - sum(ask_qty[:3])) / sum  [top three book levels = indices 0..2;
  the earlier docstring said [1:3] but the code always used [:3]]

Also splits analysis into Tier 1 (Reversal) and Tier 2 (Momentum) level types.

AUDIT FIX NOTE (2026-10-10, docs/2026-10-10-orderbook-liquidity-audit-fixes.md): output of earlier
runs came from defective code and must not be quoted: the Tier-2 branch used `+di` for PDH (opposite
to the frozen di_tilde = -DI convention of run_orderbook01_oos.py / the live gate), frames AFTER the
contact were accepted (abs() gap), depth came from every provider_symbol, missing totals became 0.0,
raw DI is a per-day constant, labels were the look-ahead v1-legacy ones (a "30s" horizon built from
1m bars), pooled candidates were not filtered, and the stored is_regression filter dropped sessions.
Now: front-month future only, recomputed sequence flags, causal within-day detrended DI for BOTH
features (missing/insufficient history => unavailable, never 0), past-only matching, one population
(BANKNIFTY / 5m / active / v2-causal; 300s reversal, 60s momentum), one event per level-day, and
aligned = -DI_detrended for every level and both tiers.
"""

from __future__ import annotations
import sys, os
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
import numpy as np
from scipy import stats

REPO_ROOT = Path(r"c:\Users\Kulwinder Singh\Desktop\personal\AI Quant Lab")
sys.path.insert(0, str(REPO_ROOT / "apps/ml"))

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string
from ai_quant_lab_ml.orderbook_di import (
    DEFAULT_SYMBOL,
    DEFAULT_TIMEFRAME,
    LABELING_VERSION_CAUSAL,
    TIER1_HORIZON_SECONDS,
    TIER2_HORIZON_SECONDS_BY_LABELING_VERSION,
    causal_detrend_di,
    collapse_to_level_days,
    fetch_front_month_depth_rows,
    latest_value_at_or_before,
    raw_depth_imbalance,
)

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
REVERSAL_TYPES  = {"SWING_HIGH", "SWING_LOW", "ITH", "ITL", "SESSION_HIGH", "SESSION_LOW"}
MOMENTUM_TYPES  = {"PDH", "PDL"}
UP_SIDES   = {"UP"}
DOWN_SIDES = {"DOWN"}


def fetch_contact_events(
    conn,
    start,
    end,
    symbol: str = DEFAULT_SYMBOL,
    timeframe: str = DEFAULT_TIMEFRAME,
    labeling_version: str = LABELING_VERSION_CAUSAL,
):
    """One population: one symbol/timeframe, active candidates, one labeling_version; the horizon
    is 300s for reversal levels and the finest honest v2 horizon (60s) for momentum levels."""
    tier2_h = TIER2_HORIZON_SECONDS_BY_LABELING_VERSION.get(labeling_version, 60)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT lcl.contact_time, lcl.breached,
                   lpc.pool_type, lpc.side, lpc.price, lpc.timeframe, lpc.symbol
            FROM liquidity_contact_labels lcl
            JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
            WHERE lcl.contact_time >= %s AND lcl.contact_time <= %s
              AND lcl.contacted = TRUE
              AND lcl.is_active_candidate = TRUE
              AND lcl.breached IS NOT NULL
              AND lcl.labeling_version = %s
              AND lpc.symbol = %s AND lpc.timeframe = %s
              AND lcl.horizon_seconds = CASE WHEN lpc.pool_type IN ('PDH', 'PDL') THEN %s ELSE %s END
            ORDER BY lcl.contact_time ASC
        """, (start, end, labeling_version, symbol, timeframe, tier2_h, TIER1_HORIZON_SECONDS))
        return [{"contact_time": r[0], "breached": r[1], "pool_type": r[2], "side": r[3],
                 "level_price": float(r[4]), "timeframe": r[5], "symbol": r[6]}
                for r in cur.fetchall()]


def build_day_series(rows):
    """(times, total_di_detrended, l1_3_di_detrended) from front-month depth rows (pure).

    Missing totals / empty top-of-book stay None (never 0.0); each feature is causally detrended
    within the day before any sign is taken."""
    times, total_raw, l13_raw = [], [], []
    for r in rows:
        times.append(r["received_at"])
        total_raw.append(raw_depth_imbalance(r["total_buy_qty"], r["total_sell_qty"]))
        bids = [float(x) for x in (r.get("bid_qty") or [])[:3] if x is not None]
        asks = [float(x) for x in (r.get("ask_qty") or [])[:3] if x is not None]
        l13_raw.append(raw_depth_imbalance(sum(bids), sum(asks)) if bids and asks else None)
    return times, causal_detrend_di(times, total_raw), causal_detrend_di(times, l13_raw)


def fetch_day_series(conn, day: date):
    """Front-month future only, IST day, duplicates/resets removed via recomputed sequence flags."""
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=INDIA_TZ)
    day_end = day_start + timedelta(days=1)
    return build_day_series(
        fetch_front_month_depth_rows(conn, day_start, day_end, day.isoformat(), include_levels=True)
    )


def aligned(di_val, side=None, tier=None):
    """di_tilde = -DI_detrended for EVERY level and BOTH tiers (ORDERBOOK-01 convention, identical to
    run_orderbook01_oos.py and the live gate): positive (sell-heavy depth, relative to the day's own
    recent baseline) predicts REJECTION at reversal levels and a SWEEP at PDL. `side` / `tier` are
    accepted for call compatibility and intentionally ignored -- the earlier per-side flip (`+di` for
    PDH) contradicted the frozen sign convention.

    Historical note (the superseded, inconsistent rule):
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
    return -di_val


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
            times, total_series, l13_series = fetch_day_series(conn, day)
            if not times:
                continue
            day_matched = []
            for ev in day_events:
                # PAST-ONLY, <= 5s old, detrended DI available; missing is skipped, never 0.
                t_hit = latest_value_at_or_before(times, total_series, ev["contact_time"])
                l_hit = latest_value_at_or_before(times, l13_series, ev["contact_time"])
                if t_hit is None and l_hit is None:
                    continue
                day_matched.append({
                    **ev,
                    "total_di": None if t_hit is None else t_hit[0],
                    "l1_3_di": None if l_hit is None else l_hit[0],
                })
            # One event per level-day (repeat contacts are not independent samples).
            for ev in collapse_to_level_days(day_matched):
                total_di, l1_3_di = ev["total_di"], ev["l1_3_di"]
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
