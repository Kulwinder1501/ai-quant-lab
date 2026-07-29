"""Create one explainable local research prediction from a promoted model.

This command has no strategy, paper-trading, broker, or order-routing imports.
It reads one completed candle as of a selected cutoff, persists an auditable
model_predictions row, and prints a compact local JSON result.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from ai_quant_lab_ml.artifacts import load_model_artifact
from ai_quant_lab_ml.contracts import InferenceRequest, PersistedModelVersion, schema_version_for
from ai_quant_lab_ml.features import VOLUME_MEDIAN_WINDOW, build_feature_vector, trailing_feature_context
from ai_quant_lab_ml.inference import (
    InferenceError,
    ProductionInferenceContract,
    build_prediction_explanation,
    explain_prediction,
    validate_production_artifact,
)
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from ai_quant_lab_ml.reference_data import ReferenceDataError, nearest_reference_label_agreement


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]


def parse_as_of(value: str) -> datetime:
    """Parse a UTC as-of boundary; a bare date means the final microsecond of that day."""

    normalized = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        normalized = f"{normalized}T23:59:59.999999+00:00"
    elif normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD or an ISO-8601 timestamp.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def non_blank(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise argparse.ArgumentTypeError("must not be blank")
    return normalized


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def require_prediction_after_training_boundary(
    source_close_time: datetime,
    contract: ProductionInferenceContract,
) -> None:
    """Refuse historic scoring before all information used to train was available."""

    if (
        not isinstance(source_close_time, datetime)
        or source_close_time.tzinfo is None
        or source_close_time.utcoffset() is None
    ):
        raise InferenceError("The selected source candle close time must include a timezone.")
    source_close_utc = source_close_time.astimezone(timezone.utc)
    if source_close_utc <= contract.deployment_not_before:
        raise InferenceError(
            "The selected source candle is at or before this model's training-information boundary "
            "(final training label availability or data cutoff). Refusing an in-sample or look-ahead historical prediction."
        )


def require_prediction_after_production_promotion(
    source_close_time: datetime,
    model_version: PersistedModelVersion,
) -> None:
    """Refuse a historical prediction before the selected model was promoted."""

    if (
        not isinstance(source_close_time, datetime)
        or source_close_time.tzinfo is None
        or source_close_time.utcoffset() is None
    ):
        raise InferenceError("The selected source candle close time must include a timezone.")
    if model_version.stage != "PRODUCTION":
        raise InferenceError("Only a PRODUCTION model may create a prediction.")
    promoted_at = model_version.promoted_at
    if promoted_at is None:
        raise InferenceError(
            "The PRODUCTION model has no persisted promotion timestamp. Refusing to backdate an inference prediction."
        )
    if promoted_at.tzinfo is None or promoted_at.utcoffset() is None:
        raise InferenceError("The PRODUCTION model promotion timestamp must include a timezone.")
    if source_close_time.astimezone(timezone.utc) <= promoted_at.astimezone(timezone.utc):
        raise InferenceError(
            "The selected source candle is at or before this model's production promotion time. "
            "Refusing to backdate an inference prediction."
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Score the latest cutoff-bounded completed candle with one promoted local research model.",
    )
    parser.add_argument("--instrument", required=True, type=non_blank, help="Registered NSE symbol, for example NIFTY50.")
    parser.add_argument("--timeframe", required=True, type=non_blank, help="Completed candle timeframe, for example 1d.")
    parser.add_argument("--model-key", required=True, type=non_blank, help="Exact model family key whose PRODUCTION version may be used.")
    parser.add_argument(
        "--as-of",
        "--data-cutoff-at",
        dest="data_cutoff_at",
        help="Evidence cutoff (YYYY-MM-DD or ISO-8601); defaults to current UTC time.",
    )
    parser.add_argument("--database-url", help="PostgreSQL URL; defaults to DATABASE_URL in the root .env/environment.")
    parser.add_argument("--maximum-features", type=positive_int, default=12, help="Top absolute feature contributions to retain (default: 12).")
    parser.add_argument("--similar-neighbors", type=positive_int, default=20, help="Training-only reference neighbors used for historical label agreement (default: 20).")
    return parser


def json_output(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, default=str))


def _load_runtime_dependencies(parser: argparse.ArgumentParser) -> Any:
    try:
        from dotenv import load_dotenv
    except ImportError as error:
        parser.error("python-dotenv is required to run ML inference. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only
    load_dotenv(ROOT_DIRECTORY / ".env")
    try:
        import psycopg
    except ImportError as error:
        parser.error("psycopg is required to run ML inference. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only
    return psycopg


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    psycopg = _load_runtime_dependencies(parser)

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")
    symbol = args.instrument.upper()
    as_of = parse_as_of(args.data_cutoff_at) if args.data_cutoff_at else datetime.now(timezone.utc)

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        production_model = repository.get_production_model(args.model_key)
        if production_model is None:
            raise InferenceError(f'No PRODUCTION model exists for model key "{args.model_key}".')
        if not production_model.artifact_checksum:
            raise InferenceError("The PRODUCTION model has no persisted artifact checksum.")
        loaded_artifact = load_model_artifact(
            production_model.artifact_uri,
            expected_checksum=production_model.artifact_checksum,
        )
        contract = validate_production_artifact(
            production_model,
            loaded_artifact.metadata,
            instrument_symbol=symbol,
            timeframe=args.timeframe,
        )
        inference_request = InferenceRequest(
            instrument_symbol=symbol,
            timeframe=args.timeframe,
            data_cutoff_at=as_of,
            indicator_algorithm_version=contract.indicator_algorithm_version,
            pattern_algorithm_version=contract.pattern_algorithm_version,
            price_action_algorithm_version=contract.price_action_algorithm_version,
        )
        evidence = repository.load_latest_completed_candle_evidence(inference_request)
        if evidence is None:
            json_output(
                {
                    "level": "info",
                    "message": "No completed candle is available at the selected as-of cutoff",
                    "modelKey": contract.model_key,
                    "instrument": symbol,
                    "timeframe": args.timeframe,
                    "asOf": as_of.isoformat(),
                    "predictionCreated": False,
                }
            )
            return 0
        require_prediction_after_training_boundary(evidence.close_time, contract)
        require_prediction_after_production_promotion(evidence.close_time, production_model)

        # The stationary schema needs the previous close and a rolling median
        # volume. Both come from the same as-of cutoff as the scored candle, so
        # inference sees exactly the trailing context training saw — anything less
        # would leave two features missing at prediction time only, and the
        # imputer would quietly paper over the skew with a training-fold median.
        trailing_series = repository.load_trailing_close_volume_series(
            inference_request,
            bars=VOLUME_MEDIAN_WINDOW,
        )
        prior_close, median_volume = trailing_feature_context(trailing_series)
        schema_version = schema_version_for(args.timeframe)
        feature_values = build_feature_vector(
            evidence,
            prior_close=prior_close,
            median_volume=median_volume,
            schema_version=schema_version,
            indicator_algorithm_version=contract.indicator_algorithm_version,
            pattern_algorithm_version=contract.pattern_algorithm_version,
            price_action_algorithm_version=contract.price_action_algorithm_version,
        )
        # The persisted algorithm chooses the explainer: linear terms for the
        # baseline, exact TreeSHAP contributions for a boosted forest.
        explained_prediction = explain_prediction(
            loaded_artifact.model,
            feature_values,
            algorithm=production_model.algorithm,
            schema=contract.feature_schema,
            maximum_features=args.maximum_features,
        )
        try:
            similar_setup = nearest_reference_label_agreement(
                pipeline=loaded_artifact.model,
                features=feature_values,
                predicted_label=explained_prediction.prediction,
                reference_metadata=contract.training_reference_data,
                k=args.similar_neighbors,
                expected_schema=contract.feature_schema,
            ).as_dict()
        except ReferenceDataError as error:
            raise InferenceError(f"Could not calculate training-only similar-setup label agreement: {error}") from error
        observed_prior_predictions = repository.historical_prediction_reliability(
            model_version_id=production_model.id,
            instrument_id=evidence.instrument_id,
            timeframe=evidence.timeframe,
            prediction=explained_prediction.prediction,
            reference_close_time=evidence.close_time,
            data_cutoff_at=as_of,
            horizon_bars=contract.horizon_bars,
            neutral_threshold_bps=contract.neutral_threshold_bps,
        )
        historical_reference = {
            "trainingOnlySimilarSetups": similar_setup,
            "earlierSameLabelPredictions": {
                "method": "EARLIER_SAME_LABEL_PREDICTION_OUTCOMES_V1",
                "evaluatedPredictions": observed_prior_predictions.evaluated_predictions,
                "correctPredictions": observed_prior_predictions.correct_predictions,
                "accuracy": observed_prior_predictions.accuracy,
            },
        }
        explanation = build_prediction_explanation(
            candle=evidence,
            contract=contract,
            explained_prediction=explained_prediction,
            artifact_checksum=loaded_artifact.checksum,
            evidence_cutoff_at=as_of,
            historical_reference=historical_reference,
        )
        persisted_prediction = repository.save_model_prediction(
            model_version_id=production_model.id,
            instrument_id=evidence.instrument_id,
            source_candle_id=evidence.candle_id,
            prediction=explained_prediction.prediction,
            confidence=explained_prediction.confidence,
            feature_contributions=explained_prediction.feature_contributions,
            explanation=explanation,
            evidence_cutoff_at=as_of,
        )

    json_output(
        {
            "level": "info",
            "message": "Explainable local model prediction persisted",
            "predictionId": persisted_prediction.id,
            "modelVersionId": persisted_prediction.model_version_id,
            "modelKey": contract.model_key,
            "algorithm": explained_prediction.algorithm,
            "contributionMethod": explained_prediction.contribution_method,
            "instrument": symbol,
            "timeframe": args.timeframe,
            "sourceCandleId": evidence.candle_id,
            "sourceCandleCloseTime": evidence.close_time.isoformat(),
            "asOf": as_of.isoformat(),
            "prediction": explained_prediction.prediction,
            "confidence": explained_prediction.confidence,
            "classProbabilities": dict(explained_prediction.class_probabilities),
            "topFeatureContributions": list(explained_prediction.feature_contributions),
            "similarSetupLabelAgreement": similar_setup,
            "predictionCreated": True,
            "tradeIdeaCreated": False,
            "paperTradeCreated": False,
            "realOrderPlaced": False,
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "ML inference interrupted before a prediction was persisted."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001 - CLI boundary emits a compact local diagnostic.
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
