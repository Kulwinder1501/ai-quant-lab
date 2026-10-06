"""Rank every model in the local registry by how surprising its score really is.

Running N independent experiments against the same market and then only
looking at the best one is exactly the setup deflated-Sharpe /
probability-of-backtest-overfitting analysis exists to correct for (Bailey &
Lopez de Prado). This command reads the registry's own
``model_versions.validation_metrics`` and performs the classification-metric
equivalent: for every distinct model_key (one independent idea, taken at its
best recorded score), it asks how surprising that macro-F1 still looks once
"we tried this many things against this data" is priced in.

Read-only: this command never writes a model version, prediction, or paper
trade, and never places an order.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Mapping

from ai_quant_lab_ml.overfitting import TrialEvidence, rank_trials_by_overfitting_risk


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]

_REGISTRY_SQL = """
    SELECT model_key, algorithm, validation_metrics
    FROM model_versions
    ORDER BY model_key, trained_at ASC
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Rank the local model registry by overfitting risk, adjusted for how many "
            "independent ideas were tried against the same data."
        ),
    )
    parser.add_argument("--database-url", help="PostgreSQL URL; defaults to DATABASE_URL in the root .env/environment.")
    parser.add_argument(
        "--simulation-trials",
        type=int,
        default=2000,
        help="Null-distribution draws per model, for the single-trial p-value (default: 2000).",
    )
    parser.add_argument("--random-state", type=int, default=42, help="Deterministic simulation seed (default: 42).")
    parser.add_argument(
        "--top", type=int, default=15, help="How many least-likely-to-be-chance models to print in full (default: 15).",
    )
    return parser


def _extract_trial(model_key: str, algorithm: str, validation_metrics: Mapping[str, Any]) -> TrialEvidence | None:
    """Return this row's evidence, or ``None`` if it predates the metrics this check needs."""

    metrics = validation_metrics.get("validationMetrics")
    if not isinstance(metrics, Mapping):
        return None
    macro_f1 = metrics.get("macroF1")
    sample_count = metrics.get("sampleCount")
    class_counts = metrics.get("classCounts")
    if (
        isinstance(macro_f1, bool)
        or not isinstance(macro_f1, (int, float))
        or isinstance(sample_count, bool)
        or not isinstance(sample_count, int)
        or sample_count <= 0
        or not isinstance(class_counts, Mapping)
        or not class_counts
    ):
        return None
    return TrialEvidence(
        model_key=model_key,
        algorithm=algorithm,
        macro_f1=float(macro_f1),
        sample_count=int(sample_count),
        class_counts={str(label): int(count) for label, count in class_counts.items()},
    )


def best_trial_per_model_key(rows: list[Mapping[str, Any]]) -> tuple[list[TrialEvidence], int]:
    """Collapse every retrain of the same idea to its single best recorded score.

    A model_key can be retrained many times (refits, walk-forward reruns); each
    of those shares one promotion lineage and is not a separate independent
    idea in the overfitting-correction sense, so only the best score per key
    counts toward the trial count. Returns the collapsed trials plus how many
    rows had no usable macro-F1/class-count evidence (an older schema, or a
    row still missing its validation metrics).
    """

    best_by_model_key: dict[str, TrialEvidence] = {}
    unusable_rows = 0
    for row in rows:
        trial = _extract_trial(row["model_key"], row["algorithm"], row["validation_metrics"] or {})
        if trial is None:
            unusable_rows += 1
            continue
        current_best = best_by_model_key.get(trial.model_key)
        if current_best is None or trial.macro_f1 > current_best.macro_f1:
            best_by_model_key[trial.model_key] = trial
    return list(best_by_model_key.values()), unusable_rows


def json_output(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, default=str))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
    except ImportError as error:
        parser.error("python-dotenv is required. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")

    try:
        import psycopg
        from psycopg.rows import dict_row
    except ImportError as error:
        parser.error("psycopg is required. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only

    with psycopg.connect(database_url, autocommit=True) as connection:
        with connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(_REGISTRY_SQL)
            rows = cursor.fetchall()

    trials, unusable_rows = best_trial_per_model_key(rows)
    ranked = rank_trials_by_overfitting_risk(
        trials, simulation_trials=args.simulation_trials, random_state=args.random_state,
    )
    notable = [verdict for verdict in ranked if verdict.adjusted_p_value < 0.05]

    report = {
        "level": "info",
        "message": "Registry overfitting check complete",
        "totalModelVersionRows": len(rows),
        "rowsSkippedForMissingMetrics": unusable_rows,
        "independentTrials": len(trials),
        "notableAfterCorrection": len(notable),
        "leastLikelyToBeChance": [
            {
                "modelKey": verdict.model_key,
                "algorithm": verdict.algorithm,
                "macroF1": verdict.macro_f1,
                "sampleCount": verdict.sample_count,
                "classCounts": dict(verdict.class_counts),
                "singleTrialPValue": verdict.single_trial_p_value,
                "adjustedPValue": verdict.adjusted_p_value,
            }
            for verdict in ranked[: args.top]
        ],
        "modelVersionCreated": False,
        "predictionCreated": False,
        "paperTradeCreated": False,
        "realOrderPlaced": False,
    }
    json_output(report)
    # A registry with nothing that survives the correction is itself a finding,
    # not a script failure, so this always exits 0; the JSON carries the verdict.
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "Overfitting check interrupted before completion."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001 - CLI boundary intentionally turns failures into a compact local log.
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
