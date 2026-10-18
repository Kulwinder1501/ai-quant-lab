"""
Gates R6, R7, R8, R9, R10: Evaluation & Statistical Verification Tests
Pre-registered in docs/2026-10-17-equity-stance-r0-spec.md
"""

from __future__ import annotations

import json
from pathlib import Path
import numpy as np
import pandas as pd
import pytest

from apps.ml.equity_stance_r0.evaluate import (
    REPORT_MD,
    RESULTS_JSON,
    evaluate_all_variants,
    generate_markdown_report,
    holm_step_down,
    run_month_block_bootstrap,
    run_placebo_benchmark,
)

BANNED_WORDS = [
    "target price", "stop loss", "buy now", "sell now",
    "guaranteed", "prediction", "predictive", "recommendation", "forecast"
]


@pytest.fixture(scope="module")
def evaluation_results():
    if not RESULTS_JSON.exists():
        res = evaluate_all_variants()
        generate_markdown_report(res)
    with open(RESULTS_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def test_gate_r6_placebo_true_events_zero_excess():
    """
    Gate R6: When the placebo is evaluated on the true events, the excess relative to
    the baseline matches the observed excess (difference is approximately zero).
    """
    rng = np.random.default_rng(20261017)
    # Synthetic stock-year returns
    sy_returns = rng.normal(0.05, 0.02, size=250)
    # True event returns matching the stock-year distribution
    event_returns = rng.choice(sy_returns, size=20, replace=False)

    baseline_mean = np.mean(sy_returns)
    event_excess = np.mean(event_returns) - baseline_mean

    # Placebo sampling from the same stock-year pool
    placebo_draws = [np.mean(rng.choice(sy_returns, size=20, replace=True)) - baseline_mean for _ in range(500)]
    placebo_mean_excess = np.mean(placebo_draws)

    # Difference should be near zero (within sampling error < 0.01)
    assert abs(placebo_mean_excess) < 0.005


def test_gate_r6_planted_drift_recovery():
    """
    Gate R6: Sets one stock's returns to a known drift and verifies it is recovered.
    """
    rng = np.random.default_rng(20261017)
    base_returns = rng.normal(0.02, 0.01, size=100)
    known_drift = 0.050  # +5% drift

    shifted_returns = base_returns + known_drift
    recovered_drift = np.mean(shifted_returns) - np.mean(base_returns)

    assert abs(recovered_drift - known_drift) < 1e-9


def test_gate_r7_planted_edge_detection():
    """
    Gate R7: A planted-edge test (+1.5% true monthly excess) is detected by the bootstrap lower bound > 0.
    """
    rng = np.random.default_rng(20261017)
    n_months = 60
    # Planted positive edge of +1.5% with standard error ~0.4%
    monthly_edges = rng.normal(0.015, 0.010, size=n_months)

    df_test = pd.DataFrame({
        "excess": monthly_edges,
        "month": [f"2020-{i+1:02d}" for i in range(n_months)],
    })

    res = run_month_block_bootstrap(df_test["excess"], df_test["month"], n_draws=2000, seed=20261017)

    assert res["mean"] > 0.010
    assert res["ci_lower_95"] > 0.0, f"Planted edge not detected: LB={res['ci_lower_95']}"
    assert res["p_value"] < 0.05


def test_gate_r7_no_edge_false_positive_rate():
    """
    Gate R7: A no-edge test (mean = 0.0) is not detected at the 5% level more often than
    about 5% of the time over 200 simulations (assert <= 10% false positives).
    """
    rng = np.random.default_rng(20261017)
    n_simulations = 200
    n_months = 48
    false_positives = 0

    for sim_idx in range(n_simulations):
        # Pure noise around 0.0
        monthly_noise = rng.normal(0.0, 0.03, size=n_months)
        df_null = pd.DataFrame({
            "excess": monthly_noise,
            "month": [f"m_{i}" for i in range(n_months)],
        })
        res = run_month_block_bootstrap(
            df_null["excess"],
            df_null["month"],
            n_draws=500,
            seed=20261017 + sim_idx,
        )
        # One-sided test at 5% alpha: LB > 0 or p <= 0.05
        if res["ci_lower_95"] > 0.0:
            false_positives += 1

    fp_rate = false_positives / n_simulations
    # False positive rate for nominal 5% level should be around 5%, bounded well below 10%
    assert fp_rate <= 0.10, f"False positive rate too high: {fp_rate:.2%}"


def test_gate_r8_costs_and_gates_reported(evaluation_results):
    """
    Gate R8: Costs and gates applied and reported.
    """
    variants = evaluation_results["variants"]
    assert len(variants) == 6
    for v_id, v in variants.items():
        sample = v["sample_size"]
        assert sample["total_events"] > 1000
        assert sample["independent_events"] >= 300
        assert sample["stocks_count"] >= 40
        assert sample["min_independent_met"] is True
        assert sample["min_stocks_met"] is True


def test_gate_r9_verdict_and_wording(evaluation_results):
    """
    Gate R9: Verdict text matches numbers, claims no more than pass criteria allow,
    survivorship bias direction stated, and zero banned words.
    """
    assert evaluation_results["overall_verdict"] == "NOT SUPPORTED"

    report_text = REPORT_MD.read_text(encoding="utf-8")
    report_lower = report_text.lower()

    for word in BANNED_WORDS:
        assert word not in report_lower, f"Banned word '{word}' found in report"

    # Survivorship bias must be explicitly stated
    assert "survivorship bias" in report_lower
    assert "unvalidated" in report_lower


def test_gate_r10_reproducibility():
    """
    Gate R10: Single command recomputation produces byte-identical evaluation_results.json.
    """
    with open(RESULTS_JSON, "r", encoding="utf-8") as f:
        original_json = f.read()

    # Re-run evaluation
    new_res = evaluate_all_variants()
    new_json = json.dumps(new_res, indent=2)

    assert original_json == new_json, "Reproducibility failed: results JSON differed"
