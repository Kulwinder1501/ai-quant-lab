"""Phase 3: Hypothesis 2 Strategy Gating & Day-Level Paired Bootstrap Evaluator.

Implements:
- Strategy signal filtering against RVOL_ToD thresholds:
    * Surge Gate: RVOL_ToD >= 1.25
    * Compression Filter: Block if RVOL_ToD < 0.75
- Day-Level Paired Bootstrapping (10,000 replicates):
    * Resample trading days with replacement.
    * Compute trade-weighted pooled expectancy E[R] for Control vs Gate arms.
    * Compute Delta E[R] = E[R]_Gate - E[R]_Control.
    * Handle zero-trade days and degenerate replicates.
- Minimum Sample Rules & Pre-registered Deferral Rule (N_trades >= 100, N_days >= 20).
- Economic Pass Hurdle (Delta E[R] >= +0.15R, 95% CI > 0.00R).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
import numpy as np
import pandas as pd


@dataclass
class H2EvaluationResult:
    strategy_key: str
    control_trade_count: int
    gate_trade_count: int
    control_expectancy_r: float
    gate_expectancy_r: float
    delta_expectancy_r: float
    ci_lower_r: float
    ci_upper_r: float
    num_days: int
    is_deferred: bool
    pass_h2: bool
    details: list[str]


def day_level_paired_bootstrap(
    daily_trades_control: dict[date, list[float]],
    daily_trades_gate: dict[date, list[float]],
    num_bootstraps: int = 10000,
    alpha: float = 0.05,
    random_state: int = 42,
) -> tuple[float, float, float, float, int]:
    """Perform day-level paired bootstrapping to evaluate Delta E[R] and its 95% CI."""
    rng = np.random.default_rng(random_state)
    all_dates = sorted(set(daily_trades_control.keys()) | set(daily_trades_gate.keys()))
    num_days = len(all_dates)

    if num_days == 0:
        return 0.0, 0.0, 0.0, 0.0, 0

    # Calculate point estimates
    all_control_r = [r for d in all_dates for r in daily_trades_control.get(d, [])]
    all_gate_r = [r for d in all_dates for r in daily_trades_gate.get(d, [])]

    control_exp = float(np.mean(all_control_r)) if len(all_control_r) > 0 else 0.0
    gate_exp = float(np.mean(all_gate_r)) if len(all_gate_r) > 0 else 0.0
    delta_exp = gate_exp - control_exp

    delta_bootstrap = []
    discarded_count = 0

    dates_array = np.array(all_dates)

    for b in range(num_bootstraps):
        # Sample days with replacement
        sampled_dates = rng.choice(dates_array, size=num_days, replace=True)

        sample_control_r = [r for d in sampled_dates for r in daily_trades_control.get(d, [])]
        sample_gate_r = [r for d in sampled_dates for r in daily_trades_gate.get(d, [])]

        if len(sample_control_r) == 0 or len(sample_gate_r) == 0:
            discarded_count += 1
            continue

        c_e = float(np.mean(sample_control_r))
        g_e = float(np.mean(sample_gate_r))
        delta_bootstrap.append(g_e - c_e)

    if len(delta_bootstrap) == 0:
        return delta_exp, control_exp, gate_exp, 0.0, 0.0

    ci_lower = float(np.percentile(delta_bootstrap, (alpha / 2.0) * 100))
    ci_upper = float(np.percentile(delta_bootstrap, (1.0 - alpha / 2.0) * 100))

    return delta_exp, control_exp, gate_exp, ci_lower, ci_upper


def evaluate_h2(
    trades_df: pd.DataFrame,
    strategy_key: str = "ict-structure-v1",
    surge_threshold: float = 1.25,
    num_bootstraps: int = 10000,
    random_state: int = 42,
) -> H2EvaluationResult:
    """Evaluate H2 PASS criteria strictly on OOS dataset for frozen strategy."""
    if len(trades_df) == 0:
        return H2EvaluationResult(
            strategy_key=strategy_key,
            control_trade_count=0,
            gate_trade_count=0,
            control_expectancy_r=0.0,
            gate_expectancy_r=0.0,
            delta_expectancy_r=0.0,
            ci_lower_r=0.0,
            ci_upper_r=0.0,
            num_days=0,
            is_deferred=True,
            pass_h2=False,
            details=["No OOS trades available for strategy evaluation."],
        )

    # Filter control vs surge gate
    control_df = trades_df.copy()
    gate_df = trades_df[trades_df["rvol_tod"] >= surge_threshold].copy()

    control_count = len(control_df)
    gate_count = len(gate_df)
    unique_days = len(trades_df["trading_date"].unique())

    # Build daily trade dictionary for paired bootstrap
    daily_control: dict[date, list[float]] = {}
    daily_gate: dict[date, list[float]] = {}

    for d, group in control_df.groupby("trading_date"):
        daily_control[d] = group["realized_r"].tolist()

    for d, group in gate_df.groupby("trading_date"):
        daily_gate[d] = group["realized_r"].tolist()

    # Pre-registered Deferral Rule:
    # Requires N_trades >= 100 AND N_days >= 20.
    # Otherwise, declared Insufficient Data - Deferred.
    if control_count < 100 or unique_days < 20:
        delta_e, c_e, g_e, ci_l, ci_u = day_level_paired_bootstrap(
            daily_control, daily_gate, num_bootstraps=num_bootstraps, random_state=random_state
        )
        return H2EvaluationResult(
            strategy_key=strategy_key,
            control_trade_count=control_count,
            gate_trade_count=gate_count,
            control_expectancy_r=c_e,
            gate_expectancy_r=g_e,
            delta_expectancy_r=delta_e,
            ci_lower_r=ci_l,
            ci_upper_r=ci_u,
            num_days=unique_days,
            is_deferred=True,
            pass_h2=False,
            details=[
                f"OOS Trade Count ({control_count}) < 100 or Days ({unique_days}) < 20.",
                "Triggered Pre-Registered Deferral Rule: Insufficient Data — Deferred.",
            ],
        )

    delta_e, c_e, g_e, ci_l, ci_u = day_level_paired_bootstrap(
        daily_control, daily_gate, num_bootstraps=num_bootstraps, random_state=random_state
    )

    # H2 PASS Criteria:
    # 1. Delta E[R] > 0 strictly
    # 2. OOS Delta E[R] >= +0.15R
    # 3. 95% Bootstrap CI of Delta E[R] excludes 0.00R (ci_lower > 0.00)
    pass_h2 = (
        delta_e >= 0.15
        and ci_l > 0.00
    )

    details = [
        f"Control Arm: N={control_count}, E[R]={c_e:+.3f}R",
        f"Surge Gate Arm (RVOL>={surge_threshold}): N={gate_count}, E[R]={g_e:+.3f}R",
        f"Delta E[R]: {delta_e:+.3f}R (hurdle >= +0.15R)",
        f"95% Bootstrap CI: [{ci_l:+.3f}R, {ci_u:+.3f}R]",
        f"Evaluated across {unique_days} trading days.",
    ]

    return H2EvaluationResult(
        strategy_key=strategy_key,
        control_trade_count=control_count,
        gate_trade_count=gate_count,
        control_expectancy_r=c_e,
        gate_expectancy_r=g_e,
        delta_expectancy_r=delta_e,
        ci_lower_r=ci_l,
        ci_upper_r=ci_u,
        num_days=unique_days,
        is_deferred=False,
        pass_h2=pass_h2,
        details=details,
    )
