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

script_dir = Path(r"c:\Users\Kulwinder Singh\Desktop\personal\AI Quant Lab\apps\ml")
sys.path.insert(0, str(script_dir))

from ai_quant_lab_ml.structure_intelligence import get_db_connection_string
from ai_quant_lab_ml.cks_ofi_touch import compute_windowed_ofi_series, DepthFrameRow, recompute_sequence_flags

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

OFI_THRESHOLD = 0.032
FORWARD_HORIZON_MINUTES = 15

class FrameRow:
    __slots__ = ['received_at', 'total_buy_qty', 'total_sell_qty', 'canonical_event_at', 'is_valid', 'bid_price_0', 'ask_price_0', 'bid_qty_0', 'ask_qty_0',
                 'is_snapshot', 'is_duplicate', 'is_regression', 'gap_before']
    def __init__(self, r):
        # Real sequence-continuity flags, filled in by get_frames() from sequence_no. They used to be
        # hard-coded False/False/None when building DepthFrameRow, which let the OFI accumulator
        # difference across snapshots, duplicates, resets and gaps.
        self.is_snapshot = False
        self.is_duplicate = False
        self.is_regression = False
        self.gap_before = None
        self.received_at = r[0].astimezone(INDIA_TZ) if r[0].tzinfo else r[0].replace(tzinfo=INDIA_TZ)
        self.total_buy_qty = float(r[1]) if r[1] is not None else 0.0
        self.total_sell_qty = float(r[2]) if r[2] is not None else 0.0
        
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
        bq = r[6]
        ap = r[7]
        aq = r[8]
        self.bid_price_0 = float(bp[0]) if bp else 0.0
        self.bid_qty_0 = float(bq[0]) if bq else 0.0
        self.ask_price_0 = float(ap[0]) if ap else 0.0
        self.ask_qty_0 = float(aq[0]) if aq else 0.0

def get_frames(conn, start_dt, end_dt, session_id=None):
    query = """
        SELECT received_at, total_buy_qty, total_sell_qty, exchange_feed_time, vendor_send_time, 
               bid_price, bid_qty, ask_price, ask_qty, provider_symbol, capture_session_id,
               sequence_no, is_snapshot
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
        
    return build_frames_by_symbol(rows)


def build_frames_by_symbol(rows):
    """Group raw depth rows by futures symbol and attach REAL sequence-continuity flags.

    Flags are recomputed per symbol over ALL of its frames (valid or not) in received order from
    sequence_no (cks_ofi_touch.recompute_sequence_flags), so snapshots, duplicates, resets
    (is_regression) and gaps break the OFI chain. Frames later dropped for an invalid canonical
    timestamp are NOT silently bridged: the next kept frame gets the dropped count added to its
    gap_before so the accumulator breaks there too."""
    raw_by_sym = {}
    for r in rows:
        sym = r[9]
        if "FUT" not in sym:
            continue
        raw_by_sym.setdefault(sym, []).append(r)

    by_sym = {}
    for sym, sym_rows in raw_by_sym.items():
        seqs = [(None if r[11] is None else int(r[11]), bool(r[12])) for r in sym_rows]
        flags = recompute_sequence_flags(seqs)
        kept = []
        dropped_since_kept = 0
        for r, (gap_before, is_dup, is_reg) in zip(sym_rows, flags):
            f = FrameRow(r)
            f.is_snapshot = bool(r[12])
            f.is_duplicate = is_dup
            f.is_regression = is_reg
            f.gap_before = gap_before
            if not f.is_valid:
                if not is_dup:
                    dropped_since_kept += 1
                continue
            if dropped_since_kept and not (f.is_snapshot or is_dup or is_reg):
                f.gap_before = (gap_before or 0) + dropped_since_kept
            dropped_since_kept = 0
            kept.append(f)
        by_sym[sym] = kept
    return by_sym

def get_dpre(frames, start_idx, t_start, t_end, get_qty):
    idx = start_idx
    qtys = []
    n = len(frames)
    while idx < n:
        f = frames[idx]
        if f.canonical_event_at > t_end:
            break
        if f.canonical_event_at >= t_start:
            qtys.append(get_qty(f))
        idx += 1
    if not qtys:
        return 0.0
    return np.median(qtys)

def get_dmin(frames, start_idx, t_start, t_end, get_qty):
    idx = start_idx
    d_min = float('inf')
    t_min = None
    n = len(frames)
    while idx < n:
        f = frames[idx]
        if f.canonical_event_at > t_end:
            break
        if f.canonical_event_at >= t_start:
            q = get_qty(f)
            if q < d_min:
                d_min = q
                t_min = f.canonical_event_at
        idx += 1
    if d_min == float('inf'):
        return None, None
    return d_min, t_min

def get_frame_at(frames, start_idx, target_t):
    idx = start_idx
    best = None
    n = len(frames)
    while idx < n:
        f = frames[idx]
        if f.canonical_event_at <= target_t and f.received_at <= target_t:
            if best is None or f.canonical_event_at > best.canonical_event_at:
                best = f
        if f.received_at > target_t + timedelta(seconds=1):
            break
        idx += 1
    return best

def compute_auc30(rec_vals):
    horizons = [0, 1, 3, 5, 10, 20, 30]
    recoveries = [0.0]
    for h in horizons[1:]:
        val = rec_vals.get(f"recovery_{h}s")
        if val is None:
            return None
        recoveries.append(val)
        
    auc = 0.0
    for i in range(1, len(horizons)):
        dt = horizons[i] - horizons[i-1]
        def0 = 1.0 - recoveries[i-1]
        def1 = 1.0 - recoveries[i]
        auc += 0.5 * (def0 + def1) * dt
    return auc

def extract_episodes(frames, thresholds, sym, side):
    is_banknifty = "BANKNIFTY" in sym
    is_nifty = "NIFTY" in sym and not is_banknifty
    if not is_banknifty and not is_nifty:
        return []
        
    key = f"{'BANKNIFTY' if is_banknifty else 'NIFTY'}_{side}"
    X = thresholds.get(key, 0.0)
    if X <= 0:
        return []
        
    get_qty = (lambda f: f.total_buy_qty) if side == "buy" else (lambda f: f.total_sell_qty)
    episodes = []
    dpre_start = 0
    dmin_start = 0
    if not frames:
        return []
        
    next_eligible_time = frames[0].canonical_event_at
    for f_start in frames:
        t0 = f_start.canonical_event_at
        if t0 < next_eligible_time:
            continue
            
        t_pre_start = t0 - timedelta(seconds=5)
        t_pre_end = t0 - timedelta(seconds=0.5)
        
        while dpre_start < len(frames) and frames[dpre_start].canonical_event_at < t_pre_start:
            dpre_start += 1
            
        if dpre_start < len(frames) and frames[dpre_start].canonical_event_at > t_pre_start + timedelta(seconds=1):
            continue
            
        d_pre = get_dpre(frames, dpre_start, t_pre_start, t_pre_end, get_qty)
        if d_pre <= 0:
            continue
            
        t_win_end = t0 + timedelta(seconds=1)
        while dmin_start < len(frames) and frames[dmin_start].canonical_event_at < t0:
            dmin_start += 1
            
        d_min, t_min = get_dmin(frames, dmin_start, t0, t_win_end, get_qty)
        if d_min is None:
            continue
            
        s_t = max(0.0, (d_pre - d_min) / d_pre)
        if s_t >= X:
            horizons = [1, 3, 5, 10, 20, 30]
            rec_vals = {}
            h_search_start = dmin_start
            
            for h in horizons:
                t_h = t_min + timedelta(seconds=h)
                f_h = get_frame_at(frames, h_search_start, t_h)
                if f_h is None:
                    rec_vals[f"recovery_{h}s"] = None
                else:
                    q_h = get_qty(f_h)
                    rec_vals[f"recovery_{h}s"] = (q_h - d_min) / (d_pre - d_min) if (d_pre - d_min) > 0 else 1.0
                    
            auc30 = compute_auc30(rec_vals)
            if auc30 is not None:
                episodes.append({
                    "shock_min_at": t_min,
                    "completed_at": t_min + timedelta(seconds=30),
                    "auc30": auc30
                })
            next_eligible_time = t0 + timedelta(seconds=30)
    return episodes

def calibrate_auc_quartiles(pre_by_sym, thresholds):
    dist = {"NIFTY_buy": [], "NIFTY_sell": [], "BANKNIFTY_buy": [], "BANKNIFTY_sell": []}
    for sym, frames in pre_by_sym.items():
        is_banknifty = "BANKNIFTY" in sym
        is_nifty = "NIFTY" in sym and not is_banknifty
        for side in ["buy", "sell"]:
            key = f"{'BANKNIFTY' if is_banknifty else 'NIFTY'}_{side}"
            eps = extract_episodes(frames, thresholds, sym, side)
            for ep in eps:
                dist[key].append(ep["auc30"])
                
    q_dict = {}
    for k, v in dist.items():
        if len(v) >= 10:
            q_dict[k] = {"Q25": np.percentile(v, 25), "Q50": np.percentile(v, 50), "Q75": np.percentile(v, 75)}
            logging.info(f"AUC Quartiles for {k} (n={len(v)}): Q25={q_dict[k]['Q25']:.2f}")
        else:
            q_dict[k] = None
    return q_dict

def get_trailing_state(episodes, t_decision, q_dict_key, quartiles_dict):
    valid_eps = [ep for ep in episodes if ep["completed_at"] <= t_decision]
    valid_eps.sort(key=lambda x: x["completed_at"])
    recent_5 = valid_eps[-5:]
    if len(recent_5) < 5:
        return "STATE_UNAVAILABLE"
    oldest_t = recent_5[0]["completed_at"]
    if oldest_t < t_decision - timedelta(minutes=30):
        return "STATE_UNAVAILABLE"
    median_auc = np.median([ep["auc30"] for ep in recent_5])
    q_bounds = quartiles_dict.get(q_dict_key)
    if not q_bounds:
        return "STATE_UNAVAILABLE"
    if median_auc <= q_bounds["Q25"]:
        return "Q1"
    elif median_auc <= q_bounds["Q50"]:
        return "Q2"
    elif median_auc <= q_bounds["Q75"]:
        return "Q3"
    else:
        return "Q4"

def compute_cost_stack(sym, is_long, entry_bid, entry_ask, exit_bid, exit_ask, lot_size, extra_slippage_bps):
    entry_mid = (entry_bid + entry_ask) / 2.0
    exit_mid = (exit_bid + exit_ask) / 2.0
    
    # Validation
    spread_source = 'quoted'
    if entry_bid >= entry_ask or entry_bid <= 0 or entry_ask <= 0:
        entry_bid = entry_mid
        entry_ask = entry_mid
        spread_source = 'estimated'
    if exit_bid >= exit_ask or exit_bid <= 0 or exit_ask <= 0:
        exit_bid = exit_mid
        exit_ask = exit_mid
        spread_source = 'estimated'

    if is_long:
        trade_entry = entry_ask
        trade_exit = exit_bid
    else:
        trade_entry = entry_bid
        trade_exit = exit_ask
        
    slippage_factor = extra_slippage_bps / 10000.0
    if is_long:
        exec_entry = trade_entry * (1 + slippage_factor)
        exec_exit = trade_exit * (1 - slippage_factor)
    else:
        exec_entry = trade_entry * (1 - slippage_factor)
        exec_exit = trade_exit * (1 + slippage_factor)
        
    entry_notional = exec_entry * lot_size
    exit_notional = exec_exit * lot_size
    
    # 1. Statutory Costs
    if is_long:
        stt = exit_notional * 0.0005
        stamp_duty = entry_notional * 0.00002
    else:
        stt = entry_notional * 0.0005
        stamp_duty = exit_notional * 0.00002
        
    sebi_entry = entry_notional * 0.000001
    sebi_exit = exit_notional * 0.000001
    
    # 2. Exchange & Broker Costs
    nse_entry = entry_notional * 0.0000183
    nse_exit = exit_notional * 0.0000183
    
    brokerage_entry = min(20.0, entry_notional * 0.0003)
    brokerage_exit = min(20.0, exit_notional * 0.0003)
    
    gst = 0.18 * (sebi_entry + sebi_exit + nse_entry + nse_exit + brokerage_entry + brokerage_exit)
    
    total_cost_inr = (stt + stamp_duty + sebi_entry + sebi_exit + 
                      nse_entry + nse_exit + brokerage_entry + brokerage_exit + gst)
                      
    if is_long:
        gross_pnl = (exec_exit - exec_entry) * lot_size
        gross_mid_pnl = (exit_mid - entry_mid) * lot_size
    else:
        gross_pnl = (exec_entry - exec_exit) * lot_size
        gross_mid_pnl = (entry_mid - exit_mid) * lot_size
        
    net_pnl = gross_pnl - total_cost_inr
    
    gross_mid_bps = (gross_mid_pnl / (entry_mid * lot_size)) * 10000.0
    
    # Deconstruct spread cost vs mid
    if is_long:
        spread_bps = ((entry_ask - entry_mid) + (exit_mid - exit_bid)) / entry_mid * 10000.0
    else:
        spread_bps = ((entry_mid - entry_bid) + (exit_ask - exit_mid)) / entry_mid * 10000.0
        
    fixed_cost_bps = (total_cost_inr / (entry_mid * lot_size)) * 10000.0
    true_net_bps = gross_mid_bps - spread_bps - (extra_slippage_bps * 2) - fixed_cost_bps
    
    return {
        "gross_mid_bps": gross_mid_bps,
        "spread_crossing_bps": spread_bps,
        "slippage_bps": extra_slippage_bps * 2,
        "statutory_exchange_broker_bps": fixed_cost_bps,
        "true_net_bps": true_net_bps,
        "spread_source": spread_source,
        "cost_inr_breakdown": {
            "stt": stt,
            "stamp_duty": stamp_duty,
            "sebi": sebi_entry + sebi_exit,
            "nse": nse_entry + nse_exit,
            "brokerage": brokerage_entry + brokerage_exit,
            "gst": gst
        }
    }

def main():
    conn_str = get_db_connection_string()
    
    # 1. Fetch Lot Sizes dynamically
    lot_sizes = {}
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT symbol, lot_size FROM instruments WHERE is_active = true OR is_active = false")
            for r in cur.fetchall():
                lot_sizes[r[0]] = int(r[1])
                
        logging.info("Fetching Pre-OOS calibration frames...")
        pre_oos_dt = datetime(2026, 9, 26, tzinfo=INDIA_TZ)
        pre_oos_start = pre_oos_dt - timedelta(days=7)
        
        shock_thresholds = {"NIFTY_buy": 0.0, "NIFTY_sell": 0.0, "BANKNIFTY_buy": 1.0, "BANKNIFTY_sell": 1.0}
        pre_by_sym = get_frames(conn, pre_oos_start, pre_oos_dt)
        auc_quartiles = calibrate_auc_quartiles(pre_by_sym, shock_thresholds)
        del pre_by_sym
        
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
            
        logging.info("Reconstructing Q1 opportunities...")
        
        q1_events = []
        for (sess_id, min_t, max_t) in capture_sessions:
            sess_by_sym = get_frames(conn, min_t, max_t, sess_id)
            
            for sym, frames in sess_by_sym.items():
                is_banknifty = "BANKNIFTY" in sym
                is_nifty = "NIFTY" in sym and not is_banknifty
                if not is_banknifty and not is_nifty: continue
                    
                eps_buy = extract_episodes(frames, shock_thresholds, sym, "buy")
                eps_sell = extract_episodes(frames, shock_thresholds, sym, "sell")
                
                dframes = [DepthFrameRow(received_at=f.received_at, is_snapshot=f.is_snapshot,
                            is_duplicate=f.is_duplicate, gap_before=f.gap_before,
                            bid_price_0=f.bid_price_0, bid_qty_0=f.bid_qty_0,
                            ask_price_0=f.ask_price_0, ask_qty_0=f.ask_qty_0,
                            is_regression=f.is_regression) for f in frames]
                    
                ofi_obs = compute_windowed_ofi_series(dframes)
                if not ofi_obs: continue
                    
                start_cadence = frames[0].received_at.replace(second=0, microsecond=0) + timedelta(minutes=1)
                end_cadence = frames[-1].received_at - timedelta(minutes=FORWARD_HORIZON_MINUTES + 1)
                
                t = start_cadence
                frame_times = [f.received_at for f in frames]
                ofi_times = [obs.at for obs in ofi_obs]
                
                # Fetch dynamically, fallback to 15 if missing (but we query exact symbol match)
                lot_size = lot_sizes.get(sym, 15)
                
                while t <= end_cadence:
                    idx = np.searchsorted(frame_times, t) - 1
                    if idx < 0 or (t - frames[idx].received_at).total_seconds() > 5.0:
                        t += timedelta(seconds=30); continue
                        
                    ofi_idx = np.searchsorted(ofi_times, t) - 1
                    if ofi_idx < 0:
                        t += timedelta(seconds=30); continue
                        
                    ofi_val = ofi_obs[ofi_idx].window_sum
                    
                    if abs(ofi_val) > OFI_THRESHOLD:
                        is_long = ofi_val > 0
                        opposing_side = "sell" if is_long else "buy"
                        episodes_pool = eps_sell if is_long else eps_buy
                        key = f"{'BANKNIFTY' if is_banknifty else 'NIFTY'}_{opposing_side}"
                        
                        quartile = get_trailing_state(episodes_pool, t, key, auc_quartiles)
                        
                        if quartile == "Q1":
                            nearest_frame = frames[idx]
                            exit_t = t + timedelta(minutes=FORWARD_HORIZON_MINUTES)
                            exit_idx = np.searchsorted(frame_times, exit_t)
                            
                            if exit_idx < len(frame_times):
                                exit_frame = frames[exit_idx]
                                q1_events.append({
                                    "sym": sym,
                                    "lot_size": lot_size,
                                    "is_long": is_long,
                                    "entry_bid": nearest_frame.bid_price_0,
                                    "entry_ask": nearest_frame.ask_price_0,
                                    "exit_bid": exit_frame.bid_price_0,
                                    "exit_ask": exit_frame.ask_price_0
                                })
                                
                    t += timedelta(seconds=30)
                    
    logging.info(f"Reconstructed {len(q1_events)} valid Q1 OFI opportunities.")
    if not q1_events:
        return
        
    sensitivity_levels = [0.0, 0.25, 0.5, 1.0, 2.0]
    results = {}
    
    for level in sensitivity_levels:
        level_stats = []
        for ev in q1_events:
            cs = compute_cost_stack(ev['sym'], ev['is_long'], 
                                    ev['entry_bid'], ev['entry_ask'], 
                                    ev['exit_bid'], ev['exit_ask'], 
                                    ev['lot_size'], level)
            level_stats.append(cs)
            
        df = pd.DataFrame(level_stats)
        results[f"slip_{level}bps"] = {
            "n_events": len(df),
            "mean_gross_mid_bps": float(df['gross_mid_bps'].mean()),
            "mean_spread_bps": float(df['spread_crossing_bps'].mean()),
            "mean_slippage_bps": float(df['slippage_bps'].mean()),
            "mean_statutory_exchange_broker_bps": float(df['statutory_exchange_broker_bps'].mean()),
            "mean_true_net_bps": float(df['true_net_bps'].mean()),
            "quoted_spread_coverage_pct": float((df['spread_source'] == 'quoted').mean() * 100),
            "per_trade_logs": level_stats
        }
        
    # Default baseline is 0.5 bps
    baseline = results["slip_0.5bps"]
    print("\n================================================")
    print(" COST STACK VALIDATION REPORT (Baseline 0.5 bps)")
    print("================================================")
    print(f"Total Q1 Opportunities Analyzed: {baseline['n_events']}")
    print(f"Quoted Spread Data Availability: {baseline['quoted_spread_coverage_pct']:.1f}%\n")
    print(f"Mean Gross Return (Mid-to-Mid):  +{baseline['mean_gross_mid_bps']:.2f} bps")
    print(f"  - Actual Quoted Spread Cost:   -{baseline['mean_spread_bps']:.2f} bps")
    print(f"  - Residual Slippage (0.5/leg): -{baseline['mean_slippage_bps']:.2f} bps")
    print(f"  - Statutory, Exch, & Broker:   -{baseline['mean_statutory_exchange_broker_bps']:.2f} bps")
    print("------------------------------------------------")
    print(f"TRUE NET RETURN (Actual Cost):   {baseline['mean_true_net_bps']:.2f} bps")
    
    out_json = script_dir / "cost_validation_report.json"
    with open(out_json, "w") as f:
        json.dump(results, f, indent=2)

if __name__ == "__main__":
    main()
