"""Audit one local dataset for leakage before its score is believed.

This command trains throwaway models to attack a claim; it persists no artifact,
registers no model version, and creates no prediction, trade idea, paper fill, or
order. Like the rest of this workspace it only reads local PostgreSQL.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from ai_quant_lab_ml.contracts import ALGORITHM_CHOICES, DatasetRequest
from ai_quant_lab_ml.features import build_labeled_examples, feature_schema
from ai_quant_lab_ml.leakage import run_leakage_audit
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from train import (
    fraction,
    non_blank,
    non_negative_float,
    parse_timestamp,
    positive_float,
    positive_int,
    selected_hyperparameters,
    strict_unit_interval,
)


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]


def build_parser() -> argparse.ArgumentParser:
    """Mirror the training command's dataset options so an audit matches a run.

    The label definition has to be identical to the training run being audited —
    a different horizon or neutral band is a different experiment, and its verdict
    would say nothing about the model in question.
    """

    parser = argparse.ArgumentParser(
        description="Audit a local dataset for leakage using label-shuffle, feature-lag, and era-holdout checks.",
    )
    parser.add_argument("--instrument", required=True, type=non_blank, help="Registered NSE symbol, for example NIFTY50.")
    parser.add_argument("--timeframe", required=True, type=non_blank, help="Completed candle timeframe, for example 1d.")
    parser.add_argument("--from", dest="data_window_start", required=True, help="Inclusive data-window start (YYYY-MM-DD or ISO-8601).")
    parser.add_argument("--to", dest="data_window_end", required=True, help="Inclusive data-window end (YYYY-MM-DD or ISO-8601).")
    parser.add_argument("--data-cutoff-at", help="Stored-data revision cutoff (defaults to the current UTC time).")
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="logistic", help="Model family to audit (default: logistic).")
    parser.add_argument("--horizon-bars", type=positive_int, default=5, help="Later completed bars used for each label (default: 5).")
    parser.add_argument("--neutral-threshold-bps", type=non_negative_float, default=50.0, help="Inclusive forward-return neutral band in bps (default: 50).")
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2, help="Chronological holdout fraction (default: 0.2).")
    parser.add_argument("--random-state", type=int, default=42, help="Deterministic random state (default: 42).")
    parser.add_argument("--database-url", help="PostgreSQL URL; defaults to DATABASE_URL in the root .env/environment.")
    parser.add_argument(
        "--report",
        type=Path,
        help="Optional path to also write the JSON verdict to, for attaching to a review.",
    )
    # The same hyperparameter flags training accepts, so the audit can fit the
    # model it is actually judging rather than a differently-tuned one.
    parser.add_argument("--max-iter", type=positive_int, help="logistic: maximum solver iterations.")
    parser.add_argument("--n-estimators", type=positive_int, help="xgboost/lightgbm: boosting rounds.")
    parser.add_argument("--learning-rate", type=positive_float, help="xgboost/lightgbm: shrinkage per round.")
    parser.add_argument("--max-depth", type=positive_int, help="xgboost/lightgbm: maximum tree depth.")
    parser.add_argument("--subsample", type=fraction, help="xgboost/lightgbm: row sampling fraction per round.")
    parser.add_argument("--colsample-bytree", type=fraction, help="xgboost/lightgbm: feature sampling fraction per tree.")
    parser.add_argument("--reg-lambda", type=non_negative_float, help="xgboost/lightgbm: L2 leaf-weight penalty.")
    parser.add_argument("--min-child-weight", type=non_negative_float, help="xgboost: minimum child hessian weight.")
    parser.add_argument("--num-leaves", type=positive_int, help="lightgbm: maximum leaves per tree.")
    parser.add_argument("--min-child-samples", type=positive_int, help="lightgbm: minimum observations per leaf.")
    return parser


def json_output(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, default=str))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
    except ImportError as error:
        parser.error("python-dotenv is required to run a leakage audit. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")

    request = DatasetRequest(
        instrument_symbol=args.instrument.upper(),
        timeframe=args.timeframe,
        data_window_start=parse_timestamp(args.data_window_start),
        data_window_end=parse_timestamp(args.data_window_end, end_of_day=True),
        data_cutoff_at=(parse_timestamp(args.data_cutoff_at) if args.data_cutoff_at else datetime.now(timezone.utc)),
        horizon_bars=args.horizon_bars,
        neutral_threshold_bps=args.neutral_threshold_bps,
    )
    if request.data_window_end <= request.data_window_start:
        parser.error("--to must be after --from.")
    if request.data_window_end > request.data_cutoff_at:
        parser.error("--to must not be later than --data-cutoff-at.")
    hyperparameters = selected_hyperparameters(args, parser)

    try:
        import psycopg
    except ImportError as error:
        parser.error("psycopg is required to run a leakage audit. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        records = repository.load_candle_evidence(request)
        examples = build_labeled_examples(records, request)
        print(f"Auditing {len(examples)} labeled rows from {len(records)} candles.", file=sys.stderr)
        audit = run_leakage_audit(
            examples,
            algorithm=args.algorithm,
            horizon_bars=request.horizon_bars,
            schema=feature_schema(),
            hyperparameters=hyperparameters,
            random_state=args.random_state,
            validation_fraction=args.validation_fraction,
        )

    # The dataset identity travels with the verdict, so a stored report can never
    # be mistaken for one belonging to a different experiment.
    report = {
        "level": "info",
        "message": "Leakage audit complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "dataWindowStart": request.data_window_start.isoformat(),
            "dataWindowEnd": request.data_window_end.isoformat(),
            "dataCutoffAt": request.data_cutoff_at.isoformat(),
            "horizonBars": request.horizon_bars,
            "neutralThresholdBps": request.neutral_threshold_bps,
            "labeledRows": len(examples),
        },
        "hyperparameters": hyperparameters,
        "audit": audit,
        "modelVersionCreated": False,
        "predictionCreated": False,
        "paperTradeCreated": False,
        "realOrderPlaced": False,
    }
    if args.report is not None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2, sort_keys=True, default=str), encoding="utf-8")

    json_output(report)
    # A verdict needing investigation exits non-zero, so a shell or CI step cannot
    # silently treat it as a pass.
    return 0 if audit["verdict"] == "PASS" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "Leakage audit interrupted before completion."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001 - CLI boundary emits a compact local diagnostic.
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
