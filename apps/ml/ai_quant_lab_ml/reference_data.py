"""Training-only reference examples for explainable local model inference.

The Phase 10 artifact records a fitted classifier, but not the historical rows
that made up its training partition.  This module serializes a bounded,
deterministic sample of those *training-only* rows alongside a model artifact.
At inference time it can compare a new feature vector with that saved sample
using the artifact's fitted imputer and scaler.  The resulting agreement rate
describes historical label agreement among comparable training observations; it
is not a trade-performance or profitability claim.

Everything here intentionally uses only the standard library.  The pipeline is
duck typed so the module can work with a fitted scikit-learn pipeline in normal
use while its safety rules remain testable without importing scikit-learn.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from .contracts import (
    DIRECTIONAL_ALPHABET,
    FEATURE_SCHEMA_VERSION,
    KNOWN_FEATURE_SCHEMA_VERSIONS,
    AnyLabel,
    LabelAlphabet,
    LabeledExample,
    MarketLabel,
)
from .features import feature_schema


REFERENCE_DATA_FORMAT = "similar-setup-reference-v1"
SAMPLING_METHOD = "STRATIFIED_CHRONOLOGICAL_V1"
NEIGHBOR_METHOD = "K_NEAREST_TRAINING_REFERENCE_V1"
DEFAULT_MAXIMUM_REFERENCE_EXAMPLES = 256


class ReferenceDataError(ValueError):
    """Raised when saved reference metadata cannot be used safely."""


@dataclass(frozen=True)
class ReferenceExample:
    """One JSON-safe, labeled training observation retained for comparison."""

    candle_id: str
    observed_at: datetime
    label: MarketLabel
    features: Mapping[str, float | None]


@dataclass(frozen=True)
class ReferenceData:
    """Parsed reference metadata with the fixed Phase 10 feature contract."""

    feature_schema: tuple[str, ...]
    examples: tuple[ReferenceExample, ...]
    training_rows: int
    maximum_rows: int
    training_class_counts: Mapping[MarketLabel, int]


@dataclass(frozen=True)
class SimilarSetupNeighbor:
    """A nearest retained training setup and its standardized Euclidean distance."""

    candle_id: str
    observed_at: datetime
    label: MarketLabel
    distance: float

    def as_dict(self) -> dict[str, Any]:
        return {
            "candleId": self.candle_id,
            "observedAt": _serialize_datetime(self.observed_at),
            "label": self.label,
            "distance": self.distance,
        }


@dataclass(frozen=True)
class SimilarSetupAgreement:
    """Historical label agreement among the nearest training-only references."""

    predicted_label: MarketLabel
    requested_k: int
    neighbor_count: int
    matching_label_count: int
    label_agreement: float | None
    neighbor_label_counts: Mapping[MarketLabel, int]
    neighbors: tuple[SimilarSetupNeighbor, ...]

    def as_dict(self) -> dict[str, Any]:
        """Return a JSON-safe explanation payload suitable for ``model_predictions``."""

        return {
            "method": NEIGHBOR_METHOD,
            "predictedLabel": self.predicted_label,
            "requestedK": self.requested_k,
            "neighborCount": self.neighbor_count,
            "matchingLabelCount": self.matching_label_count,
            "labelAgreement": self.label_agreement,
            "neighborLabelCounts": dict(self.neighbor_label_counts),
            "neighbors": [neighbor.as_dict() for neighbor in self.neighbors],
        }


def _require_positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ReferenceDataError(f"{field} must be a positive integer.")
    return value


def _require_non_blank_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ReferenceDataError(f"{field} must be a non-blank string.")
    return value.strip()


def _require_aware_datetime(value: Any, field: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ReferenceDataError(f"{field} must be a timezone-aware datetime.")
    return value.astimezone(UTC)


def _serialize_datetime(value: datetime) -> str:
    normalized = _require_aware_datetime(value, "datetime")
    return normalized.isoformat().replace("+00:00", "Z")


def _parse_datetime(value: Any, field: str) -> datetime:
    text = _require_non_blank_string(value, field)
    try:
        parsed = datetime.fromisoformat(f"{text[:-1]}+00:00" if text.endswith("Z") else text)
    except ValueError as error:
        raise ReferenceDataError(f"{field} must be an ISO-8601 timestamp.") from error
    return _require_aware_datetime(parsed, field)


def _known_schemas() -> Mapping[tuple[str, ...], str]:
    """Map each supported ordered schema to the version that names it."""

    return {
        tuple(feature_schema(version)): version
        for version in KNOWN_FEATURE_SCHEMA_VERSIONS
    }


def _fixed_schema(schema: Sequence[str] | None) -> tuple[str, ...]:
    """Accept a known schema in its declared order, and nothing else.

    The scalp track needs this to admit a second schema, but it must stay a
    whitelist. Returning ``tuple(schema)`` unchecked was the only thing standing
    between silently reordered columns at inference and a caught error: a
    permuted feature vector still has the right length and dtype, so every
    downstream check passes and the model simply reads the wrong column.
    """

    if schema is None:
        return tuple(feature_schema(FEATURE_SCHEMA_VERSION))
    selected = tuple(schema)
    if selected not in _known_schemas():
        raise ReferenceDataError(
            "Reference data must use a known feature schema "
            f"({', '.join(KNOWN_FEATURE_SCHEMA_VERSIONS)}) in its declared order."
        )
    return selected


def _schema_version_of(selected_schema: tuple[str, ...]) -> str:
    """Return the version naming an already-validated schema.

    Reference data for a scalp model must declare the scalp version, not the
    swing one, or the reader rejects the writer's own output.
    """

    version = _known_schemas().get(selected_schema)
    if version is None:
        raise ReferenceDataError("Reference data schema does not correspond to a known feature-schema version.")
    return version


def _label_counts(
    labels: Sequence[AnyLabel], alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET
) -> dict[AnyLabel, int]:
    counts = Counter(labels)
    return {label: int(counts[label]) for label in alphabet.labels}


def _json_feature_value(value: Any) -> float | None:
    """Mirror the training matrix's missing-value behaviour in JSON-safe form."""

    if value is None or isinstance(value, bool):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if math.isfinite(numeric) else None


def _matrix_feature_value(value: Any) -> float:
    normalized = _json_feature_value(value)
    return float("nan") if normalized is None else normalized


def _validate_training_example(
    example: LabeledExample,
    schema: Sequence[str],
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> ReferenceExample:
    if not isinstance(example, LabeledExample):
        raise ReferenceDataError("Training references must be LabeledExample instances.")
    candle_id = _require_non_blank_string(example.candle_id, "Training example candle_id")
    observed_at = _require_aware_datetime(example.observed_at, "Training example observed_at")
    label_available_at = _require_aware_datetime(example.label_available_at, "Training example label_available_at")
    if label_available_at <= observed_at:
        raise ReferenceDataError("Training example label_available_at must be after observed_at.")
    if example.label not in set(alphabet.labels):
        raise ReferenceDataError(
            f"Training example label must be one of {', '.join(alphabet.labels)}."
        )
    if not isinstance(example.features, Mapping):
        raise ReferenceDataError("Training example features must be a mapping.")
    return ReferenceExample(
        candle_id=candle_id,
        observed_at=observed_at,
        label=example.label,
        features={name: _json_feature_value(example.features.get(name)) for name in schema},
    )


def _allocate_stratified_quotas(
    counts: Mapping[AnyLabel, int],
    maximum_rows: int,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> dict[AnyLabel, int]:
    """Allocate bounded proportional quotas, keeping every present class when possible."""

    total_rows = sum(counts.values())
    target_rows = min(maximum_rows, total_rows)
    quotas = {label: 0 for label in alphabet.labels}
    present_labels = [label for label in alphabet.labels if counts[label] > 0]
    if target_rows == total_rows:
        return {label: counts[label] for label in alphabet.labels}
    if target_rows < len(present_labels):
        # A too-small cap cannot represent every class. Prefer the larger
        # strata and retain alphabet order as the deterministic tie breaker.
        for label in sorted(present_labels, key=lambda item: (-counts[item], alphabet.labels.index(item)))[:target_rows]:
            quotas[label] = 1
        return quotas

    for label in present_labels:
        quotas[label] = 1
    remaining_rows = target_rows - len(present_labels)
    remaining_capacity = {label: counts[label] - quotas[label] for label in alphabet.labels}
    total_capacity = sum(remaining_capacity.values())
    if remaining_rows == 0 or total_capacity == 0:
        return quotas

    fractional_allocations: dict[AnyLabel, float] = {}
    for label in alphabet.labels:
        allocation = remaining_rows * remaining_capacity[label] / total_capacity
        whole = min(remaining_capacity[label], math.floor(allocation))
        quotas[label] += whole
        fractional_allocations[label] = allocation - whole

    rows_left = target_rows - sum(quotas.values())
    for label in sorted(alphabet.labels, key=lambda item: (-fractional_allocations[item], alphabet.labels.index(item))):
        if rows_left == 0:
            break
        if quotas[label] < counts[label]:
            quotas[label] += 1
            rows_left -= 1

    if rows_left != 0:  # Defensive: arithmetic above should fully allocate the cap.
        raise ReferenceDataError("Could not allocate deterministic stratified reference quotas.")
    return quotas


def _chronological_sample(examples: Sequence[ReferenceExample], count: int) -> list[ReferenceExample]:
    """Select observations evenly across one label's chronological history."""

    if count <= 0:
        return []
    if count >= len(examples):
        return list(examples)
    if count == 1:
        return [examples[len(examples) // 2]]
    last_index = len(examples) - 1
    return [examples[(position * last_index) // (count - 1)] for position in range(count)]


def build_reference_metadata(
    training_examples: Sequence[LabeledExample],
    *,
    maximum_examples: int = DEFAULT_MAXIMUM_REFERENCE_EXAMPLES,
    schema: Sequence[str] | None = None,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> dict[str, Any]:
    """Build deterministic, stratified metadata from a model's training rows only.

    Callers must pass ``TemporalSplit.train`` rather than the full experiment or
    validation rows.  The function deliberately does not accept a validation
    sequence, making the training-only boundary visible at every call site.
    """

    selected_schema = _fixed_schema(schema)
    maximum_rows = _require_positive_int(maximum_examples, "maximum_examples")
    if not isinstance(training_examples, Sequence) or isinstance(training_examples, (str, bytes, bytearray)):
        raise ReferenceDataError("training_examples must be a sequence of LabeledExamples.")
    if not training_examples:
        raise ReferenceDataError("At least one training example is required for reference metadata.")

    parsed_examples = [
        _validate_training_example(example, selected_schema, alphabet) for example in training_examples
    ]
    parsed_examples.sort(key=lambda item: (item.observed_at, item.candle_id))
    candle_ids = [item.candle_id for item in parsed_examples]
    if len(set(candle_ids)) != len(candle_ids):
        raise ReferenceDataError("Training reference candle IDs must be unique.")

    training_counts = _label_counts([item.label for item in parsed_examples], alphabet)
    quotas = _allocate_stratified_quotas(training_counts, maximum_rows, alphabet)
    selected: list[ReferenceExample] = []
    for label in alphabet.labels:
        label_examples = [item for item in parsed_examples if item.label == label]
        selected.extend(_chronological_sample(label_examples, quotas[label]))
    selected.sort(key=lambda item: (item.observed_at, item.candle_id))
    reference_counts = _label_counts([item.label for item in selected], alphabet)

    return {
        "format": REFERENCE_DATA_FORMAT,
        # Recorded so a reader validates class counts against the alphabet the
        # writer actually used, rather than assuming the directional one.
        "labelAlphabet": alphabet.name,
        "labels": list(alphabet.labels),
        "featureSchemaVersion": _schema_version_of(selected_schema),
        "featureSchema": list(selected_schema),
        "trainingOnly": True,
        "sampling": {
            "method": SAMPLING_METHOD,
            "maximumRows": maximum_rows,
            "trainingRows": len(parsed_examples),
            "referenceRows": len(selected),
            "trainingClassCounts": training_counts,
            "referenceClassCounts": reference_counts,
        },
        "examples": [
            {
                "candleId": item.candle_id,
                "observedAt": _serialize_datetime(item.observed_at),
                "label": item.label,
                "features": dict(item.features),
            }
            for item in selected
        ],
    }


def _require_mapping(value: Any, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ReferenceDataError(f"{field} must be a JSON object.")
    return value


def _require_sequence(value: Any, field: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ReferenceDataError(f"{field} must be a JSON array.")
    return value


def _parse_class_counts(
    value: Any, field: str, alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET
) -> dict[AnyLabel, int]:
    parsed = _require_mapping(value, field)
    if set(parsed) != set(alphabet.labels):
        raise ReferenceDataError(f"{field} must contain exactly the {alphabet.name} label keys.")
    counts: dict[AnyLabel, int] = {}
    for label in alphabet.labels:
        count = parsed[label]
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ReferenceDataError(f"{field}.{label} must be a non-negative integer.")
        counts[label] = count
    return counts


def _parse_feature_row(value: Any, schema: Sequence[str], field: str) -> dict[str, float | None]:
    features = _require_mapping(value, field)
    if set(features) != set(schema):
        raise ReferenceDataError(f"{field} must contain exactly the fixed feature-schema names.")
    parsed: dict[str, float | None] = {}
    for name in schema:
        raw = features[name]
        if raw is None:
            parsed[name] = None
            continue
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            raise ReferenceDataError(f"{field}.{name} must be a finite number or null.")
        numeric = float(raw)
        if not math.isfinite(numeric):
            raise ReferenceDataError(f"{field}.{name} must be a finite number or null.")
        parsed[name] = numeric
    return parsed


def parse_reference_metadata(
    metadata: Mapping[str, Any],
    *,
    expected_schema: Sequence[str] | None = None,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> ReferenceData:
    """Parse and validate saved reference metadata against its feature schema."""

    selected_schema = _fixed_schema(expected_schema)
    payload = _require_mapping(metadata, "Reference metadata")
    if payload.get("format") != REFERENCE_DATA_FORMAT:
        raise ReferenceDataError("Reference metadata has an unsupported format.")
    if payload.get("featureSchemaVersion") != _schema_version_of(selected_schema):
        raise ReferenceDataError("Reference metadata has an incompatible feature-schema version.")
    payload_schema = _require_sequence(payload.get("featureSchema"), "Reference metadata featureSchema")
    if tuple(payload_schema) != selected_schema:
        raise ReferenceDataError("Reference metadata does not match the fixed feature schema.")
    if payload.get("trainingOnly") is not True:
        raise ReferenceDataError("Reference metadata must explicitly declare trainingOnly=true.")

    sampling = _require_mapping(payload.get("sampling"), "Reference metadata sampling")
    if sampling.get("method") != SAMPLING_METHOD:
        raise ReferenceDataError("Reference metadata has an unsupported sampling method.")
    maximum_rows = _require_positive_int(sampling.get("maximumRows"), "Reference metadata maximumRows")
    training_rows = _require_positive_int(sampling.get("trainingRows"), "Reference metadata trainingRows")
    training_counts = _parse_class_counts(
        sampling.get("trainingClassCounts"), "Reference metadata trainingClassCounts", alphabet
    )
    if sum(training_counts.values()) != training_rows:
        raise ReferenceDataError("Reference metadata training class counts do not match trainingRows.")

    raw_examples = _require_sequence(payload.get("examples"), "Reference metadata examples")
    if not raw_examples:
        raise ReferenceDataError("Reference metadata must contain at least one training reference.")
    if len(raw_examples) > maximum_rows or len(raw_examples) > training_rows:
        raise ReferenceDataError("Reference metadata contains more rows than its declared limits.")
    declared_reference_rows = _require_positive_int(sampling.get("referenceRows"), "Reference metadata referenceRows")
    if declared_reference_rows != len(raw_examples):
        raise ReferenceDataError("Reference metadata referenceRows does not match examples.")

    examples: list[ReferenceExample] = []
    previous_key: tuple[datetime, str] | None = None
    seen_candle_ids: set[str] = set()
    for index, raw_example in enumerate(raw_examples):
        item = _require_mapping(raw_example, f"Reference metadata examples[{index}]")
        candle_id = _require_non_blank_string(item.get("candleId"), f"Reference metadata examples[{index}].candleId")
        if candle_id in seen_candle_ids:
            raise ReferenceDataError("Reference metadata candle IDs must be unique.")
        seen_candle_ids.add(candle_id)
        observed_at = _parse_datetime(item.get("observedAt"), f"Reference metadata examples[{index}].observedAt")
        label = item.get("label")
        if label not in set(alphabet.labels):
            raise ReferenceDataError(
                f"Reference metadata labels must be one of {', '.join(alphabet.labels)}."
            )
        key = (observed_at, candle_id)
        if previous_key is not None and key < previous_key:
            raise ReferenceDataError("Reference metadata examples must be chronological and deterministically ordered.")
        previous_key = key
        examples.append(
            ReferenceExample(
                candle_id=candle_id,
                observed_at=observed_at,
                label=label,
                features=_parse_feature_row(item.get("features"), selected_schema, f"Reference metadata examples[{index}].features"),
            )
        )

    reference_counts = _parse_class_counts(
        sampling.get("referenceClassCounts"), "Reference metadata referenceClassCounts", alphabet
    )
    if reference_counts != _label_counts([item.label for item in examples], alphabet):
        raise ReferenceDataError("Reference metadata reference class counts do not match examples.")
    return ReferenceData(
        feature_schema=selected_schema,
        examples=tuple(examples),
        training_rows=training_rows,
        maximum_rows=maximum_rows,
        training_class_counts=training_counts,
    )


def _pipeline_step(pipeline: Any, name: str) -> Any:
    model = getattr(pipeline, "model", pipeline)
    named_steps = getattr(model, "named_steps", None)
    if named_steps is not None:
        try:
            step = named_steps[name]
        except (KeyError, TypeError, AttributeError):
            step = None
        if step is not None:
            return step
    step = getattr(model, name, None)
    if step is None:
        raise ReferenceDataError(f"The fitted pipeline must expose a {name} step.")
    return step


def _validate_step_width(step: Any, width: int, name: str) -> None:
    declared_width = getattr(step, "n_features_in_", None)
    if declared_width is None:
        return
    if isinstance(declared_width, bool):
        raise ReferenceDataError(f"The fitted {name} step reports an invalid feature width.")
    try:
        normalized_width = int(declared_width)
    except (TypeError, ValueError) as error:
        raise ReferenceDataError(f"The fitted {name} step reports an invalid feature width.") from error
    if normalized_width != width:
        raise ReferenceDataError(f"The fitted {name} step does not match the fixed feature schema.")


def _coerce_transformed_matrix(value: Any, *, row_count: int, column_count: int, field: str) -> list[list[float]]:
    try:
        rows = list(value)
    except TypeError as error:
        raise ReferenceDataError(f"The fitted {field} step did not return a matrix.") from error
    if len(rows) != row_count:
        raise ReferenceDataError(f"The fitted {field} step returned an unexpected row count.")
    matrix: list[list[float]] = []
    for row in rows:
        if isinstance(row, (str, bytes, bytearray)):
            raise ReferenceDataError(f"The fitted {field} step returned an invalid row.")
        try:
            values = list(row)
        except TypeError as error:
            raise ReferenceDataError(f"The fitted {field} step returned an invalid row.") from error
        if len(values) != column_count:
            raise ReferenceDataError(f"The fitted {field} step returned an unexpected feature width.")
        normalized: list[float] = []
        for numeric in values:
            if isinstance(numeric, bool):
                raise ReferenceDataError(f"The fitted {field} step returned a non-finite value.")
            try:
                parsed = float(numeric)
            except (TypeError, ValueError) as error:
                raise ReferenceDataError(f"The fitted {field} step returned a non-numeric value.") from error
            if not math.isfinite(parsed):
                raise ReferenceDataError(f"The fitted {field} step returned a non-finite value.")
            normalized.append(parsed)
        matrix.append(normalized)
    return matrix


def _preprocess_matrix(pipeline: Any, matrix: list[list[float]], schema: Sequence[str]) -> list[list[float]]:
    imputer = _pipeline_step(pipeline, "imputer")
    scaler = _pipeline_step(pipeline, "scaler")
    _validate_step_width(imputer, len(schema), "imputer")
    _validate_step_width(scaler, len(schema), "scaler")
    transform_imputer = getattr(imputer, "transform", None)
    transform_scaler = getattr(scaler, "transform", None)
    if not callable(transform_imputer) or not callable(transform_scaler):
        raise ReferenceDataError("The fitted pipeline imputer and scaler must both expose transform().")
    try:
        imputed = transform_imputer(matrix)
    except (AttributeError, TypeError, ValueError) as error:
        raise ReferenceDataError("The fitted pipeline imputer could not preprocess the reference feature matrix.") from error
    normalized_imputed = _coerce_transformed_matrix(
        imputed,
        row_count=len(matrix),
        column_count=len(schema),
        field="imputer",
    )
    # Run the scaler from the normalized imputer output.  This keeps duck-typed
    # implementations honest about receiving finite, rectangular numeric rows.
    try:
        normalized_scaled = transform_scaler(normalized_imputed)
    except (AttributeError, TypeError, ValueError) as error:
        raise ReferenceDataError("The fitted pipeline scaler could not scale the reference matrix.") from error
    return _coerce_transformed_matrix(
        normalized_scaled,
        row_count=len(matrix),
        column_count=len(schema),
        field="scaler",
    )


def nearest_reference_label_agreement(
    *,
    pipeline: Any,
    features: Mapping[str, Any],
    predicted_label: AnyLabel,
    reference_metadata: Mapping[str, Any] | ReferenceData,
    k: int = 20,
    expected_schema: Sequence[str] | None = None,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> SimilarSetupAgreement:
    """Compare a prediction with its nearest saved training-only references.

    Distances are Euclidean over the model's already-fitted imputer/scaler
    output.  No statistic is fit during inference, and no validation or future
    candle row is consulted.
    """

    selected_schema = _fixed_schema(expected_schema)
    requested_k = _require_positive_int(k, "k")
    if predicted_label not in set(alphabet.labels):
        raise ReferenceDataError(
            f"predicted_label must be one of {', '.join(alphabet.labels)}."
        )
    if not isinstance(features, Mapping):
        raise ReferenceDataError("features must be a mapping.")
    reference_data = (
        reference_metadata
        if isinstance(reference_metadata, ReferenceData)
        else parse_reference_metadata(
            reference_metadata, expected_schema=selected_schema, alphabet=alphabet
        )
    )
    if reference_data.feature_schema != selected_schema:
        raise ReferenceDataError("Reference data does not match the fixed feature schema.")

    query_row = [_matrix_feature_value(features.get(name)) for name in selected_schema]
    reference_rows = [
        [_matrix_feature_value(example.features.get(name)) for name in selected_schema]
        for example in reference_data.examples
    ]
    transformed = _preprocess_matrix(pipeline, [query_row, *reference_rows], selected_schema)
    query_vector = transformed[0]
    distances: list[tuple[float, ReferenceExample]] = []
    for vector, reference in zip(transformed[1:], reference_data.examples, strict=True):
        distance = math.sqrt(sum((query - candidate) ** 2 for query, candidate in zip(query_vector, vector, strict=True)))
        if not math.isfinite(distance):  # Defensive after finite preprocessing validation.
            raise ReferenceDataError("Reference distance was not finite.")
        distances.append((distance, reference))
    distances.sort(key=lambda item: (item[0], item[1].observed_at, item[1].candle_id))
    selected_neighbors = distances[: min(requested_k, len(distances))]
    label_counts = _label_counts([reference.label for _, reference in selected_neighbors], alphabet)
    matching_label_count = label_counts[predicted_label]
    neighbor_count = len(selected_neighbors)
    return SimilarSetupAgreement(
        predicted_label=predicted_label,
        requested_k=requested_k,
        neighbor_count=neighbor_count,
        matching_label_count=matching_label_count,
        label_agreement=None if neighbor_count == 0 else matching_label_count / neighbor_count,
        neighbor_label_counts=label_counts,
        neighbors=tuple(
            SimilarSetupNeighbor(
                candle_id=reference.candle_id,
                observed_at=reference.observed_at,
                label=reference.label,
                distance=distance,
            )
            for distance, reference in selected_neighbors
        ),
    )


__all__ = [
    "DEFAULT_MAXIMUM_REFERENCE_EXAMPLES",
    "NEIGHBOR_METHOD",
    "REFERENCE_DATA_FORMAT",
    "SAMPLING_METHOD",
    "ReferenceData",
    "ReferenceDataError",
    "ReferenceExample",
    "SimilarSetupAgreement",
    "SimilarSetupNeighbor",
    "build_reference_metadata",
    "nearest_reference_label_agreement",
    "parse_reference_metadata",
]
