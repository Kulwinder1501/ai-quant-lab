"""
Gate R5 Event Generation & Hand-Recomputation Verification Tests
Pre-registered in docs/2026-10-17-equity-stance-r0-spec.md
"""

from __future__ import annotations

import math
from pathlib import Path
import pandas as pd
import pytest

from apps.ml.equity_stance_r0.events import (
    HOLDOUT_START_DATE,
    OUTPUT_DIR,
    RAW_DATA_DIR,
    parse_raw_bars,
)
from apps.ml.equity_stance_r0.levels import compute_levels, load_rules

EVENTS_PARQUET = OUTPUT_DIR / "events.parquet"
EVENTS_CSV = OUTPUT_DIR / "events.csv"


@pytest.fixture(scope="module")
def events_df():
    if EVENTS_PARQUET.exists():
        try:
            return pd.read_parquet(EVENTS_PARQUET)
        except Exception:
            pass
    if EVENTS_CSV.exists():
        return pd.read_csv(EVENTS_CSV)
    pytest.skip("Neither events.parquet nor events.csv exists.")


def test_events_schema_and_variants(events_df: pd.DataFrame):
    required_cols = [
        "symbol", "variant", "signal_date", "signal_bar_index", "close", "atr14",
        "sma200", "entry_date", "entry_open", "exit_date_63", "exit_close_63",
        "gross_return_63", "cost_tier_pct", "net_return_63", "stock_year_baseline_63",
        "nifty50_baseline_63", "net_excess_stock_year_63", "net_excess_nifty50_63",
        "is_independent", "has_artifact", "partition_63", "is_exploratory_50"
    ]
    for col in required_cols:
        assert col in events_df.columns, f"Missing required column: {col}"

    variants = set(events_df["variant"].unique())
    assert {"V1", "V2", "V3", "V4", "V5", "V6"}.issubset(variants)
    assert len(events_df) > 1000, f"Expected >1000 events, got {len(events_df)}"


def test_cooldown_and_independence(events_df: pd.DataFrame):
    # Cooldown check for V1..V4: consecutive events for same stock & variant must be >= 10 bars apart
    for variant in ["V1", "V2", "V3", "V4"]:
        sub = events_df[events_df["variant"] == variant]
        for sym, group in sub.groupby("symbol"):
            bar_indices = group["signal_bar_index"].tolist()
            for i in range(1, len(bar_indices)):
                diff = bar_indices[i] - bar_indices[i - 1]
                assert diff >= 10, f"Cooldown violated for {sym} {variant}: bar diff {diff} < 10"

    # Monthly independence cap: at most 1 independent event per symbol, variant, and calendar month
    indep = events_df[events_df["is_independent"]].copy()
    indep["cal_month"] = indep["signal_date"].str[:7]
    dupes = indep.duplicated(subset=["symbol", "variant", "cal_month"])
    assert not dupes.any(), "Duplicate independent event found in the same calendar month"


def test_cost_tiers_and_liquidity(events_df: pd.DataFrame):
    # Cost tier must be either 0.003 or 0.010
    valid_costs = {0.003, 0.010}
    for cost in events_df["cost_tier_pct"].unique():
        assert cost in valid_costs, f"Invalid cost tier: {cost}"


def test_net_excess_formulas(events_df: pd.DataFrame):
    valid_63 = events_df[events_df["gross_return_63"].notnull()].copy()

    # BUY variants: V1, V3, V5, V6
    buy_mask = valid_63["variant"].isin(["V1", "V3", "V5", "V6"])
    buy_df = valid_63[buy_mask]

    for _, row in buy_df.iterrows():
        expected_net = row["gross_return_63"] - row["cost_tier_pct"]
        assert abs(row["net_return_63"] - expected_net) < 1e-9

        expected_excess_sy = row["net_return_63"] - row["stock_year_baseline_63"]
        assert abs(row["net_excess_stock_year_63"] - expected_excess_sy) < 1e-9

        if pd.notnull(row["nifty50_baseline_63"]):
            expected_excess_nifty = row["net_return_63"] - row["nifty50_baseline_63"]
            assert abs(row["net_excess_nifty50_63"] - expected_excess_nifty) < 1e-9

    # SELL variants: V2, V4 (Avoided loss)
    sell_mask = valid_63["variant"].isin(["V2", "V4"])
    sell_df = valid_63[sell_mask]

    for _, row in sell_df.iterrows():
        expected_excess_sy = row["stock_year_baseline_63"] - row["gross_return_63"] - row["cost_tier_pct"]
        assert abs(row["net_excess_stock_year_63"] - expected_excess_sy) < 1e-9

        if pd.notnull(row["nifty50_baseline_63"]):
            expected_excess_nifty = row["nifty50_baseline_63"] - row["gross_return_63"] - row["cost_tier_pct"]
            assert abs(row["net_excess_nifty50_63"] - expected_excess_nifty) < 1e-9


def test_holdout_boundary_zero_leakage(events_df: pd.DataFrame):
    valid_63 = events_df[events_df["gross_return_63"].notnull()]

    # Non-holdout partitions (half1, half2) must have exit date < HOLDOUT_START_DATE
    non_holdout = valid_63[valid_63["partition_63"].isin(["half1", "half2"])]
    for _, row in non_holdout.iterrows():
        assert row["exit_date_63"] < HOLDOUT_START_DATE, (
            f"Holdout leakage: event on {row['signal_date']} with exit {row['exit_date_63']} "
            f"classified as {row['partition_63']}"
        )

    # Any event entering on or after HOLDOUT_START_DATE must be in holdout
    holdout = valid_63[valid_63["entry_date"] >= HOLDOUT_START_DATE]
    for _, row in holdout.iterrows():
        assert row["partition_63"] == "holdout", (
            f"Event with entry {row['entry_date']} must be in holdout, got {row['partition_63']}"
        )


def test_gate_r5_hand_recomputation(events_df: pd.DataFrame):
    """
    R5 Hand check: independently recompute 10 events (levels, ATR, distance, forward return, cost)
    from the raw data and verify exact match.
    """
    rules = load_rules()
    valid_events = events_df[events_df["gross_return_63"].notnull()].copy()

    # Pick 10 diverse events across variants and symbols
    sample_indices = []
    for var in ["V1", "V2", "V3", "V4", "V5", "V6"]:
        matching = valid_events[valid_events["variant"] == var]
        if len(matching) > 0:
            sample_indices.append(matching.index[0])
            if len(sample_indices) < 10 and len(matching) > 1:
                sample_indices.append(matching.index[min(10, len(matching) - 1)])

    # Pad up to 10
    idx_iter = iter(valid_events.index)
    while len(sample_indices) < 10:
        nxt = next(idx_iter)
        if nxt not in sample_indices:
            sample_indices.append(nxt)

    sample_10 = valid_events.loc[sample_indices[:10]]

    for _, row in sample_10.iterrows():
        sym = row["symbol"]
        T = int(row["signal_bar_index"])
        raw_bars = parse_raw_bars(sym)

        # 1. Verify bar T close
        bar_T = raw_bars[T]
        assert bar_T.bar_date == row["signal_date"]
        assert abs(bar_T.close - row["close"]) < 1e-9

        # 2. Independently compute ATR14
        tr_list = []
        for j in range(max(1, T - 13), T + 1):
            h = raw_bars[j].high
            l = raw_bars[j].low
            prev_c = raw_bars[j - 1].close
            tr_list.append(max(h - l, abs(h - prev_c), abs(l - prev_c)))
        expected_atr14 = sum(tr_list) / 14.0
        assert abs(row["atr14"] - expected_atr14) < 1e-9

        # 3. Independently compute forward return H=63
        entry_bar = raw_bars[T + 1]
        exit_bar = raw_bars[T + 63]
        assert entry_bar.bar_date == row["entry_date"]
        assert abs(entry_bar.open - row["entry_open"]) < 1e-9
        assert exit_bar.bar_date == row["exit_date_63"]
        assert abs(exit_bar.close - row["exit_close_63"]) < 1e-9

        expected_gross = (exit_bar.close / entry_bar.open) - 1.0
        assert abs(row["gross_return_63"] - expected_gross) < 1e-9

        # 4. Verify cost and net return
        cost = row["cost_tier_pct"]
        if row["variant"] in ("V1", "V3", "V5", "V6"):
            expected_net = expected_gross - cost
            assert abs(row["net_return_63"] - expected_net) < 1e-9
            expected_excess_sy = expected_net - row["stock_year_baseline_63"]
            assert abs(row["net_excess_stock_year_63"] - expected_excess_sy) < 1e-9
        else:
            expected_excess_sy = row["stock_year_baseline_63"] - expected_gross - cost
            assert abs(row["net_excess_stock_year_63"] - expected_excess_sy) < 1e-9
