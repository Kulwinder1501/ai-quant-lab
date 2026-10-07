"""
Yang-Zhang Minimum-Variance Volatility Estimator.

Purely offline research feature implementation combining overnight jump variance
and Rogers-Satchell intraday volatility estimator.

Formula:
  σ²_YZ = σ²_o + k * σ²_c + (1 - k) * σ²_rs
where:
  k = 0.34 / (1.34 + (n + 1) / (n - 1))
  σ²_o  = Variance of overnight returns v_o = ln(Open_t / Close_{t-1})
  σ²_c  = Variance of open-to-close returns v_c = ln(Close_t / Open_t)
  σ²_rs = Rogers-Satchell variance = ln(High_t / Close_t)*ln(High_t / Open_t) + ln(Low_t / Close_t)*ln(Low_t / Open_t)

STRICT BOUNDARY: Strictly an offline research module under apps/ml/.
DO NOT IMPORT into apps/api or live strategy inference components.
"""

from typing import Optional
import numpy as np
import pandas as pd


def compute_yang_zhang_volatility(
    df: pd.DataFrame,
    window: int = 20,
    trading_periods: int = 252,
    open_col: str = "open",
    high_col: str = "high",
    low_col: str = "low",
    close_col: str = "close",
    min_periods: Optional[int] = 10,
) -> pd.Series:
    """
    Computes rolling annualized Yang-Zhang volatility for OHLC data.

    Returns pandas Series of annualized standard deviation (volatility).
    """
    if window < 2:
        raise ValueError("Window size must be at least 2 for variance calculation.")

    if min_periods is None:
        min_periods = max(2, window // 2)

    o = df[open_col].astype(float)
    h = df[high_col].astype(float)
    l = df[low_col].astype(float)
    c = df[close_col].astype(float)

    # Prev close for overnight return
    prev_c = c.shift(1)

    # Log returns
    log_ho = np.log(h / o)
    log_lo = np.log(l / o)
    log_co = np.log(c / o)

    log_hc = np.log(h / c)
    log_lc = np.log(l / c)

    # Overnight return v_o = ln(O_t / C_{t-1})
    log_oc = np.log(o / prev_c)

    # Rogers-Satchell variance term
    rs = log_hc * log_ho + log_lc * log_lo

    # Rolling component variances
    var_o = log_oc.rolling(window=window, min_periods=min_periods).var(ddof=1)
    var_c = log_co.rolling(window=window, min_periods=min_periods).var(ddof=1)
    var_rs = rs.rolling(window=window, min_periods=min_periods).mean()

    # Weight k
    n = float(window)
    k = 0.34 / (1.34 + (n + 1.0) / (n - 1.0))

    # Total Yang-Zhang variance
    yz_var = var_o + k * var_c + (1.0 - k) * var_rs

    # Annualize and take square root for volatility (std dev)
    yz_vol = np.sqrt(np.maximum(0.0, yz_var) * trading_periods)

    return pd.Series(yz_vol, index=df.index).fillna(0.0)
