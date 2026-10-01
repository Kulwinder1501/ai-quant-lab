"""Phase 4: Microstructure Incremental Test for Liquidity Intelligence Engine v1.

Tests the core research hypothesis:
  H0: Observable market microstructure features do NOT provide incremental predictive
      information about near-term interaction with identified liquidity pools beyond
      a geometry-only baseline.
  H1: Observable market microstructure features DO provide incremental predictive
      information beyond a geometry-only baseline.

Dataset:
- Joins active candidate pools with their point-in-time exact L2 depth frame
  from `depth_frames` (BANKNIFTY front-month futures) strictly at or before known_at_time.
- Temporal coverage: 2026-08-21 to 2026-09-24 (the entire contiguous L2 historical archive).
- Features engineered:
    * Spread & Spread bps
    * Mid price & Microprice
    * Microprice gap to mid (bps)
    * Level 1 Queue Imbalance
    * Level 3, 5, 10 Multi-level Depth Imbalances
    * Total Book Depth & Buy/Sell Ratio
- Chronological Walk-Forward / Holdout Evaluation:
    * Train: earlier sessions
    * Test: later sessions
    * Stage A (Geometry Only) vs Stage D (Geometry + L2 State)
"""

from __future__ import annotations

import os
import sys
import numpy as np
import pandas as pd
import psycopg
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    log_loss,
    roc_auc_score,
)
from sklearn.preprocessing import OneHotEncoder, StandardScaler


def get_connection_string() -> str:
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        return db_url
    return "postgresql://ai_quant_lab:ai_quant_lab@ai-quant-lab-db-v2:5432/ai_quant_lab"


def load_microstructure_dataset(horizon_seconds: int = 300) -> pd.DataFrame:
    conn_str = get_connection_string()
    query = f"""
    WITH candidates AS (
      SELECT
        lpc.id AS candidate_id,
        lpc.pool_type,
        lpc.side,
        lpc.timeframe,
        lpc.price AS pool_price,
        lpc.known_at_time,
        lcl.price_at_known,
        lcl.distance_bps,
        lcl.contacted,
        lcl.breached,
        lcl.max_excursion_toward_bps
      FROM liquidity_contact_labels lcl
      JOIN liquidity_pool_candidates lpc ON lcl.candidate_id = lpc.id
      WHERE lcl.horizon_seconds = {horizon_seconds}
        AND lcl.is_active_candidate = true
        AND lcl.contacted IS NOT NULL
        AND lpc.known_at_time >= '2026-08-21 00:00:00+00'
    )
    SELECT
      c.*,
      df.received_at AS depth_received_at,
      df.bid_price[1] AS best_bid,
      df.ask_price[1] AS best_ask,
      df.bid_qty[1] AS bid_qty_1,
      df.ask_qty[1] AS ask_qty_1,
      df.bid_qty[1:3] AS bid_qty_3,
      df.ask_qty[1:3] AS ask_qty_3,
      df.bid_qty[1:5] AS bid_qty_5,
      df.ask_qty[1:5] AS ask_qty_5,
      df.bid_qty[1:10] AS bid_qty_10,
      df.ask_qty[1:10] AS ask_qty_10,
      df.total_buy_qty,
      df.total_sell_qty
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT *
      FROM depth_frames d
      WHERE d.provider_symbol LIKE '%BANKNIFTY%FUT'
        AND d.received_at <= c.known_at_time
        AND d.received_at >= c.known_at_time - INTERVAL '10 seconds'
        AND d.levels_stored >= 5
      ORDER BY d.received_at DESC
      LIMIT 1
    ) df ON true
    WHERE df.received_at IS NOT NULL
    ORDER BY c.known_at_time ASC;
    """
    with psycopg.connect(conn_str) as conn:
        df = pd.read_sql_query(query, conn)
    return df


def engineer_microstructure_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    y = df["contacted"].astype(int)

    # 1. Geometry Features
    dist = df["distance_bps"].astype(float).clip(lower=0.0)
    log_dist = np.log1p(dist)

    feats = pd.DataFrame(index=df.index)
    feats["log_distance_bps"] = log_dist
    feats["pool_type"] = df["pool_type"]
    feats["side"] = df["side"]
    feats["timeframe"] = df["timeframe"]

    # 2. L2 Microstructure State Features
    best_bid = df["best_bid"].astype(float)
    best_ask = df["best_ask"].astype(float)
    bid_qty_1 = df["bid_qty_1"].astype(float)
    ask_qty_1 = df["ask_qty_1"].astype(float)

    mid_price = (best_bid + best_ask) / 2.0
    spread = (best_ask - best_bid).clip(lower=0.0)
    spread_bps = (spread / mid_price) * 10000.0

    # Queue Imbalance L1: in [-1, +1]
    denom_1 = (bid_qty_1 + ask_qty_1).replace(0, np.nan)
    qi_1 = ((bid_qty_1 - ask_qty_1) / denom_1).fillna(0.0)

    # Microprice: volume-weighted mid price
    microprice = (best_bid * ask_qty_1 + best_ask * bid_qty_1) / denom_1
    microprice_gap_bps = ((microprice - mid_price) / mid_price * 10000.0).fillna(0.0)

    # Multi-level Depth sums
    def sum_array(col: pd.Series) -> pd.Series:
        return col.apply(lambda arr: sum(arr) if isinstance(arr, (list, tuple, np.ndarray)) else 0.0)

    sum_bid_3 = sum_array(df["bid_qty_3"])
    sum_ask_3 = sum_array(df["ask_qty_3"])
    qi_3 = ((sum_bid_3 - sum_ask_3) / (sum_bid_3 + sum_ask_3).replace(0, np.nan)).fillna(0.0)

    sum_bid_5 = sum_array(df["bid_qty_5"])
    sum_ask_5 = sum_array(df["ask_qty_5"])
    qi_5 = ((sum_bid_5 - sum_ask_5) / (sum_bid_5 + sum_ask_5).replace(0, np.nan)).fillna(0.0)

    sum_bid_10 = sum_array(df["bid_qty_10"])
    sum_ask_10 = sum_array(df["ask_qty_10"])
    qi_10 = ((sum_bid_10 - sum_ask_10) / (sum_bid_10 + sum_ask_10).replace(0, np.nan)).fillna(0.0)

    total_buy = df["total_buy_qty"].astype(float)
    total_sell = df["total_sell_qty"].astype(float)
    total_book_qi = ((total_buy - total_sell) / (total_buy + total_sell).replace(0, np.nan)).fillna(0.0)
    total_depth_log = np.log1p(total_buy + total_sell)

    # Alignment with pool side:
    # If pool is UP (overhead), positive ask imbalance opposes movement, negative helps
    # We construct "imbalance_toward_pool"
    pool_is_up = (df["side"] == "UP").astype(float)
    # When UP, we want price to rise (buying pressure = positive bid imbalance)
    imbalance_toward_pool_l1 = np.where(pool_is_up == 1.0, qi_1, -qi_1)
    imbalance_toward_pool_l5 = np.where(pool_is_up == 1.0, qi_5, -qi_5)
    microprice_toward_pool_bps = np.where(pool_is_up == 1.0, microprice_gap_bps, -microprice_gap_bps)

    # Store Microstructure Features
    feats["spread_bps"] = spread_bps
    feats["qi_1"] = qi_1
    feats["qi_3"] = qi_3
    feats["qi_5"] = qi_5
    feats["qi_10"] = qi_10
    feats["total_book_qi"] = total_book_qi
    feats["total_depth_log"] = total_depth_log
    feats["microprice_gap_bps"] = microprice_gap_bps
    feats["imbalance_toward_pool_l1"] = imbalance_toward_pool_l1
    feats["imbalance_toward_pool_l5"] = imbalance_toward_pool_l5
    feats["microprice_toward_pool_bps"] = microprice_toward_pool_bps

    return feats, y


def evaluate(
    name: str,
    y_test: pd.Series,
    p_test: np.ndarray,
) -> dict[str, float]:
    p_test_clipped = np.clip(p_test, 1e-6, 1.0 - 1e-6)
    roc_auc = roc_auc_score(y_test, p_test)
    pr_auc = average_precision_score(y_test, p_test)
    brier = brier_score_loss(y_test, p_test)
    loss = log_loss(y_test, p_test_clipped)

    return {
        "model": name,
        "test_roc_auc": round(float(roc_auc), 4),
        "test_pr_auc": round(float(pr_auc), 4),
        "test_brier": round(float(brier), 4),
        "test_log_loss": round(float(loss), 4),
    }


def run_phase4_experiment(horizon_seconds: int = 300) -> None:
    print(f"\n=========================================================================")
    print(f"  PHASE 4: MICROSTRUCTURE INCREMENTAL TEST (Horizon: {horizon_seconds}s)")
    print(f"=========================================================================")

    df = load_microstructure_dataset(horizon_seconds)
    n_samples = len(df)
    print(f"Total matched (Candidate + L2 Depth Frame) samples: {n_samples}")
    if n_samples < 50:
        print("Insufficient samples with matching L2 depth frames. Aborting.")
        return

    feats, y = engineer_microstructure_features(df)

    # Chronological Split within the L2 archive:
    # 70% Train, 30% Test
    split_idx = int(n_samples * 0.70)
    train_mask = np.zeros(n_samples, dtype=bool)
    train_mask[:split_idx] = True
    test_mask = ~train_mask

    y_train = y[train_mask]
    y_test = y[test_mask]

    n_train = int(train_mask.sum())
    n_test = int(test_mask.sum())
    print(f"Chronological Train (N={n_train}, Positive rate={y_train.mean():.2%})")
    print(f"Chronological Test  (N={n_test}, Positive rate={y_test.mean():.2%})")

    # Geometry-Only Features
    geo_cols = ["pool_type", "side", "timeframe"]
    ohe = OneHotEncoder(sparse_output=False, handle_unknown="ignore")
    ohe_train = ohe.fit_transform(feats.loc[train_mask, geo_cols])
    ohe_test = ohe.transform(feats.loc[test_mask, geo_cols])

    dist_scaler = StandardScaler()
    dist_train = dist_scaler.fit_transform(feats.loc[train_mask, ["log_distance_bps"]])
    dist_test = dist_scaler.transform(feats.loc[test_mask, ["log_distance_bps"]])

    X_geo_train = np.hstack([dist_train, ohe_train])
    X_geo_test = np.hstack([dist_test, ohe_test])

    # L2 Microstructure Features
    l2_cols = [
        "spread_bps",
        "qi_1",
        "qi_3",
        "qi_5",
        "qi_10",
        "total_book_qi",
        "total_depth_log",
        "microprice_gap_bps",
        "imbalance_toward_pool_l1",
        "imbalance_toward_pool_l5",
        "microprice_toward_pool_bps",
    ]
    l2_scaler = StandardScaler()
    l2_train = l2_scaler.fit_transform(feats.loc[train_mask, l2_cols].fillna(0.0))
    l2_test = l2_scaler.transform(feats.loc[test_mask, l2_cols].fillna(0.0))

    # Combined Geometry + L2 Features
    X_combined_train = np.hstack([X_geo_train, l2_train])
    X_combined_test = np.hstack([X_geo_test, l2_test])

    results = []

    # 1. Null Prior
    p_null_test = np.full(n_test, float(y_train.mean()))
    results.append({
        "model": "0. Null / Base-Rate Prior",
        "test_roc_auc": 0.5000,
        "test_pr_auc": round(float(y_test.mean()), 4),
        "test_brier": round(brier_score_loss(y_test, p_null_test), 4),
        "test_log_loss": round(log_loss(y_test, p_null_test), 4),
    })

    # 2. Stage A: Geometry-Only Benchmark
    clf_geo = LogisticRegression(solver="lbfgs", max_iter=500, C=1.0)
    clf_geo.fit(X_geo_train, y_train)
    p_geo_test = clf_geo.predict_proba(X_geo_test)[:, 1]
    results.append(evaluate("1. Stage A: Geometry-Only Baseline", y_test, p_geo_test))

    # 3. Stage D: Geometry + L2 Microstructure (Logistic Regression)
    clf_combined = LogisticRegression(solver="lbfgs", max_iter=500, C=1.0)
    clf_combined.fit(X_combined_train, y_train)
    p_combined_test = clf_combined.predict_proba(X_combined_test)[:, 1]
    results.append(evaluate("2. Stage D: Geometry + L2 Microstructure (Linear)", y_test, p_combined_test))

    # 4. Stage F: Geometry + L2 Microstructure (XGBoost / Gradient Boosting)
    try:
        from xgboost import XGBClassifier
        clf_xgb = XGBClassifier(
            n_estimators=50,
            max_depth=3,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
            eval_metric="logloss"
        )
        clf_xgb.fit(X_combined_train, y_train)
        p_xgb_test = clf_xgb.predict_proba(X_combined_test)[:, 1]
        results.append(evaluate("3. Stage F: Geometry + L2 (XGBoost Challenger)", y_test, p_xgb_test))
    except Exception as e:
        print(f"XGBoost evaluation skipped: {e}")

    # Results Table
    res_df = pd.DataFrame(results)
    print("\n--- OUT-OF-SAMPLE TEST PERFORMANCE (L2 ARCHIVE) ---")
    print(res_df.to_string(index=False))

    geo_auc = res_df.loc[res_df["model"].str.startswith("1."), "test_roc_auc"].values[0]
    l2_auc = res_df.loc[res_df["model"].str.startswith("2."), "test_roc_auc"].values[0]
    geo_brier = res_df.loc[res_df["model"].str.startswith("1."), "test_brier"].values[0]
    l2_brier = res_df.loc[res_df["model"].str.startswith("2."), "test_brier"].values[0]

    delta_auc = l2_auc - geo_auc
    delta_brier = l2_brier - geo_brier

    print("\n--- HYPOTHESIS TEST VERDICT ---")
    print(f"Delta ROC-AUC (Stage D vs Stage A): {delta_auc:+.4f}")
    print(f"Delta Brier   (Stage D vs Stage A): {delta_brier:+.4f} (negative is better)")

    if delta_auc > 0.01:
        print("VERDICT: H1 ACCEPTED! L2 microstructure provides material incremental predictive power.")
    elif delta_auc >= -0.005:
        print("VERDICT: INCONCLUSIVE / EQUIVALENT. L2 features neither materially add nor subtract edge over geometry.")
    else:
        print("VERDICT: H0 NOT REJECTED. L2 features added noise on this sample.")


if __name__ == "__main__":
    for h in [120, 300]:
        run_phase4_experiment(h)
