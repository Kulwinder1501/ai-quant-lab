"""
Equity Stance R0: Step A2 - Event Generation Pipeline
Pre-Registered Spec: docs/2026-10-17-equity-stance-r0-spec.md

Implements:
1. Point-in-time universe, liquidity gating (60-bar median traded value >= ₹20,000,000).
2. Point-in-time cost tiering: top 100 active stocks on bar T by 60-bar median traded value
   receive 0.30% round-trip friction; all others receive 1.00%.
3. Technical stance evaluation for Variants V1, V2, V3, V4, V5, V6.
4. Cooldown (10 trading bars) and monthly independence cap.
5. Gross forward returns and cost-adjusted net returns for H in {63, 21, 126}.
6. Baselines: Stock-Year average return, NIFTY 50 buy-and-hold return.
7. Conservative net excess formulas for BUY and SELL (avoided loss).
8. Partitions: Half 1, Half 2, Holdout (2024-10-18 to 2026-10-17), and Boundary Excluded.
9. Suspected artifact flag (1-day absolute move > 40%).
10. Exploratory 50 prior exposure flag.
"""

from __future__ import annotations

import csv
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import pandas as pd

from apps.ml.equity_stance_r0.levels import Bar, LevelsResult, compute_levels, load_rules

RAW_DATA_DIR = Path(__file__).resolve().parent.parent / "research_data" / "raw"
MANIFEST_PATH = Path(__file__).resolve().parent.parent / "research_data" / "manifest.csv"
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "research_data"

HOLDOUT_START_DATE = "2024-10-18"
DATASET_EARLIEST_DATE = "1991-01-02"

EXPLORATORY_50_STOCKS = {
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "HINDUNILVR", "ITC", "SBIN",
    "BHARTIARTL", "KOTAKBANK", "LT", "AXISBANK", "ASIANPAINT", "MARUTI", "SUNPHARMA",
    "TITAN", "ULTRACEMCO", "NESTLEIND", "WIPRO", "HCLTECH", "M&M", "BAJFINANCE",
    "POWERGRID", "NTPC", "ONGC", "TATASTEEL", "JSWSTEEL", "ADANIPORTS", "COALINDIA",
    "TECHM", "GRASIM", "HINDALCO", "DRREDDY", "CIPLA", "EICHERMOT", "BPCL",
    "HEROMOTOCO", "DIVISLAB", "BRITANNIA", "INDUSINDBK", "APOLLOHOSP", "TATACONSUM",
    "BAJAJ-AUTO", "SUZLON", "TATAMOTORS", "PIDILITIND", "DABUR", "GAIL", "IOC", "SIEMENS"
}


@dataclass
class EventRecord:
    symbol: str
    variant: str
    signal_date: str
    signal_bar_index: int
    close: float
    atr14: float
    sma200: Optional[float]
    support_price: Optional[float]
    support_touches: Optional[int]
    support_distance_atr: Optional[float]
    resistance_price: Optional[float]
    resistance_touches: Optional[int]
    resistance_distance_atr: Optional[float]
    entry_date: str
    entry_open: float
    # Horizon outcomes for H = 63 (primary)
    exit_date_63: Optional[str]
    exit_close_63: Optional[float]
    gross_return_63: Optional[float]
    cost_tier_pct: float
    net_return_63: Optional[float]
    stock_year_baseline_63: Optional[float]
    nifty50_baseline_63: Optional[float]
    net_excess_stock_year_63: Optional[float]
    net_excess_nifty50_63: Optional[float]
    # Horizon outcomes for H = 21 (secondary)
    gross_return_21: Optional[float]
    net_return_21: Optional[float]
    stock_year_baseline_21: Optional[float]
    nifty50_baseline_21: Optional[float]
    net_excess_stock_year_21: Optional[float]
    net_excess_nifty50_21: Optional[float]
    # Horizon outcomes for H = 126 (secondary)
    gross_return_126: Optional[float]
    net_return_126: Optional[float]
    stock_year_baseline_126: Optional[float]
    nifty50_baseline_126: Optional[float]
    net_excess_stock_year_126: Optional[float]
    net_excess_nifty50_126: Optional[float]
    # Metadata flags
    is_independent: bool
    is_large_cap_cost: bool
    has_artifact: bool
    partition_63: str  # half1, half2, holdout, boundary_excluded
    is_exploratory_50: bool


def parse_raw_bars(symbol: str) -> list[Bar]:
    path = RAW_DATA_DIR / f"{symbol}.json"
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    result = raw["chart"]["result"][0]
    timestamps = result.get("timestamp", [])
    quotes = result["indicators"]["quote"][0]
    opens = quotes.get("open", [])
    highs = quotes.get("high", [])
    lows = quotes.get("low", [])
    closes = quotes.get("close", [])
    volumes = quotes.get("volume", [])

    bars: list[Bar] = []
    for t, o, h, l, c, v in zip(timestamps, opens, highs, lows, closes, volumes):
        if (
            t is not None
            and o is not None and math.isfinite(o) and o > 0
            and h is not None and math.isfinite(h) and h > 0
            and l is not None and math.isfinite(l) and l > 0
            and c is not None and math.isfinite(c) and c > 0
            and v is not None
        ):
            d_str = datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d")
            bars.append(
                Bar(
                    bar_date=d_str,
                    open=float(o),
                    high=float(h),
                    low=float(l),
                    close=float(c),
                    volume=int(v),
                )
            )
    bars.sort(key=lambda b: b.bar_date)
    return bars


def compute_chronological_midpoint(earliest_date_str: str, holdout_start_str: str) -> str:
    d1 = datetime.strptime(earliest_date_str, "%Y-%m-%d")
    d2 = datetime.strptime(holdout_start_str, "%Y-%m-%d")
    mid = d1 + (d2 - d1) / 2
    return mid.strftime("%Y-%m-%d")


def _process_single_symbol(args: tuple) -> list[dict]:
    """Worker function for parallel symbol event generation."""
    (
        sym,
        bars_dict_list,
        config,
        top100_by_date,
        v6_selected_by_date,
        stock_year_baselines_sym,
        benchmark_by_date_tuples,
        midpoint_date,
    ) = args

    bars = [Bar(**b) for b in bars_dict_list]
    n_bars = len(bars)
    if n_bars < 258:
        return []

    cooldown_bars = config["evaluation"]["cooldownBars"]
    large_cap_cost = config["costs"]["roundTripLargeCapPct"]
    other_cost = config["costs"]["roundTripOtherPct"]
    min_liquidity_val = config["stance"]["liquidity"]["minMedianTradedValueInr"]

    # Precompute artifacts (>40% 1-day move)
    art_indices: set[int] = set()
    for i in range(1, n_bars):
        move = abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close)
        if move > 0.40:
            art_indices.add(i)

    # Precompute 60-bar median traded values
    meds: list[float] = [0.0] * n_bars
    rolling_vals: list[float] = []
    for i in range(n_bars):
        rolling_vals.append(bars[i].close * bars[i].volume)
        if len(rolling_vals) > 60:
            rolling_vals.pop(0)
        if len(rolling_vals) >= 60:
            s_vals = sorted(rolling_vals)
            meds[i] = (s_vals[29] + s_vals[30]) / 2.0

    benchmark_by_date = dict(benchmark_by_date_tuples)
    benchmark_sorted_dates = sorted(benchmark_by_date.keys())

    def get_benchmark_return(entry_date: str, exit_date: str) -> Optional[float]:
        if not benchmark_sorted_dates:
            return None
        if entry_date < benchmark_sorted_dates[0]:
            return None
        b_entry = benchmark_by_date.get(entry_date)
        if not b_entry:
            for d in benchmark_sorted_dates:
                if d >= entry_date:
                    b_entry = benchmark_by_date[d]
                    break
        b_exit = benchmark_by_date.get(exit_date)
        if not b_exit:
            for d in reversed(benchmark_sorted_dates):
                if d <= exit_date:
                    b_exit = benchmark_by_date[d]
                    break
        if b_entry and b_exit and b_entry[0] > 0:  # b_entry is (open, close)
            return (b_exit[1] / b_entry[0]) - 1.0
        return None

    is_exploratory = sym in EXPLORATORY_50_STOCKS
    last_event_bar: dict[str, int] = {
        "V1": -999, "V2": -999, "V3": -999, "V4": -999, "V5": -999, "V6": -999
    }
    month_events_seen: dict[str, set[str]] = {
        "V1": set(), "V2": set(), "V3": set(), "V4": set(), "V5": set(), "V6": set()
    }

    events: list[dict] = []

    for T in range(258, n_bars):
        med_val = meds[T]
        if med_val < min_liquidity_val:
            continue

        bar_T = bars[T]
        date_T = bar_T.bar_date
        close_T = bar_T.close
        cal_month = date_T[:7]

        is_month_end = date_T in v6_selected_by_date

        # Check if all level-based variants are on cooldown and not month-end
        v1_cd = (T - last_event_bar["V1"]) < cooldown_bars
        v2_cd = (T - last_event_bar["V2"]) < cooldown_bars
        v3_cd = (T - last_event_bar["V3"]) < cooldown_bars
        v4_cd = (T - last_event_bar["V4"]) < cooldown_bars

        if v1_cd and v2_cd and v3_cd and v4_cd and not is_month_end:
            continue

        if T + 1 >= n_bars:
            continue
        entry_bar = bars[T + 1]
        entry_date = entry_bar.bar_date
        entry_open = entry_bar.open
        if entry_open <= 0:
            continue

        is_large_cap = sym in top100_by_date.get(date_T, set())
        cost_tier_pct = large_cap_cost if is_large_cap else other_cost

        # SMA 200
        sma200 = sum(bars[j].close for j in range(T - 199, T + 1)) / 200.0

        # Compute levels on 600-bar rolling window
        window = bars[max(0, T - 599) : T + 1]
        res = compute_levels(window, rules=config)
        atr14 = res.atr14 or 0.0
        supp = res.nearest_support
        resis = res.nearest_resistance

        v1_cond = False
        v2_cond = False
        v3_cond = False
        v4_cond = False

        if res is not None:
            # V1: Support touch (<= 1.5 ATR), >= 2 touches, close >= -10% from 200 SMA
            if (
                not v1_cd
                and supp is not None
                and supp.distance_atr <= config["stance"]["buy"]["maxAtrAboveSupport"]
                and supp.touches >= config["stance"]["buy"]["minStrengthTouches"]
                and ((close_T - sma200) / sma200) >= -config["stance"]["buy"]["maxBelowSma200Pct"]
            ):
                v1_cond = True

            # V3: Support touch alone (<= 1.5 ATR, >= 2 touches)
            if (
                not v3_cd
                and supp is not None
                and supp.distance_atr <= config["stance"]["buy"]["maxAtrAboveSupport"]
                and supp.touches >= config["stance"]["buy"]["minStrengthTouches"]
            ):
                v3_cond = True

            # V4: Resistance touch (<= 1.0 ATR, >= 2 touches) and stretch > 25% above SMA 200
            if (
                resis is not None
                and abs(resis.distance_atr) <= config["stance"]["sell"]["maxAtrBelowResistance"]
                and resis.touches >= config["stance"]["sell"]["minStrengthTouches"]
                and ((close_T - sma200) / sma200) > config["stance"]["sell"]["stretchAboveSma200Pct"]
            ):
                if not v4_cd:
                    v4_cond = True

            # Support breakdown: price breaks > 1.0 ATR below support level
            breakdown_cond = False
            if not v2_cd and atr14 > 0:
                for lvl in res.levels:
                    if lvl.kind == "SWING" and lvl.state in ("BROKEN", "FLIPPED"):
                        if (lvl.price - close_T) / atr14 >= config["stance"]["sell"]["breakBelowSupportAtr"]:
                            breakdown_cond = True
                            break

            if not v2_cd and (v4_cond or breakdown_cond):
                v2_cond = True

        # V5: Trend context alone (close > sma200), evaluated on month-end
        v5_cond = is_month_end and (close_T > sma200)

        # V6: 52W Proximity top decile, evaluated on month-end
        v6_cond = is_month_end and (sym in v6_selected_by_date.get(date_T, set()))

        triggered_variants: list[str] = []
        if v1_cond:
            triggered_variants.append("V1")
        if v2_cond:
            triggered_variants.append("V2")
        if v3_cond:
            triggered_variants.append("V3")
        if v4_cond:
            triggered_variants.append("V4")
        if v5_cond:
            triggered_variants.append("V5")
        if v6_cond:
            triggered_variants.append("V6")

        if not triggered_variants:
            continue

        for variant in triggered_variants:
            if variant in ("V1", "V2", "V3", "V4"):
                last_event_bar[variant] = T

            is_independent = cal_month not in month_events_seen[variant]
            month_events_seen[variant].add(cal_month)

            is_buy = variant in ("V1", "V3", "V5", "V6")
            y = int(date_T[:4])

            # H = 63 (primary)
            exit_date_63 = None
            exit_close_63 = None
            gross_ret_63 = None
            net_ret_63 = None
            sy_b_63 = None
            nifty_b_63 = None
            excess_sy_63 = None
            excess_nifty_63 = None
            has_artifact_63 = False
            partition_63 = "boundary_excluded"

            if T + 63 < n_bars:
                exit_bar_63 = bars[T + 63]
                exit_date_63 = exit_bar_63.bar_date
                exit_close_63 = exit_bar_63.close
                gross_ret_63 = (exit_close_63 / entry_open) - 1.0

                sy_b_63 = stock_year_baselines_sym.get(y, {}).get(63, 0.0)
                nifty_b_63 = get_benchmark_return(entry_date, exit_date_63)

                if is_buy:
                    net_ret_63 = gross_ret_63 - cost_tier_pct
                    excess_sy_63 = net_ret_63 - sy_b_63
                    excess_nifty_63 = (net_ret_63 - nifty_b_63) if nifty_b_63 is not None else None
                else:
                    net_ret_63 = -gross_ret_63 - cost_tier_pct
                    excess_sy_63 = sy_b_63 - gross_ret_63 - cost_tier_pct
                    excess_nifty_63 = (nifty_b_63 - gross_ret_63 - cost_tier_pct) if nifty_b_63 is not None else None

                has_artifact_63 = any(
                    j in art_indices for j in range(max(0, T - 252), T + 64)
                )

                if entry_date >= HOLDOUT_START_DATE:
                    partition_63 = "holdout"
                elif exit_date_63 >= HOLDOUT_START_DATE:
                    partition_63 = "boundary_excluded"
                elif date_T < midpoint_date:
                    partition_63 = "half1"
                else:
                    partition_63 = "half2"

            # H = 21 (secondary)
            gross_ret_21 = None
            net_ret_21 = None
            sy_b_21 = None
            nifty_b_21 = None
            excess_sy_21 = None
            excess_nifty_21 = None
            if T + 21 < n_bars:
                exit_bar_21 = bars[T + 21]
                gross_ret_21 = (exit_bar_21.close / entry_open) - 1.0
                sy_b_21 = stock_year_baselines_sym.get(y, {}).get(21, 0.0)
                nifty_b_21 = get_benchmark_return(entry_date, exit_bar_21.bar_date)
                if is_buy:
                    net_ret_21 = gross_ret_21 - cost_tier_pct
                    excess_sy_21 = net_ret_21 - sy_b_21
                    excess_nifty_21 = (net_ret_21 - nifty_b_21) if nifty_b_21 is not None else None
                else:
                    net_ret_21 = -gross_ret_21 - cost_tier_pct
                    excess_sy_21 = sy_b_21 - gross_ret_21 - cost_tier_pct
                    excess_nifty_21 = (nifty_b_21 - gross_ret_21 - cost_tier_pct) if nifty_b_21 is not None else None

            # H = 126 (secondary)
            gross_ret_126 = None
            net_ret_126 = None
            sy_b_126 = None
            nifty_b_126 = None
            excess_sy_126 = None
            excess_nifty_126 = None
            if T + 126 < n_bars:
                exit_bar_126 = bars[T + 126]
                gross_ret_126 = (exit_bar_126.close / entry_open) - 1.0
                sy_b_126 = stock_year_baselines_sym.get(y, {}).get(126, 0.0)
                nifty_b_126 = get_benchmark_return(entry_date, exit_bar_126.bar_date)
                if is_buy:
                    net_ret_126 = gross_ret_126 - cost_tier_pct
                    excess_sy_126 = net_ret_126 - sy_b_126
                    excess_nifty_126 = (net_ret_126 - nifty_b_126) if nifty_b_126 is not None else None
                else:
                    net_ret_126 = -gross_ret_126 - cost_tier_pct
                    excess_sy_126 = sy_b_126 - gross_ret_126 - cost_tier_pct
                    excess_nifty_126 = (nifty_b_126 - gross_ret_126 - cost_tier_pct) if nifty_b_126 is not None else None

            events.append({
                "symbol": sym,
                "variant": variant,
                "signal_date": date_T,
                "signal_bar_index": T,
                "close": close_T,
                "atr14": atr14,
                "sma200": sma200,
                "support_price": supp.price if supp else None,
                "support_touches": supp.touches if supp else None,
                "support_distance_atr": supp.distance_atr if supp else None,
                "resistance_price": resis.price if resis else None,
                "resistance_touches": resis.touches if resis else None,
                "resistance_distance_atr": resis.distance_atr if resis else None,
                "entry_date": entry_date,
                "entry_open": entry_open,
                "exit_date_63": exit_date_63,
                "exit_close_63": exit_close_63,
                "gross_return_63": gross_ret_63,
                "cost_tier_pct": cost_tier_pct,
                "net_return_63": net_ret_63,
                "stock_year_baseline_63": sy_b_63,
                "nifty50_baseline_63": nifty_b_63,
                "net_excess_stock_year_63": excess_sy_63,
                "net_excess_nifty50_63": excess_nifty_63,
                "gross_return_21": gross_ret_21,
                "net_return_21": net_ret_21,
                "stock_year_baseline_21": sy_b_21,
                "nifty50_baseline_21": nifty_b_21,
                "net_excess_stock_year_21": excess_sy_21,
                "net_excess_nifty50_21": excess_nifty_21,
                "gross_return_126": gross_ret_126,
                "net_return_126": net_ret_126,
                "stock_year_baseline_126": sy_b_126,
                "nifty50_baseline_126": nifty_b_126,
                "net_excess_stock_year_126": excess_sy_126,
                "net_excess_nifty50_126": excess_nifty_126,
                "is_independent": is_independent,
                "is_large_cap_cost": is_large_cap,
                "has_artifact": has_artifact_63,
                "partition_63": partition_63,
                "is_exploratory_50": is_exploratory,
            })

    return events


def build_events_dataset(
    rules: Optional[dict[str, Any]] = None,
    output_parquet: Optional[Path] = None,
    output_csv: Optional[Path] = None,
    max_workers: Optional[int] = None,
) -> tuple[pd.DataFrame, list[EventRecord]]:
    config = rules or load_rules()
    min_liquidity_val = config["stance"]["liquidity"]["minMedianTradedValueInr"]
    midpoint_date = compute_chronological_midpoint(DATASET_EARLIEST_DATE, HOLDOUT_START_DATE)

    # 1. Load qualified symbols
    qualified_symbols: list[str] = []
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            if r["status"] == "QUALIFIED" and r["symbol"] != "^NSEI":
                qualified_symbols.append(r["symbol"])

    # 2. Load bars for benchmark and all qualified stocks
    benchmark_bars = parse_raw_bars("^NSEI")
    benchmark_by_date = {b.bar_date: (b.open, b.close) for b in benchmark_bars}
    benchmark_tuples = list(benchmark_by_date.items())

    all_stock_bars: dict[str, list[Bar]] = {}
    for sym in qualified_symbols:
        all_stock_bars[sym] = parse_raw_bars(sym)

    # 3. Market trading calendar & month-ends
    all_dates_set: set[str] = set()
    for bars in all_stock_bars.values():
        for b in bars:
            all_dates_set.add(b.bar_date)
    market_calendar = sorted(all_dates_set)

    month_end_dates: set[str] = set()
    for i in range(len(market_calendar) - 1):
        d_curr = market_calendar[i]
        d_next = market_calendar[i + 1]
        if d_curr[:7] != d_next[:7]:
            month_end_dates.add(d_curr)

    # 4. Precompute 60-bar median traded values and map (date -> list of (symbol, median_val))
    stock_date_to_idx: dict[str, dict[str, int]] = {}
    stock_idx_to_med60: dict[str, list[float]] = {}
    date_to_active_stocks_med: dict[str, list[tuple[str, float]]] = {d: [] for d in market_calendar}

    for sym, bars in all_stock_bars.items():
        date_map: dict[str, int] = {}
        meds: list[float] = [0.0] * len(bars)
        rolling_values: list[float] = []

        for i, b in enumerate(bars):
            date_map[b.bar_date] = i
            rolling_values.append(b.close * b.volume)
            if len(rolling_values) > 60:
                rolling_values.pop(0)

            if len(rolling_values) >= 60:
                s_vals = sorted(rolling_values)
                med = (s_vals[29] + s_vals[30]) / 2.0
            else:
                med = 0.0

            meds[i] = med
            if med > 0:
                date_to_active_stocks_med[b.bar_date].append((sym, med))

        stock_date_to_idx[sym] = date_map
        stock_idx_to_med60[sym] = meds

    # 5. Determine Top 100 Large-Cap per date
    top100_by_date: dict[str, set[str]] = {}
    for d, entries in date_to_active_stocks_med.items():
        if len(entries) > 100:
            entries.sort(key=lambda x: x[1], reverse=True)
            top100_by_date[d] = {x[0] for x in entries[:100]}
        else:
            top100_by_date[d] = {x[0] for x in entries}

    # 6. Precompute Stock-Year Gross Baselines
    horizons = [63, 21, 126]
    stock_year_baselines: dict[str, dict[int, dict[int, float]]] = {}

    for sym, bars in all_stock_bars.items():
        year_returns: dict[int, dict[int, list[float]]] = {}
        n_bars = len(bars)
        for i in range(n_bars):
            y = int(bars[i].bar_date[:4])
            if y not in year_returns:
                year_returns[y] = {21: [], 63: [], 126: []}

            if i + 1 < n_bars:
                open_next = bars[i + 1].open
                if open_next > 0:
                    for h in horizons:
                        if i + h < n_bars:
                            ret = (bars[i + h].close / open_next) - 1.0
                            year_returns[y][h].append(ret)

        stock_year_baselines[sym] = {}
        for y, h_dict in year_returns.items():
            stock_year_baselines[sym][y] = {}
            for h, rets in h_dict.items():
                stock_year_baselines[sym][y][h] = (sum(rets) / len(rets)) if rets else 0.0

    # 7. Precompute 52-Week High Proximity on Month-End dates for V6
    v6_selected_by_date: dict[str, set[str]] = {}
    for d in month_end_dates:
        qualifying_scores: list[tuple[str, float]] = []
        for sym, bars in all_stock_bars.items():
            if d in stock_date_to_idx[sym]:
                idx = stock_date_to_idx[sym][d]
                med_val = stock_idx_to_med60[sym][idx]
                if med_val >= min_liquidity_val and idx >= 252:
                    dt_curr = datetime.strptime(d, "%Y-%m-%d")
                    cutoff_365 = (dt_curr - timedelta(days=365)).strftime("%Y-%m-%d")
                    sub_highs = [bars[j].high for j in range(idx, -1, -1) if bars[j].bar_date > cutoff_365]
                    if sub_highs:
                        h52 = max(sub_highs)
                        if h52 > 0:
                            ratio = bars[idx].close / h52
                            qualifying_scores.append((sym, ratio))

        if qualifying_scores:
            qualifying_scores.sort(key=lambda x: x[1], reverse=True)
            n_top = max(1, math.ceil(len(qualifying_scores) * 0.10))
            v6_selected_by_date[d] = {x[0] for x in qualifying_scores[:n_top]}
        else:
            v6_selected_by_date[d] = set()

    # 8. Parallel execution across symbols
    workers = max_workers or min(os.cpu_count() or 4, 8)
    tasks = []
    for sym in qualified_symbols:
        bars_dict_list = [asdict(b) for b in all_stock_bars[sym]]
        tasks.append((
            sym,
            bars_dict_list,
            config,
            top100_by_date,
            v6_selected_by_date,
            stock_year_baselines[sym],
            benchmark_tuples,
            midpoint_date,
        ))

    all_event_dicts: list[dict] = []
    t_start = time.time()
    print(f"Scanning {len(tasks)} symbols across {workers} worker processes...")

    with ProcessPoolExecutor(max_workers=workers) as executor:
        for i, res_list in enumerate(executor.map(_process_single_symbol, tasks, chunksize=4)):
            all_event_dicts.extend(res_list)
            if (i + 1) % 50 == 0 or (i + 1) == len(tasks):
                print(f"  Processed {i + 1}/{len(tasks)} symbols ({len(all_event_dicts)} events so far, {time.time()-t_start:.1f}s)")

    df = pd.DataFrame(all_event_dicts)

    out_p = output_parquet or (OUTPUT_DIR / "events.parquet")
    out_c = output_csv or (OUTPUT_DIR / "events.csv")
    try:
        df.to_parquet(out_p, index=False)
    except Exception as e:
        print(f"Note: parquet save skipped ({e}), saving to CSV.")
    df.to_csv(out_c, index=False)

    return df, [EventRecord(**row) for row in all_event_dicts]


if __name__ == "__main__":
    t0 = time.time()
    print("Generating Equity Stance R0 events...")
    df, events = build_events_dataset()
    print(f"\nGenerated {len(df)} total events across {df['symbol'].nunique()} stocks in {time.time()-t0:.2f}s")
    print("\nEvents by Variant:")
    print(df["variant"].value_counts())
    print("\nEvents by Partition (H=63):")
    print(df["partition_63"].value_counts())
    print("\nIndependent events by Variant (H=63, valid return):")
    h63_valid = df[df["gross_return_63"].notnull() & df["is_independent"]]
    print(h63_valid["variant"].value_counts())
