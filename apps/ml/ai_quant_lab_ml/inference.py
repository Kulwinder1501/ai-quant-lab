"""Trusted production-model validation and transparent local inference.

Every supported model family gets an explainer built for its own arithmetic,
never borrowed language from another:

* the logistic baseline is explained by its selected-class linear terms —
  `standardized value * coefficient`;
* a gradient-boosted forest is explained by exact TreeSHAP contributions read
  from the model's own booster, which decompose the selected-class margin the
  same additive way a linear term does.

A model family without an explainer here is still refused. Reporting a
coefficient for a forest, or a "linear score" for a boosted margin, would put a
misleading number in front of a research decision.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .contracts import (
    DIRECTIONAL_ALPHABET,
    FEATURE_SCHEMA_VERSION,
    LIGHTGBM_ALGORITHM,
    LOGISTIC_BASELINE_ALGORITHM,
    SUPPORTED_ALGORITHMS,
    TREE_ENSEMBLE_ALGORITHMS,
    XGBOOST_ALGORITHM,
    AnyLabel,
    CandleEvidence,
    LabelAlphabet,
    MarketLabel,
    PersistedModelVersion,
)
from .features import feature_definition, feature_schema
from .reference_data import ReferenceData, ReferenceDataError, parse_reference_metadata


LINEAR_CONTRIBUTION_METHOD = "LINEAR_COEFFICIENT_V1"
TREE_CONTRIBUTION_METHOD = "TREE_SHAP_V1"

CONTRIBUTION_METHOD_BY_ALGORITHM: Mapping[str, str] = {
    LOGISTIC_BASELINE_ALGORITHM: LINEAR_CONTRIBUTION_METHOD,
    XGBOOST_ALGORITHM: TREE_CONTRIBUTION_METHOD,
    LIGHTGBM_ALGORITHM: TREE_CONTRIBUTION_METHOD,
}


class InferenceError(ValueError):
    """Raised when a local artifact or prediction cannot be explained safely."""


@dataclass(frozen=True)
class ProductionInferenceContract:
    """The artifact fields that bind one inference request to one model family."""

    model_key: str
    instrument_symbol: str
    timeframe: str
    feature_schema: tuple[str, ...]
    horizon_bars: int
    neutral_threshold_bps: float
    indicator_algorithm_version: str
    pattern_algorithm_version: str
    price_action_algorithm_version: str
    training_source_end: datetime
    training_label_available_end: datetime
    data_cutoff_at: datetime
    validation_metrics: Mapping[str, Any]
    training_reference_data: ReferenceData

    @property
    def deployment_not_before(self) -> datetime:
        """Latest historical-information boundary required before scoring a candle."""

        return max(self.training_label_available_end, self.data_cutoff_at)


@dataclass(frozen=True)
class ExplainablePrediction:
    """A predicted label, model-estimated class probability, and local evidence.

    ``intercept`` is the additive baseline of the selected class: the logistic
    intercept for the linear baseline, and the TreeSHAP expected-value term for a
    boosted forest. In both cases ``intercept`` plus every feature contribution
    reconstructs the selected class's margin, which is what makes the two
    families comparable in the dashboard.
    """

    prediction: MarketLabel
    confidence: float
    class_probabilities: Mapping[MarketLabel, float]
    intercept: float
    feature_contributions: Sequence[Mapping[str, Any]]
    contribution_method: str = LINEAR_CONTRIBUTION_METHOD
    algorithm: str = LOGISTIC_BASELINE_ALGORITHM


def _require_non_blank(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InferenceError(f"{field} must be a non-blank string.")
    return value.strip()


def _parse_timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str):
        raise InferenceError(f"{field} must be an ISO-8601 timestamp.")
    normalized = f"{value[:-1]}+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise InferenceError(f"{field} must be an ISO-8601 timestamp.") from error
    if parsed.tzinfo is None:
        raise InferenceError(f"{field} must include a timezone.")
    return parsed.astimezone(timezone.utc)


def _schema_names(schema: Any) -> tuple[str, ...]:
    if not isinstance(schema, Sequence) or isinstance(schema, (str, bytes, bytearray)):
        raise InferenceError("Persisted feature schema must be an array.")
    names: list[str] = []
    for field in schema:
        if not isinstance(field, Mapping):
            raise InferenceError("Persisted feature schema entries must be objects.")
        names.append(_require_non_blank(field.get("name"), "Persisted feature-schema name"))
    return tuple(names)


def _positive_integer(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise InferenceError(f"{field} must be a positive integer.")
    return value


def _non_negative_finite(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise InferenceError(f"{field} must be a finite non-negative number.")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise InferenceError(f"{field} must be a finite non-negative number.")
    return parsed


def validate_production_artifact(
    model_version: PersistedModelVersion,
    metadata: Mapping[str, Any],
    *,
    instrument_symbol: str,
    timeframe: str,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
    allow_candidate_pool_member: bool = False,
) -> ProductionInferenceContract:
    """Reject any artifact that cannot prove it matches the request and V1 contract.

    ``allow_candidate_pool_member`` admits a CANDIDATE that is enrolled in the
    daily model competition: its shadow predictions build the live track record
    the competition ranks on, and every other artifact integrity check below
    still applies to it unchanged.
    """

    allowed_stages = ("PRODUCTION", "CANDIDATE") if allow_candidate_pool_member else ("PRODUCTION",)
    if model_version.stage not in allowed_stages:
        raise InferenceError("Only a PRODUCTION model may create a Phase 11 prediction.")
    if model_version.algorithm not in SUPPORTED_ALGORITHMS:
        raise InferenceError(
            f"No local explainer exists for {model_version.algorithm}; "
            f"supported algorithms are {', '.join(SUPPORTED_ALGORITHMS)}."
        )
    expected_schema = feature_schema()
    if _schema_names(model_version.feature_schema) != expected_schema:
        raise InferenceError("The production model has an incompatible persisted feature schema.")
    metadata_schema = metadata.get("featureSchema")
    if not isinstance(metadata_schema, list) or tuple(metadata_schema) != expected_schema:
        raise InferenceError("The production artifact does not match the fixed feature schema.")
    if metadata.get("featureSchemaVersion") != FEATURE_SCHEMA_VERSION:
        raise InferenceError("The production artifact has an incompatible feature-schema version.")
    if metadata.get("featureDefinition") != feature_definition():
        raise InferenceError("The production artifact has an incompatible feature definition.")
    if metadata.get("algorithm") != model_version.algorithm:
        raise InferenceError("The production artifact algorithm does not match its persisted model version.")
    if metadata.get("modelKey") != model_version.model_key:
        raise InferenceError("The production artifact model key does not match its persisted model version.")

    dataset = metadata.get("dataset")
    expected_symbol = _require_non_blank(instrument_symbol, "Instrument symbol").upper()
    expected_timeframe = _require_non_blank(timeframe, "Timeframe")
    if not isinstance(dataset, Mapping) or dataset.get("timeframe") != expected_timeframe:
        raise InferenceError("The production artifact was trained for a different instrument or timeframe.")
    # A pooled cross-sectional model is trained on many instruments at once, and its
    # `dataset.instrument` records only the primary member. Scoring is therefore allowed
    # for any instrument in the recorded pool -- that is the entire point of pooling
    # scale-free features -- and refused for anything outside it. The guard is not
    # relaxed: an instrument the model never saw is still rejected, and a model without
    # a recorded pool still has to match its single instrument exactly.
    pooled = dataset.get("pooledInstruments")
    if isinstance(pooled, (list, tuple)) and pooled:
        if expected_symbol not in {str(symbol).upper() for symbol in pooled}:
            raise InferenceError(
                f"{expected_symbol} is not a member of this pooled artifact's training set."
            )
    elif dataset.get("instrument") != expected_symbol:
        raise InferenceError("The production artifact was trained for a different instrument or timeframe.")

    protocol = metadata.get("validationProtocol")
    if not isinstance(protocol, Mapping):
        raise InferenceError("The production artifact is missing its temporal validation protocol.")
    training_window = protocol.get("trainingSourceWindow")
    if not isinstance(training_window, Mapping):
        raise InferenceError("The production artifact is missing its training-source window.")
    training_source_end = _parse_timestamp(training_window.get("end"), "Artifact training-source end")
    training_label_available_end = _parse_timestamp(
        protocol.get("trainingLabelAvailableEnd"),
        "Artifact training-label availability end",
    )
    data_cutoff_at = _parse_timestamp(protocol.get("dataCutoffAt"), "Artifact data cutoff")
    if training_label_available_end <= training_source_end:
        raise InferenceError("The production artifact has an invalid training-label availability boundary.")
    if data_cutoff_at < training_label_available_end:
        raise InferenceError("The production artifact data cutoff precedes its final training label availability.")
    validation_metrics = metadata.get("validationMetrics")
    if not isinstance(validation_metrics, Mapping):
        raise InferenceError("The production artifact is missing validation metrics.")
    reference_metadata = metadata.get("trainingReferenceSet")
    if not isinstance(reference_metadata, Mapping):
        raise InferenceError(
            "The production artifact has no training-only similar-setup reference data. Retrain and promote a Phase 11-compatible model."
        )
    try:
        training_reference_data = parse_reference_metadata(
            reference_metadata, expected_schema=expected_schema, alphabet=alphabet
        )
    except ReferenceDataError as error:
        raise InferenceError(f"The production artifact has invalid training-only reference data: {error}") from error

    return ProductionInferenceContract(
        model_key=model_version.model_key,
        instrument_symbol=expected_symbol,
        timeframe=expected_timeframe,
        feature_schema=expected_schema,
        horizon_bars=_positive_integer(protocol.get("horizonBars"), "Artifact horizonBars"),
        neutral_threshold_bps=_non_negative_finite(protocol.get("neutralThresholdBps"), "Artifact neutralThresholdBps"),
        indicator_algorithm_version=_require_non_blank(protocol.get("indicatorAlgorithmVersion"), "Artifact indicator algorithm version"),
        pattern_algorithm_version=_require_non_blank(protocol.get("patternAlgorithmVersion"), "Artifact pattern algorithm version"),
        price_action_algorithm_version=_require_non_blank(protocol.get("priceActionAlgorithmVersion"), "Artifact price-action algorithm version"),
        training_source_end=training_source_end,
        training_label_available_end=training_label_available_end,
        data_cutoff_at=data_cutoff_at,
        validation_metrics=dict(validation_metrics),
        training_reference_data=training_reference_data,
    )


def _numeric_or_nan(value: Any) -> float:
    if isinstance(value, bool) or value is None:
        return float("nan")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return parsed if math.isfinite(parsed) else float("nan")


def _finite(value: Any, field: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise InferenceError(f"{field} must be numeric.") from error
    if not math.isfinite(parsed):
        raise InferenceError(f"{field} must be finite.")
    return parsed


def _one_row(value: Any, field: str) -> Sequence[Any]:
    try:
        row = value[0]
    except (TypeError, IndexError, KeyError) as error:
        raise InferenceError(f"{field} did not return a single feature row.") from error
    if not isinstance(row, Sequence) and not hasattr(row, "__len__"):
        raise InferenceError(f"{field} did not return a feature row.")
    return row


def _feature_category(feature_name: str) -> str:
    if feature_name.startswith("indicator."):
        return "INDICATOR"
    if feature_name.startswith("pattern."):
        return "PATTERN"
    if feature_name.startswith("price_action."):
        return "PRICE_ACTION"
    return "CANDLE"


def _linear_coefficients(classifier: Any, classes: Sequence[str], predicted_label: str, width: int) -> tuple[Sequence[Any], float]:
    coefficients = getattr(classifier, "coef_", None)
    intercepts = getattr(classifier, "intercept_", None)
    if coefficients is None or intercepts is None:
        raise InferenceError("The promoted model does not expose linear coefficients for explanation.")
    try:
        coefficient_rows = list(coefficients)
        intercept_values = list(intercepts)
    except TypeError as error:
        raise InferenceError("The promoted model exposes malformed linear coefficients.") from error
    if len(classes) == 2 and len(coefficient_rows) == 1 and len(intercept_values) == 1:
        positive_label = classes[1]
        sign = 1.0 if predicted_label == positive_label else -1.0
        row = coefficient_rows[0]
        try:
            if len(row) != width:
                raise InferenceError("The promoted model coefficient width does not match the feature schema.")
            signed_row = tuple(sign * _finite(value, "Model coefficient") for value in row)
        except TypeError as error:
            raise InferenceError("The promoted model exposes malformed linear coefficients.") from error
        # sklearn stores one binary coefficient vector for classes_[1]. The
        # classes_[0] logit is its exact negative, so both the intercept and
        # every feature coefficient must change sign for that selected class.
        return signed_row, sign * _finite(intercept_values[0], "Model intercept")
    try:
        class_index = list(classes).index(predicted_label)
        row = coefficient_rows[class_index]
        if len(row) != width:
            raise InferenceError("The promoted model coefficient width does not match the feature schema.")
    except (ValueError, IndexError, TypeError) as error:
        if isinstance(error, InferenceError):
            raise
        raise InferenceError("The promoted model coefficient rows do not match its classes.") from error
    return row, _finite(intercept_values[class_index], "Model intercept")


def _contribution_rows(values: Any, *, width: int, class_count: int, source: str) -> list[list[float]]:
    """Normalise a library's contribution output to one row per scored class.

    Both libraries append the model's expected-value term to each block, so every
    returned row is ``width + 1`` long. A binary model emits a single block for
    its positive class; a multiclass model emits one block per class.
    """

    try:
        flat = [float(value) for value in _flattened(values)]
    except (TypeError, ValueError) as error:
        raise InferenceError(f"{source} returned malformed feature contributions.") from error
    block = width + 1
    if len(flat) == block:
        return [flat]
    if class_count > 1 and len(flat) == block * class_count:
        return [flat[index * block:(index + 1) * block] for index in range(class_count)]
    raise InferenceError(f"{source} returned {len(flat)} contribution values for a {width}-feature schema.")


def _flattened(values: Any) -> list[Any]:
    """Flatten a nested sequence or numpy array of one scored row into a list."""

    try:
        rows = list(values)
    except TypeError as error:
        raise InferenceError("Model contributions are not a sequence.") from error
    if len(rows) != 1:
        raise InferenceError("Model contributions did not describe exactly one scored row.")
    flat: list[Any] = []
    stack = [rows[0]]
    while stack:
        item = stack.pop(0)
        if isinstance(item, (str, bytes)):
            raise InferenceError("Model contributions contain non-numeric values.")
        try:
            children = list(item)
        except TypeError:
            flat.append(item)
            continue
        stack = children + stack
    return flat


def _xgboost_contribution_rows(estimator: Any, standardized: Sequence[float], width: int, class_count: int) -> list[list[float]]:
    """Read exact TreeSHAP values from the fitted XGBoost booster."""

    try:
        import xgboost
    except ImportError as error:  # pragma: no cover - depends on the optional runtime environment
        raise InferenceError("xgboost is required to explain an XGBoost artifact. Install apps/ml requirements first.") from error
    booster = getattr(estimator, "get_booster", None)
    if not callable(booster):
        raise InferenceError("The promoted XGBoost classifier does not expose a fitted booster.")
    try:
        matrix = xgboost.DMatrix([list(standardized)], missing=float("nan"))
        raw = booster().predict(matrix, pred_contribs=True, validate_features=False)
    except Exception as error:  # noqa: BLE001 - any library failure is an explanation failure here.
        raise InferenceError(f"The promoted XGBoost booster could not produce TreeSHAP contributions: {error}") from error
    return _contribution_rows(raw, width=width, class_count=class_count, source="The XGBoost booster")


def _lightgbm_contribution_rows(estimator: Any, standardized: Sequence[float], width: int, class_count: int) -> list[list[float]]:
    """Read exact TreeSHAP values from the fitted LightGBM booster."""

    if not hasattr(estimator, "predict"):
        raise InferenceError("The promoted LightGBM classifier cannot be scored for contributions.")
    try:
        raw = estimator.predict([list(standardized)], pred_contrib=True)
    except Exception as error:  # noqa: BLE001 - any library failure is an explanation failure here.
        raise InferenceError(f"The promoted LightGBM booster could not produce TreeSHAP contributions: {error}") from error
    return _contribution_rows(raw, width=width, class_count=class_count, source="The LightGBM booster")


def _tree_contributions(
    classifier: Any,
    standardized: Sequence[float],
    classes: Sequence[str],
    predicted_label: str,
    width: int,
    algorithm: str,
) -> tuple[Sequence[float], float]:
    """Return selected-class TreeSHAP contributions and their expected-value term."""

    estimator = getattr(classifier, "estimator", None)
    if estimator is None:
        raise InferenceError("The promoted boosted artifact does not expose its underlying booster.")
    rows = (
        _xgboost_contribution_rows(estimator, standardized, width, len(classes))
        if algorithm == XGBOOST_ALGORITHM
        else _lightgbm_contribution_rows(estimator, standardized, width, len(classes))
    )

    if len(rows) == 1:
        if len(classes) != 2:
            raise InferenceError("A single contribution block is only valid for a two-class model.")
        # A binary booster scores the margin of classes_[1]. The classes_[0]
        # margin is its exact negative, so both the expected value and every
        # feature contribution flip sign for that selected class.
        sign = 1.0 if predicted_label == classes[1] else -1.0
        selected = [sign * value for value in rows[0]]
    else:
        try:
            selected = rows[list(classes).index(predicted_label)]
        except (ValueError, IndexError) as error:
            raise InferenceError("The promoted booster contribution blocks do not match its classes.") from error
    return tuple(selected[:width]), _finite(selected[width], "Model expected value")


@dataclass(frozen=True)
class _ScoredVector:
    """One fixed-schema vector after the training-fold transforms, with its scores."""

    classifier: Any
    raw_values: Sequence[float]
    imputed: Sequence[Any]
    standardized: Sequence[Any]
    classes: Sequence[str]
    predicted_label: str
    probabilities: Mapping[MarketLabel, float]
    confidence: float


def _score_fixed_vector(
    model: Any,
    features: Mapping[str, Any],
    selected_schema: Sequence[str],
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> _ScoredVector:
    """Apply the stored imputer and scaler, then score the fixed feature vector.

    Both transforms were fitted on the training partition only, so scoring here
    cannot leak validation statistics into a prediction.
    """

    named_steps = getattr(model, "named_steps", None)
    if not isinstance(named_steps, Mapping):
        raise InferenceError("The promoted artifact is not a supported sklearn pipeline.")
    imputer = named_steps.get("imputer")
    scaler = named_steps.get("scaler")
    classifier = named_steps.get("classifier")
    if any(step is None or not hasattr(step, "transform") for step in (imputer, scaler)) or classifier is None:
        raise InferenceError("The promoted pipeline is missing its imputer, scaler, or classifier.")
    if not hasattr(classifier, "predict") or not hasattr(classifier, "predict_proba"):
        raise InferenceError("The promoted classifier cannot provide an explainable probability prediction.")

    raw_values = [_numeric_or_nan(features.get(name)) for name in selected_schema]
    try:
        imputed = _one_row(imputer.transform([raw_values]), "Model imputer")
        standardized = _one_row(scaler.transform([imputed]), "Model scaler")
        raw_prediction = classifier.predict([standardized])[0]
        probability_row = _one_row(classifier.predict_proba([standardized]), "Model classifier")
        classes = [str(item) for item in classifier.classes_]
    except (AttributeError, IndexError, KeyError, TypeError, ValueError) as error:
        raise InferenceError("The promoted model could not score the fixed feature vector.") from error
    if len(imputed) != len(selected_schema) or len(standardized) != len(selected_schema):
        raise InferenceError("The promoted pipeline changed the fixed feature schema width.")
    permitted = set(alphabet.labels)
    if any(label not in permitted for label in classes):
        raise InferenceError(
            f"The promoted classifier exposes a label outside the {alphabet.name} label set."
        )
    predicted_label = str(raw_prediction)
    if predicted_label not in permitted or predicted_label not in classes:
        raise InferenceError("The promoted classifier returned an unsupported prediction label.")
    if len(probability_row) != len(classes):
        raise InferenceError("The promoted classifier probability width does not match its classes.")

    probabilities: dict[AnyLabel, float] = {label: 0.0 for label in alphabet.labels}
    for label, value in zip(classes, probability_row, strict=True):
        probability = _finite(value, f"Probability for {label}")
        if probability < 0 or probability > 1:
            raise InferenceError("The promoted classifier returned a probability outside [0, 1].")
        probabilities[label] = probability  # type: ignore[index]
    probability_total = sum(probabilities.values())
    if not math.isclose(probability_total, 1.0, rel_tol=1e-7, abs_tol=1e-7):
        raise InferenceError("The promoted classifier probabilities do not sum to one.")
    confidence = probabilities[predicted_label]  # type: ignore[index]

    return _ScoredVector(
        classifier=classifier,
        raw_values=raw_values,
        imputed=imputed,
        standardized=standardized,
        classes=classes,
        predicted_label=predicted_label,
        probabilities=probabilities,
        confidence=confidence,
    )


def explain_prediction(
    model: Any,
    features: Mapping[str, Any],
    *,
    algorithm: str = LOGISTIC_BASELINE_ALGORITHM,
    schema: Sequence[str] | None = None,
    maximum_features: int = 12,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> ExplainablePrediction:
    """Score one fixed-schema vector and explain it with its own model's arithmetic.

    For the linear baseline a contribution is
    `standardized feature value * selected-class coefficient`. For a boosted
    forest it is the feature's exact TreeSHAP value for the selected class. Both
    describe local model arithmetic — not causality, and not a trade return.
    """

    contribution_method = CONTRIBUTION_METHOD_BY_ALGORITHM.get(algorithm)
    if contribution_method is None:
        raise InferenceError(
            f"No local explainer exists for {algorithm}; supported algorithms are {', '.join(SUPPORTED_ALGORITHMS)}."
        )
    selected_schema = tuple(schema or feature_schema())
    if not selected_schema:
        raise InferenceError("At least one feature is required for inference.")
    if not isinstance(features, Mapping):
        raise InferenceError("features must be a mapping.")
    if isinstance(maximum_features, bool) or not isinstance(maximum_features, int) or maximum_features <= 0:
        raise InferenceError("maximum_features must be a positive integer.")

    scored = _score_fixed_vector(model, features, selected_schema, alphabet)
    width = len(selected_schema)
    if algorithm in TREE_ENSEMBLE_ALGORITHMS:
        contribution_values, intercept = _tree_contributions(
            scored.classifier,
            [_finite(value, "Standardized value") for value in scored.standardized],
            scored.classes,
            scored.predicted_label,
            width,
            algorithm,
        )
        coefficients: Sequence[float | None] = (None,) * width
    else:
        coefficient_row, intercept = _linear_coefficients(scored.classifier, scored.classes, scored.predicted_label, width)
        coefficients = tuple(_finite(coefficient_row[index], f"Coefficient for {selected_schema[index]}") for index in range(width))
        contribution_values = tuple(
            _finite(scored.standardized[index], f"Standardized value for {selected_schema[index]}") * (coefficients[index] or 0.0)
            for index in range(width)
        )
    if len(contribution_values) != width:
        raise InferenceError("The promoted model produced a contribution width that does not match the feature schema.")

    contributions: list[dict[str, Any]] = []
    for index, feature_name in enumerate(selected_schema):
        raw_value = scored.raw_values[index]
        contribution = _finite(contribution_values[index], f"Contribution for {feature_name}")
        contributions.append(
            {
                "feature": feature_name,
                "category": _feature_category(feature_name),
                "rawValue": None if math.isnan(raw_value) else raw_value,
                "imputedValue": _finite(scored.imputed[index], f"Imputed value for {feature_name}"),
                "standardizedValue": _finite(scored.standardized[index], f"Standardized value for {feature_name}"),
                "coefficient": coefficients[index],
                "contribution": contribution,
                "contributionMethod": contribution_method,
                "supportsPredictedClass": contribution >= 0,
            }
        )
    contributions.sort(key=lambda item: (-abs(float(item["contribution"])), str(item["feature"])))
    return ExplainablePrediction(
        prediction=scored.predicted_label,  # type: ignore[arg-type]
        confidence=scored.confidence,
        class_probabilities=scored.probabilities,
        intercept=intercept,
        feature_contributions=tuple(contributions[:maximum_features]),
        contribution_method=contribution_method,
        algorithm=algorithm,
    )


def explain_logistic_prediction(
    model: Any,
    features: Mapping[str, Any],
    *,
    schema: Sequence[str] | None = None,
    maximum_features: int = 12,
) -> ExplainablePrediction:
    """Explain a logistic-baseline artifact; kept for callers that predate Phase 19."""

    return explain_prediction(
        model,
        features,
        algorithm=LOGISTIC_BASELINE_ALGORITHM,
        schema=schema,
        maximum_features=maximum_features,
    )


def build_prediction_explanation(
    *,
    candle: CandleEvidence,
    contract: ProductionInferenceContract,
    explained_prediction: ExplainablePrediction,
    artifact_checksum: str,
    evidence_cutoff_at: datetime,
    historical_reference: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Make structured, user-readable evidence without turning it into a trade signal."""

    supporting = [item for item in explained_prediction.feature_contributions if item["supportsPredictedClass"]][:3]
    opposing = [item for item in explained_prediction.feature_contributions if not item["supportsPredictedClass"]][:3]
    patterns = [
        {
            "code": pattern.code,
            "direction": pattern.direction,
            "confidence": pattern.confidence,
        }
        for pattern in candle.patterns
        if pattern.algorithm_version == contract.pattern_algorithm_version
    ]
    price_action = [
        {
            "eventType": event.event_type,
            "direction": event.direction,
            "confidence": event.confidence,
            "level": event.level,
        }
        for event in candle.price_action_events
        if event.algorithm_version == contract.price_action_algorithm_version
    ]
    validation_macro_f1 = contract.validation_metrics.get("macroF1")
    is_tree_ensemble = explained_prediction.contribution_method == TREE_CONTRIBUTION_METHOD
    inputs_summary = (
        "These are the largest exact TreeSHAP contributions to the selected class's margin, "
        "measured after the training-fold imputer and scaler."
        if is_tree_ensemble
        else "These are the largest local linear terms for the selected class after the training-fold imputer and scaler."
    )
    return [
        {
            "kind": "MODEL_OUTPUT",
            "summary": "A promoted local research model classified one completed candle.",
            "details": {
                "prediction": explained_prediction.prediction,
                "confidence": explained_prediction.confidence,
                "classProbabilities": dict(explained_prediction.class_probabilities),
                "algorithm": explained_prediction.algorithm,
                "contributionMethod": explained_prediction.contribution_method,
                # The additive baseline of the selected class: a logistic
                # intercept, or a TreeSHAP expected value for a boosted forest.
                "intercept": explained_prediction.intercept,
            },
        },
        {
            "kind": "MODEL_LINEAGE",
            "summary": "The prediction is bound to one checksum-verified local model artifact and as-of evidence cutoff.",
            "details": {
                "modelKey": contract.model_key,
                "artifactChecksum": artifact_checksum,
                "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
                "sourceCandleId": candle.candle_id,
                "sourceCandleCloseTime": candle.close_time.isoformat(),
                "evidenceCutoffAt": evidence_cutoff_at.isoformat(),
                "trainingLabelAvailableEnd": contract.training_label_available_end.isoformat(),
                "trainingDataCutoffAt": contract.data_cutoff_at.isoformat(),
            },
        },
        {
            "kind": "TOP_MODEL_INPUTS",
            "summary": inputs_summary,
            "details": {
                "contributionMethod": explained_prediction.contribution_method,
                "supporting": supporting,
                "opposing": opposing,
            },
        },
        {
            "kind": "PATTERN_EVIDENCE",
            "summary": "Persisted candlestick detections visible at the completed source candle.",
            "details": {"detections": patterns},
        },
        {
            "kind": "PRICE_ACTION_EVIDENCE",
            "summary": "Persisted price-action events visible at the completed source candle.",
            "details": {"events": price_action},
        },
        {
            "kind": "HISTORICAL_SIMILAR_SETUPS",
            "summary": "Nearest reference examples come only from the model training partition and report label agreement, not realised trading profit.",
            "details": dict(historical_reference),
        },
        {
            "kind": "VALIDATION_CONTEXT",
            "summary": "This is historical holdout validation context for the model, not a guarantee for this candle.",
            "details": {"macroF1": validation_macro_f1, "metrics": dict(contract.validation_metrics)},
        },
        {
            "kind": "LIMITATION",
            "summary": "This directional research label is not a trade idea, order, entry, stop, target, or promise of return.",
            "details": {"automatedExecution": False, "paperTradeCreated": False},
        },
    ]


__all__ = [
    "CONTRIBUTION_METHOD_BY_ALGORITHM",
    "LIGHTGBM_ALGORITHM",
    "LINEAR_CONTRIBUTION_METHOD",
    "LOGISTIC_BASELINE_ALGORITHM",
    "SUPPORTED_ALGORITHMS",
    "TREE_CONTRIBUTION_METHOD",
    "XGBOOST_ALGORITHM",
    "ExplainablePrediction",
    "InferenceError",
    "ProductionInferenceContract",
    "build_prediction_explanation",
    "explain_logistic_prediction",
    "explain_prediction",
    "validate_production_artifact",
]
