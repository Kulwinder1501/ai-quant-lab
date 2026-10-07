"""
Kyle's Lambda (λ) Price Impact Estimator.

Purely offline research feature implementation for estimating market depth and 
price impact parameter λ from price and volume / signed order flow data.

Model: ΔP_t = α + λ * SignedVolume_t + ε_t
Kyle's λ = Cov(ΔP, SignedVolume) / Var(SignedVolume)

STRICT BOUNDARY: Strictly an offline research module under apps/ml/.
DO NOT IMPORT into apps/api or live strategy inference components.
"""

from typing import Dict, Optional, Tuple, Union
import numpy as np
import pandas as pd


def compute_signed_volume(
    df: pd.DataFrame,
    price_col: str = "close",
    volume_col: str = "volume",
    signed_flow_col: Optional[str] = None,
) -> pd.Series:
    """
    Computes signed volume: Volume_t * sign(P_t - P_{t-1}).
    If signed_flow_col is explicitly provided (e.g. OFI), uses that instead.
    """
    if signed_flow_col is not None and signed_flow_col in df.columns:
        return df[signed_flow_col].astype(float)

    price_diff = df[price_col].diff().fillna(0.0)
    sign = np.sign(price_diff)
    return df[volume_col].astype(float) * sign


def estimate_kyle_lambda_rolling(
    df: pd.DataFrame,
    window: int = 20,
    price_col: str = "close",
    volume_col: str = "volume",
    signed_flow_col: Optional[str] = None,
    min_periods: Optional[int] = 10,
) -> pd.Series:
    """
    Estimates rolling Kyle's λ over a moving window of length `window`.
    λ = Cov(ΔP, S) / Var(S)
    
    Returns a pandas Series containing rolling Kyle's λ estimates.
    """
    if window < 2:
        raise ValueError("Window size must be at least 2 for covariance estimation.")

    if min_periods is None:
        min_periods = max(2, window // 2)

    delta_p = df[price_col].diff()
    s_vol = compute_signed_volume(df, price_col, volume_col, signed_flow_col)

    cov = delta_p.rolling(window=window, min_periods=min_periods).cov(s_vol)
    var = s_vol.rolling(window=window, min_periods=min_periods).var()

    # Prevent division by zero when signed volume variance is 0
    kyle_lambda = cov / var.replace(0.0, np.nan)
    return kyle_lambda.fillna(0.0)


def estimate_kyle_lambda_summary(
    df: pd.DataFrame,
    price_col: str = "close",
    volume_col: str = "volume",
    signed_flow_col: Optional[str] = None,
) -> Dict[str, float]:
    """
    Computes global Kyle's λ, t-statistic, R-squared, and standard error for a dataset.
    """
    delta_p = df[price_col].diff().dropna()
    s_vol = compute_signed_volume(df, price_col, volume_col, signed_flow_col).loc[delta_p.index]

    if len(delta_p) < 2:
        return {
            "kyle_lambda": 0.0,
            "t_stat": 0.0,
            "r_squared": 0.0,
            "std_err": 0.0,
            "n_obs": len(delta_p),
        }

    cov = np.cov(delta_p, s_vol)[0, 1]
    var_s = np.var(s_vol, ddof=1)

    if var_s == 0:
        return {
            "kyle_lambda": 0.0,
            "t_stat": 0.0,
            "r_squared": 0.0,
            "std_err": 0.0,
            "n_obs": len(delta_p),
        }

    lambda_est = float(cov / var_s)

    # Compute regression diagnostics
    n = len(delta_p)
    residuals = delta_p - (lambda_est * s_vol)
    ss_res = np.sum(residuals**2)
    ss_tot = np.sum((delta_p - np.mean(delta_p)) ** 2)
    r_squared = float(1.0 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0

    mse = ss_res / max(1, n - 2)
    std_err = float(np.sqrt(mse / (n * var_s))) if var_s > 0 and mse >= 0 else 0.0
    t_stat = float(lambda_est / std_err) if std_err > 0 else 0.0

    return {
        "kyle_lambda": lambda_est,
        "t_stat": t_stat,
        "r_squared": r_squared,
        "std_err": std_err,
        "n_obs": n,
    }
