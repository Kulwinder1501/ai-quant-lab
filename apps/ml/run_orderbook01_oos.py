"""ORDERBOOK-01: Formal Out-Of-Sample (OOS) Evaluator & Verdict Engine.

Pre-Registration Code: ORDERBOOK-01
Specification: C:/Users/Kulwinder Singh/.gemini/antigravity/brain/346d3e2f-549d-447a-9efe-7eac395ba211/orderbook01_experiment_plan.md
Status: FROZEN — Parameters locked after calibration on Aug 21 – Sep 25, 2026 data.

Evaluation Logic:
1. Tier 1 (Reversal): SWING_HIGH/LOW, ITH/ITL, SESSION_HIGH/LOW at 300s horizon.
   - DI_tilde = -DI. Predict REJECTION (breached=False) if DI_tilde > 0.
   - H1-R Target: Accuracy >= 0.72, Binomial p <= 0.01, N >= 3,000, >= 4 of 6 level types pass.

2. Tier 2 (Momentum): PDL at 30s horizon.
   - DI_tilde = -DI. Predict SWEEP (breached=True) if DI_tilde > 0.
   - H1-M Target: Accuracy >= 0.78, Binomial p <= 0.01, N >= 1,000.

3. Hypothesis 2 (Monotonicity):
   - Q4 accuracy >= Q1 accuracy + 8 percentage points.
   - Permutation p <= 0.05.

4. Disaggregated Verdict:
   - Case A: H1-R PASS, H1-M PASS, H2 PASS (Full edge confirmed)
   - Case B: H1-R PASS, H1-M PASS, H2 FALSIFIED (Sign-only edge)
   - Case C: H1-R PASS, H1-M FALSIFIED (Reversal-only edge)
   - Case D: H1-R FALSIFIED, H1-M PASS (PDL momentum edge)
   - Case E: H1-R FALSIFIED, H1-M FALSIFIED (Falsified)
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
from bisect import bisect_left
import json

import numpy as np
from scipy import stats

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")

TIER1_LEVELS = {"SWING_HIGH", "SWING_LOW", "ITH", "ITL", "SESSION_HIGH", "SESSION_LOW"}
TIER2_LEVELS = {"PDL"}
EXCLUDED_LEVELS = {"PDH"}


def fetch_contact_events(
    conn: psycopg.Connection,
    start_dt: datetime,
    end_dt: datetime,
    horizon_seconds: int,
    level_types: set[str],
) -> list[dict]:
    """Fetch labeled contact events for specified level types and horizon."""
    placeholders = ", ".join(["%s"] * len(level_types))
    query = f"""
        SELECT
            lcl.id::text,
            lcl.contact_time,
            lcl.distance_bps,
            lcl.breached,
            lcl.horizon_seconds,
            lpc.pool_type,
            lpc.side,
            lpc.price AS level_price
        FROM liquidity_contact_labels lcl
        JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
        WHERE lcl.contacted = TRUE
          AND lcl.horizon_seconds = %s
          AND lcl.contact_time >= %s
          AND lcl.contact_time < %s
          AND lpc.pool_type IN ({placeholders})
        ORDER BY lcl.contact_time ASC;
    """
    params = [horizon_seconds, start_dt, end_dt] + list(level_types)
    with conn.cursor() as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
        return [
            {
                "id": r[0],
                "contact_time": r[1].astimezone(INDIA_TZ) if r[1].tzinfo else r[1].replace(tzinfo=INDIA_TZ),
                "distance_bps": float(r[2]),
                "breached": bool(r[3]),
                "horizon_seconds": int(r[4]),
                "pool_type": r[5],
                "side": r[6],
                "level_price": float(r[7]),
            }
            for r in rows
        ]


def fetch_depth_frames_for_day(conn: psycopg.Connection, day: date) -> tuple[list[datetime], list[float]]:
    """Fetch all depth frames for a single day, sorted by received_at."""
    start_dt = datetime.combine(day, datetime.min.time(), tzinfo=INDIA_TZ)
    end_dt = start_dt + timedelta(days=1)
    query = """
        SELECT received_at, total_buy_qty, total_sell_qty
        FROM depth_frames
        WHERE received_at >= %s AND received_at < %s
        ORDER BY received_at ASC;
    """
    with conn.cursor() as cur:
        cur.execute(query, (start_dt, end_dt))
        rows = cur.fetchall()

    times = []
    dis = []
    for r in rows:
        t = r[0].astimezone(INDIA_TZ) if r[0].tzinfo else r[0].replace(tzinfo=INDIA_TZ)
        tb = float(r[1])
        ts = float(r[2])
        if tb + ts > 0:
            di = (tb - ts) / (tb + ts)
            times.append(t)
            dis.append(di)
    return times, dis


def match_events_to_depth(
    events: list[dict],
    depth_times: list[datetime],
    depth_dis: list[float],
) -> list[dict]:
    """Match each contact event to the nearest past depth_frame (received_at <= contact_time + 1s)."""
    if not depth_times:
        return []

    matched = []
    for ev in events:
        ctime = ev["contact_time"]
        max_allowed_time = ctime + timedelta(seconds=1)
        min_allowed_time = ctime - timedelta(seconds=5)

        idx = bisect_left(depth_times, max_allowed_time)
        best_idx = None
        best_diff = timedelta(days=999)

        for check_idx in range(max(0, idx - 20), min(len(depth_times), idx + 2)):
            dt_time = depth_times[check_idx]
            if dt_time <= max_allowed_time and dt_time >= min_allowed_time:
                diff = abs((dt_time - ctime).total_seconds())
                if diff < best_diff.total_seconds():
                    best_diff = timedelta(seconds=diff)
                    best_idx = check_idx

        if best_idx is not None:
            di = depth_dis[best_idx]
            di_tilde = -di
            matched.append({**ev, "raw_di": di, "di_tilde": di_tilde, "lag_sec": (ctime - depth_times[best_idx]).total_seconds()})

    return matched


def evaluate_h1_r(tier1_matched: list[dict], is_oos: bool = True) -> dict:
    """Evaluate Hypothesis 1-R (Tier 1 Reversal DI Accuracy)."""
    n = len(tier1_matched)
    if n == 0:
        return {
            "status": "INSUFFICIENT_DATA",
            "n": 0,
            "accuracy": 0.0,
            "binomial_p": 1.0,
            "per_level": {},
            "level_types_passed": 0,
            "reason": "Zero matched Tier 1 contact events in period.",
        }

    level_results = {}
    for level_type in TIER1_LEVELS:
        level_events = [e for e in tier1_matched if e["pool_type"] == level_type]
        if not level_events:
            level_results[level_type] = {"n": 0, "accuracy": 0.0, "pass": False}
            continue
        # Tier 1 Reversal: predict REJECTION (breached == False) if di_tilde > 0
        corrects = [(e["di_tilde"] > 0) == (not e["breached"]) for e in level_events]
        acc = float(np.mean(corrects))
        # Level passes if acc >= 0.70 and binomial p <= 0.05
        p_val = float(stats.binomtest(sum(corrects), len(corrects), 0.50, alternative="greater").pvalue)
        level_results[level_type] = {
            "n": len(level_events),
            "accuracy": round(acc, 4),
            "p_value": round(p_val, 6),
            "pass": bool(acc >= 0.70 and p_val <= 0.05),
        }

    all_correct = [(e["di_tilde"] > 0) == (not e["breached"]) for e in tier1_matched]
    overall_acc = float(np.mean(all_correct))
    binom_p = float(stats.binomtest(sum(all_correct), n, 0.50, alternative="greater").pvalue)
    levels_passed = sum(1 for r in level_results.values() if r["pass"])

    min_n = 3000 if is_oos else 1000
    pass_acc = bool(overall_acc >= 0.72)
    pass_p = bool(binom_p <= 0.01)
    pass_n = bool(n >= min_n)
    pass_levels = bool(levels_passed >= 4)

    is_pass = pass_acc and pass_p and pass_n and pass_levels

    return {
        "status": "PASS" if is_pass else "FALSIFIED",
        "n": n,
        "accuracy": round(overall_acc, 4),
        "binomial_p": round(binom_p, 6),
        "levels_passed": levels_passed,
        "per_level": level_results,
        "criteria_checks": {
            "acc_ge_0_72": pass_acc,
            "p_le_0_01": pass_p,
            f"n_ge_{min_n}": pass_n,
            "levels_ge_4": pass_levels,
        },
    }


def evaluate_h1_m(tier2_matched: list[dict], is_oos: bool = True) -> dict:
    """Evaluate Hypothesis 1-M (Tier 2 Momentum DI Accuracy - PDL)."""
    n = len(tier2_matched)
    if n == 0:
        return {
            "status": "INSUFFICIENT_DATA",
            "n": 0,
            "accuracy": 0.0,
            "binomial_p": 1.0,
            "reason": "Zero matched Tier 2 (PDL) contact events in period.",
        }

    # Tier 2 Momentum (PDL): predict SWEEP (breached == True) if di_tilde > 0
    corrects = [(e["di_tilde"] > 0) == e["breached"] for e in tier2_matched]
    acc = float(np.mean(corrects))
    binom_p = float(stats.binomtest(sum(corrects), n, 0.50, alternative="greater").pvalue)

    min_n = 1000 if is_oos else 500
    pass_acc = bool(acc >= 0.78)
    pass_p = bool(binom_p <= 0.01)
    pass_n = bool(n >= min_n)

    is_pass = pass_acc and pass_p and pass_n

    return {
        "status": "PASS" if is_pass else "FALSIFIED",
        "n": n,
        "accuracy": round(acc, 4),
        "binomial_p": round(binom_p, 6),
        "criteria_checks": {
            "acc_ge_0_78": pass_acc,
            "p_le_0_01": pass_p,
            f"n_ge_{min_n}": pass_n,
        },
    }



def evaluate_h2(all_matched: list[dict]) -> dict:
    """Evaluate Hypothesis 2 (DI Monotonicity via Quartiles)."""
    if len(all_matched) < 100:
        return {
            "status": "INSUFFICIENT_DATA",
            "n": len(all_matched),
            "quartiles": {},
            "q4_minus_q1": 0.0,
            "permutation_p": 1.0,
            "reason": "Fewer than 100 events available for quartile test.",
        }

    # Calculate correctness for each event
    data = []
    for e in all_matched:
        mag = abs(e["di_tilde"])
        if e["pool_type"] in TIER1_LEVELS:
            is_correct = (e["di_tilde"] > 0) == (not e["breached"])
        elif e["pool_type"] == "PDL":
            is_correct = (e["di_tilde"] > 0) == e["breached"]
        else:
            continue
        data.append((mag, 1 if is_correct else 0))

    if not data:
        return {"status": "INSUFFICIENT_DATA", "n": 0}

    mags, corrects = zip(*data)
    mags = np.array(mags)
    corrects = np.array(corrects)

    # Bin into 4 quartiles
    q_edges = np.quantile(mags, [0, 0.25, 0.50, 0.75, 1.0])
    q_accs = []
    q_counts = []

    for i in range(4):
        low, high = q_edges[i], q_edges[i + 1]
        if i == 3:
            mask = (mags >= low) & (mags <= high)
        else:
            mask = (mags >= low) & (mags < high)
        cnt = np.sum(mask)
        q_counts.append(int(cnt))
        if cnt > 0:
            q_accs.append(float(np.mean(corrects[mask])))
        else:
            q_accs.append(0.0)

    q4_q1_diff = q_accs[3] - q_accs[0]

    # Permutation test for monotonic slope
    # Correlation between quartile index and accuracy
    q_indices = np.digitize(mags, q_edges[1:-1])
    orig_corr, _ = stats.spearmanr(q_indices, corrects)

    n_perms = 1000
    perm_corrs = []
    rng = np.random.default_rng(42)
    for _ in range(n_perms):
        shuffled = rng.permutation(corrects)
        c, _ = stats.spearmanr(q_indices, shuffled)
        perm_corrs.append(c)

    p_perm = float(np.mean(np.array(perm_corrs) >= orig_corr))

    pass_diff = q4_q1_diff >= 0.08
    pass_p = p_perm <= 0.05

    return {
        "status": "PASS" if (pass_diff and pass_p) else "FALSIFIED",
        "n": len(data),
        "q4_minus_q1": round(float(q4_q1_diff), 4),
        "permutation_p": round(p_perm, 6),
        "quartile_accs": [round(a, 4) for a in q_accs],
        "quartile_counts": q_counts,
        "criteria_checks": {
            "diff_ge_0_08": pass_diff,
            "p_le_0_05": pass_p,
        },
    }


def determine_verdict(h1_r: dict, h1_m: dict, h2: dict) -> tuple[str, str]:
    """Determine case verdict A, B, C, D, E based on H1-R, H1-M, H2 results."""
    st_r = h1_r.get("status")
    st_m = h1_m.get("status")
    st_h2 = h2.get("status")

    if st_r == "INSUFFICIENT_DATA" or st_m == "INSUFFICIENT_DATA":
        return "INCONCLUSIVE", "OOS data incomplete or threshold sample size not yet reached."

    pass_r = (st_r == "PASS")
    pass_m = (st_m == "PASS")
    pass_h2 = (st_h2 == "PASS")

    if pass_r and pass_m and pass_h2:
        return "CASE A", "Full Edge Confirmed. Authorize DI as directional gate for Confluence setups."
    elif pass_r and pass_m and not pass_h2:
        return "CASE B", "Sign-Only Edge Confirmed. Use DI binary directional gate (magnitude uninformative)."
    elif pass_r and not pass_m:
        return "CASE C", "Reversal-Only Edge Confirmed. Apply DI gate to Tier 1 levels (swings/session) only."
    elif not pass_r and pass_m:
        return "CASE D", "PDL Momentum Edge Confirmed. Apply DI gate to PDL sweep setups only."
    else:
        return "CASE E", "FALSIFIED. No robust directional edge found in OOS test."


def main():
    parser = argparse.ArgumentParser(description="ORDERBOOK-01 Formal Out-Of-Sample Evaluator")
    parser.add_argument("--start-oos", type=str, default="2026-09-26", help="OOS start date (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=str, default=None, help="Optional end date (YYYY-MM-DD)")
    parser.add_argument("--eval-mode", choices=["oos", "calibration", "all"], default="oos", help="Evaluation mode")
    args = parser.parse_args()

    conn_str = get_db_connection_string()
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT MIN(contact_time), MAX(contact_time) FROM liquidity_contact_labels WHERE contacted = TRUE;")
            min_dt, max_dt = cur.fetchone()

    if not min_dt or not max_dt:
        print("ERROR: No contact events found in liquidity_contact_labels table.")
        sys.exit(1)

    min_date = min_dt.astimezone(INDIA_TZ).date()
    max_date = max_dt.astimezone(INDIA_TZ).date()

    print("=" * 80)
    print("ORDERBOOK-01 FORMAL PRE-REGISTERED EVALUATION ENGINE")
    print("=" * 80)
    print(f"Database Contact Events Window: {min_date} to {max_date}")

    oos_start_date = date.fromisoformat(args.start_oos)
    eval_mode = args.eval_mode

    if eval_mode == "calibration":
        eval_start = min_date
        eval_end = min(oos_start_date - timedelta(days=1), max_date)
        mode_str = f"CALIBRATION (Baseline: {eval_start} to {eval_end})"
    elif eval_mode == "oos":
        eval_start = oos_start_date
        eval_end = date.fromisoformat(args.end_date) if args.end_date else max(max_date, oos_start_date)
        mode_str = f"OUT-OF-SAMPLE ({eval_start} to {eval_end})"
    else:
        eval_start = min_date
        eval_end = date.fromisoformat(args.end_date) if args.end_date else max_date
        mode_str = f"ALL DATA ({eval_start} to {eval_end})"

    if eval_start > eval_end:
        print(f"WARNING: Selected evaluation start ({eval_start}) is past the latest event date ({eval_end}).")
        print(f"Database latest contact_time is {max_date}. Labeling pipeline has not produced post-{max_date} events yet.")

    print(f"Evaluation Window: {mode_str}")
    print("-" * 80)

    start_dt = datetime.combine(eval_start, datetime.min.time(), tzinfo=INDIA_TZ)
    end_dt = datetime.combine(eval_end + timedelta(days=1), datetime.min.time(), tzinfo=INDIA_TZ)

    with psycopg.connect(conn_str) as conn:
        print("Fetching Tier 1 events (300s horizon)...")
        t1_events = fetch_contact_events(conn, start_dt, end_dt, horizon_seconds=300, level_types=TIER1_LEVELS)
        print(f"-> {len(t1_events)} Tier 1 events fetched.")

        print("Fetching Tier 2 events (30s horizon)...")
        t2_events = fetch_contact_events(conn, start_dt, end_dt, horizon_seconds=30, level_types=TIER2_LEVELS)
        print(f"-> {len(t2_events)} Tier 2 (PDL) events fetched.")

        # Gather matched data day by day
        t1_matched = []
        t2_matched = []
        all_dates = sorted(list({e["contact_time"].date() for e in t1_events + t2_events}))

        print(f"Matching depth frames across {len(all_dates)} trading sessions...")
        for day in all_dates:
            depth_times, depth_dis = fetch_depth_frames_for_day(conn, day)
            if not depth_times:
                continue
            day_t1 = [e for e in t1_events if e["contact_time"].date() == day]
            day_t2 = [e for e in t2_events if e["contact_time"].date() == day]

            t1_matched.extend(match_events_to_depth(day_t1, depth_times, depth_dis))
            t2_matched.extend(match_events_to_depth(day_t2, depth_times, depth_dis))

    print(f"-> Matched {len(t1_matched)} Tier 1 events and {len(t2_matched)} Tier 2 events.")
    print("=" * 80)

    # Evaluate Hypotheses
    is_oos = (eval_mode == "oos")
    h1_r = evaluate_h1_r(t1_matched, is_oos=is_oos)
    h1_m = evaluate_h1_m(t2_matched, is_oos=is_oos)
    h2 = evaluate_h2(t1_matched + t2_matched)
    case_verdict, verdict_desc = determine_verdict(h1_r, h1_m, h2)

    # Format Results Output
    print("\nHYPOTHESIS EVALUATION SUMMARY")
    print("-" * 80)
    print(f"H1-R (Tier 1 Reversal Accuracy): [{h1_r['status']}]")
    print(f"  N: {h1_r['n']} | Accuracy: {h1_r['accuracy']*100:.1f}% | Binomial p: {h1_r['binomial_p']:.6f}")
    print(f"  Level Types Passed: {h1_r.get('levels_passed', 0)} / 6")
    if "per_level" in h1_r:
        for lvl, stats_dict in h1_r["per_level"].items():
            st = "PASS" if stats_dict["pass"] else "FAIL"
            print(f"    - {lvl:12s}: N={stats_dict['n']:4d} | Acc={stats_dict['accuracy']*100:5.1f}% | p={stats_dict.get('p_value', 1.0):.4f} [{st}]")

    print(f"\nH1-M (Tier 2 Momentum PDL Accuracy): [{h1_m['status']}]")
    print(f"  N: {h1_m['n']} | Accuracy: {h1_m['accuracy']*100:.1f}% | Binomial p: {h1_m['binomial_p']:.6f}")

    print(f"\nH2 (DI Monotonicity Lift): [{h2['status']}]")
    print(f"  N: {h2['n']} | Q4-Q1 Lift: {h2['q4_minus_q1']*100:+.1f} pp | Permutation p: {h2['permutation_p']:.6f}")
    if "quartile_accs" in h2:
        print(f"  Quartile Accuracies (Q1->Q4): {[round(a*100, 1) for a in h2['quartile_accs']]}")

    print("=" * 80)
    print(f"FINAL VERDICT: {case_verdict}")
    print(f"Details: {verdict_desc}")
    print("=" * 80)

    # Save results to JSON artifact
    def default_serializer(o):
        if isinstance(o, (np.bool_, bool)):
            return bool(o)
        if isinstance(o, (np.integer, np.floating)):
            return float(o)
        return str(o)

    res_payload = {
        "pre_registration": "ORDERBOOK-01",
        "eval_mode": eval_mode,
        "eval_start": str(eval_start),
        "eval_end": str(eval_end),
        "h1_r": h1_r,
        "h1_m": h1_m,
        "h2": h2,
        "verdict": case_verdict,
        "verdict_description": verdict_desc,
        "executed_at": datetime.now(INDIA_TZ).isoformat(),
    }

    out_json = script_dir / "orderbook01_verdict.json"
    with open(out_json, "w") as f:
        json.dump(res_payload, f, indent=2, default=default_serializer)
    print(f"\nVerdict report written to {out_json}")



if __name__ == "__main__":
    main()
