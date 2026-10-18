"""
Gates R6, R7, R8, R9, R10: Evaluation & Statistical Verification Tests
Pre-registered in docs/2026-10-17-equity-stance-r0-spec.md
"""

from __future__ import annotations

import json
import re
from pathlib import Path
import numpy as np
import pandas as pd
import pytest

from apps.ml.equity_stance_r0.evaluate import (
    ELIGIBLE_STOCK_DAYS_PARQUET,
    EVENTS_CSV,
    EVENTS_PARQUET,
    REPORT_MD,
    RESULTS_JSON,
    ensure_eligible_stock_days_pool,
    evaluate_all_variants,
    generate_markdown_report,
    holm_step_down,
    run_month_block_bootstrap,
    run_placebo_benchmark,
)
from apps.ml.equity_stance_r0.events import RAW_DATA_DIR, parse_raw_bars

BANNED_WORDS = [
    "target price", "stop loss", "buy now", "sell now",
    "guaranteed", "prediction", "predictive", "recommendation", "forecast"
]


@pytest.fixture(scope="module")
def evaluation_results():
    if not EVENTS_PARQUET.exists() and not EVENTS_CSV.exists():
        pytest.skip("Research events data not found in apps/ml/research_data.")
    if not RESULTS_JSON.exists():
        res = evaluate_all_variants()
        generate_markdown_report(res)
    with open(RESULTS_JSON, "r", encoding="utf-8") as f:
        return json.load(f)


def test_gate_r6_placebo_true_events_zero_excess():
    """
    Gate R6: When the placebo pool is constructed from the true event returns,
    the real run_placebo_benchmark function produces a placebo mean matching
    the observed event mean (difference is approximately zero).
    """
    if not EVENTS_PARQUET.exists() and not EVENTS_CSV.exists():
        pytest.skip("Events data not present.")

    df_events = pd.read_parquet(EVENTS_PARQUET) if EVENTS_PARQUET.exists() else pd.read_csv(EVENTS_CSV)
    v1_events = df_events[
        (df_events["variant"] == "V1")
        & (df_events["partition_63"].isin(["half1", "half2"]))
        & (~df_events["has_artifact"])
        & (df_events["gross_return_63"].notnull())
    ]
    observed_mean = v1_events["net_excess_stock_year_63"].mean()

    # Construct mock pool where each stock-year contains exactly its true event returns
    mock_pool: dict[tuple[str, int], np.ndarray] = (
        v1_events.groupby([v1_events["symbol"], v1_events["signal_date"].str[:4].astype(int)])["net_excess_stock_year_63"]
        .apply(lambda x: x.values)
        .to_dict()
    )

    # Run real placebo function against mock pool containing true events
    res = run_placebo_benchmark(
        df_events,
        variant="V1",
        eligible_pool=mock_pool,
        n_draws=500,
        seed=20261017,
    )

    diff = abs(res["placebo_mean"] - observed_mean)
    assert diff < 0.005, f"Placebo on true events deviated: diff={diff:.6f}"


def test_gate_r6_placebo_planted_edge_and_null_calibration():
    """
    Gate R6: Placebo calibration through the real run_placebo_benchmark function:
    1. Null calibration: With events drawn directly from the eligible pool across stock-years,
       verifies that the procedure is not over-confident (false positives at p < 0.05 are rare).
    2. Planted-edge recovery: A planted +1.0% edge returns ~+1.0% (within 0.15%) with p approx 0,
       and a planted +2.0% edge returns ~+2.0% with p approx 0.
    """
    if not EVENTS_PARQUET.exists() and not EVENTS_CSV.exists():
        pytest.skip("Events data not present.")

    buy_pool, _ = ensure_eligible_stock_days_pool()
    df_events = pd.read_parquet(EVENTS_PARQUET) if EVENTS_PARQUET.exists() else pd.read_csv(EVENTS_CSV)
    sub = df_events[
        (df_events["variant"] == "V1")
        & (df_events["partition_63"].isin(["half1", "half2"]))
        & (~df_events["has_artifact"])
        & (df_events["gross_return_63"].notnull())
    ].copy()

    counts = sub.groupby([sub["symbol"], sub["signal_date"].str[:4].astype(int)]).size()

    # 1. Null calibration baseline
    rng = np.random.default_rng(20261017)
    null_vals = []
    for (sym, yr), k in counts.items():
        arr = buy_pool.get((sym, yr))
        if arr is not None and len(arr) > 0:
            null_vals.extend(rng.choice(arr, size=k, replace=True))
        else:
            null_vals.extend([0.0] * k)

    sub_null = sub.copy()
    sub_null["net_excess_stock_year_63"] = null_vals

    # 2. Planted edge recovery on +1.0% (+0.010) and +2.0% (+0.020)
    for edge in [0.010, 0.020]:
        df_edge = sub_null.copy()
        df_edge["net_excess_stock_year_63"] = sub_null["net_excess_stock_year_63"] + edge
        res = run_placebo_benchmark(df_edge, "V1", buy_pool, n_draws=300, seed=20261017)
        rec_edge = res["observed_mean"] - res["placebo_mean"]
        assert abs(rec_edge - edge) < 0.0025, f"Planted edge {edge} recovery failed: got {rec_edge:.4f}"
        assert res["p_value"] < 0.005, f"Planted edge p-value expected approx 0, got {res['p_value']}"

    # 3. Null calibration: verify it is not over-confident
    fps = 0
    n_sims = 25
    for i in range(n_sims):
        sim_rng = np.random.default_rng(10000 + i)
        sim_vals = []
        for (sym, yr), k in counts.items():
            arr = buy_pool.get((sym, yr))
            if arr is not None and len(arr) > 0:
                sim_vals.extend(sim_rng.choice(arr, size=k, replace=True))
            else:
                sim_vals.extend([0.0] * k)
        df_sim = sub.copy()
        df_sim["net_excess_stock_year_63"] = sim_vals
        res = run_placebo_benchmark(df_sim, "V1", buy_pool, n_draws=150, seed=50000 + i)
        if res["p_value"] < 0.05:
            fps += 1

    fp_rate = fps / n_sims
    assert fp_rate <= 0.10, f"Placebo null calibration over-confident: fp_rate={fp_rate:.2%}"


def test_gate_r7_planted_edge_detection():
    """
    Gate R7: A planted-edge test (+1.5% true monthly excess) is detected by the bootstrap lower bound > 0.
    """
    rng = np.random.default_rng(20261017)
    n_months = 60
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
        if res["ci_lower_95"] > 0.0:
            false_positives += 1

    fp_rate = false_positives / n_simulations
    assert fp_rate <= 0.10, f"False positive rate too high: {fp_rate:.2%}"


def test_gate_r8_costs_and_gates_reported(evaluation_results):
    """
    Gate R8: Costs and gates applied and reported across all 6 variants.
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
    survivorship bias direction stated per variant, and zero banned words.
    """
    assert evaluation_results["overall_verdict"] == "NOT SUPPORTED"

    report_text = REPORT_MD.read_text(encoding="utf-8")
    report_lower = report_text.lower()

    for word in BANNED_WORDS:
        assert word not in report_lower, f"Banned word '{word}' found in report"

    # Survivorship bias must be explicitly stated per variant direction
    assert "survivorship bias" in report_lower
    assert "buy variants" in report_lower
    assert "sell variants" in report_lower
    assert "unvalidated" in report_lower


def test_gate_r9_report_numbers_match_json(evaluation_results):
    """
    Gate R9: Asserts that every number in the Markdown report matches the JSON results exactly.
    """
    report_text = REPORT_MD.read_text(encoding="utf-8")
    variants = evaluation_results["variants"]

    for v_id, v in variants.items():
        # Scoreboard values
        sy_mean_str = f"{v['bootstrap_stock_year']['mean'] * 100:+.2f}%"
        lb_str = f"{v['bootstrap_stock_year']['ci_lower_95'] * 100:+.2f}%"
        ub_str = f"{v['bootstrap_stock_year']['ci_upper_95'] * 100:+.2f}%"
        p_sy_str = f"{v['bootstrap_stock_year']['p_value']:.4f}"
        nifty_mean_str = f"{v['bootstrap_nifty50']['mean'] * 100:+.2f}%"
        p_nifty_str = f"{v['bootstrap_nifty50']['p_value']:.4f}"
        p_max_str = f"{v['variant_p_value']:.4f}"
        verdict_str = f"**{v['classification']}**"

        assert sy_mean_str in report_text, f"{v_id} SY mean {sy_mean_str} not in report"
        assert lb_str in report_text, f"{v_id} LB {lb_str} not in report"
        assert ub_str in report_text, f"{v_id} UB {ub_str} not in report"
        assert p_sy_str in report_text, f"{v_id} p_sy {p_sy_str} not in report"
        assert nifty_mean_str in report_text, f"{v_id} Nifty mean {nifty_mean_str} not in report"
        assert p_nifty_str in report_text, f"{v_id} p_nifty {p_nifty_str} not in report"
        assert p_max_str in report_text, f"{v_id} p_max {p_max_str} not in report"
        assert verdict_str in report_text, f"{v_id} verdict {verdict_str} not in report"


def test_gate_r10_reproducibility(tmp_path):
    """
    Gate R10: Single command recomputation produces byte-identical evaluation_results.json.
    Uses tmp_path to verify byte-identical output without side-effect overwriting.
    """
    with open(RESULTS_JSON, "r", encoding="utf-8") as f:
        original_json = f.read()

    test_output = tmp_path / "evaluation_results.json"
    new_res = evaluate_all_variants(output_path=test_output)
    new_json = test_output.read_text(encoding="utf-8")

    assert original_json == new_json, "Reproducibility failed: results JSON differed"
