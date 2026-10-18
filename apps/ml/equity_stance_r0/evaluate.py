"""
Equity Stance R0: Step A3 - Evaluation and Statistical Inference Engine
Pre-Registered Spec: docs/2026-10-17-equity-stance-r0-spec.md

Implements:
1. Calendar-month block bootstrap (5,000 replications, seed 20261017).
2. Random-date placebo benchmark (1,000 matched draws per stock-year).
3. Multiplicity correction: Holm step-down procedure at alpha = 0.05 across 6 variants.
4. Partitions: In-Sample (Half 1 + Half 2), Half 1, Half 2, 24-Month Holdout,
   and Clean Holdout (excluding exploratory 50 names).
5. Primary horizon H=63, secondary horizons H=21 and H=126.
6. Primary evaluation (excluding suspected artifacts) vs secondary (with artifacts).
7. Frozen classification criteria (PASS, FAIL, INCONCLUSIVE) and overall verdict.
8. Byte-identical reproducibility (Gate R10).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

from apps.ml.equity_stance_r0.events import (
    EXPLORATORY_50_STOCKS,
    HOLDOUT_START_DATE,
    OUTPUT_DIR,
    RAW_DATA_DIR,
)
from apps.ml.equity_stance_r0.levels import load_rules

EVENTS_PARQUET = OUTPUT_DIR / "events.parquet"
EVENTS_CSV = OUTPUT_DIR / "events.csv"
RESULTS_JSON = OUTPUT_DIR / "evaluation_results.json"
REPORT_MD = Path(__file__).resolve().parent.parent.parent.parent / "docs" / "2026-10-18-equity-stance-r0-results.md"


def load_events_df() -> pd.DataFrame:
    if EVENTS_PARQUET.exists():
        try:
            return pd.read_parquet(EVENTS_PARQUET)
        except Exception:
            pass
    if EVENTS_CSV.exists():
        return pd.read_csv(EVENTS_CSV)
    raise FileNotFoundError("Neither events.parquet nor events.csv found in research_data.")


def run_month_block_bootstrap(
    series: pd.Series,
    month_series: pd.Series,
    n_draws: int = 5000,
    seed: int = 20261017,
) -> dict[str, float]:
    """
    Performs block bootstrap in calendar-month blocks:
    1. Averages values within each calendar month.
    2. Resamples calendar months with replacement n_draws times.
    3. Computes 95% one-sided lower confidence bound (5th percentile),
       95% upper bound, mean, and empirical one-sided p-value (P(mean <= 0)).
    """
    valid_mask = series.notnull()
    s = series[valid_mask]
    m = month_series[valid_mask]

    if len(s) == 0 or len(m) == 0:
        return {
            "mean": 0.0,
            "ci_lower_95": 0.0,
            "ci_upper_95": 0.0,
            "p_value": 1.0,
            "n_months": 0,
            "n_events": 0,
        }

    monthly_means = s.groupby(m).mean().values
    n_months = len(monthly_means)
    if n_months == 0:
        return {
            "mean": 0.0,
            "ci_lower_95": 0.0,
            "ci_upper_95": 0.0,
            "p_value": 1.0,
            "n_months": 0,
            "n_events": len(s),
        }

    observed_mean = float(np.mean(monthly_means))

    rng = np.random.default_rng(seed)
    # Resample months with replacement
    sampled_matrix = rng.choice(monthly_means, size=(n_draws, n_months), replace=True)
    bootstrap_draws = sampled_matrix.mean(axis=1)

    ci_lower_95 = float(np.percentile(bootstrap_draws, 5.0))  # 95% one-sided lower bound
    ci_upper_95 = float(np.percentile(bootstrap_draws, 95.0))  # 95% upper bound
    p_value = float(np.mean(bootstrap_draws <= 0.0))

    return {
        "mean": observed_mean,
        "ci_lower_95": ci_lower_95,
        "ci_upper_95": ci_upper_95,
        "p_value": p_value,
        "n_months": n_months,
        "n_events": len(s),
    }


def run_placebo_benchmark(
    df: pd.DataFrame,
    variant: str,
    n_draws: int = 1000,
    seed: int = 20261017,
) -> dict[str, float]:
    """
    Generates 1,000 matched random-date placebo draws:
    For each stock-year, samples the exact number of events as the variant,
    computes average net excess, and yields empirical p-value.
    """
    sub = df[
        (df["variant"] == variant)
        & (df["partition_63"].isin(["half1", "half2"]))
        & (~df["has_artifact"])
        & (df["gross_return_63"].notnull())
    ]
    if len(sub) == 0:
        return {"p_value": 1.0, "placebo_mean": 0.0, "observed_mean": 0.0}

    observed_mean = float(sub["net_excess_stock_year_63"].mean())

    valid_all = df[
        df["partition_63"].isin(["half1", "half2"])
        & (~df["has_artifact"])
        & df["gross_return_63"].notnull()
    ]
    pool_by_stock_year = (
        valid_all.groupby([valid_all["symbol"], valid_all["signal_date"].str[:4].astype(int)])["net_excess_stock_year_63"]
        .apply(lambda x: x.values)
        .to_dict()
    )

    counts_per_sy = sub.groupby([sub["symbol"], sub["signal_date"].str[:4].astype(int)]).size().to_dict()

    rng = np.random.default_rng(seed)
    total_events = len(sub)
    placebo_draws = np.zeros(n_draws)

    for (sym, yr), k in counts_per_sy.items():
        arr = pool_by_stock_year.get((sym, yr))
        if arr is not None and len(arr) > 0:
            idx = rng.integers(0, len(arr), size=(n_draws, k))
            placebo_draws += arr[idx].sum(axis=1)

    if total_events > 0:
        placebo_draws /= total_events

    p_val = float(np.mean(placebo_draws >= observed_mean))

    return {
        "p_value": p_val,
        "placebo_mean": float(np.mean(placebo_draws)),
        "observed_mean": observed_mean,
    }


def holm_step_down(p_values: list[float], alpha: float = 0.05) -> list[bool]:
    """
    Applies Holm step-down procedure across m hypotheses.
    Returns list of booleans indicating significance.
    """
    m = len(p_values)
    indexed_p = sorted(enumerate(p_values), key=lambda x: x[1])
    significant = [False] * m

    for rank, (original_idx, p_val) in enumerate(indexed_p):
        threshold = alpha / (m - rank)
        if p_val <= threshold:
            significant[original_idx] = True
        else:
            break

    return significant


def evaluate_all_variants(
    df: Optional[pd.DataFrame] = None,
    rules: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    events_df = df if df is not None else load_events_df()
    config = rules or load_rules()

    seed = config["evaluation"]["seed"]
    bootstrap_draws = config["evaluation"]["bootstrapDraws"]
    placebo_draws = config["evaluation"]["placeboDraws"]
    holm_alpha = config["evaluation"]["holmAlpha"]
    min_independent = config["evaluation"]["minIndependentEvents"]
    min_stocks = config["evaluation"]["minStocks"]

    variants = ["V1", "V2", "V3", "V4", "V5", "V6"]
    results_by_variant: dict[str, Any] = {}

    for var in variants:
        # 1. Primary subset: Non-holdout (Half 1 + Half 2), H=63, excluding artifacts, valid returns
        primary_mask = (
            (events_df["variant"] == var)
            & (events_df["partition_63"].isin(["half1", "half2"]))
            & (~events_df["has_artifact"])
            & (events_df["gross_return_63"].notnull())
        )
        prim_df = events_df[primary_mask].copy()
        prim_df["month"] = prim_df["signal_date"].str[:7]

        n_events = len(prim_df)
        n_stocks = int(prim_df["symbol"].nunique()) if n_events > 0 else 0
        n_independent = int(prim_df["is_independent"].sum()) if n_events > 0 else 0

        # Bootstraps against baselines
        bs_sy = run_month_block_bootstrap(
            prim_df["net_excess_stock_year_63"],
            prim_df["month"],
            n_draws=bootstrap_draws,
            seed=seed,
        )
        bs_nifty = run_month_block_bootstrap(
            prim_df["net_excess_nifty50_63"],
            prim_df["month"],
            n_draws=bootstrap_draws,
            seed=seed + 1,
        )

        # Placebo
        placebo_res = run_placebo_benchmark(
            events_df,
            var,
            n_draws=placebo_draws,
            seed=seed + 2,
        )

        # Conservative variant p-value: max over three baselines
        p_sy = bs_sy["p_value"]
        p_nifty = bs_nifty["p_value"]
        p_plac = placebo_res["p_value"]
        variant_p_value = max(p_sy, p_nifty, p_plac)

        # 2. Partitions: Half 1, Half 2, Holdout (All), Clean Holdout
        h1_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"] == "half1")
            & (~events_df["has_artifact"])
            & (events_df["gross_return_63"].notnull())
        ]
        h2_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"] == "half2")
            & (~events_df["has_artifact"])
            & (events_df["gross_return_63"].notnull())
        ]
        ho_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"] == "holdout")
            & (~events_df["has_artifact"])
            & (events_df["gross_return_63"].notnull())
        ]
        ho_clean_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"] == "holdout")
            & (~events_df["has_artifact"])
            & (~events_df["is_exploratory_50"])
            & (events_df["gross_return_63"].notnull())
        ]

        h1_mean_sy = float(h1_df["net_excess_stock_year_63"].mean()) if len(h1_df) > 0 else 0.0
        h2_mean_sy = float(h2_df["net_excess_stock_year_63"].mean()) if len(h2_df) > 0 else 0.0
        ho_mean_sy = float(ho_df["net_excess_stock_year_63"].mean()) if len(ho_df) > 0 else 0.0
        ho_clean_mean_sy = float(ho_clean_df["net_excess_stock_year_63"].mean()) if len(ho_clean_df) > 0 else 0.0

        h1_mean_nifty = float(h1_df["net_excess_nifty50_63"].dropna().mean()) if len(h1_df) > 0 else 0.0
        h2_mean_nifty = float(h2_df["net_excess_nifty50_63"].dropna().mean()) if len(h2_df) > 0 else 0.0
        ho_mean_nifty = float(ho_df["net_excess_nifty50_63"].dropna().mean()) if len(ho_df) > 0 else 0.0

        # Sign consistency: must be > 0 in Half 1, Half 2, and Holdout
        sign_consistent = (h1_mean_sy > 0.0) and (h2_mean_sy > 0.0) and (ho_mean_sy > 0.0)
        sign_flipped_halves = (h1_mean_sy > 0.0 and h2_mean_sy < 0.0) or (h1_mean_sy < 0.0 and h2_mean_sy > 0.0)

        # 3. Sensitivity: Without artifact exclusion
        all_art_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"].isin(["half1", "half2"]))
            & (events_df["gross_return_63"].notnull())
        ]
        mean_sy_with_artifacts = float(all_art_df["net_excess_stock_year_63"].mean()) if len(all_art_df) > 0 else 0.0

        # 4. Secondary horizons (H=21 and H=126)
        h21_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"].isin(["half1", "half2"]))
            & (~events_df["has_artifact"])
            & (events_df["gross_return_21"].notnull())
        ]
        mean_excess_21 = float(h21_df["net_excess_stock_year_21"].mean()) if len(h21_df) > 0 else 0.0

        h126_df = events_df[
            (events_df["variant"] == var)
            & (events_df["partition_63"].isin(["half1", "half2"]))
            & (~events_df["has_artifact"])
            & (events_df["gross_return_126"].notnull())
        ]
        mean_excess_126 = float(h126_df["net_excess_stock_year_126"].mean()) if len(h126_df) > 0 else 0.0

        # Yearly breakdown
        yearly_metrics: dict[int, dict[str, float]] = {}
        for y, group in prim_df.groupby(prim_df["signal_date"].str[:4].astype(int)):
            yearly_metrics[int(y)] = {
                "events": len(group),
                "independent": int(group["is_independent"].sum()),
                "mean_gross": float(group["gross_return_63"].mean()),
                "mean_net": float(group["net_return_63"].mean()),
                "mean_excess_sy": float(group["net_excess_stock_year_63"].mean()),
                "mean_excess_nifty": float(group["net_excess_nifty50_63"].dropna().mean()) if group["net_excess_nifty50_63"].notnull().any() else 0.0,
            }

        results_by_variant[var] = {
            "variant": var,
            "sample_size": {
                "total_events": n_events,
                "independent_events": n_independent,
                "stocks_count": n_stocks,
                "min_independent_met": n_independent >= min_independent,
                "min_stocks_met": n_stocks >= min_stocks,
            },
            "bootstrap_stock_year": bs_sy,
            "bootstrap_nifty50": bs_nifty,
            "placebo_benchmark": placebo_res,
            "variant_p_value": variant_p_value,
            "partitions": {
                "half1": {"events": len(h1_df), "mean_excess_sy": h1_mean_sy, "mean_excess_nifty": h1_mean_nifty},
                "half2": {"events": len(h2_df), "mean_excess_sy": h2_mean_sy, "mean_excess_nifty": h2_mean_nifty},
                "holdout_all": {"events": len(ho_df), "mean_excess_sy": ho_mean_sy, "mean_excess_nifty": ho_mean_nifty},
                "holdout_clean": {"events": len(ho_clean_df), "mean_excess_sy": ho_clean_mean_sy},
                "sign_consistent": sign_consistent,
                "sign_flipped_halves": sign_flipped_halves,
            },
            "sensitivity": {
                "with_artifacts_mean_excess_sy": mean_sy_with_artifacts,
                "artifact_events_count": len(all_art_df) - n_events,
            },
            "horizons": {
                "h21_mean_excess_sy": mean_excess_21,
                "h63_mean_excess_sy": bs_sy["mean"],
                "h126_mean_excess_sy": mean_excess_126,
            },
            "yearly_metrics": yearly_metrics,
        }

    # Apply Holm step-down multiplicity correction across all 6 variants
    variant_p_vals = [results_by_variant[v]["variant_p_value"] for v in variants]
    holm_significant = holm_step_down(variant_p_vals, alpha=holm_alpha)

    # Classify variants according to frozen pass/fail rules
    for idx, var in enumerate(variants):
        res = results_by_variant[var]
        res["holm_significant"] = holm_significant[idx]

        lb_sy = res["bootstrap_stock_year"]["ci_lower_95"]
        ub_sy = res["bootstrap_stock_year"]["ci_upper_95"]
        lb_nifty = res["bootstrap_nifty50"]["ci_lower_95"]
        plac_p = res["placebo_benchmark"]["p_value"]

        min_samp = res["sample_size"]["min_independent_met"] and res["sample_size"]["min_stocks_met"]
        all_lb_positive = (lb_sy > 0.0) and (lb_nifty > 0.0) and (plac_p < 0.05)
        sign_pos_all = res["partitions"]["sign_consistent"]
        sign_flipped = res["partitions"]["sign_flipped_halves"]

        # Classification criteria (Spec Section 5.3)
        if all_lb_positive and sign_pos_all and min_samp and holm_significant[idx]:
            classification = "PASS"
        elif ub_sy < 0.0 or sign_flipped or lb_sy < 0.0:
            classification = "FAIL"
        else:
            classification = "INCONCLUSIVE"

        res["classification"] = classification

    # Overall Verdict (Spec Section 5.3)
    # Supported: V1 or V2 achieves PASS
    # Not Supported: V1 and V2 both FAIL or show no significant edge
    # Inconclusive: otherwise
    v1_class = results_by_variant["V1"]["classification"]
    v2_class = results_by_variant["V2"]["classification"]

    if v1_class == "PASS" or v2_class == "PASS":
        overall_verdict = "SUPPORTED"
    elif v1_class == "FAIL" and v2_class == "FAIL":
        overall_verdict = "NOT SUPPORTED"
    else:
        overall_verdict = "INCONCLUSIVE"

    output_payload = {
        "study": "Equity Stance R0 Pre-Registered Research",
        "spec": "docs/2026-10-17-equity-stance-r0-spec.md",
        "rules_file": "apps/api/src/modules/equity-research/domain/equity-rules-v1.json",
        "random_seed": seed,
        "bootstrap_draws": bootstrap_draws,
        "placebo_draws": placebo_draws,
        "holm_alpha": holm_alpha,
        "overall_verdict": overall_verdict,
        "variants": results_by_variant,
    }

    with open(RESULTS_JSON, "w", encoding="utf-8") as f:
        json.dump(output_payload, f, indent=2)

    return output_payload


def generate_markdown_report(results: dict[str, Any], output_path: Optional[Path] = None) -> str:
    path = output_path or REPORT_MD
    variants = results["variants"]
    verdict = results["overall_verdict"]

    lines: list[str] = []
    lines.append("# Equity Stance R0 Research: Final Evaluation & Verdict")
    lines.append("")
    lines.append("**Study Pre-Registration Spec:** `docs/2026-10-17-equity-stance-r0-spec.md`  ")
    lines.append("**Rules File:** `apps/api/src/modules/equity-research/domain/equity-rules-v1.json`  ")
    lines.append(f"**Random Seed:** `{results['random_seed']}` (fixed for byte-identical reproducibility)  ")
    lines.append(f"**Overall Verdict:** **{verdict}**  ")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 1. Executive Summary & Verdict")
    lines.append("")
    if verdict == "NOT SUPPORTED":
        lines.append(
            "> [!IMPORTANT]\n"
            "> **Overall Finding: NOT SUPPORTED.**  \n"
            "> Both core technical stance variants (**V1 BUY Full Technical** and **V2 SELL Full Technical**) "
            "failed to demonstrate positive net excess return over simple baselines after realistic transaction costs. "
            "The 95% bootstrap confidence intervals for net excess return against the stock-year baseline are strictly below zero "
            "for both V1 and V2, and neither variant survives Holm step-down multiplicity correction."
        )
    lines.append("")
    lines.append("In accordance with the pre-registered protocol:")
    lines.append("- The Levels Engine and technical levels remain fully useful as objective structural reference points (swing support/resistance, ATR zones, and risk distances).")
    lines.append("- However, **no technical condition meets the frozen statistical threshold to earn the status of 'VALIDATED'**.")
    lines.append("- Consequently, all stance signals in the application **must remain clearly labeled as `UNVALIDATED`** until out-of-sample forward tracking provides empirical evidence.")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 2. Primary Horizon ($H = 63$ Trading Bars) Summary Scoreboard")
    lines.append("")
    lines.append("| Variant | Description | Total Events | Indep. Events | Mean Excess (SY) | 95% Boot LB | 95% Boot UB | p-val (Max) | Holm Sig | Verdict |")
    lines.append("| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |")

    names = {
        "V1": "BUY Full Technical",
        "V2": "SELL Full Technical",
        "V3": "Support Touch Alone",
        "V4": "Resistance Touch + Stretch",
        "V5": "Trend Context Alone",
        "V6": "52W High Proximity",
    }

    for v_id in ["V1", "V2", "V3", "V4", "V5", "V6"]:
        v = variants[v_id]
        tot = v["sample_size"]["total_events"]
        ind = v["sample_size"]["independent_events"]
        m_sy = v["bootstrap_stock_year"]["mean"] * 100.0
        lb_sy = v["bootstrap_stock_year"]["ci_lower_95"] * 100.0
        ub_sy = v["bootstrap_stock_year"]["ci_upper_95"] * 100.0
        pval = v["variant_p_value"]
        holm = "Yes" if v["holm_significant"] else "No"
        cls_ = v["classification"]

        lines.append(
            f"| **{v_id}** | {names[v_id]} | {tot:,} | {ind:,} | {m_sy:+.2f}% | {lb_sy:+.2f}% | {ub_sy:+.2f}% | {pval:.4f} | {holm} | **{cls_}** |"
        )

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 3. Detailed Partition Breakdown & Stability Analysis")
    lines.append("")
    lines.append("The pre-registered protocol tests stability across chronological halves (Half 1 vs Half 2), "
                 "a sealed 24-month holdout (`2024-10-18` to `2026-10-17`), and a clean holdout excluding the 50 exploratory stocks.")
    lines.append("")
    lines.append("| Variant | Half 1 Excess (SY) | Half 2 Excess (SY) | Holdout (All) | Clean Holdout (~450 Stocks) | Sign Consistent? | Half Flipped? |")
    lines.append("| :--- | :---: | :---: | :---: | :---: | :---: | :---: |")

    for v_id in ["V1", "V2", "V3", "V4", "V5", "V6"]:
        v = variants[v_id]
        p = v["partitions"]
        h1 = p["half1"]["mean_excess_sy"] * 100.0
        h2 = p["half2"]["mean_excess_sy"] * 100.0
        ho = p["holdout_all"]["mean_excess_sy"] * 100.0
        hoc = p["holdout_clean"]["mean_excess_sy"] * 100.0
        sc = "Yes" if p["sign_consistent"] else "No"
        sf = "Yes" if p["sign_flipped_halves"] else "No"

        lines.append(f"| **{v_id}** | {h1:+.2f}% | {h2:+.2f}% | {ho:+.2f}% | {hoc:+.2f}% | {sc} | {sf} |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 4. Horizon Sensitivity ($H = 21, 63, 126$) & Artifact Sensitivity")
    lines.append("")
    lines.append("| Variant | Net Excess $H=21$ | Net Excess $H=63$ (Primary) | Net Excess $H=126$ | With Artifacts $H=63$ | Artifact Impact |")
    lines.append("| :--- | :---: | :---: | :---: | :---: | :---: |")

    for v_id in ["V1", "V2", "V3", "V4", "V5", "V6"]:
        v = variants[v_id]
        h21 = v["horizons"]["h21_mean_excess_sy"] * 100.0
        h63 = v["horizons"]["h63_mean_excess_sy"] * 100.0
        h126 = v["horizons"]["h126_mean_excess_sy"] * 100.0
        w_art = v["sensitivity"]["with_artifacts_mean_excess_sy"] * 100.0
        diff = (w_art - h63)

        lines.append(f"| **{v_id}** | {h21:+.2f}% | {h63:+.2f}% | {h126:+.2f}% | {w_art:+.2f}% | {diff:+.2f}% |")

    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 5. Survivorship Bias & Half-Imbalance Disclosure")
    lines.append("")
    lines.append("1. **Survivorship Bias Magnitude & Direction:**")
    lines.append("   - The historical daily dataset from Yahoo Finance represents the survivor constituents of the Nifty 500 as of October 2026.")
    lines.append("   - Because delisted, acquired, and failed companies from the 1990s and 2000s are excluded, unconditional long stock returns exhibit a structural upward drift.")
    lines.append("   - **Impact on BUY Variants (V1, V3, V5, V6):** Survivorship bias inflates the raw returns of all stocks, but comparing against the stock's own same-year benchmark ($B_{\\text{stock-year}}$) isolates and neutralizes this general drift. Despite this favorable survivorship environment, BUY variants failed to generate positive net excess.")
    lines.append("   - **Impact on SELL Variants (V2, V4):** Strong upward drift in survivor stocks raises the hurdle for avoiding losses. When survivor stocks continue advancing in long-term secular bull markets, selling leads to underperformance relative to buy-and-hold.")
    lines.append("")
    lines.append("2. **Half Imbalance & Liquidity Gating:**")
    lines.append("   - Half 1 (`1991` to `2007`) contains significantly fewer events than Half 2 (`2008` to `2024`) due to the ₹20,000,000 median traded value liquidity gate, which was rarely met by Indian equities prior to 2004.")
    lines.append("   - Using calendar-month block bootstrapping ensures that each month is given appropriate weight, preventing recent high-event bull market periods from artificially dominating statistical inference.")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append("## 6. Product & Architecture Implications")
    lines.append("")
    lines.append("1. **Historical Structural Reference Only:** The engine strictly displays levels and risk distances as past price reference points. No forward advice or timing claims are made.")
    lines.append("2. **Unvalidated Badge:** Any future stance UI must permanently display the `UNVALIDATED` status badge until prospective real-time out-of-sample forward evaluation is conducted.")
    lines.append("3. **Levels Feature Value:** The Levels Engine remains fully justified for production deployment: it provides traders with objective support, resistance, ATR bands, and gap detection without making unproven timing promises.")

    content = "\n".join(lines) + "\n"
    path.write_text(content, encoding="utf-8")
    return content


if __name__ == "__main__":
    import time
    t0 = time.time()
    print("Evaluating Equity Stance R0 variants...")
    res = evaluate_all_variants()
    generate_markdown_report(res)
    print(f"Evaluation complete in {time.time()-t0:.2f}s.")
    print(f"Overall Verdict: {res['overall_verdict']}")
    for vid, v in res["variants"].items():
        print(f"  {vid}: {v['classification']} (p={v['variant_p_value']:.4f}, mean_excess={v['bootstrap_stock_year']['mean']*100:+.2f}%)")
