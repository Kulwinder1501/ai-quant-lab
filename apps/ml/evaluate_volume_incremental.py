"""Phase 4B: Volume & Relative Volume Incremental Test for Liquidity Intelligence Engine v1.

Tests the core research hypothesis:
  H0: Observable volume and relative volume (RVOL) features do NOT provide incremental
      predictive information about near-term interaction with identified liquidity pools
      beyond the geometry-only baseline.
  H1: Observable volume and relative volume (RVOL) features DO provide incremental
      predictive information beyond the geometry-only baseline.

Dataset:
- Joins active candidate pools with historical candle volume and 20-bar trailing volume SMA
  strictly at or before known_at_time.
- Features engineered:
    * Raw bar volume
    * 20-bar Volume SMA
    * Relative Volume ratio (RVOL_20 = volume / volume_sma_20)
    * Log RVOL_20
    * High-Volume Surge Flag (RVOL_20 >= 1.5)
- Chronological Holdout Evaluation:
    * Train: Jan 01, 2026 - Jun 30, 2026
    * Test:  Jul 01, 2026 - Sep 24, 2026
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


def load_volume_dataset(horizon_seconds: int = 300) -> pd.DataFrame:
    conn_str = get_connection_string()
    query = f"""
    WITH candidates AS (
      SELECT
        lpc.id AS candidate_id,
        lpc.instrument_id,
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
    )
    SELECT
      c.*,
      vol.bar_volume,
      vol.vol_sma20
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT
        c1.volume AS bar_volume,
        AVG(c2.volume) AS vol_sma20
      FROM candles c1
      JOIN candles c2 ON c2.instrument_id = c1.instrument_id
                     AND c2.timeframe = c1.timeframe
                     AND c2.open_time <= c1.open_time
                     AND c2.open_time > c1.open_time - INTERVAL '20 minutes'
      WHERE c1.instrument_id = c.instrument_id
        AND c1.timeframe = c.timeframe
        AND c1.open_time <= c.known_at_time
      ORDER BY c1.open_time DESC
      LIMIT 1
      GROUP BY c1.volume
    ) vol ON true
    ORDER BY c.known_at_time ASC;
    """
    
    # Fallback simpler query if LATERAL GROUP BY is strict in Postgres:
    query_clean = f"""
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
      c.volume AS bar_volume,
      sub.avg_vol_20 AS vol_sma20
    FROM liquidity_contact_labels lcl
    JOIN liquidity_pool_candidates lpc ON lcl.candidate_id = lpc.id
    LEFT JOIN candles c ON c.instrument_id = lpc.instrument_id
                       AND c.timeframe = lpc.timeframe
                       AND c.open_time <= lpc.known_at_time
    LEFT JOIN LATERAL (
      SELECT AVG(c_sub.volume) as avg_vol_20
      FROM (
        SELECT volume FROM candles
        WHERE instrument_id = lpc.instrument_id
          AND timeframe = lpc.timeframe
          AND open_time <= lpc.known_at_time
        ORDER BY open_time DESC
        LIMIT 20
      ) c_sub
    ) sub ON true
    WHERE lcl.horizon_seconds = {horizon_seconds}
      AND lcl.is_active_candidate = true
      AND lcl.contacted IS NOT NULL
    ORDER BY lpc.known_at_time ASC;
    """
    with psycopg.connect(conn_str) as conn:
        df = pd.read_sql_query(query_clean, conn)
    return df


def engineer_volume_features(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series]:
    y = df["contacted"].astype(int)

    # 1. Geometry Features
    dist = df["distance_bps"].astype(float).clip(lower=0.0)
    log_dist = np.log1p(dist)

    known_dt = pd.to_datetime(df["known_at_time"])
    ist_dt = known_dt + pd.Timedelta(hours=5, minutes=30)
    minutes_since_open = (ist_dt.dt.hour * 60 + ist_dt.dt.minute) - (9 * 60 + 15)
    normalized_session_time = (minutes_since_open / 375.0).clip(0.0, 1.0)

    feats = pd.DataFrame(index=df.index)
    feats["log_distance_bps"] = log_dist
    feats["pool_type"] = df["pool_type"]
    feats["side"] = df["side"]
    feats["timeframe"] = df["timeframe"]
    feats["session_time"] = normalized_session_time

    # 2. Volume & RVOL Features
    bar_vol = df["bar_volume"].astype(float).fillna(0.0)
    vol_sma = df["vol_sma20"].astype(float).replace(0, np.nan).fillna(1.0)

    rvol_20 = (bar_vol / vol_sma).fillna(1.0).clip(0.0, 10.0)
    log_rvol = np.log1p(rvol_20)
    is_volume_surge = (rvol_20 >= 1.5).astype(float)

    feats["bar_volume_log"] = np.log1p(bar_vol)
    feats["rvol_20"] = rvol_20
    feats["log_rvol_20"] = log_rvol
    feats["is_volume_surge"] = is_volume_surge

    return feats, y


def evaluate(name: str, y_test: pd.Series, p_test: np.ndarray) -> dict[str, float]:
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


def run_volume_experiment(horizon_seconds: int = 300) -> None:
    print(f"\n=========================================================================")
    print(f"  PHASE 4B: VOLUME & RVOL INCREMENTAL TEST (Horizon: {horizon_seconds}s / {horizon_seconds//60}m)")
    print(f"=========================================================================")

    df = load_volume_dataset(horizon_seconds)
    total_samples = len(df)
    print(f"Total labeled active candidates with volume data: {total_samples}")

    feats, y = engineer_volume_features(df)

    known_time = pd.to_datetime(df["known_at_time"])
    split_date = pd.Timestamp("2026-07-01 00:00:00+0000", tz="UTC")

    train_mask = known_time < split_date
    test_mask = known_time >= split_date

    n_train = int(train_mask.sum())
    n_test = int(test_mask.sum())
    y_train = y[train_mask]
    y_test = y[test_mask]

    print(f"Train period: {known_time[train_mask].min()} to {known_time[train_mask].max()} (N={n_train}, Positive rate={y_train.mean():.2%})")
    print(f"Test period:  {known_time[test_mask].min()} to {known_time[test_mask].max()} (N={n_test}, Positive rate={y_test.mean():.2%})")

    # 1. Geometry Features
    cat_cols = ["pool_type", "side", "timeframe"]
    ohe = OneHotEncoder(sparse_output=False, handle_unknown="ignore")
    ohe_train = ohe.fit_transform(feats.loc[train_mask, cat_cols])
    ohe_test = ohe.transform(feats.loc[test_mask, cat_cols])

    dist_scaler = StandardScaler()
    dist_train = dist_scaler.fit_transform(feats.loc[train_mask, ["log_distance_bps", "session_time"]])
    dist_test = dist_scaler.transform(feats.loc[test_mask, ["log_distance_bps", "session_time"]])

    X_geo_train = np.hstack([dist_train, ohe_train])
    X_geo_test = np.hstack([dist_test, ohe_test])

    # 2. Volume Features
    vol_cols = ["bar_volume_log", "rvol_20", "log_rvol_20", "is_volume_surge"]
    vol_scaler = StandardScaler()
    vol_train = vol_scaler.fit_transform(feats.loc[train_mask, vol_cols])
    vol_test = vol_scaler.transform(feats.loc[test_mask, vol_cols])

    X_combined_train = np.hstack([X_geo_train, vol_train])
    X_combined_test = np.hstack([X_geo_test, vol_test])

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

    # 2. Stage A: Geometry-Only Baseline
    clf_geo = LogisticRegression(solver="lbfgs", max_iter=500, C=1.0)
    clf_geo.fit(X_geo_train, y_train)
    p_geo_test = clf_geo.predict_proba(X_geo_test)[:, 1]
    results.append(evaluate("1. Stage A: Geometry Baseline", y_test, p_geo_test))

    # 3. Stage V1: Geometry + Volume & RVOL (Linear Logistic)
    clf_vol = LogisticRegression(solver="lbfgs", max_iter=500, C=1.0)
    clf_vol.fit(X_combined_train, y_train)
    p_vol_test = clf_vol.predict_proba(X_combined_test)[:, 1]
    results.append(evaluate("2. Stage V1: Geometry + Volume/RVOL (Linear)", y_test, p_vol_test))

    # 4. Stage V2: Geometry + Volume (XGBoost Challenger)
    try:
        from xgboost import XGBClassifier
        clf_xgb = XGBClassifier(
            n_estimators=50,
            max_depth=3,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
            eval_metric="logloss",
        )
        clf_xgb.fit(X_combined_train, y_train)
        p_xgb_test = clf_xgb.predict_proba(X_combined_test)[:, 1]
        results.append(evaluate("3. Stage V2: Geometry + Volume (XGBoost)", y_test, p_xgb_test))
    except Exception as e:
        print(f"XGBoost evaluation skipped: {e}")

    # Results Table
    res_df = pd.DataFrame(results)
    print("\n--- OUT-OF-SAMPLE TEST PERFORMANCE ---")
    print(res_df.to_string(index=False))

    geo_auc = res_df.loc[res_df["model"].str.startswith("1."), "test_roc_auc"].values[0]
    vol_auc = res_df.loc[res_df["model"].str.startswith("2."), "test_roc_auc"].values[0]
    geo_brier = res_df.loc[res_df["model"].str.startswith("1."), "test_brier"].values[0]
    vol_brier = res_df.loc[res_df["model"].str.startswith("2."), "test_brier"].values[0]

    delta_auc = vol_auc - geo_auc
    delta_brier = vol_brier - geo_brier

    print("\n--- HYPOTHESIS TEST VERDICT ---")
    print(f"Delta ROC-AUC (Stage V1 vs Stage A): {delta_auc:+.4f}")
    print(f"Delta Brier   (Stage V1 vs Stage A): {delta_brier:+.4f} (negative is better)")

    if delta_auc > 0.01:
        print("VERDICT: H1 ACCEPTED! Volume & Relative Volume provide material incremental predictive power.")
    elif delta_auc >= -0.005:
        print("VERDICT: INCONCLUSIVE / EQUIVALENT. Volume features neither materially add nor subtract edge.")
    else:
        print("VERDICT: H0 NOT REJECTED. Volume features added noise on this sample.")


if __name__ == "__main__":
    for h in [120, 300]:
        run_volume_experiment(h)
