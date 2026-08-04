"""As-of sequence scoring for Stage 5/6 shadow enrollment (TCN + OOF stack).

Tabular ``score_model`` cannot feed these families: they need a contiguous
intrasession lookback window, not a single-bar feature vector. This module
keeps that path separate while still emitting ``ExplainablePrediction`` so the
existing auxiliary-prediction persistence layer stays unchanged.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import Any

from .artifacts import load_model_artifact
from .contracts import (
    FEATURE_SCHEMA_VERSION_SCALP,
    LABEL_SCHEME_FIXED_HORIZON,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
    CandleEvidence,
    DatasetRequest,
    LabelAlphabet,
    PersistedModelVersion,
)
from .features import VOLUME_MEDIAN_WINDOW, build_feature_vector, feature_definition, feature_schema, trailing_feature_context
from .inference import (
    ExplainablePrediction,
    InferenceError,
    ProductionInferenceContract,
    _parse_timestamp,
    _positive_integer,
    _require_non_blank,
    _schema_names,
)
from .reference_data import ReferenceData
from .sequences import SequenceExample, SequenceError, build_intrasession_sequences
from .stack_explain import explain_stack_prediction
from .stacking import STACK_ALGORITHM, STACK_CONTRIBUTION_METHOD, predict_lag_lightgbm_proba
from .tcn_explain import temporal_occlusion_contributions
from .tcn_model import TCN_ALGORITHM, TEMPORAL_OCCLUSION_METHOD
from .tcn_training import predict_tcn_proba
from .volatility_expansion import VOLATILITY_ALPHABET

SEQUENCE_SHADOW_ALGORITHMS: frozenset[str] = frozenset({TCN_ALGORITHM, STACK_ALGORITHM})


def is_sequence_shadow_algorithm(algorithm: str) -> bool:
    return algorithm in SEQUENCE_SHADOW_ALGORITHMS


def validate_sequence_shadow_artifact(
    model_version: PersistedModelVersion,
    metadata: Mapping[str, Any],
    *,
    instrument_symbol: str,
    timeframe: str,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    allow_candidate_pool_member: bool = False,
) -> ProductionInferenceContract:
    """Validate a TCN/stack research artifact for shadow scoring.

    Intentionally lighter than the tabular production contract: sequence models
    do not ship a training-reference neighbor set, and their explanation path is
    temporal/meta rather than TreeSHAP. Settlement-critical fields
    (``horizonBars``, ``expansionBand``, ``labelScheme``, cutoffs) remain mandatory.
    """

    allowed_stages = ("PRODUCTION", "CANDIDATE") if allow_candidate_pool_member else ("PRODUCTION",)
    if model_version.stage not in allowed_stages:
        raise InferenceError("Only a PRODUCTION or enrolled CANDIDATE sequence model may create a shadow prediction.")
    if model_version.algorithm not in SEQUENCE_SHADOW_ALGORITHMS:
        raise InferenceError(f"{model_version.algorithm} is not a sequence shadow algorithm.")
    if metadata.get("algorithm") != model_version.algorithm:
        raise InferenceError("The artifact algorithm does not match its persisted model version.")
    if metadata.get("modelKey") != model_version.model_key:
        raise InferenceError("The artifact model key does not match its persisted model version.")

    schema_version = metadata.get("featureSchemaVersion")
    if schema_version != FEATURE_SCHEMA_VERSION_SCALP:
        raise InferenceError(
            f"Sequence shadow artifacts must use {FEATURE_SCHEMA_VERSION_SCALP!r}, got {schema_version!r}."
        )
    expected_schema = feature_schema(schema_version)
    if _schema_names(model_version.feature_schema) != expected_schema:
        raise InferenceError("The sequence model has an incompatible persisted feature schema.")
    metadata_schema = metadata.get("featureSchema")
    if not isinstance(metadata_schema, list) or tuple(metadata_schema) != expected_schema:
        raise InferenceError("The sequence artifact does not match the scalp feature schema.")
    if metadata.get("featureDefinition") not in (None, feature_definition(schema_version)):
        # Allow missing featureDefinition on early research artifacts; if present it must match.
        if metadata.get("featureDefinition") is not None:
            raise InferenceError("The sequence artifact has an incompatible feature definition.")

    dataset = metadata.get("dataset")
    expected_symbol = _require_non_blank(instrument_symbol, "Instrument symbol").upper()
    expected_timeframe = _require_non_blank(timeframe, "Timeframe")
    if not isinstance(dataset, Mapping) or dataset.get("timeframe") != expected_timeframe:
        raise InferenceError("The sequence artifact was trained for a different instrument or timeframe.")
    if dataset.get("instrument") != expected_symbol:
        raise InferenceError("The sequence artifact was trained for a different instrument or timeframe.")

    protocol = metadata.get("validationProtocol")
    if not isinstance(protocol, Mapping):
        raise InferenceError("The sequence artifact is missing its temporal validation protocol.")
    if protocol.get("labelScheme") != LABEL_SCHEME_VOLATILITY_EXPANSION:
        raise InferenceError("Sequence shadow enrollment is only authorized for volatility-expansion-v1.")
    lookback = metadata.get("lookback") or protocol.get("lookback")
    if isinstance(lookback, bool) or not isinstance(lookback, int) or lookback < 2:
        raise InferenceError("The sequence artifact is missing a valid lookback.")
    expansion_band = protocol.get("expansionBand")
    if not isinstance(expansion_band, (int, float)) or not math.isfinite(float(expansion_band)) or float(expansion_band) <= 0:
        raise InferenceError("The sequence artifact is missing a valid expansionBand.")

    training_window = protocol.get("trainingSourceWindow")
    if not isinstance(training_window, Mapping):
        raise InferenceError("The sequence artifact is missing its training-source window.")
    training_source_end = _parse_timestamp(training_window.get("end"), "Artifact training-source end")
    training_label_available_end = _parse_timestamp(
        protocol.get("trainingLabelAvailableEnd"),
        "Artifact training-label availability end",
    )
    data_cutoff_at = _parse_timestamp(protocol.get("dataCutoffAt"), "Artifact data cutoff")
    if training_label_available_end <= training_source_end:
        raise InferenceError("The sequence artifact has an invalid training-label availability boundary.")
    if data_cutoff_at < training_label_available_end:
        raise InferenceError("The sequence artifact data cutoff precedes its final training label availability.")

    validation_metrics = metadata.get("validationMetrics") or metadata.get("holdoutMetrics")
    if not isinstance(validation_metrics, Mapping):
        raise InferenceError("The sequence artifact is missing validation metrics.")

    empty_reference = ReferenceData(
        feature_schema=expected_schema,
        examples=(),
        training_rows=0,
        maximum_rows=0,
        training_class_counts={},
    )

    return ProductionInferenceContract(
        model_key=model_version.model_key,
        instrument_symbol=expected_symbol,
        timeframe=expected_timeframe,
        feature_schema=expected_schema,
        schema_version=schema_version,
        horizon_bars=_positive_integer(protocol.get("horizonBars"), "Artifact horizonBars"),
        neutral_threshold_bps=0.0,
        indicator_algorithm_version=_require_non_blank(
            protocol.get("indicatorAlgorithmVersion", "ta-v1"),
            "Artifact indicator algorithm version",
        ),
        pattern_algorithm_version=_require_non_blank(
            protocol.get("patternAlgorithmVersion", "candlestick-v1"),
            "Artifact pattern algorithm version",
        ),
        price_action_algorithm_version=_require_non_blank(
            protocol.get("priceActionAlgorithmVersion", "price-action-v2"),
            "Artifact price-action algorithm version",
        ),
        training_source_end=training_source_end,
        training_label_available_end=training_label_available_end,
        data_cutoff_at=data_cutoff_at,
        validation_metrics=dict(validation_metrics),
        training_reference_data=empty_reference,
    )


def _build_decision_sequence(
    candles: Sequence[CandleEvidence],
    *,
    lookback: int,
    schema: Sequence[str],
    schema_version: str,
    indicator_algorithm_version: str,
    pattern_algorithm_version: str,
    price_action_algorithm_version: str,
) -> SequenceExample:
    """Build the single decision sequence ending at the latest candle."""

    if len(candles) < lookback + 1:
        raise InferenceError(
            f"Need at least {lookback + 1} completed candles for sequence inference "
            f"(lookback={lookback} plus one prior close); found {len(candles)}."
        )
    ordered = sorted(candles, key=lambda c: (c.close_time, c.candle_id))
    # Walk features with the same prior-close / median-volume context training uses.
    close_volume: list[tuple[float, float]] = []
    labeled_like = []
    from .contracts import LabeledExample

    for candle in ordered:
        try:
            close_volume.append((float(candle.close), float(candle.volume)))
        except (TypeError, ValueError):
            close_volume.append((float("nan"), float("nan")))
        # Context ends at the bar being scored — same walk training uses.
        prior_close, median_volume = trailing_feature_context(close_volume)
        features = build_feature_vector(
            candle,
            prior_close=prior_close,
            median_volume=median_volume,
            schema_version=schema_version,
            indicator_algorithm_version=indicator_algorithm_version,
            pattern_algorithm_version=pattern_algorithm_version,
            price_action_algorithm_version=price_action_algorithm_version,
        )
        labeled_like.append(
            LabeledExample(
                candle_id=candle.candle_id,
                instrument_id=candle.instrument_id,
                symbol=candle.symbol,
                timeframe=candle.timeframe,
                observed_at=candle.close_time,
                label_available_at=candle.close_time,
                forward_return=0.0,
                label="STABLE",
                features=features,
            )
        )

    try:
        sequences = build_intrasession_sequences(
            labeled_like,
            lookback=lookback,
            feature_names=schema,
            timeframe=ordered[-1].timeframe,
        )
    except SequenceError as error:
        raise InferenceError(f"Could not build a leakage-safe inference sequence: {error}") from error
    if not sequences:
        raise InferenceError(
            "No contiguous intrasession sequence ends at the decision candle "
            "(gap, session boundary, or insufficient lookback)."
        )
    decision = sequences[-1]
    if decision.candle_id != ordered[-1].candle_id:
        raise InferenceError("The latest completed candle could not form a contiguous lookback window.")
    return decision


def score_sequence_prediction(
    repository: Any,
    model_version: PersistedModelVersion,
    loaded_artifact: Any,
    contract: ProductionInferenceContract,
    *,
    as_of: datetime,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> tuple[CandleEvidence, ExplainablePrediction]:
    """Score one as-of candle with a TCN or stack artifact."""

    metadata = loaded_artifact.metadata
    lookback = int(metadata.get("lookback") or metadata["validationProtocol"]["lookback"])
    # Extra bars for prior-close / volume-median warmup and session cushion.
    history_bars = lookback + VOLUME_MEDIAN_WINDOW + 30
    window_start = as_of - timedelta(days=7)
    evidence_request = DatasetRequest(
        instrument_symbol=contract.instrument_symbol,
        timeframe=contract.timeframe,
        data_window_start=window_start,
        data_window_end=as_of,
        data_cutoff_at=as_of,
        horizon_bars=contract.horizon_bars,
        neutral_threshold_bps=0.0,
        # Avoid the expensive forward-path query; we only need features.
        label_scheme=LABEL_SCHEME_FIXED_HORIZON,
        indicator_algorithm_version=contract.indicator_algorithm_version,
        pattern_algorithm_version=contract.pattern_algorithm_version,
        price_action_algorithm_version=contract.price_action_algorithm_version,
    )
    candles = repository.load_candle_evidence(evidence_request)
    if not candles:
        raise InferenceError("No completed candles are available at the selected as-of cutoff.")
    candles = sorted(candles, key=lambda c: (c.close_time, c.candle_id))[-history_bars:]
    decision_candle = candles[-1]
    sequence = _build_decision_sequence(
        candles,
        lookback=lookback,
        schema=contract.feature_schema,
        schema_version=contract.schema_version,
        indicator_algorithm_version=contract.indicator_algorithm_version,
        pattern_algorithm_version=contract.pattern_algorithm_version,
        price_action_algorithm_version=contract.price_action_algorithm_version,
    )

    algorithm = model_version.algorithm
    if algorithm == TCN_ALGORITHM:
        medians = metadata.get("hyperparameters", {}).get("featureMedians")
        if not isinstance(medians, list) or len(medians) != len(contract.feature_schema):
            raise InferenceError("TCN artifact is missing featureMedians matching the feature schema.")
        proba = predict_tcn_proba(
            loaded_artifact.model, [sequence], medians=medians, alphabet=alphabet,
        )[0]
        prediction = max(proba, key=proba.get)
        occlusion = temporal_occlusion_contributions(
            loaded_artifact.model,
            sequence,
            medians=medians,
            alphabet=alphabet,
            predicted_label=prediction,
        )
        contributions = [
            {
                "feature": f"lag[{block['lagStart']}:{block['lagEnd']}]",
                "contribution": float(block["logitDrop"]),
                "direction": "supports" if block.get("supportsPredictedClass") else "opposes",
            }
            for block in occlusion.get("blocks", [])[:12]
        ]
        explained = ExplainablePrediction(
            prediction=prediction,  # type: ignore[arg-type]
            confidence=float(proba[prediction]),
            class_probabilities=proba,  # type: ignore[arg-type]
            intercept=0.0,
            feature_contributions=contributions,
            contribution_method=TEMPORAL_OCCLUSION_METHOD,
            algorithm=TCN_ALGORITHM,
        )
        return decision_candle, explained

    if algorithm == STACK_ALGORITHM:
        bases = metadata.get("baseArtifacts")
        if not isinstance(bases, list) or len(bases) < 2:
            raise InferenceError("Stack artifact is missing baseArtifacts for TCN and lag LightGBM.")
        by_role = {str(item.get("role")): item for item in bases if isinstance(item, Mapping)}
        tcn_meta = by_role.get("tcn")
        lag_meta = by_role.get("lagLightgbm")
        if tcn_meta is None or lag_meta is None:
            raise InferenceError("Stack artifact must cite baseArtifacts roles 'tcn' and 'lagLightgbm'.")
        tcn_loaded = load_model_artifact(
            str(tcn_meta["path"]),
            expected_checksum=str(tcn_meta["checksum"]),
        )
        lag_loaded = load_model_artifact(
            str(lag_meta["path"]),
            expected_checksum=str(lag_meta["checksum"]),
        )
        tcn_medians = tcn_loaded.metadata.get("featureMedians")
        if not isinstance(tcn_medians, list):
            tcn_medians = metadata.get("hyperparameters", {}).get("featureMedians")
        if not isinstance(tcn_medians, list):
            raise InferenceError("Stack TCN base is missing featureMedians.")
        lag_schema = lag_loaded.metadata.get("featureSchema")
        if not isinstance(lag_schema, list) or not lag_schema:
            raise InferenceError("Stack lag-LightGBM base is missing featureSchema.")
        tcn_proba = predict_tcn_proba(
            tcn_loaded.model, [sequence], medians=tcn_medians, alphabet=alphabet,
        )[0]
        lag_proba = predict_lag_lightgbm_proba(
            lag_loaded.model, [sequence], schema=lag_schema, alphabet=alphabet,
        )[0]
        stack_explained = explain_stack_prediction(
            loaded_artifact.model,
            sequence=sequence,
            tcn_model=tcn_loaded.model,
            tcn_medians=tcn_medians,
            tcn_proba=tcn_proba,
            lag_lgbm_proba=lag_proba,
            alphabet=alphabet,
        )
        contributions = [
            {
                "feature": row["metaFeature"],
                "contribution": float(row["contribution"]),
                "direction": "supports" if row["contribution"] >= 0 else "opposes",
                "source": row["source"],
            }
            for row in stack_explained["meta"]["topContributions"][:12]
        ]
        explained = ExplainablePrediction(
            prediction=stack_explained["prediction"],  # type: ignore[arg-type]
            confidence=float(stack_explained["probabilities"][stack_explained["prediction"]]),
            class_probabilities=stack_explained["probabilities"],  # type: ignore[arg-type]
            intercept=float(stack_explained["meta"]["intercept"]),
            feature_contributions=contributions,
            contribution_method=STACK_CONTRIBUTION_METHOD,
            algorithm=STACK_ALGORITHM,
        )
        return decision_candle, explained

    raise InferenceError(f"Unsupported sequence algorithm {algorithm}.")


__all__ = [
    "SEQUENCE_SHADOW_ALGORITHMS",
    "is_sequence_shadow_algorithm",
    "score_sequence_prediction",
    "validate_sequence_shadow_artifact",
]
