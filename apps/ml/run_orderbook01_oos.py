"""ORDERBOOK-01: Formal Out-Of-Sample (OOS) Evaluator & Verdict Engine.

Pre-Registration Code: ORDERBOOK-01
Specification: C:/Users/Kulwinder Singh/.gemini/antigravity/brain/346d3e2f-549d-447a-9efe-7eac395ba211/orderbook01_experiment_plan.md
Status: FROZEN — Parameters locked after calibration on Aug 21 – Sep 25, 2026 data.

Evaluation Logic:
1. Tier 1 (Reversal): SWING_HIGH/LOW, ITH/ITL, SESSION_HIGH/LOW at 300s horizon.
   - DI_tilde = -DI. Predict REJECTION (breached=False) if DI_tilde > 0.
   - H1-R Target: Accuracy >= 0.72, Accuracy > trivial majority-class baseline, McNemar p <= 0.01
     (one-sided, model vs. baseline on paired events -- see mcnemar_one_sided_p), N >= 3,000,
     >= 4 of 6 level types pass.

2. Tier 2 (Momentum): PDL at 30s horizon.
   - DI_tilde = -DI. Predict SWEEP (breached=True) if DI_tilde > 0.
   - H1-M Target: Accuracy >= 0.78, Accuracy > trivial majority-class baseline, McNemar p <= 0.01
     (one-sided, model vs. baseline), N >= 1,000.

3. Hypothesis 2 (Monotonicity):
   - Q4 accuracy >= Q1 accuracy + 8 percentage points.
   - Permutation p <= 0.05.

4. Disaggregated Verdict:
   - Case A: H1-R PASS, H1-M PASS, H2 PASS (Full edge confirmed)
   - Case B: H1-R PASS, H1-M PASS, H2 FALSIFIED (Sign-only edge)
   - Case C: H1-R PASS, H1-M FALSIFIED (Reversal-only edge)
   - Case D: H1-R FALSIFIED, H1-M PASS (PDL momentum edge)
   - Case E: H1-R FALSIFIED, H1-M FALSIFIED (Falsified)

Statistical note (fixed 2026-10-05): H1-R/H1-M previously tested model accuracy against a 50/50
binomial null (`binomtest(successes, n, 0.5)`), which is the wrong null for these heavily
class-imbalanced labels -- PDL breaches at the 30s horizon 97.28% of the time (4299/4419,
confirmed against the live DB), and other Tier-1 levels sit at 84-97%. Against a 0.5 null, a
constant always-predict-majority classifier also reports p~=0.0, so the old test could not
distinguish a real edge from doing nothing. This mirrors the "trivial baseline" convention used
throughout apps/ml/train.py (`trivial_majority_metrics`): every hypothesis here is now tested
against the real majority-class baseline computed from the same population, using a one-sided
exact McNemar test on paired model-vs-baseline correctness (see `mcnemar_one_sided_p`) rather
than a one-sample test against an arbitrary null proportion.
"""

from __future__ import annotations

import argparse
import math
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


def compute_decaying_di(bid_p, bid_q, ask_p, ask_q, raw_di: float, lambda_bps: float = 0.05) -> float:
    if not bid_p or not ask_p or not bid_q or not ask_q:
        return raw_di
    try:
        best_bid = float(bid_p[0])
        best_ask = float(ask_p[0])
        mid_price = (best_bid + best_ask) / 2.0
        if mid_price <= 0:
            return raw_di

        wb_sum = 0.0
        for p, q in zip(bid_p, bid_q):
            dist_bps = (abs(mid_price - float(p)) / mid_price) * 10000.0
            w = math.exp(-lambda_bps * dist_bps)
            wb_sum += float(q) * w

        wa_sum = 0.0
        for p, q in zip(ask_p, ask_q):
            dist_bps = (abs(float(p) - mid_price) / mid_price) * 10000.0
            w = math.exp(-lambda_bps * dist_bps)
            wa_sum += float(q) * w

        tot = wb_sum + wa_sum
        return (wb_sum - wa_sum) / tot if tot > 0 else raw_di
    except Exception:
        return raw_di


def fetch_depth_frames_for_day(conn: psycopg.Connection, day: date) -> tuple[list[datetime], list[float]]:
    """Fetch all depth frames for a single day, sorted by received_at, calculating decaying DI."""
    start_dt = datetime.combine(day, datetime.min.time(), tzinfo=INDIA_TZ)
    end_dt = start_dt + timedelta(days=1)
    query = """
        SELECT received_at, total_buy_qty, total_sell_qty, bid_price, bid_qty, ask_price, ask_qty
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
        tb = float(r[1]) if r[1] is not None else 0.0
        ts = float(r[2]) if r[2] is not None else 0.0
        raw_di = (tb - ts) / (tb + ts) if (tb + ts > 0) else 0.0

        times.append(t)
        dis.append(raw_di)
    return times, dis


def match_events_to_depth(
    events: list[dict],
    depth_times: list[datetime],
    depth_dis: list[float],
) -> list[dict]:
    """Match each contact event to the nearest past depth_frame (received_at <= contact_time)."""
    if not depth_times:
        return []

    matched = []
    for ev in events:
        ctime = ev["contact_time"]
        min_allowed_time = ctime - timedelta(seconds=5)

        idx = bisect_left(depth_times, ctime)
        best_idx = None
        best_diff = 999.0

        for check_idx in range(max(0, idx - 20), min(len(depth_times), idx + 1)):
            dt_time = depth_times[check_idx]
            if dt_time <= ctime and dt_time >= min_allowed_time:
                diff = (ctime - dt_time).total_seconds()
                if diff < best_diff:
                    best_diff = diff
                    best_idx = check_idx

        if best_idx is not None:
            di = depth_dis[best_idx]
            di_tilde = -di
            matched.append({**ev, "raw_di": di, "di_tilde": di_tilde, "lag_sec": (ctime - depth_times[best_idx]).total_seconds()})

    return matched


def trivial_baseline_rate(outcomes: list[bool]) -> tuple[bool, float]:
    """Compute the always-predict-the-majority-outcome baseline on this exact population.

    Mirrors the house convention in apps/ml/train.py's `trivial_majority_metrics`: the
    baseline that matters is not a 50/50 coin flip, it's a constant predictor that always
    guesses whichever outcome is more common. For heavily imbalanced labels (e.g. PDL
    breaches 97.28% of the time at the 30s horizon) that constant predictor's accuracy is
    far above 50%, so any test against a 0.5 null overstates significance for every model,
    including a trivial one.
    """
    n = len(outcomes)
    if n == 0:
        return True, 0.0
    rate_true = sum(1 for o in outcomes if o) / n
    majority_label = rate_true >= 0.5
    baseline_acc = rate_true if majority_label else (1.0 - rate_true)
    return majority_label, baseline_acc


def mcnemar_one_sided_p(model_correct: list[bool], baseline_correct: list[bool]) -> tuple[float, int, int]:
    """One-sided exact McNemar test: does the model beat the majority-baseline on these paired events?

    The model and the trivial baseline are scored on the *same* events, so their correctness
    is correlated -- both tend to be right together whenever an event lands on the majority
    side, and that shared correctness carries zero information about whether the model adds
    anything. A one-sample test (binomial against 0.5, or even against the baseline rate
    treated as an independent null proportion) can't see that correlation and will call a
    result "significant" purely because concordant-correct pairs pile up for both sides --
    which is exactly how the old 50/50-null test let a below-baseline PDL accuracy (96.8%
    model vs 97.28% trivial) through as p~=0.

    McNemar's test strips out the concordant pairs entirely and looks only at the discordant
    ones -- cases where exactly one of {model, baseline} was correct -- and asks whether the
    model wins those more often than chance (p=0.5). That is precisely "does the model beat
    this specific majority-class baseline on this specific sample," which is the paired
    comparison the task calls for. It reduces to an exact binomial test on the discordant
    count, so no new dependency (e.g. statsmodels) is needed -- scipy.stats.binomtest, already
    imported above, is sufficient.
    """
    n10 = sum(1 for m, b in zip(model_correct, baseline_correct) if m and not b)
    n01 = sum(1 for m, b in zip(model_correct, baseline_correct) if (not m) and b)
    discordant = n10 + n01
    if discordant == 0:
        # Model and baseline agree on every single event (always both right or both wrong) --
        # there is no paired evidence the model adds anything, so this cannot be significant.
        return 1.0, n10, n01
    p_val = float(stats.binomtest(n10, discordant, 0.5, alternative="greater").pvalue)
    return p_val, n10, n01


def evaluate_h1_r(tier1_matched: list[dict], is_oos: bool = True) -> dict:
    """Evaluate Hypothesis 1-R (Tier 1 Reversal DI Accuracy)."""
    n = len(tier1_matched)
    if n == 0:
        return {
            "status": "INSUFFICIENT_DATA",
            "n": 0,
            "accuracy": 0.0,
            "trivial_baseline_accuracy": 0.0,
            "vs_baseline_p": 1.0,
            "per_level": {},
            "level_types_passed": 0,
            "reason": "Zero matched Tier 1 contact events in period.",
        }

    level_results = {}
    for level_type in TIER1_LEVELS:
        level_events = [e for e in tier1_matched if e["pool_type"] == level_type]
        if not level_events:
            level_results[level_type] = {"n": 0, "accuracy": 0.0, "trivial_baseline_accuracy": 0.0, "pass": False}
            continue
        # Tier 1 Reversal: predict REJECTION (breached == False) if di_tilde > 0
        actual_breached = [e["breached"] for e in level_events]
        model_correct = [(e["di_tilde"] > 0) == (not e["breached"]) for e in level_events]
        acc = float(np.mean(model_correct))
        majority_label, baseline_acc = trivial_baseline_rate(actual_breached)
        baseline_correct = [a == majority_label for a in actual_breached]
        p_val, n10, n01 = mcnemar_one_sided_p(model_correct, baseline_correct)
        # Level passes only if it clears the pre-registered floor AND beats the real
        # majority-class baseline on this population, not merely a 50/50 coin flip.
        level_results[level_type] = {
            "n": len(level_events),
            "accuracy": round(acc, 4),
            "trivial_baseline_accuracy": round(baseline_acc, 4),
            "p_value": round(p_val, 6),
            "mcnemar_n10": n10,
            "mcnemar_n01": n01,
            "pass": bool(acc >= 0.70 and acc > baseline_acc and p_val <= 0.05),
        }

    all_actual_breached = [e["breached"] for e in tier1_matched]
    all_model_correct = [(e["di_tilde"] > 0) == (not e["breached"]) for e in tier1_matched]
    overall_acc = float(np.mean(all_model_correct))
    overall_majority_label, overall_baseline_acc = trivial_baseline_rate(all_actual_breached)
    overall_baseline_correct = [a == overall_majority_label for a in all_actual_breached]
    vs_baseline_p, n10, n01 = mcnemar_one_sided_p(all_model_correct, overall_baseline_correct)
    levels_passed = sum(1 for r in level_results.values() if r["pass"])

    min_n = 3000 if is_oos else 1000
    pass_acc = bool(overall_acc >= 0.72)
    pass_baseline = bool(overall_acc > overall_baseline_acc)
    pass_p = bool(vs_baseline_p <= 0.01)
    pass_n = bool(n >= min_n)
    pass_levels = bool(levels_passed >= 4)

    is_pass = pass_acc and pass_baseline and pass_p and pass_n and pass_levels

    return {
        "status": "PASS" if is_pass else "FALSIFIED",
        "n": n,
        "accuracy": round(overall_acc, 4),
        "trivial_baseline_accuracy": round(overall_baseline_acc, 4),
        "vs_baseline_p": round(vs_baseline_p, 6),
        "mcnemar_n10": n10,
        "mcnemar_n01": n01,
        "levels_passed": levels_passed,
        "per_level": level_results,
        "criteria_checks": {
            "acc_ge_0_72": pass_acc,
            "acc_gt_trivial_baseline": pass_baseline,
            "mcnemar_p_le_0_01": pass_p,
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
            "trivial_baseline_accuracy": 0.0,
            "vs_baseline_p": 1.0,
            "reason": "Zero matched Tier 2 (PDL) contact events in period.",
        }

    # Tier 2 Momentum (PDL): predict SWEEP (breached == True) if di_tilde > 0
    actual_breached = [e["breached"] for e in tier2_matched]
    model_correct = [(e["di_tilde"] > 0) == e["breached"] for e in tier2_matched]
    acc = float(np.mean(model_correct))

    # PDL breaches at the 30s horizon in 84-97% of contacts (confirmed against the live DB --
    # 4299/4419 = 97.28% for PDL specifically), so a constant always-predict-breach classifier
    # already scores well above the old 0.78 floor. Testing accuracy against a 50/50 null (as
    # this script did before) reports p~=0.0 for that constant classifier too, which is how a
    # 96.8%-accurate model that is actually *worse* than the 97.3% trivial baseline got waved
    # through as "highly significant." See trivial_baseline_rate / mcnemar_one_sided_p above for
    # the corrected, paired, baseline-relative test.
    majority_label, baseline_acc = trivial_baseline_rate(actual_breached)
    baseline_correct = [a == majority_label for a in actual_breached]
    vs_baseline_p, n10, n01 = mcnemar_one_sided_p(model_correct, baseline_correct)

    min_n = 1000 if is_oos else 500
    pass_acc = bool(acc >= 0.78)
    pass_baseline = bool(acc > baseline_acc)
    pass_p = bool(vs_baseline_p <= 0.01)
    pass_n = bool(n >= min_n)

    is_pass = pass_acc and pass_baseline and pass_p and pass_n

    return {
        "status": "PASS" if is_pass else "FALSIFIED",
        "n": n,
        "accuracy": round(acc, 4),
        "trivial_baseline_accuracy": round(baseline_acc, 4),
        "vs_baseline_p": round(vs_baseline_p, 6),
        "mcnemar_n10": n10,
        "mcnemar_n01": n01,
        "criteria_checks": {
            "acc_ge_0_78": pass_acc,
            "acc_gt_trivial_baseline": pass_baseline,
            "mcnemar_p_le_0_01": pass_p,
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
        # An inverted window used to fall through and write an "INCONCLUSIVE / zero events" verdict
        # file (apps/ml/orderbook01_oos_rerun_2026-09-26.json: eval_start 2026-09-26 > eval_end
        # 2026-09-24) that reads like a real result. An invalid window is an error, not a verdict:
        # write nothing and exit non-zero.
        print("ERROR: invalid evaluation window (start is after end); no result file written.")
        sys.exit(2)

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
    print(
        f"  N: {h1_r['n']} | Accuracy: {h1_r['accuracy']*100:.1f}% | "
        f"Trivial baseline: {h1_r.get('trivial_baseline_accuracy', 0.0)*100:.1f}% | "
        f"McNemar p (vs baseline): {h1_r.get('vs_baseline_p', 1.0):.6f}"
    )
    print(f"  Level Types Passed: {h1_r.get('levels_passed', 0)} / 6")
    if "per_level" in h1_r:
        for lvl, stats_dict in h1_r["per_level"].items():
            st = "PASS" if stats_dict["pass"] else "FAIL"
            print(
                f"    - {lvl:12s}: N={stats_dict['n']:4d} | Acc={stats_dict['accuracy']*100:5.1f}% | "
                f"Baseline={stats_dict.get('trivial_baseline_accuracy', 0.0)*100:5.1f}% | "
                f"p={stats_dict.get('p_value', 1.0):.4f} [{st}]"
            )

    print(f"\nH1-M (Tier 2 Momentum PDL Accuracy): [{h1_m['status']}]")
    print(
        f"  N: {h1_m['n']} | Accuracy: {h1_m['accuracy']*100:.1f}% | "
        f"Trivial baseline: {h1_m.get('trivial_baseline_accuracy', 0.0)*100:.1f}% | "
        f"McNemar p (vs baseline): {h1_m.get('vs_baseline_p', 1.0):.6f}"
    )

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
