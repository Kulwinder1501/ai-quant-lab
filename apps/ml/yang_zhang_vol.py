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

Output contract
---------------
* **NaN means "no estimate", never zero.** The warm-up (fewer than ``min_periods`` usable
  observations) and every window that contains an invalid OHLC row return NaN. An earlier
  version filled these with 0.0, which a downstream consumer reads as "this instrument had no
  volatility" -- the opposite of "unknown".
* A row is invalid when any price is non-finite or non-positive, or the bar is not
  self-consistent (``high`` below ``max(open, close, low)`` or ``low`` above
  ``min(open, close)``). The row after it is also unusable because its overnight return
  needs the invalid close. Any window containing either is NaN.
* A negative estimated variance (possible in a short window) is clipped to zero volatility;
  that is a finite, measured result, unlike a missing one.

Annualisation
-------------
The variance is per *bar*, so the factor is bars per year: ``trading_periods *
bars_per_session``. Daily bars: ``bars_per_session=1`` -> 252. Intraday bars: pass the
number of bars in a session (25 for NSE 15-minute bars, 75 for 5-minute), giving
252 * bars_per_day. Without this an intraday series was annualised as if each bar were a day,
understating volatility by sqrt(bars_per_session). For intraday bars the "overnight" term is
the gap from the previous bar's close: near zero inside a session and the true overnight jump
on the first bar of each session, so the estimator remains valid but the term it is named for
is only informative on the session-opening bar.

STRICT BOUNDARY: Strictly an offline research module under apps/ml/.
DO NOT IMPORT into apps/api or live strategy inference components.
"""

from typing import Optional

import numpy as np
import pandas as pd


def _invalid_ohlc_rows(o: pd.Series, h: pd.Series, l: pd.Series, c: pd.Series) -> pd.Series:
    """Boolean mask of rows that cannot support a log-return estimate."""
    finite = np.isfinite(o) & np.isfinite(h) & np.isfinite(l) & np.isfinite(c)
    positive = (o > 0) & (h > 0) & (l > 0) & (c > 0)
    consistent = (h >= np.maximum(np.maximum(o, c), l)) & (l <= np.minimum(o, c))
    return ~(finite & positive & consistent)


def compute_yang_zhang_volatility(
    df: pd.DataFrame,
    window: int = 20,
    trading_periods: int = 252,
    open_col: str = "open",
    high_col: str = "high",
    low_col: str = "low",
    close_col: str = "close",
    min_periods: Optional[int] = 10,
    bars_per_session: int = 1,
) -> pd.Series:
    """
    Computes rolling annualized Yang-Zhang volatility for OHLC data.

    Returns a pandas Series of annualized standard deviation (volatility), NaN wherever no
    valid estimate exists (warm-up, or a window containing an invalid OHLC row). See the module
    docstring for the annualisation (``trading_periods * bars_per_session``) and NaN contract.
    """
    if window < 2:
        raise ValueError("Window size must be at least 2 for variance calculation.")
    if trading_periods < 1:
        raise ValueError("trading_periods must be a positive integer.")
    if bars_per_session < 1:
        raise ValueError("bars_per_session must be a positive integer.")

    if min_periods is None:
        min_periods = max(2, window // 2)
    if min_periods < 2 or min_periods > window:
        raise ValueError("min_periods must be between 2 and window.")

    missing = [col for col in (open_col, high_col, low_col, close_col) if col not in df.columns]
    if missing:
        raise ValueError(f"OHLC columns missing from the frame: {missing}")

    o = df[open_col].astype(float)
    h = df[high_col].astype(float)
    l = df[low_col].astype(float)
    c = df[close_col].astype(float)

    invalid = _invalid_ohlc_rows(o, h, l, c)
    # The next row's overnight return reads this row's close, so it is unusable too.
    unusable = invalid | invalid.shift(1, fill_value=False)

    # Blank invalid rows BEFORE taking logs so no inf/NaN-with-warning leaks into a window.
    o, h, l, c = (series.where(~invalid) for series in (o, h, l, c))

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

    # Annualize and take square root for volatility (std dev). NaN propagates: np.maximum
    # keeps a NaN variance as NaN, and only a *measured* negative variance becomes zero.
    annualisation = float(trading_periods) * float(bars_per_session)
    yz_vol = pd.Series(np.sqrt(np.maximum(0.0, yz_var) * annualisation), index=df.index)

    # Any window that touches an unusable row has no trustworthy estimate.
    poisoned = unusable.astype(float).rolling(window=window, min_periods=1).sum() > 0
    return yz_vol.mask(poisoned)
