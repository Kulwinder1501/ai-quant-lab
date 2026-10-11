"""
Kyle's Lambda (λ) Price Impact Estimator.

Purely offline research feature implementation for estimating market depth and 
price impact parameter λ from price and volume / signed order flow data.

Model: ΔP_t = α + λ * SignedVolume_t + ε_t
Kyle's λ = Cov(ΔP, SignedVolume) / Var(SignedVolume)

SIGNED VOLUME MUST BE SUPPLIED BY THE CALLER (an independent trade-direction measure such as
OFI or a trade-classified aggressor volume). The previous default, `volume * sign(ΔP)`, is
CIRCULAR: it is built from the very ΔP it is regressed on, so λ comes out positive and "significant"
by construction on any data. `compute_signed_volume` therefore raises unless `signed_flow_col`
is given; the tick-rule construction is still available behind the explicit
`allow_circular_tick_rule=True` opt-in for diagnostics only (never evidence of price impact).

Missing data is propagated, never invented: undefined estimates are NaN (not 0.0).

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
    allow_circular_tick_rule: bool = False,
) -> pd.Series:
    """
    Returns the caller-supplied signed volume column (e.g. OFI) as floats.

    Raises ValueError if `signed_flow_col` is None or absent from `df`: a signed volume derived from
    the same price change it is regressed on (`volume * sign(ΔP)`) is circular and would manufacture
    a "significant" λ out of nothing. Pass `allow_circular_tick_rule=True` to explicitly get that
    tick-rule series anyway (diagnostics only). NaN stays NaN (the first bar has no ΔP, so its
    tick-rule value is NaN, not 0).
    """
    if signed_flow_col is not None:
        if signed_flow_col not in df.columns:
            raise ValueError(
                f"signed_flow_col '{signed_flow_col}' not found in DataFrame columns."
            )
        return df[signed_flow_col].astype(float)

    if not allow_circular_tick_rule:
        raise ValueError(
            "signed_flow_col is required: signed volume must come from an independent trade-direction "
            "measure (e.g. OFI). The default volume*sign(dP) is circular when regressed on dP. "
            "Pass allow_circular_tick_rule=True to opt in for diagnostics only."
        )

    price_diff = df[price_col].diff()
    sign = np.sign(price_diff)
    return df[volume_col].astype(float) * sign


def estimate_kyle_lambda_rolling(
    df: pd.DataFrame,
    window: int = 20,
    price_col: str = "close",
    volume_col: str = "volume",
    signed_flow_col: Optional[str] = None,
    min_periods: Optional[int] = 10,
    allow_circular_tick_rule: bool = False,
) -> pd.Series:
    """
    Estimates rolling Kyle's λ over a moving window of length `window`.
    λ = Cov(ΔP, S) / Var(S)
    
    Returns a pandas Series containing rolling Kyle's λ estimates. Windows with too few
    observations or zero signed-volume variance are NaN (NOT 0.0: a zero would read as
    "no price impact" when the truth is "not estimable").
    """
    if window < 2:
        raise ValueError("Window size must be at least 2 for covariance estimation.")

    if min_periods is None:
        min_periods = max(2, window // 2)

    delta_p = df[price_col].diff()
    s_vol = compute_signed_volume(
        df, price_col, volume_col, signed_flow_col, allow_circular_tick_rule=allow_circular_tick_rule
    )

    cov = delta_p.rolling(window=window, min_periods=min_periods).cov(s_vol)
    var = s_vol.rolling(window=window, min_periods=min_periods).var()

    # Prevent division by zero when signed volume variance is 0 (undefined -> NaN, propagated).
    kyle_lambda = cov / var.replace(0.0, np.nan)
    return kyle_lambda


def _undefined_summary(n_obs: int) -> Dict[str, float]:
    nan = float("nan")
    return {
        "kyle_lambda": nan,
        "t_stat": nan,
        "r_squared": nan,
        "std_err": nan,
        "n_obs": n_obs,
    }


def estimate_kyle_lambda_summary(
    df: pd.DataFrame,
    price_col: str = "close",
    volume_col: str = "volume",
    signed_flow_col: Optional[str] = None,
    allow_circular_tick_rule: bool = False,
) -> Dict[str, float]:
    """
    Computes global Kyle's λ, t-statistic, R-squared, and standard error for a dataset.

    Rows where ΔP or the signed volume is NaN are dropped (never zero-filled). If fewer than 2
    usable rows remain, or the signed volume has zero variance, every statistic is NaN.
    """
    delta_p_all = df[price_col].diff()
    s_vol_all = compute_signed_volume(
        df, price_col, volume_col, signed_flow_col, allow_circular_tick_rule=allow_circular_tick_rule
    )
    paired = pd.concat([delta_p_all.rename("dp"), s_vol_all.rename("s")], axis=1).dropna()
    delta_p = paired["dp"]
    s_vol = paired["s"]

    if len(delta_p) < 2:
        return _undefined_summary(len(delta_p))

    cov = np.cov(delta_p, s_vol)[0, 1]
    var_s = np.var(s_vol, ddof=1)

    if var_s == 0:
        return _undefined_summary(len(delta_p))

    lambda_est = float(cov / var_s)
    # cov/var_s is the OLS slope of the model WITH an intercept (this docstring's own
    # Delta_P = alpha + lambda*SignedVolume + eps) -- the intercept itself still has to be
    # recovered and subtracted before residuals mean anything, otherwise ss_res/r_squared/std_err
    # are only correct by coincidence, when both series happen to have a near-zero sample mean.
    alpha_est = float(np.mean(delta_p) - lambda_est * np.mean(s_vol))

    # Compute regression diagnostics
    n = len(delta_p)
    residuals = delta_p - (alpha_est + lambda_est * s_vol)
    ss_res = np.sum(residuals**2)
    ss_tot = np.sum((delta_p - np.mean(delta_p)) ** 2)
    r_squared = float(1.0 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0

    # Sxx = sum((s_vol - mean(s_vol))**2) = (n - 1) * var_s (var_s uses ddof=1), the actual
    # denominator of Var(lambda_hat) = MSE / Sxx -- not n * var_s, which understates the standard
    # error (and so overstates t_stat) by a factor that shrinks with n but is not negligible on
    # the small rolling windows this module's own min_periods default anticipates.
    mse = ss_res / max(1, n - 2)
    sxx = (n - 1) * var_s
    std_err = float(np.sqrt(mse / sxx)) if sxx > 0 and mse >= 0 else 0.0
    t_stat = float(lambda_est / std_err) if std_err > 0 else 0.0

    return {
        "kyle_lambda": lambda_est,
        "t_stat": t_stat,
        "r_squared": r_squared,
        "std_err": std_err,
        "n_obs": n,
    }
