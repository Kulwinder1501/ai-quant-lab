"""Create explainable local research predictions from promoted or pool models.

This command has no strategy, paper-trading, broker, or order-routing imports.
It reads one completed candle as of a selected cutoff, persists an auditable
model_predictions row, and prints a compact local JSON result.

Two modes:

* Single model (default): score the PRODUCTION version of ``--model-key``,
  exactly as before.
* ``--competition-pool``: score every enrolled competition-pool member. Only
  the PRIMARY (the sole PRODUCTION version of its group) feeds downstream
  consumers; the others are shadow predictions that exist purely to build the
  live, settled track record the daily competition ranks on.
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
from ai_quant_lab_ml.contracts import InferenceRequest, PersistedModelVersion
from ai_quant_lab_ml.features import VOLUME_MEDIAN_WINDOW, build_feature_vector, trailing_feature_context
from ai_quant_lab_ml.inference import (
    InferenceError,
    ProductionInferenceContract,
    build_prediction_explanation,
    explain_prediction,
    validate_production_artifact,
)
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from ai_quant_lab_ml.contracts import (
    DIRECTIONAL_ALPHABET,
    DIRECTIONAL_LABEL_SCHEMES,
    LABEL_SCHEME_FIXED_HORIZON,
    LabelAlphabet,
)
from ai_quant_lab_ml.reference_data import ReferenceDataError, nearest_reference_label_agreement
from ai_quant_lab_ml.sequence_inference import (
    is_sequence_shadow_algorithm,
    score_sequence_prediction,
    validate_sequence_shadow_artifact,
)
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET


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


def require_prediction_after_pool_enrollment(
    source_close_time: datetime,
    enrolled_at: datetime,
) -> None:
    """Refuse a shadow prediction on a candle from before pool enrollment.

    The same no-backdating property PRODUCTION models get from ``promoted_at``:
    a challenger's live track record must start at its enrollment, or a model
    could be graded on candles it never actually faced in real time.
    """

    if (
        not isinstance(source_close_time, datetime)
        or source_close_time.tzinfo is None
        or source_close_time.utcoffset() is None
    ):
        raise InferenceError("The selected source candle close time must include a timezone.")
    if not isinstance(enrolled_at, datetime) or enrolled_at.tzinfo is None or enrolled_at.utcoffset() is None:
        raise InferenceError("The competition enrollment timestamp must include a timezone.")
    if source_close_time.astimezone(timezone.utc) <= enrolled_at.astimezone(timezone.utc):
        raise InferenceError(
            "The selected source candle is at or before this model's competition enrollment time. "
            "Refusing to backdate a shadow prediction."
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Score the latest cutoff-bounded completed candle with promoted or competition-pool models.",
    )
    parser.add_argument("--instrument", type=non_blank, help="Registered NSE symbol, for example NIFTY50. Required unless --competition-pool.")
    parser.add_argument("--timeframe", type=non_blank, help="Completed candle timeframe, for example 1d. Required unless --competition-pool.")
    parser.add_argument("--model-key", type=non_blank, help="Exact model family key. Required unless --competition-pool (there it filters one group).")
    parser.add_argument(
        "--competition-pool",
        action="store_true",
        help="Score every enrolled competition-pool member (shadow predictions for challengers).",
    )
    parser.add_argument(
        "--shadow-scheme",
        type=non_blank,
        help=(
            "Shadow-predict for every current candidate of a NON-directional label scheme, "
            "for example volatility-expansion-v1. These models are excluded from the "
            "directional competition pool by design, so without this they never write a "
            "prediction and can never build settled evidence."
        ),
    )
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


def score_model(
    repository: PostgresMlRepository,
    model_version: PersistedModelVersion,
    *,
    symbol: str | None,
    timeframe: str | None,
    as_of: datetime,
    maximum_features: int,
    similar_neighbors: int,
    enrolled_at: datetime | None = None,
) -> dict[str, Any]:
    """Score one model's latest cutoff-bounded candle and persist the prediction.

    ``symbol``/``timeframe`` default to the instrument and timeframe recorded in
    the artifact's own dataset block, so pool mode cannot score a model against
    a market it was never trained on.
    """

    if not model_version.artifact_checksum:
        raise InferenceError("The selected model has no persisted artifact checksum.")
    loaded_artifact = load_model_artifact(
        model_version.artifact_uri,
        expected_checksum=model_version.artifact_checksum,
    )

    dataset = loaded_artifact.metadata.get("dataset")
    if symbol is None or timeframe is None:
        if not isinstance(dataset, Mapping):
            raise InferenceError(
                "The artifact has no dataset block, so its instrument and timeframe cannot be inferred. "
                "Pass --instrument and --timeframe explicitly."
            )
        symbol = symbol or str(dataset.get("instrument") or "").strip()
        timeframe = timeframe or str(dataset.get("timeframe") or "").strip()
        if not symbol or not timeframe:
            raise InferenceError("The artifact's dataset block is missing its instrument or timeframe.")
    symbol = symbol.upper()

    # The label scheme is read from the artifact rather than a CLI flag, so a
    # served model can never be scored or persisted under the wrong target.
    # An artifact written before schemes existed was necessarily directional.
    artifact_protocol = loaded_artifact.metadata.get("validationProtocol")
    label_scheme = (
        artifact_protocol.get("labelScheme", LABEL_SCHEME_FIXED_HORIZON)
        if isinstance(artifact_protocol, Mapping)
        else LABEL_SCHEME_FIXED_HORIZON
    )
    is_directional = label_scheme in DIRECTIONAL_LABEL_SCHEMES
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET if is_directional else VOLATILITY_ALPHABET
    sequence_model = is_sequence_shadow_algorithm(model_version.algorithm)
    if sequence_model:
        contract = validate_sequence_shadow_artifact(
            model_version,
            loaded_artifact.metadata,
            instrument_symbol=symbol,
            timeframe=timeframe,
            alphabet=alphabet,
            allow_candidate_pool_member=enrolled_at is not None,
        )
    else:
        contract = validate_production_artifact(
            model_version,
            loaded_artifact.metadata,
            instrument_symbol=symbol,
            timeframe=timeframe,
            alphabet=alphabet,
            # An enrolled pool CANDIDATE shadow-predicts for the daily competition;
            # its no-backdating guard below uses enrolled_at instead of promoted_at.
            allow_candidate_pool_member=enrolled_at is not None,
        )

    if sequence_model:
        evidence, explained_prediction = score_sequence_prediction(
            repository,
            model_version,
            loaded_artifact,
            contract,
            as_of=as_of,
            alphabet=alphabet,
        )
        require_prediction_after_training_boundary(evidence.close_time, contract)
        if model_version.stage == "PRODUCTION":
            require_prediction_after_production_promotion(evidence.close_time, model_version)
        elif enrolled_at is not None and model_version.stage == "CANDIDATE":
            require_prediction_after_pool_enrollment(evidence.close_time, enrolled_at)
        else:
            raise InferenceError(
                "Only a PRODUCTION model or an enrolled competition-pool CANDIDATE may create a prediction."
            )
        similar_setup = {
            "method": "NOT_APPLICABLE_FOR_SEQUENCE_MODEL",
            "algorithm": model_version.algorithm,
            "neighborCount": 0,
            "labelAgreement": None,
        }
        earlier_same_label = {
            "method": "NOT_APPLICABLE_FOR_NON_DIRECTIONAL_TARGET",
            "labelScheme": label_scheme,
        }
        historical_reference = {
            "trainingOnlySimilarSetups": similar_setup,
            "earlierSameLabelPredictions": earlier_same_label,
        }
    else:
        inference_request = InferenceRequest(
            instrument_symbol=symbol,
            timeframe=timeframe,
            data_cutoff_at=as_of,
            indicator_algorithm_version=contract.indicator_algorithm_version,
            pattern_algorithm_version=contract.pattern_algorithm_version,
            price_action_algorithm_version=contract.price_action_algorithm_version,
        )
        evidence = repository.load_latest_completed_candle_evidence(inference_request)
        if evidence is None:
            return {
                "level": "info",
                "message": "No completed candle is available at the selected as-of cutoff",
                "modelKey": contract.model_key,
                "modelVersionId": model_version.id,
                "instrument": symbol,
                "timeframe": timeframe,
                "asOf": as_of.isoformat(),
                "predictionCreated": False,
            }
        require_prediction_after_training_boundary(evidence.close_time, contract)
        # A PRODUCTION model keeps its promotion guard. A pool CANDIDATE is guarded
        # by its enrollment instead: same no-backdating property, different clock.
        if model_version.stage == "PRODUCTION":
            require_prediction_after_production_promotion(evidence.close_time, model_version)
        elif enrolled_at is not None and model_version.stage == "CANDIDATE":
            require_prediction_after_pool_enrollment(evidence.close_time, enrolled_at)
        else:
            raise InferenceError(
                "Only a PRODUCTION model or an enrolled competition-pool CANDIDATE may create a prediction."
            )

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
        # The artifact's own recorded schema version, never the timeframe's current
        # default: after the v6 bump both v5 and v6 swing artifacts are live at the
        # same time, and each must be scored against the columns it trained on.
        feature_values = build_feature_vector(
            evidence,
            prior_close=prior_close,
            median_volume=median_volume,
            schema_version=contract.schema_version,
            indicator_algorithm_version=contract.indicator_algorithm_version,
            pattern_algorithm_version=contract.pattern_algorithm_version,
            price_action_algorithm_version=contract.price_action_algorithm_version,
        )
        # The persisted algorithm chooses the explainer: linear terms for the
        # baseline, exact TreeSHAP contributions for a boosted forest.
        explained_prediction = explain_prediction(
            loaded_artifact.model,
            feature_values,
            algorithm=model_version.algorithm,
            schema=contract.feature_schema,
            maximum_features=maximum_features,
            alphabet=alphabet,
        )
        try:
            similar_setup = nearest_reference_label_agreement(
                pipeline=loaded_artifact.model,
                features=feature_values,
                predicted_label=explained_prediction.prediction,
                reference_metadata=contract.training_reference_data,
                k=similar_neighbors,
                expected_schema=contract.feature_schema,
                alphabet=alphabet,
            ).as_dict()
        except ReferenceDataError as error:
            raise InferenceError(f"Could not calculate training-only similar-setup label agreement: {error}") from error
        # This reliability measure asks whether earlier same-label calls came true
        # by comparing a forward close against the directional neutral band. That
        # question only exists for a directional target, so for any other scheme it
        # is reported as not applicable instead of being computed misleadingly.
        if is_directional:
            observed_prior_predictions = repository.historical_prediction_reliability(
                model_version_id=model_version.id,
                instrument_id=evidence.instrument_id,
                timeframe=evidence.timeframe,
                prediction=explained_prediction.prediction,
                reference_close_time=evidence.close_time,
                data_cutoff_at=as_of,
                horizon_bars=contract.horizon_bars,
                neutral_threshold_bps=contract.neutral_threshold_bps,
            )
            earlier_same_label = {
                "method": "EARLIER_SAME_LABEL_PREDICTION_OUTCOMES_V1",
                "evaluatedPredictions": observed_prior_predictions.evaluated_predictions,
                "correctPredictions": observed_prior_predictions.correct_predictions,
                "accuracy": observed_prior_predictions.accuracy,
            }
        else:
            earlier_same_label = {
                "method": "NOT_APPLICABLE_FOR_NON_DIRECTIONAL_TARGET",
                "labelScheme": label_scheme,
            }
        historical_reference = {
            "trainingOnlySimilarSetups": similar_setup,
            "earlierSameLabelPredictions": earlier_same_label,
        }
    explanation = build_prediction_explanation(
        candle=evidence,
        contract=contract,
        explained_prediction=explained_prediction,
        artifact_checksum=loaded_artifact.checksum,
        evidence_cutoff_at=as_of,
        historical_reference=historical_reference,
    )
    # model_predictions is read as a trade direction by the strategy engine, the
    # autonomous agent, the market scanner, and the predictions dashboard. A
    # non-directional label must therefore go to its own table, never there.
    if is_directional:
        persisted = repository.save_model_prediction(
            model_version_id=model_version.id,
            instrument_id=evidence.instrument_id,
            source_candle_id=evidence.candle_id,
            prediction=explained_prediction.prediction,
            confidence=explained_prediction.confidence,
            feature_contributions=explained_prediction.feature_contributions,
            explanation=explanation,
            evidence_cutoff_at=as_of,
        )
        prediction_id = persisted.id
        prediction_model_version_id = persisted.model_version_id
    else:
        auxiliary = repository.save_auxiliary_prediction(
            model_version_id=model_version.id,
            instrument_id=evidence.instrument_id,
            source_candle_id=evidence.candle_id,
            label_scheme=label_scheme,
            prediction=explained_prediction.prediction,
            confidence=explained_prediction.confidence,
            feature_contributions=explained_prediction.feature_contributions,
            explanation=explanation,
            evidence_cutoff_at=as_of,
            alphabet=alphabet,
        )
        prediction_id = auxiliary["id"]
        prediction_model_version_id = auxiliary["modelVersionId"]

    return {
        "level": "info",
        "message": "Explainable local model prediction persisted",
        "predictionId": prediction_id,
        "modelVersionId": prediction_model_version_id,
        "labelScheme": label_scheme,
        "modelKey": contract.model_key,
        "modelStage": model_version.stage,
        "algorithm": explained_prediction.algorithm,
        "contributionMethod": explained_prediction.contribution_method,
        "instrument": symbol,
        "timeframe": timeframe,
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


def _pooled_roster(model_version: PersistedModelVersion) -> list[str]:
    """The pooled-training roster train.py records, or [] for a single-instrument model."""

    protocol = model_version.validation_metrics.get("validationProtocol")
    if not isinstance(protocol, Mapping):
        return []
    pooled = protocol.get("pooledInstruments")
    if not isinstance(pooled, (list, tuple)):
        return []
    return [str(symbol).strip().upper() for symbol in pooled if str(symbol).strip()]


def run_shadow_pool(repository: PostgresMlRepository, args: argparse.Namespace, as_of: datetime) -> int:
    """Shadow-predict for non-directional candidates.

    Identical in shape to ``run_competition_pool`` -- one broken artifact must not
    silence the rest -- but draws its members from ``list_shadow_pool``, which is scoped
    by label scheme rather than by enrollment. Predictions land in
    ``auxiliary_model_predictions`` because ``score_model`` routes by the model's own
    alphabet, so nothing directional is touched.

    Each member is scored against its own scope: a pooled artifact fans out across its
    recorded roster, a single-instrument artifact scores its own instrument. Pinning one
    CLI symbol here (the original behaviour) made every model whose pool excluded that
    symbol fail its pass -- so a pooled champion could never write a prediction, never
    settle, and never satisfy "shadow before primary". ``--instrument`` remains an
    explicit operator override for scoring one symbol only.
    """

    members = repository.list_shadow_pool(args.shadow_scheme, args.model_key)
    results: list[dict[str, Any]] = []
    created = 0
    failed = 0
    for member in members:
        model_version = member["model_version"]
        roster = _pooled_roster(model_version)
        if args.instrument:
            symbols: list[str | None] = [args.instrument]
        elif roster:
            symbols = list(roster)
        else:
            # score_model resolves the artifact's own instrument and timeframe.
            symbols = [None]
        for symbol in symbols:
            try:
                result = score_model(
                    repository,
                    model_version,
                    symbol=symbol,
                    timeframe=args.timeframe,
                    as_of=as_of,
                    maximum_features=args.maximum_features,
                    similar_neighbors=args.similar_neighbors,
                    enrolled_at=member["enrolled_at"],
                )
                result["shadowRole"] = member["role"]
                result["modelKey"] = model_version.model_key
                if result.get("predictionCreated"):
                    created += 1
                results.append(result)
            except Exception as error:  # noqa: BLE001 - one broken artifact or symbol must not stop the others.
                failed += 1
                results.append(
                    {
                        "level": "error",
                        "message": str(error),
                        "errorType": type(error).__name__,
                        "modelVersionId": model_version.id,
                        "modelKey": model_version.model_key,
                        "instrument": symbol,
                        "shadowRole": member["role"],
                        "predictionCreated": False,
                    }
                )
    json_output(
        {
            "level": "info",
            "message": "Shadow-pool scoring complete",
            "labelScheme": args.shadow_scheme,
            "membersScored": len(members),
            "predictionsCreated": created,
            "failures": failed,
            "results": results,
        }
    )
    return 1 if failed and not created else 0


def run_competition_pool(repository: PostgresMlRepository, args: argparse.Namespace, as_of: datetime) -> int:
    """Shadow-predict for every enrolled pool member; one failure never silences the rest."""

    members = repository.list_competition_pool(args.model_key)
    results: list[dict[str, Any]] = []
    created = 0
    failed = 0
    for member in members:
        model_version = member["model_version"]
        try:
            result = score_model(
                repository,
                model_version,
                symbol=args.instrument,
                timeframe=args.timeframe,
                as_of=as_of,
                maximum_features=args.maximum_features,
                similar_neighbors=args.similar_neighbors,
                enrolled_at=member["enrolled_at"],
            )
            result["competitionRole"] = member["role"]
            result["competitionGroup"] = member["competition_group"]
            if result.get("predictionCreated"):
                created += 1
            results.append(result)
        except Exception as error:  # noqa: BLE001 - one broken artifact must not stop the champion.
            failed += 1
            results.append(
                {
                    "level": "error",
                    "message": str(error),
                    "errorType": type(error).__name__,
                    "modelVersionId": model_version.id,
                    "modelKey": model_version.model_key,
                    "competitionRole": member["role"],
                    "predictionCreated": False,
                }
            )
    json_output(
        {
            "level": "error" if members and failed == len(members) else "info",
            "message": "Competition-pool shadow predictions complete",
            "poolSize": len(members),
            "predictionsCreated": created,
            "failures": failed,
            "asOf": as_of.isoformat(),
            "results": results,
        }
    )
    return 1 if members and failed == len(members) else 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    psycopg = _load_runtime_dependencies(parser)

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")
    if args.competition_pool and args.shadow_scheme:
        parser.error("--competition-pool and --shadow-scheme are different pools; pass one.")
    if not args.competition_pool and not args.shadow_scheme:
        if not args.instrument or not args.timeframe or not args.model_key:
            parser.error(
                "--instrument, --timeframe, and --model-key are required unless "
                "--competition-pool or --shadow-scheme is used."
            )
    as_of = parse_as_of(args.data_cutoff_at) if args.data_cutoff_at else datetime.now(timezone.utc)

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)

        if args.shadow_scheme:
            return run_shadow_pool(repository, args, as_of)
        if args.competition_pool:
            return run_competition_pool(repository, args, as_of)

        production_model = repository.get_production_model(args.model_key)
        if production_model is None:
            raise InferenceError(f'No PRODUCTION model exists for model key "{args.model_key}".')
        result = score_model(
            repository,
            production_model,
            symbol=args.instrument,
            timeframe=args.timeframe,
            as_of=as_of,
            maximum_features=args.maximum_features,
            similar_neighbors=args.similar_neighbors,
        )

    json_output(result)
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
