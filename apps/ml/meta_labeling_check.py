"""Standalone meta-labeling check: can a secondary model filter the primary's calls.

Deliberately independent of the shared train_model/run_leakage_audit machinery
(which is built around a fixed 3-class target and isn't shaped for a binary
"was the primary correct" label). This script has its own connection, its own
chronological split, and its own sklearn fit/evaluate -- nothing here touches
the production training or promotion pipeline.

The primary is a promoted volatility-expansion model; ``auxiliary_model_predictions``
already stores its confidence and predicted class for every live call it has made
and settled. The meta-label is binary: did the realized outcome match the
prediction. The meta-features are only what was already known at the moment the
primary made its call (its own predicted class and confidence) -- nothing here
reads ``realized_label`` or ``settled_at`` as an input, only as the target.

Payoff metric, not just accuracy: among holdout rows the meta-model would have
let through (predicted P(correct) >= threshold), what is the actual hit rate,
and what fraction of calls survive the filter? That is the number that matters
for whether meta-labeling would improve on "trust every primary call."

Read-only: no model version, prediction, paper trade, or order is created.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Mapping

from train import non_blank, strict_unit_interval


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

_SETTLED_PREDICTIONS_SQL = """
    SELECT amp.prediction, amp.confidence, amp.realized_label, amp.created_at
    FROM auxiliary_model_predictions amp
    JOIN model_versions mv ON mv.id = amp.model_version_id
    WHERE mv.model_key = %s
      AND amp.settled_at IS NOT NULL
      AND amp.unsettleable_reason IS NULL
    ORDER BY amp.created_at ASC
"""

META_FEATURE_SCHEMA: tuple[str, ...] = (
    "meta.confidence",
    "meta.predicted_is_expansion",
    "meta.predicted_is_contraction",
)

DECISION_THRESHOLD = 0.5


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Standalone check: does a secondary model filtering a primary's own calls improve on trusting every call.",
    )
    parser.add_argument("--model-key", required=True, type=non_blank)
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--database-url")
    return parser


def json_output(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, default=str))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")

    import numpy as np
    import psycopg
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import roc_auc_score

    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.cursor() as cursor:
            cursor.execute(_SETTLED_PREDICTIONS_SQL, (args.model_key,))
            rows = cursor.fetchall()

    if len(rows) < 100:
        json_output({
            "level": "error",
            "message": f"Only {len(rows)} settled predictions for {args.model_key!r}; too few for a meaningful meta-labeling test.",
        })
        return 1

    features = np.array(
        [
            [
                float(confidence),
                1.0 if prediction == "EXPANSION" else 0.0,
                1.0 if prediction == "CONTRACTION" else 0.0,
            ]
            for prediction, confidence, _realized, _created in rows
        ],
        dtype=np.float64,
    )
    meta_labels = np.array(
        [1 if prediction == realized else 0 for prediction, _confidence, realized, _created in rows],
        dtype=np.int64,
    )
    predictions = [row[0] for row in rows]

    split_index = int(round(len(rows) * (1.0 - args.validation_fraction)))
    split_index = max(1, min(len(rows) - 1, split_index))

    train_features, holdout_features = features[:split_index], features[split_index:]
    train_labels, holdout_labels = meta_labels[:split_index], meta_labels[split_index:]
    holdout_predictions = predictions[split_index:]

    train_baseline_hit_rate = float(np.mean(train_labels))
    holdout_baseline_hit_rate = float(np.mean(holdout_labels))

    if len(set(train_labels.tolist())) < 2:
        json_output({
            "level": "error",
            "message": "The training split has only one meta-label class (all correct or all incorrect); cannot fit a classifier.",
        })
        return 1

    classifier = LogisticRegression(max_iter=1000, random_state=args.random_state)
    classifier.fit(train_features, train_labels)

    holdout_probabilities = classifier.predict_proba(holdout_features)[:, list(classifier.classes_).index(1)]
    passed_filter = holdout_probabilities >= DECISION_THRESHOLD
    filtered_hit_rate = float(np.mean(holdout_labels[passed_filter])) if passed_filter.any() else None
    coverage = float(np.mean(passed_filter))

    auc = None
    if len(set(holdout_labels.tolist())) == 2:
        auc = float(roc_auc_score(holdout_labels, holdout_probabilities))

    per_class_train_hit_rate = {
        label: float(np.mean(train_labels[[p == label for p in predictions[:split_index]]]))
        for label in ("EXPANSION", "CONTRACTION", "STABLE")
        if any(p == label for p in predictions[:split_index])
    }

    json_output({
        "level": "info",
        "message": "Standalone meta-labeling check complete",
        "modelKey": args.model_key,
        "totalSettledPredictions": len(rows),
        "trainingRows": int(split_index),
        "holdoutRows": len(rows) - split_index,
        "trainBaselineHitRate": train_baseline_hit_rate,
        "trainPerClassHitRate": per_class_train_hit_rate,
        "holdout": {
            "baselineHitRate": holdout_baseline_hit_rate,
            "metaFilteredHitRate": filtered_hit_rate,
            "coverage": coverage,
            "rowsPassingFilter": int(passed_filter.sum()),
            "aucRoc": auc,
            "decisionThreshold": DECISION_THRESHOLD,
        },
        "metaFeatureSchema": list(META_FEATURE_SCHEMA),
        "coefficients": dict(zip(META_FEATURE_SCHEMA, classifier.coef_[0].tolist())),
        "caveat": (
            f"Only {len(rows)} settled predictions total, {len(rows) - split_index} in the holdout. "
            "Treat this as a directional first look, not a validated result -- the sample is far "
            "below what the rest of this project's checks require before trusting a number."
        ),
        "modelVersionCreated": False,
        "predictionCreated": False,
        "paperTradeCreated": False,
        "realOrderPlaced": False,
    })
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "Interrupted before completion."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
