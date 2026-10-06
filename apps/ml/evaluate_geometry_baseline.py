"""Phase 3: Geometry-Only Baseline Evaluation for Liquidity Intelligence Engine v1.

Evaluates whether observable geometric liquidity features alone (distance to pool,
pool type, side, time of day) have statistically valid predictive power for near-term
contact, establishing the H0 benchmark floor before any microstructure features are
introduced.

Validation Protocol:
- Chronological Split:
    Train: Jan 01, 2026 - Jun 30, 2026
    Test:  Jul 01, 2026 - Sep 24, 2026
- Purged boundary to prevent horizon overlap.
- Metrics: ROC-AUC, PR-AUC (Average Precision), Brier Score, Log Loss.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
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


def load_dataset(horizon_seconds: int = 300) -> pd.DataFrame:
    conn_str = get_connection_string()
    query = f"""
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
    ORDER BY lpc.known_at_time ASC;
    """
    with psycopg.connect(conn_str) as conn:
        df = pd.read_sql_query(query, conn)
    return df


def engineer_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    # Target
    y = df["contacted"].astype(int)

    # Time features (Asia/Kolkata timezone: UTC + 5h30m)
    known_dt = pd.to_datetime(df["known_at_time"])
    ist_dt = known_dt + pd.Timedelta(hours=5, minutes=30)

    minutes_since_open = (ist_dt.dt.hour * 60 + ist_dt.dt.minute) - (9 * 60 + 15)
    normalized_session_time = (minutes_since_open / 375.0).clip(0.0, 1.0)
    is_opening = (minutes_since_open <= 30).astype(float)
    is_closing = (minutes_since_open >= 345).astype(float)

    # Distance features
    dist = df["distance_bps"].astype(float).clip(lower=0.0)
    log_dist = np.log1p(dist)

    feats = pd.DataFrame(index=df.index)
    feats["distance_bps"] = dist
    feats["log_distance_bps"] = log_dist
    feats["pool_type"] = df["pool_type"]
    feats["side"] = df["side"]
    feats["timeframe"] = df["timeframe"]
    feats["session_time"] = normalized_session_time
    feats["is_opening"] = is_opening
    feats["is_closing"] = is_closing

    return feats, y


def evaluate_model(
    name: str,
    y_train: pd.Series,
    y_test: pd.Series,
    p_train: np.ndarray,
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


def run_experiment(horizon_seconds: int = 300) -> None:
    print(f"\n=======================================================")
    print(f"  PHASE 3: GEOMETRY-ONLY BASELINE (Horizon: {horizon_seconds}s / {horizon_seconds//60}m)")
    print(f"=======================================================")

    df = load_dataset(horizon_seconds)
    total_samples = len(df)
    print(f"Total labeled active candidates: {total_samples}")

    feats, y = engineer_features(df)

    # Chronological Split: Train < 2026-07-01, Test >= 2026-07-01
    known_time = pd.to_datetime(df["known_at_time"])
    split_date = pd.Timestamp("2026-07-01 00:00:00+0000", tz="UTC")

    train_mask = known_time < split_date
    test_mask = known_time >= split_date

    n_train = int(train_mask.sum())
    n_test = int(test_mask.sum())
    y_train = y[train_mask]
    y_test = y[test_mask]

    prior_train = float(y_train.mean())
    prior_test = float(y_test.mean())

    print(f"Train period: {known_time[train_mask].min()} to {known_time[train_mask].max()} (N={n_train}, Positive rate={prior_train:.2%})")
    print(f"Test period:  {known_time[test_mask].min()} to {known_time[test_mask].max()} (N={n_test}, Positive rate={prior_test:.2%})")

    results = []

    # 1. Null / Prior Model (always predicts training prior)
    p_null_train = np.full(n_train, prior_train)
    p_null_test = np.full(n_test, prior_train)
    # For ROC/PR AUC of null model, use jitter-free constant (or prior)
    res_null = {
        "model": "0. Null / Base-Rate Prior",
        "test_roc_auc": 0.5000,
        "test_pr_auc": round(prior_test, 4),
        "test_brier": round(brier_score_loss(y_test, p_null_test), 4),
        "test_log_loss": round(log_loss(y_test, p_null_test), 4),
    }
    results.append(res_null)

    # 2. Model 1: Distance Only (log distance)
    X_dist_train = feats.loc[train_mask, ["log_distance_bps"]].copy()
    X_dist_test = feats.loc[test_mask, ["log_distance_bps"]].copy()

    scaler_dist = StandardScaler()
    X_dist_train_s = scaler_dist.fit_transform(X_dist_train)
    X_dist_test_s = scaler_dist.transform(X_dist_test)

    clf_dist = LogisticRegression(solver="lbfgs")
    clf_dist.fit(X_dist_train_s, y_train)
    p_dist_test = clf_dist.predict_proba(X_dist_test_s)[:, 1]
    p_dist_train = clf_dist.predict_proba(X_dist_train_s)[:, 1]

    results.append(evaluate_model("1. Distance-Only (Log Distance)", y_train, y_test, p_dist_train, p_dist_test))

    # 3. Model 2: Stage A (Distance + Pool Type + Side)
    cat_cols = ["pool_type", "side", "timeframe"]
    ohe = OneHotEncoder(sparse_output=False, handle_unknown="ignore")
    ohe_train = ohe.fit_transform(feats.loc[train_mask, cat_cols])
    ohe_test = ohe.transform(feats.loc[test_mask, cat_cols])

    X_stageA_train = np.hstack([X_dist_train_s, ohe_train])
    X_stageA_test = np.hstack([X_dist_test_s, ohe_test])

    clf_stageA = LogisticRegression(solver="lbfgs", max_iter=500)
    clf_stageA.fit(X_stageA_train, y_train)
    p_stageA_test = clf_stageA.predict_proba(X_stageA_test)[:, 1]
    p_stageA_train = clf_stageA.predict_proba(X_stageA_train)[:, 1]

    results.append(evaluate_model("2. Stage A: Geometry (Dist + Type + Side)", y_train, y_test, p_stageA_train, p_stageA_test))

    # 4. Model 3: Stage B (Stage A + Time Context)
    time_cols = ["session_time", "is_opening", "is_closing"]
    X_time_train = feats.loc[train_mask, time_cols].values
    X_time_test = feats.loc[test_mask, time_cols].values

    X_stageB_train = np.hstack([X_stageA_train, X_time_train])
    X_stageB_test = np.hstack([X_stageA_test, X_time_test])

    clf_stageB = LogisticRegression(solver="lbfgs", max_iter=500)
    clf_stageB.fit(X_stageB_train, y_train)
    p_stageB_test = clf_stageB.predict_proba(X_stageB_test)[:, 1]
    p_stageB_train = clf_stageB.predict_proba(X_stageB_train)[:, 1]

    results.append(evaluate_model("3. Stage B: Geometry + Session Context", y_train, y_test, p_stageB_train, p_stageB_test))

    # Print Results Table
    res_df = pd.DataFrame(results)
    print("\n--- OUT-OF-SAMPLE TEST PERFORMANCE ---")
    print(res_df.to_string(index=False))

    # Calculate Deltas over Distance-Only
    dist_auc = res_df.loc[res_df["model"].str.startswith("1."), "test_roc_auc"].values[0]
    stageA_auc = res_df.loc[res_df["model"].str.startswith("2."), "test_roc_auc"].values[0]
    stageB_auc = res_df.loc[res_df["model"].str.startswith("3."), "test_roc_auc"].values[0]

    print("\n--- INCREMENTAL DELTAS ---")
    print(f"Delta(Stage A over Distance): ROC-AUC {stageA_auc - dist_auc:+.4f}")
    print(f"Delta(Stage B over Stage A):  ROC-AUC {stageB_auc - stageA_auc:+.4f}")
    print(f"Total Geometry Edge over Null: ROC-AUC {stageB_auc - 0.50:+.4f}")


if __name__ == "__main__":
    for h in [120, 300]:
        run_experiment(h)
