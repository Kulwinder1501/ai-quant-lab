import sys
import json
import psycopg
import logging
import argparse
import pandas as pd
import numpy as np
from pathlib import Path
from datetime import datetime, timedelta
import zoneinfo
import random
import time

script_dir = Path(r"c:\Users\Kulwinder Singh\Desktop\personal\AI Quant Lab\apps\ml")
sys.path.insert(0, str(script_dir))

from ai_quant_lab_ml.structure_intelligence import get_db_connection_string
from ai_quant_lab_ml.cks_ofi_touch import compute_windowed_ofi_series, DepthFrameRow

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

class FrameRow:
    __slots__ = ['received_at', 'canonical_event_at', 'is_valid', 'bid_price_0', 'ask_price_0']
    def __init__(self, r):
        self.received_at = r[0].astimezone(INDIA_TZ) if r[0].tzinfo else r[0].replace(tzinfo=INDIA_TZ)
        
        eft = r[3]
        vst = r[4]
        ts_val = eft if eft is not None else vst
        if ts_val is None:
            self.canonical_event_at = None
            self.is_valid = False
        else:
            if ts_val > 20000000000:
                self.canonical_event_at = datetime.fromtimestamp(ts_val / 1000.0, tz=INDIA_TZ)
            else:
                self.canonical_event_at = datetime.fromtimestamp(ts_val, tz=INDIA_TZ)
            self.is_valid = self.canonical_event_at <= self.received_at
            
        bp = r[5]
        ap = r[7]
        self.bid_price_0 = float(bp[0]) if bp else 0.0
        self.ask_price_0 = float(ap[0]) if ap else 0.0

def get_frames_basic(conn, start_dt, end_dt, session_id=None):
    query = """
        SELECT received_at, total_buy_qty, total_sell_qty, exchange_feed_time, vendor_send_time, 
               bid_price, bid_qty, ask_price, ask_qty, provider_symbol, capture_session_id
        FROM depth_frames
        WHERE received_at >= %s AND received_at < %s
    """
    params = [start_dt, end_dt]
    if session_id:
        query += " AND capture_session_id = %s"
        params.append(session_id)
    query += " ORDER BY received_at ASC"
    
    with conn.cursor() as cur:
        cur.execute(query, tuple(params))
        rows = cur.fetchall()
        
    by_sym = {}
    for r in rows:
        sym = r[9]
        if "FUT" not in sym:
            continue
        if sym not in by_sym:
            by_sym[sym] = []
        by_sym[sym].append(r)
    return by_sym

def get_target_quote(frames, target_t, max_age_seconds=1.0, enforce_age=True):
    # frames is a list of FrameRow
    # Find the latest quote such that quote_event_time <= target_t
    # In OOS, we just do a binary search or linear search if small
    # Since they are sorted by received_at, we can just scan backwards from the point where received_at > target_t
    
    # We will use binary search on received_at
    received_times = [f.received_at for f in frames]
    idx = np.searchsorted(received_times, target_t, side='right') - 1
    
    best = None
    while idx >= 0:
        f = frames[idx]
        # Must be valid
        if f.is_valid and f.canonical_event_at <= target_t and f.received_at <= target_t:
            if best is None or f.canonical_event_at > best.canonical_event_at:
                best = f
        
        # Optimization: if received_at is too far back, we can stop if we are enforcing age
        if enforce_age and (target_t - f.received_at).total_seconds() > 5.0:
            break
            
        idx -= 1
        
    if best is None:
        return None
        
    if enforce_age:
        if (target_t - best.received_at).total_seconds() > max_age_seconds:
            return None
            
    if best.bid_price_0 >= best.ask_price_0 or best.bid_price_0 <= 0 or best.ask_price_0 <= 0:
        return None
        
    return (best.bid_price_0 + best.ask_price_0) / 2.0

def main():
    conn_str = get_db_connection_string()
    
    with psycopg.connect(conn_str) as conn:
        logging.info("Fetching Pre-OOS calibration frames for OFI percentiles...")
        pre_oos_dt = datetime(2026, 9, 26, tzinfo=INDIA_TZ)
        pre_oos_start = pre_oos_dt - timedelta(days=7)
        
        pre_by_sym = get_frames_basic(conn, pre_oos_start, pre_oos_dt)
        
        ofi_thresholds = {}
        for sym, r_list in pre_by_sym.items():
            is_banknifty = "BANKNIFTY" in sym
            is_nifty = "NIFTY" in sym and not is_banknifty
            if not is_banknifty and not is_nifty:
                continue
                
            dframes = []
            for r in r_list:
                dframes.append(DepthFrameRow(
                    received_at=r[0].astimezone(INDIA_TZ) if r[0].tzinfo else r[0].replace(tzinfo=INDIA_TZ),
                    is_snapshot=False,
                    is_duplicate=False,
                    gap_before=None,
                    bid_price_0=float(r[5][0]) if r[5] else 0.0,
                    bid_qty_0=float(r[6][0]) if r[6] else 0.0,
                    ask_price_0=float(r[7][0]) if r[7] else 0.0,
                    ask_qty_0=float(r[8][0]) if r[8] else 0.0
                ))
            
            ofi_obs = compute_windowed_ofi_series(dframes)
            if not ofi_obs:
                continue
                
            vals = [obs.window_sum for obs in ofi_obs]
            instrument = "BANKNIFTY" if is_banknifty else "NIFTY"
            if instrument not in ofi_thresholds:
                ofi_thresholds[instrument] = []
            ofi_thresholds[instrument].extend(vals)
            
        del pre_by_sym
        
        frozen_q = {}
        for inst, vals in ofi_thresholds.items():
            if len(vals) > 0:
                frozen_q[f"{inst}_Q01"] = np.percentile(vals, 1)
                frozen_q[f"{inst}_Q99"] = np.percentile(vals, 99)
                logging.info(f"{inst} Q01: {frozen_q[f'{inst}_Q01']:.4f}, Q99: {frozen_q[f'{inst}_Q99']:.4f}")
            else:
                logging.error(f"No OFI observations for {inst}")
                return

        end_dt = datetime(2026, 10, 8, tzinfo=INDIA_TZ)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT capture_session_id, MIN(received_at) as min_t, MAX(received_at) as max_t 
                FROM depth_frames 
                WHERE received_at >= %s AND received_at < %s
                GROUP BY capture_session_id 
                ORDER BY min_t;
            """, (pre_oos_dt, end_dt))
            capture_sessions = cur.fetchall()
            
        logging.info(f"Evaluating {len(capture_sessions)} OOS capture sessions...")
        
        events = []
        horizons = [1, 5, 10, 30, 60, 300, 900]
        
        for (sess_id, min_t, max_t) in capture_sessions:
            sess_by_sym = get_frames_basic(conn, min_t, max_t, sess_id)
            
            for sym, r_list in sess_by_sym.items():
                is_banknifty = "BANKNIFTY" in sym
                is_nifty = "NIFTY" in sym and not is_banknifty
                if not is_banknifty and not is_nifty:
                    continue
                    
                instrument = "BANKNIFTY" if is_banknifty else "NIFTY"
                q01 = frozen_q[f"{instrument}_Q01"]
                q99 = frozen_q[f"{instrument}_Q99"]
                
                dframes = []
                frows = []
                for r in r_list:
                    d_r = r[0].astimezone(INDIA_TZ) if r[0].tzinfo else r[0].replace(tzinfo=INDIA_TZ)
                    dframes.append(DepthFrameRow(
                        received_at=d_r,
                        is_snapshot=False,
                        is_duplicate=False,
                        gap_before=None,
                        bid_price_0=float(r[5][0]) if r[5] else 0.0,
                        bid_qty_0=float(r[6][0]) if r[6] else 0.0,
                        ask_price_0=float(r[7][0]) if r[7] else 0.0,
                        ask_qty_0=float(r[8][0]) if r[8] else 0.0
                    ))
                    frows.append(FrameRow(r))
                    
                ofi_obs = compute_windowed_ofi_series(dframes)
                if len(ofi_obs) < 2:
                    continue
                    
                next_eligible_time = ofi_obs[0].at
                
                for i in range(1, len(ofi_obs)):
                    prev_ofi = ofi_obs[i-1].window_sum
                    curr_ofi = ofi_obs[i].window_sum
                    decision_t = ofi_obs[i].at
                    
                    if decision_t < next_eligible_time:
                        continue
                        
                    is_pos = prev_ofi <= q99 and curr_ofi > q99
                    is_neg = prev_ofi >= q01 and curr_ofi < q01
                    
                    if is_pos or is_neg:
                        s_j = 1.0 if is_pos else -1.0
                        
                        m_tj = get_target_quote(frows, decision_t, enforce_age=False) # decision quote
                        if m_tj is None:
                            continue
                            
                        # Extract horizons
                        irf_vals = {}
                        valid = True
                        for h in horizons:
                            t_h = decision_t + timedelta(seconds=h)
                            m_h = get_target_quote(frows, t_h, max_age_seconds=1.0, enforce_age=True)
                            if m_h is None:
                                irf_vals[f"h_{h}"] = np.nan
                            else:
                                irf_vals[f"h_{h}"] = s_j * 10000.0 * (m_h - m_tj) / m_tj
                                
                        events.append({
                            "session_id": sess_id,
                            "instrument": instrument,
                            "direction": "positive" if is_pos else "negative",
                            "decision_at": decision_t.isoformat(),
                            **irf_vals
                        })
                        
                        next_eligible_time = decision_t + timedelta(minutes=15)
                        
    df = pd.DataFrame(events)
    if len(df) == 0:
        logging.error("No events found.")
        return
        
    logging.info(f"Total events found: {len(df)}")
    
    # Analyze per instrument-direction
    results = {}
    
    for inst in ["NIFTY", "BANKNIFTY"]:
        for d in ["positive", "negative"]:
            subset = df[(df['instrument'] == inst) & (df['direction'] == d)].copy()
            # Must have complete records for simultaneous inference across all horizons
            # A completely valid trajectory is needed for bootstrapping
            h_cols = [f"h_{h}" for h in horizons]
            subset = subset.dropna(subset=h_cols)
            
            n = len(subset)
            logging.info(f"{inst} {d} completely observed events: {n}")
            
            if n < 50:
                results[f"{inst}_{d}"] = {
                    "count": n,
                    "status": "INCONCLUSIVE",
                    "reason": "Insufficient independent events (< 50)"
                }
                continue
                
            # Block Bootstrap by Session
            sessions = subset['session_id'].unique()
            B = 10000
            rng = np.random.default_rng(42)
            
            # Original Means
            obs_means = subset[h_cols].mean().values
            
            # Precompute session blocks
            sess_blocks = []
            for s in sessions:
                sess_blocks.append(subset[subset['session_id'] == s][h_cols].values)
                
            n_sess = len(sessions)
            boot_means = np.zeros((B, len(horizons)))
            
            t0 = time.time()
            for b in range(B):
                idx = rng.integers(0, n_sess, size=n_sess)
                resampled = np.vstack([sess_blocks[i] for i in idx])
                boot_means[b] = np.mean(resampled, axis=0)
                
            logging.info(f"Bootstrap done in {time.time()-t0:.1f}s")
            
            # Simultaneous CI via max-statistic
            # 1. Compute standard error for each horizon
            se = np.std(boot_means, axis=0)
            
            # 2. Compute absolute studentized difference for each bootstrap replicate
            # M_b = max_h |boot_means[b, h] - obs_means[h]| / se[h]
            M_b = np.max(np.abs(boot_means - obs_means) / se, axis=1)
            
            # 3. Find 95th percentile of M_b
            C_95 = np.percentile(M_b, 95)
            
            # 4. Construct simultaneous CIs
            lower_ci = obs_means - C_95 * se
            upper_ci = obs_means + C_95 * se
            
            is_sig_positive = lower_ci > 0
            is_sig_negative = upper_ci < 0
            
            # Classification
            p900 = is_sig_positive[-1]
            n900 = is_sig_negative[-1]
            
            early_horizons = is_sig_positive[:-1]
            
            cls = "Mixed / inconclusive"
            if p900:
                cls = "Persistent through 15 minutes"
            elif any(early_horizons) and not p900 and not n900:
                cls = "Transitory / decaying"
            elif any(early_horizons) and n900:
                cls = "Reversal"
            elif not any(early_horizons) and any(is_sig_negative):
                cls = "Opposite-direction impact"
            elif not any(is_sig_positive) and not any(is_sig_negative):
                cls = "No reliable impact"
                
            results[f"{inst}_{d}"] = {
                "count": n,
                "status": "VALID",
                "classification": cls,
                "means": {str(horizons[i]): float(obs_means[i]) for i in range(len(horizons))},
                "lower_ci": {str(horizons[i]): float(lower_ci[i]) for i in range(len(horizons))},
                "upper_ci": {str(horizons[i]): float(upper_ci[i]) for i in range(len(horizons))}
            }
            
            print(f"\n--- {inst} {d.upper()} IMPULSE (n={n}) ---")
            print(f"Classification: {cls}")
            for i, h in enumerate(horizons):
                print(f"  {h}s: {obs_means[i]:.2f} bps [{lower_ci[i]:.2f}, {upper_ci[i]:.2f}]")
                
    out_json = script_dir / "ofi_impulse_verdict.json"
    with open(out_json, "w") as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    main()
