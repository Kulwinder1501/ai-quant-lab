import os
import psycopg2
import pandas as pd
import numpy as np

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")
MAX_ENTRY_LIQUIDITY_RATIO = 0.15  # execution-liquidity-policy-v1

def main():
    print("Connecting to DB...")
    conn = psycopg2.connect(DATABASE_URL)
    
    print("Loading XAU_USD M15 MID...")
    xau = pd.read_sql("""
        SELECT open_time, open, high, low, close 
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = 'XAU_USD' AND c.timeframe = '15m'
        ORDER BY open_time ASC
    """, conn, index_col='open_time', parse_dates=['open_time'])
    
    print("Loading DXY M15 SYNTH_DXY...")
    dxy = pd.read_sql("""
        SELECT open_time, open, high, low, close 
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = 'DXY' AND c.timeframe = '15m'
        ORDER BY open_time ASC
    """, conn, index_col='open_time', parse_dates=['open_time'])
    
    # 1. Base Signal (Phase 0 logic preserved exactly)
    xau['body'] = abs(xau['close'] - xau['open'])
    xau['body_sma20'] = xau['body'].rolling(20).mean()
    xau['trigger'] = xau['body'] > xau['body_sma20']
    
    xau['signal'] = 0
    xau.loc[xau['trigger'] & (xau['close'] > xau['open']), 'signal'] = 1
    xau.loc[xau['trigger'] & (xau['close'] < xau['open']), 'signal'] = -1
    
    # Generate geometric R values based on Phase 0 MID geometry
    xau['mid_entry_price'] = xau['close']
    xau['mid_sl_price'] = xau.apply(lambda r: r['low'] if r['signal'] == 1 else (r['high'] if r['signal'] == -1 else np.nan), axis=1)
    xau['mid_risk'] = abs(xau['mid_entry_price'] - xau['mid_sl_price'])
    xau['mid_tp_price'] = xau.apply(lambda r: r['mid_entry_price'] + (1.5 * r['mid_risk']) if r['signal'] == 1 else (r['mid_entry_price'] - (1.5 * r['mid_risk']) if r['signal'] == -1 else np.nan), axis=1)

    # 2. DXY Veto
    dxy_daily = dxy.resample('1D').agg({'open': 'first', 'high': 'max', 'low': 'min', 'close': 'last'}).dropna()
    dxy_daily['prev_close'] = dxy_daily['close'].shift(1)
    dxy_daily = dxy_daily.dropna()
    
    dxy_daily['o_var'] = np.log(dxy_daily['open'] / dxy_daily['prev_close']) ** 2
    dxy_daily['c_var'] = np.log(dxy_daily['close'] / dxy_daily['open']) ** 2
    dxy_daily['rs_var'] = (np.log(dxy_daily['high'] / dxy_daily['open']) * np.log(dxy_daily['high'] / dxy_daily['close']) + 
                           np.log(dxy_daily['low'] / dxy_daily['open']) * np.log(dxy_daily['low'] / dxy_daily['close']))
    
    N = 20
    o_var_N = dxy_daily['o_var'].rolling(N).mean()
    c_var_N = dxy_daily['c_var'].rolling(N).mean()
    rs_var_N = dxy_daily['rs_var'].rolling(N).mean()
    
    k = 0.34 / (1.34 + (N + 1) / (N - 1))
    dxy_daily['yz_vol'] = np.sqrt(o_var_N + k * c_var_N + (1 - k) * rs_var_N)
    dxy_daily['yz_vol_shifted'] = dxy_daily['yz_vol'].shift(1)
    dxy_daily['yz_median_20'] = dxy_daily['yz_vol_shifted'].rolling(20).median()
    
    dxy['date'] = dxy.index.floor('D')
    dxy_daily['date'] = dxy_daily.index
    dxy = dxy.reset_index().merge(dxy_daily[['date', 'yz_vol_shifted', 'yz_median_20']], on='date', how='left').set_index('open_time')
    
    dxy['sma50'] = dxy['close'].rolling(50).mean()
    dxy['dxy_expanding'] = dxy['yz_vol_shifted'] > dxy['yz_median_20']
    
    xau['dxy_close'] = dxy['close']
    xau['dxy_sma50'] = dxy['sma50']
    xau['dxy_expanding'] = dxy['dxy_expanding']
    
    xau['dxy_gate'] = False
    xau.loc[(xau['signal'] == 1) & (xau['dxy_close'] < xau['dxy_sma50']) & xau['dxy_expanding'], 'dxy_gate'] = True
    xau.loc[(xau['signal'] == -1) & (xau['dxy_close'] > xau['dxy_sma50']) & xau['dxy_expanding'], 'dxy_gate'] = True
    
    candidates = xau[xau['signal'] != 0].copy()
    print(f"Total Candidates: {len(candidates)}")

    # 3. Simulate Phase 0.1 M1 Bid/Ask Execution
    print("Loading XAU_USD M1 Bid/Ask execution dataset...")
    m1_data = pd.read_sql("""
        SELECT time, bid_open, bid_high, bid_low, bid_close, ask_open, ask_high, ask_low, ask_close 
        FROM oanda_bid_ask_candles 
        WHERE instrument = 'XAU_USD' AND granularity = '1m'
        ORDER BY time ASC
    """, conn, index_col='time', parse_dates=['time'])
    
    if m1_data.index.tz is None:
        m1_data.index = m1_data.index.tz_localize('UTC')
    else:
        m1_data.index = m1_data.index.tz_convert('UTC')
        
    if xau.index.tz is None:
        xau.index = xau.index.tz_localize('UTC')
    else:
        xau.index = xau.index.tz_convert('UTC')

    results = []
    excluded_data_quality = 0

    for idx, row in candidates.iterrows():
        signalAt = idx + pd.Timedelta(minutes=15)
        # Entry assumption = next M1 open
        entry_time = signalAt
        
        # We need a slice of the next say 72 hours for execution modeling
        exec_path = m1_data.loc[entry_time : entry_time + pd.Timedelta(hours=72)]
        if len(exec_path) == 0:
            excluded_data_quality += 1
            continue
            
        entry_bar = exec_path.iloc[0]
        if (entry_bar.name - entry_time).total_seconds() > 60: # Gaps > 1m means missing execution data
            excluded_data_quality += 1
            continue

        direction = row['signal']
        # EXACT PHASE 0 GEOMETRY for absolute levels:
        sl_price = row['mid_sl_price']
        tp_price = row['mid_tp_price']
        stop_dist = row['mid_risk']
        
        if direction == 1:
            entry = entry_bar['ask_open']
            spread = entry_bar['ask_open'] - entry_bar['bid_open']
        else:
            entry = entry_bar['bid_open']
            spread = entry_bar['ask_open'] - entry_bar['bid_open']
            
        if pd.isna(spread) or pd.isna(stop_dist) or stop_dist == 0:
            excluded_data_quality += 1
            continue
            
        spread_ratio = spread / stop_dist
        
        # Evaluate execution path
        outcome_r = 0.0
        resolved = False
        
        for p_idx, p_row in exec_path.iterrows():
            if direction == 1: # Long exits against Bid
                sl_hit = p_row['bid_low'] <= sl_price
                tp_hit = p_row['bid_high'] >= tp_price
            else: # Short exits against Ask
                sl_hit = p_row['ask_high'] >= sl_price
                tp_hit = p_row['ask_low'] <= tp_price
                
            if sl_hit and tp_hit:
                # Intrabar collision! Escalate to S5 for this minute.
                s5_start = p_idx.isoformat() + 'Z'
                s5_end = (p_idx + pd.Timedelta(minutes=1)).isoformat() + 'Z'
                
                try:
                    import requests
                    headers = {"Authorization": "Bearer 12c98f9d99857239738300a59493e147-024e390f598c460af78cc44fccd1e97e", "Accept-Datetime-Format": "RFC3339"}
                    url = f"https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles?granularity=S5&price=BAM&from={s5_start}&to={s5_end}"
                    resp = requests.get(url, headers=headers)
                    if resp.status_code == 200:
                        s5_candles = resp.json().get('candles', [])
                        s5_resolved = False
                        for s5c in s5_candles:
                            if direction == 1:
                                s5_sl = float(s5c['bid']['l']) <= sl_price
                                s5_tp = float(s5c['bid']['h']) >= tp_price
                            else:
                                s5_sl = float(s5c['ask']['h']) >= sl_price
                                s5_tp = float(s5c['ask']['l']) <= tp_price
                                
                            if s5_sl and s5_tp:
                                # Still collided inside a 5-second bar, use CONSERVATIVE_LOSS
                                outcome_r = -1.0
                                s5_resolved = True
                                break
                            elif s5_sl:
                                outcome_r = -1.0
                                s5_resolved = True
                                break
                            elif s5_tp:
                                outcome_r = 1.5
                                s5_resolved = True
                                break
                                
                        if s5_resolved:
                            resolved = True
                            break
                        
                except Exception as e:
                    print(f"Failed to fetch S5 for {s5_start}: {e}")
                    
                # If S5 failed or still unresolved, fallback to CONSERVATIVE_LOSS
                outcome_r = -1.0
                resolved = True
                break
            elif sl_hit:
                outcome_r = -1.0
                resolved = True
                break
            elif tp_hit:
                outcome_r = 1.5
                resolved = True
                break
                
        if not resolved:
            # Reached end of 72h path or data end
            excluded_data_quality += 1
            continue
            
        results.append({
            'time': idx,
            'dxy_gated': row['dxy_gate'],
            'spread_ratio': spread_ratio,
            'R': outcome_r,
            'entry_price_impact_vs_reference': entry - row['mid_entry_price'],
            'historical_bid_ask_spread': spread,
            'valid': True
        })

    print(f"Excluded due to missing/broken M1 execution data: {excluded_data_quality}")
    
    res_df = pd.DataFrame(results)
    if len(res_df) == 0:
        print("No valid trades parsed.")
        return

    # COMMON VALID MASK
    valid_set = res_df[res_df['valid'] == True]
    
    # 0.1A: Ungated Baseline
    ungated_r = valid_set['R'].mean()
    
    # 0.1A: Gated Baseline (No spread veto)
    gated = valid_set[valid_set['dxy_gated'] == True]
    gated_r = gated['R'].mean()
    
    # 0.1B: Spread Veto 
    spread_vetoed = valid_set[(valid_set['dxy_gated'] == True) & (valid_set['spread_ratio'] <= MAX_ENTRY_LIQUIDITY_RATIO)]
    spread_vetoed_r = spread_vetoed['R'].mean()
    
    print("\n=== PHASE 0.1 RESULTS ===")
    print(f"Total Valid Candidate Pairs: {len(valid_set)}")
    print(f"Ungated Expectancy: {ungated_r:.3f} R")
    print(f"DXY-Gated Expectancy (0.1A): {gated_r:.3f} R (n={len(gated)})")
    print(f"DXY-Gated + Spread Veto (0.1B): {spread_vetoed_r:.3f} R (n={len(spread_vetoed)})")
    
    # Block Bootstrap (Simplified)
    def bootstrap_diff(df, iters=1000):
        np.random.seed(42)
        diffs = []
        for _ in range(iters):
            samp = df.sample(frac=1, replace=True)
            u = samp['R'].mean()
            g = samp[samp['dxy_gated'] == True]['R'].mean()
            diffs.append(g - u)
        return np.percentile(diffs, 2.5), np.percentile(diffs, 97.5)
        
    ci_lower, ci_upper = bootstrap_diff(valid_set)
    print(f"Delta Expectancy (Gated - Ungated) 95% CI: [{ci_lower:.3f}, {ci_upper:.3f}] R")

if __name__ == "__main__":
    main()
