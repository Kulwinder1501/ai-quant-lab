import os
import psycopg2
import pandas as pd
import numpy as np

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")

def main():
    print("Connecting to DB...")
    conn = psycopg2.connect(DATABASE_URL)
    
    print("Loading XAU_USD 15m...")
    xau = pd.read_sql("""
        SELECT open_time, open, high, low, close 
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = 'XAU_USD' AND c.timeframe = '15m'
        ORDER BY open_time ASC
    """, conn, index_col='open_time', parse_dates=['open_time'])
    
    print("Loading DXY 15m...")
    dxy = pd.read_sql("""
        SELECT open_time, open, high, low, close 
        FROM candles c
        JOIN instruments i ON i.id = c.instrument_id
        WHERE i.symbol = 'DXY' AND c.timeframe = '15m'
        ORDER BY open_time ASC
    """, conn, index_col='open_time', parse_dates=['open_time'])
    
    for df in [xau, dxy]:
        for c in ['open', 'high', 'low', 'close']:
            df[c] = df[c].astype(float)
            
    print(f"XAU shape: {xau.shape}, DXY shape: {dxy.shape}")

    # 1. Baseline Strategy on XAU
    xau['body'] = abs(xau['close'] - xau['open'])
    xau['body_sma20'] = xau['body'].rolling(20).mean()
    xau['trigger'] = xau['body'] > xau['body_sma20']
    
    xau['signal'] = 0
    xau.loc[xau['trigger'] & (xau['close'] > xau['open']), 'signal'] = 1
    xau.loc[xau['trigger'] & (xau['close'] < xau['open']), 'signal'] = -1
    
    # 2. DXY YZ Volatility
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
    
    # 3. Apply Gates
    xau['dxy_close'] = dxy['close']
    xau['dxy_sma50'] = dxy['sma50']
    xau['dxy_expanding'] = dxy['dxy_expanding']
    
    xau['gated_signal'] = 0
    xau.loc[(xau['signal'] == 1) & (xau['dxy_close'] < xau['dxy_sma50']) & xau['dxy_expanding'], 'gated_signal'] = 1
    xau.loc[(xau['signal'] == -1) & (xau['dxy_close'] > xau['dxy_sma50']) & xau['dxy_expanding'], 'gated_signal'] = -1
    
    # 4. Simulation
    SPREAD = 0.20 # $0.20 per oz round trip (20 pipettes)
    
    def run_sim(signals_col):
        trades = []
        in_trade = False
        entry_price = 0
        sl_price = 0
        tp_price = 0
        direction = 0
        
        for idx, row in xau.iterrows():
            if in_trade:
                # Check for SL or TP (very basic 15m resolution check)
                # Since we don't have 1m data loaded in memory, we assume worst case for intrabar: SL hit before TP if both hit
                low, high = row['low'], row['high']
                
                sl_hit = False
                tp_hit = False
                
                if direction == 1:
                    if low <= sl_price: sl_hit = True
                    elif high >= tp_price: tp_hit = True
                else:
                    if high >= sl_price: sl_hit = True
                    elif low <= tp_price: tp_hit = True
                    
                if sl_hit or tp_hit:
                    exit_price = sl_price if sl_hit else tp_price
                    pnl = (exit_price - entry_price) * direction - SPREAD
                    trades.append({'entry': entry_price, 'exit': exit_price, 'pnl': pnl, 'type': 'sl' if sl_hit else 'tp'})
                    in_trade = False
            
            if not in_trade and row[signals_col] != 0:
                in_trade = True
                direction = row[signals_col]
                # Enter at next candle open, but for simplicity here we enter at current close
                # Actually, let's enter at current close + spread
                entry_price = row['close']
                sl_price = row['low'] if direction == 1 else row['high']
                risk = abs(entry_price - sl_price)
                if risk == 0:
                    in_trade = False
                    continue
                tp_price = entry_price + (1.5 * risk * direction)
                
        return pd.DataFrame(trades)
        
    print("Running Baseline...")
    baseline_trades = run_sim('signal')
    print("Running Gated...")
    gated_trades = run_sim('gated_signal')
    
    def get_metrics(name, df):
        if df.empty: return f"{name}: No trades"
        win_rate = len(df[df['pnl'] > 0]) / len(df)
        gross_profit = df[df['pnl'] > 0]['pnl'].sum()
        gross_loss = abs(df[df['pnl'] < 0]['pnl'].sum())
        pf = gross_profit / gross_loss if gross_loss != 0 else float('inf')
        cum_pnl = df['pnl'].cumsum()
        max_dd = (cum_pnl.cummax() - cum_pnl).max()
        return f"{name} - Trades: {len(df)}, WinRate: {win_rate:.2%}, ProfitFactor: {pf:.2f}, MaxDD: {max_dd:.2f}, TotalPnL: {cum_pnl.iloc[-1]:.2f}"
        
    print("-" * 50)
    print(get_metrics("Baseline", baseline_trades))
    print(get_metrics("DXY-Gated", gated_trades))
    print("-" * 50)

if __name__ == "__main__":
    main()
