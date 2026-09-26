"""One-off exploratory experiment: is there any learnable signal in momentum-scalp's own setup
features that nine hand-crafted filters missed? See
docs/2026-09-18-scalp1m-setup-classifier-experiment-v1.md for the pre-registration -- feature set,
label, split and decision rule are fixed there before this was run.

Not part of the production training pipeline (train.py). Reads research_scalp.proposals /
terminal_settlements directly; writes nothing back.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import accuracy_score, f1_score
import lightgbm as lgb

ROOT_DIRECTORY = Path(__file__).resolve().parents[2]


def load_database_url() -> str:
    from dotenv import load_dotenv

    load_dotenv(ROOT_DIRECTORY / ".env")
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        sys.exit("DATABASE_URL is required (define it in .env or the environment).")
    return database_url


QUERY = """
SELECT
  p.id, p.decision_at, p.direction, p.strategy_research_version, i.symbol AS instrument,
  p.raw_context, ts.outcome, ts.r_multiple
FROM research_scalp.proposals p
JOIN research_scalp.terminal_settlements ts
  ON ts.subject_type = 'NATIVE_PROPOSAL' AND ts.subject_id = p.id
JOIN instruments i ON i.id = p.instrument_id
WHERE p.setup_type = 'MOMENTUM_CONTINUATION'
ORDER BY p.decision_at ASC;
"""


def indicator_value(indicators: list[dict], code: str, period: int | None = None) -> float | None:
    for indicator in indicators:
        if indicator.get("code") != code:
            continue
        if period is not None and indicator.get("parameters", {}).get("period") != period:
            continue
        value = indicator.get("values", {}).get("value")
        if isinstance(value, (int, float)):
            return float(value)
    return None


def indicator_type(indicators: list[dict], code: str) -> str | None:
    for indicator in indicators:
        if indicator.get("code") == code:
            return indicator.get("values", {}).get("type")
    return None


def flatten_row(row: pd.Series) -> dict:
    ctx = row["raw_context"]
    indicators = ctx.get("indicators", [])
    patterns = ctx.get("patterns", [])
    regime = ctx.get("regime") or {}
    direction = row["direction"]

    ema_fast = indicator_value(indicators, "EMA", 3)
    ema_slow = indicator_value(indicators, "EMA", 8)
    ema_9 = indicator_value(indicators, "EMA", 9)
    ema_20 = indicator_value(indicators, "EMA", 20)
    rsi = indicator_value(indicators, "RSI")
    atr = indicator_value(indicators, "ATR")
    vwap = indicator_value(indicators, "VWAP")
    bollinger = next((i for i in indicators if i.get("code") == "BOLLINGER_BANDS"), None)
    bb = (bollinger or {}).get("values", {})
    supertrend = next((i for i in indicators if i.get("code") == "SUPERTREND"), None)
    st_values = (supertrend or {}).get("values", {})

    close = ctx.get("sourceCandle", {}).get("close") if isinstance(ctx.get("sourceCandle"), dict) else None

    ema_spread_atr = None
    vwap_displacement_atr = None
    if ema_fast is not None and ema_slow is not None and atr and atr > 0:
        ema_spread_atr = abs(ema_fast - ema_slow) / atr
    if close is not None and vwap is not None and atr and atr > 0:
        signed = (close - vwap) if direction == "LONG" else (vwap - close)
        vwap_displacement_atr = signed / atr

    bb_position = None
    if bb.get("upper") is not None and bb.get("lower") is not None and close is not None:
        span = bb["upper"] - bb["lower"]
        if span > 0:
            bb_position = (close - bb["lower"]) / span

    aligned = 0
    contradicting = 0
    neutral = 0
    for pattern in patterns:
        pattern_direction = pattern.get("direction")
        if pattern_direction == "NEUTRAL":
            neutral += 1
        elif (pattern_direction == "BULLISH" and direction == "LONG") or (
            pattern_direction == "BEARISH" and direction == "SHORT"
        ):
            aligned += 1
        else:
            contradicting += 1

    decision_at = row["decision_at"]
    ist_minute_of_day = None
    if decision_at is not None:
        ist = decision_at.tz_convert("Asia/Kolkata")
        ist_minute_of_day = ist.hour * 60 + ist.minute

    return {
        "ema_fast": ema_fast,
        "ema_slow": ema_slow,
        "ema_9": ema_9,
        "ema_20": ema_20,
        "rsi": rsi,
        "atr": atr,
        "ema_spread_atr": ema_spread_atr,
        "vwap_displacement_atr": vwap_displacement_atr,
        "bb_position": bb_position,
        "bb_width_atr": (bb["upper"] - bb["lower"]) / atr if bb.get("upper") is not None and atr else None,
        "supertrend_direction": st_values.get("direction"),
        "bos_type": indicator_type(indicators, "BOS"),
        "choch_type": indicator_type(indicators, "CHOCH"),
        "has_fvg": any(i.get("code") == "FVG" for i in indicators),
        "has_liquidity_sweep": any(i.get("code") == "LIQUIDITY_SWEEP" for i in indicators),
        "has_order_block": any(i.get("code") == "ORDER_BLOCK" for i in indicators),
        "has_equilibrium_zone": any(i.get("code") == "EQUILIBRIUM_ZONE" for i in indicators),
        "patterns_aligned": aligned,
        "patterns_contradicting": contradicting,
        "patterns_neutral": neutral,
        "regime": regime.get("regime"),
        "regime_value_ratio": regime.get("valueRatio"),
        "direction": direction,
        "instrument": row["instrument"],
        "strategy_research_version": row["strategy_research_version"],
        "ist_minute_of_day": ist_minute_of_day,
        "day_of_week": decision_at.tz_convert("Asia/Kolkata").dayofweek if decision_at is not None else None,
    }


CATEGORICAL_COLUMNS = [
    "supertrend_direction", "bos_type", "choch_type", "regime", "direction", "instrument",
    "strategy_research_version",
]


def expanding_walk_forward_folds(n_rows: int, n_folds: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    fold_size = n_rows // (n_folds + 1)
    folds = []
    for fold_index in range(1, n_folds + 1):
        train_end = fold_size * fold_index
        test_end = min(fold_size * (fold_index + 1), n_rows)
        folds.append((np.arange(0, train_end), np.arange(train_end, test_end)))
    return folds


def main() -> None:
    database_url = load_database_url()
    with psycopg.connect(database_url, autocommit=True) as connection:
        frame = pd.read_sql(QUERY, connection)

    print(f"Loaded {len(frame)} settled MOMENTUM_CONTINUATION proposals "
          f"({frame['decision_at'].min()} to {frame['decision_at'].max()}).")

    flattened = pd.DataFrame([flatten_row(row) for _, row in frame.iterrows()])
    flattened["r_multiple"] = frame["r_multiple"].astype(float)
    flattened["outcome"] = frame["outcome"]
    flattened["win"] = (flattened["r_multiple"] > 0).astype(int)

    print("\nOutcome distribution:")
    print(flattened["outcome"].value_counts())
    print(f"Win rate (r_multiple > 0): {flattened['win'].mean():.4f}")

    feature_frame = flattened.drop(columns=["r_multiple", "outcome", "win"]).copy()
    for column in CATEGORICAL_COLUMNS:
        feature_frame[column] = feature_frame[column].astype("category")
    numeric_columns = [c for c in feature_frame.columns if c not in CATEGORICAL_COLUMNS]
    feature_frame[numeric_columns] = feature_frame[numeric_columns].astype(float)

    label = flattened["win"].to_numpy()
    r_multiple = flattened["r_multiple"].to_numpy()

    folds = expanding_walk_forward_folds(len(feature_frame), n_folds=5)

    print(f"\n{'fold':<6}{'train_n':<10}{'test_n':<10}"
          f"{'trivial_acc':<13}{'logreg_acc':<12}{'lgbm_acc':<11}"
          f"{'trivial_f1':<12}{'logreg_f1':<11}{'lgbm_f1':<10}"
          f"{'uncond_R':<10}{'lgbm_topR':<10}")

    logreg_numeric = numeric_columns  # logistic regression needs numeric-only, imputed
    for fold_number, (train_index, test_index) in enumerate(folds, start=1):
        train_label, test_label = label[train_index], label[test_index]
        train_r, test_r = r_multiple[train_index], r_multiple[test_index]

        trivial_prediction = np.full_like(test_label, int(round(train_label.mean())))
        trivial_accuracy = accuracy_score(test_label, trivial_prediction)
        trivial_f1 = f1_score(test_label, trivial_prediction, average="macro", zero_division=0)

        # Logistic regression: numeric features only, median-imputed, standardized.
        train_numeric = feature_frame.iloc[train_index][logreg_numeric].copy()
        test_numeric = feature_frame.iloc[test_index][logreg_numeric].copy()
        medians = train_numeric.median()
        train_numeric = train_numeric.fillna(medians)
        test_numeric = test_numeric.fillna(medians)
        scaler = StandardScaler().fit(train_numeric)
        logreg = LogisticRegression(max_iter=1000).fit(scaler.transform(train_numeric), train_label)
        logreg_prediction = logreg.predict(scaler.transform(test_numeric))
        logreg_accuracy = accuracy_score(test_label, logreg_prediction)
        logreg_f1 = f1_score(test_label, logreg_prediction, average="macro", zero_division=0)

        # LightGBM: full feature set, native categorical support.
        train_features = feature_frame.iloc[train_index]
        test_features = feature_frame.iloc[test_index]
        booster = lgb.LGBMClassifier(
            n_estimators=200, max_depth=3, num_leaves=7, min_child_samples=30,
            learning_rate=0.05, verbosity=-1,
        )
        booster.fit(train_features, train_label, categorical_feature=CATEGORICAL_COLUMNS)
        lgbm_prediction = booster.predict(test_features)
        lgbm_probability = booster.predict_proba(test_features)[:, 1]
        lgbm_accuracy = accuracy_score(test_label, lgbm_prediction)
        lgbm_f1 = f1_score(test_label, lgbm_prediction, average="macro", zero_division=0)

        unconditional_mean_r = test_r.mean()
        above_median_confidence = lgbm_probability >= np.median(lgbm_probability)
        top_half_mean_r = test_r[above_median_confidence].mean() if above_median_confidence.any() else float("nan")

        print(f"{fold_number:<6}{len(train_index):<10}{len(test_index):<10}"
              f"{trivial_accuracy:<13.4f}{logreg_accuracy:<12.4f}{lgbm_accuracy:<11.4f}"
              f"{trivial_f1:<12.4f}{logreg_f1:<11.4f}{lgbm_f1:<10.4f}"
              f"{unconditional_mean_r:<10.4f}{top_half_mean_r:<10.4f}")

    print("\nFeature importance from the final fold's LightGBM model (gain):")
    importance = pd.Series(booster.feature_importances_, index=feature_frame.columns)
    print(importance.sort_values(ascending=False).head(15).to_string())


if __name__ == "__main__":
    main()
