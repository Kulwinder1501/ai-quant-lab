"""Deterministic local model training, with every library imported lazily.

Three model families share one pipeline contract — ``imputer``, ``scaler``,
``classifier`` — so an artifact from any of them can be scored, compared, and
promoted by the same code:

* the scikit-learn logistic-regression baseline, explained by linear terms;
* an XGBoost gradient-boosted forest, explained by exact TreeSHAP values;
* a LightGBM gradient-boosted forest, explained the same way.

The boosted models do not need the scaler (a split point is scale-invariant) or
the imputer (both libraries route missing values down a learned default branch),
but keeping the three steps identical means the promotion gate and the Phase 11
explainers never have to special-case an artifact's shape.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .contracts import (
    ALGORITHM_BY_CHOICE,
    FEATURE_SCHEMA_VERSION,
    LABELS,
    LIGHTGBM_ALGORITHM,
    LOGISTIC_BASELINE_ALGORITHM,
    XGBOOST_ALGORITHM,
    EvaluationMetrics,
    LabeledExample,
    MarketLabel,
    TemporalSplit,
)
from .estimators import LabelEncodedClassifier
from .features import feature_definition, feature_schema


class TrainingError(ValueError):
    """Raised when the supplied temporal split cannot train a reliable baseline."""


@dataclass(frozen=True)
class BaselineTrainingResult:
    """A serializable trained pipeline and transparent train/validation results."""

    algorithm: str
    model: Any
    feature_schema: tuple[str, ...]
    training_metrics: EvaluationMetrics
    validation_metrics: EvaluationMetrics
    training_rows: int
    validation_rows: int
    hyperparameters: Mapping[str, Any] = field(default_factory=dict)


# A readable alias now that more than a baseline is trainable here.
TrainingResult = BaselineTrainingResult


def _feature_matrix(examples: Sequence[LabeledExample], schema: Sequence[str]) -> list[list[float]]:
    matrix: list[list[float]] = []
    for example in examples:
        row: list[float] = []
        for feature_name in schema:
            value = example.features.get(feature_name, float("nan"))
            if isinstance(value, bool):
                row.append(float("nan"))
                continue
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                numeric = float("nan")
            row.append(numeric if math.isfinite(numeric) else float("nan"))
        matrix.append(row)
    return matrix


def _labels(examples: Sequence[LabeledExample]) -> list[MarketLabel]:
    return [example.label for example in examples]


def _class_counts(labels: Sequence[MarketLabel]) -> dict[MarketLabel, int]:
    counts = Counter(labels)
    return {label: int(counts[label]) for label in LABELS}


def evaluate_predictions(
    actual: Sequence[MarketLabel], predicted: Sequence[MarketLabel],
) -> EvaluationMetrics:
    """Evaluate a fixed three-class label space without importing sklearn early."""

    if not actual:
        raise TrainingError("Cannot evaluate an empty label sequence.")
    if len(actual) != len(predicted):
        raise TrainingError("actual and predicted labels must have the same length.")
    if any(label not in LABELS for label in actual) or any(label not in LABELS for label in predicted):
        raise TrainingError("Labels must be one of BEARISH, NEUTRAL, or BULLISH.")

    try:
        from sklearn.metrics import accuracy_score, balanced_accuracy_score, f1_score
    except ImportError as error:  # pragma: no cover - depends on the optional runtime environment
        raise RuntimeError("scikit-learn is required to evaluate model predictions. Install apps/ml requirements first.") from error

    directional_predictions = 0
    correct_directional_predictions = 0
    for a, p in zip(actual, predicted):
        if p in ("BULLISH", "BEARISH"):
            directional_predictions += 1
            if a == p:
                correct_directional_predictions += 1
    
    sample_count = len(actual)
    coverage = float(directional_predictions) / sample_count if sample_count > 0 else 0.0
    directional_hit_rate = (
        float(correct_directional_predictions) / directional_predictions
        if directional_predictions > 0
        else None
    )

    return EvaluationMetrics(
        accuracy=float(accuracy_score(actual, predicted)),
        balanced_accuracy=float(balanced_accuracy_score(actual, predicted)),
        macro_f1=float(f1_score(actual, predicted, labels=list(LABELS), average="macro", zero_division=0)),
        directional_predictions=directional_predictions,
        directional_hit_rate=directional_hit_rate,
        coverage=coverage,
        sample_count=sample_count,
        class_counts=_class_counts(actual),
    )


def predict_labels(
    model: Any,
    examples: Sequence[LabeledExample],
    *,
    schema: Sequence[str] | None = None,
) -> list[MarketLabel]:
    """Predict labels for already-built examples using the declared schema order.

    Promotion code uses this helper to score an existing production artifact on
    the exact validation rows used by a candidate.  It intentionally performs
    no fitting or imputation itself; those operations remain inside the stored
    pipeline that was fitted on its own training partition.
    """

    selected_schema = tuple(schema or feature_schema())
    if not selected_schema:
        raise TrainingError("At least one feature is required.")
    if not examples:
        return []
    predictor = getattr(model, "model", model)
    if not hasattr(predictor, "predict"):
        raise TrainingError("The supplied model does not expose a predict method.")
    try:
        raw_predictions = predictor.predict(_feature_matrix(examples, selected_schema))
    except (TypeError, ValueError, AttributeError) as error:
        raise TrainingError("The supplied model could not score the provided feature matrix.") from error
    predictions = [str(value) for value in raw_predictions]
    if any(label not in LABELS for label in predictions):
        raise TrainingError("The supplied model returned a label outside the fixed Phase 10 label set.")
    return predictions  # type: ignore[return-value]


def _prepared_split(
    split: TemporalSplit,
    schema: Sequence[str] | None,
    *,
    algorithm_label: str,
) -> tuple[tuple[str, ...], list[MarketLabel], list[MarketLabel]]:
    """Validate one purged split and its feature schema before any library loads."""

    if not split.train:
        raise TrainingError("The training partition cannot be empty.")
    if not split.validation:
        raise TrainingError("The validation partition cannot be empty.")
    selected_schema = tuple(schema or feature_schema())
    if not selected_schema:
        raise TrainingError("At least one feature is required.")
    if len(set(selected_schema)) != len(selected_schema):
        raise TrainingError("Feature schema names must be unique.")

    train_labels = _labels(split.train)
    validation_labels = _labels(split.validation)
    if any(label not in LABELS for label in (*train_labels, *validation_labels)):
        raise TrainingError("Labels must be one of BEARISH, NEUTRAL, or BULLISH.")
    if len(set(train_labels)) < 2:
        raise TrainingError(f"{algorithm_label} requires at least two classes in the training partition.")
    return selected_schema, train_labels, validation_labels


def _fitted_result(
    *,
    algorithm: str,
    pipeline: Any,
    split: TemporalSplit,
    selected_schema: tuple[str, ...],
    train_labels: Sequence[MarketLabel],
    validation_labels: Sequence[MarketLabel],
    hyperparameters: Mapping[str, Any],
) -> BaselineTrainingResult:
    """Fit one pipeline on the training partition only and score both partitions."""

    pipeline.fit(_feature_matrix(split.train, selected_schema), list(train_labels))
    train_predictions = predict_labels(pipeline, split.train, schema=selected_schema)
    validation_predictions = predict_labels(pipeline, split.validation, schema=selected_schema)
    return BaselineTrainingResult(
        algorithm=algorithm,
        model=pipeline,
        feature_schema=selected_schema,
        training_metrics=evaluate_predictions(train_labels, train_predictions),
        validation_metrics=evaluate_predictions(validation_labels, validation_predictions),
        training_rows=len(split.train),
        validation_rows=len(split.validation),
        hyperparameters=dict(hyperparameters),
    )


def _positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise TrainingError(f"{field_name} must be an integer greater than zero.")
    return value


def _positive_float(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrainingError(f"{field_name} must be a finite number greater than zero.")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise TrainingError(f"{field_name} must be a finite number greater than zero.")
    return parsed


def _fraction(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrainingError(f"{field_name} must be a number in (0, 1].")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0 or parsed > 1:
        raise TrainingError(f"{field_name} must be a number in (0, 1].")
    return parsed


def _non_negative_float(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TrainingError(f"{field_name} must be a finite non-negative number.")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise TrainingError(f"{field_name} must be a finite non-negative number.")
    return parsed


def train_logistic_regression_baseline(
    split: TemporalSplit,
    *,
    schema: Sequence[str] | None = None,
    random_state: int = 42,
    max_iter: int = 1_000,
) -> BaselineTrainingResult:
    """Fit the Phase 10 logistic-regression benchmark on a purged temporal split.

    The pipeline keeps missing values out of feature engineering and handles
    them only inside the training fold with median imputation, followed by
    standard scaling.  Validation labels are never used to fit either step.
    """

    selected_schema, train_labels, validation_labels = _prepared_split(
        split, schema, algorithm_label="Logistic regression",
    )
    max_iter = _positive_int(max_iter, "max_iter")

    try:
        from sklearn.impute import SimpleImputer
        from sklearn.linear_model import LogisticRegression
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError as error:  # pragma: no cover - depends on the optional runtime environment
        raise RuntimeError("scikit-learn is required for baseline model training. Install apps/ml requirements first.") from error

    # keep_empty_features preserves the versioned feature contract when an
    # indicator is absent throughout the training period.
    pipeline = Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median", keep_empty_features=True)),
            ("scaler", StandardScaler()),
            (
                "classifier",
                LogisticRegression(
                    max_iter=max_iter,
                    random_state=random_state,
                    solver="lbfgs",
                ),
            ),
        ]
    )
    return _fitted_result(
        algorithm=LOGISTIC_BASELINE_ALGORITHM,
        pipeline=pipeline,
        split=split,
        selected_schema=selected_schema,
        train_labels=train_labels,
        validation_labels=validation_labels,
        hyperparameters={"maxIter": max_iter, "solver": "lbfgs", "randomState": random_state},
    )


def _boosting_pipeline(classifier: Any) -> Any:
    """Wrap a boosted classifier in the shared three-step artifact contract."""

    try:
        from sklearn.impute import SimpleImputer
        from sklearn.pipeline import Pipeline
        from sklearn.preprocessing import StandardScaler
    except ImportError as error:  # pragma: no cover - depends on the optional runtime environment
        raise RuntimeError("scikit-learn is required to assemble a training pipeline. Install apps/ml requirements first.") from error

    return Pipeline(
        steps=[
            ("imputer", SimpleImputer(strategy="median", keep_empty_features=True)),
            ("scaler", StandardScaler()),
            ("classifier", LabelEncodedClassifier(classifier)),
        ]
    )


def train_xgboost_classifier(
    split: TemporalSplit,
    *,
    schema: Sequence[str] | None = None,
    random_state: int = 42,
    n_estimators: int = 300,
    max_depth: int = 3,
    learning_rate: float = 0.05,
    subsample: float = 0.8,
    colsample_bytree: float = 0.8,
    min_child_weight: float = 5.0,
    reg_lambda: float = 1.0,
) -> BaselineTrainingResult:
    """Fit a deterministic XGBoost forest on the same purged temporal split.

    The defaults are deliberately conservative for a few thousand daily bars:
    shallow trees, a slow learning rate, row and column subsampling, and a
    minimum child weight, because a deep unregularised forest memorises market
    noise and then loses the unseen-data promotion gate to the linear baseline.
    """

    selected_schema, train_labels, validation_labels = _prepared_split(
        split, schema, algorithm_label="XGBoost",
    )
    hyperparameters = {
        "nEstimators": _positive_int(n_estimators, "n_estimators"),
        "maxDepth": _positive_int(max_depth, "max_depth"),
        "learningRate": _positive_float(learning_rate, "learning_rate"),
        "subsample": _fraction(subsample, "subsample"),
        "colsampleByTree": _fraction(colsample_bytree, "colsample_bytree"),
        "minChildWeight": _non_negative_float(min_child_weight, "min_child_weight"),
        "regLambda": _non_negative_float(reg_lambda, "reg_lambda"),
        "randomState": random_state,
    }

    try:
        from xgboost import XGBClassifier
    except ImportError as error:  # pragma: no cover - depends on the optional runtime environment
        raise RuntimeError("xgboost is required for gradient-boosted training. Install apps/ml requirements first.") from error

    # n_jobs=1 and the histogram tree method keep repeated local runs on the same
    # split byte-identical, which the artifact checksum relies on.
    classifier = XGBClassifier(
        n_estimators=hyperparameters["nEstimators"],
        max_depth=hyperparameters["maxDepth"],
        learning_rate=hyperparameters["learningRate"],
        subsample=hyperparameters["subsample"],
        colsample_bytree=hyperparameters["colsampleByTree"],
        min_child_weight=hyperparameters["minChildWeight"],
        reg_lambda=hyperparameters["regLambda"],
        random_state=random_state,
        tree_method="hist",
        n_jobs=1,
        verbosity=0,
    )
    return _fitted_result(
        algorithm=XGBOOST_ALGORITHM,
        pipeline=_boosting_pipeline(classifier),
        split=split,
        selected_schema=selected_schema,
        train_labels=train_labels,
        validation_labels=validation_labels,
        hyperparameters=hyperparameters,
    )


def train_lightgbm_classifier(
    split: TemporalSplit,
    *,
    schema: Sequence[str] | None = None,
    random_state: int = 42,
    n_estimators: int = 300,
    num_leaves: int = 15,
    max_depth: int = 4,
    learning_rate: float = 0.05,
    min_child_samples: int = 20,
    subsample: float = 0.8,
    colsample_bytree: float = 0.8,
    reg_lambda: float = 1.0,
) -> BaselineTrainingResult:
    """Fit a deterministic LightGBM forest on the same purged temporal split.

    ``num_leaves`` is capped well below ``2 ** max_depth`` and
    ``min_child_samples`` stays high, because LightGBM's leaf-wise growth will
    otherwise carve single-observation leaves out of a short market history.
    """

    selected_schema, train_labels, validation_labels = _prepared_split(
        split, schema, algorithm_label="LightGBM",
    )
    hyperparameters = {
        "nEstimators": _positive_int(n_estimators, "n_estimators"),
        "numLeaves": _positive_int(num_leaves, "num_leaves"),
        "maxDepth": _positive_int(max_depth, "max_depth"),
        "learningRate": _positive_float(learning_rate, "learning_rate"),
        "minChildSamples": _positive_int(min_child_samples, "min_child_samples"),
        "subsample": _fraction(subsample, "subsample"),
        "colsampleByTree": _fraction(colsample_bytree, "colsample_bytree"),
        "regLambda": _non_negative_float(reg_lambda, "reg_lambda"),
        "randomState": random_state,
    }
    if hyperparameters["numLeaves"] < 2:
        raise TrainingError("num_leaves must be at least two for a tree to split.")

    try:
        from lightgbm import LGBMClassifier
    except ImportError as error:  # pragma: no cover - depends on the optional runtime environment
        raise RuntimeError("lightgbm is required for gradient-boosted training. Install apps/ml requirements first.") from error

    # deterministic + force_row_wise + a single thread remove LightGBM's
    # thread-order nondeterminism so a rerun reproduces the same artifact.
    classifier = LGBMClassifier(
        n_estimators=hyperparameters["nEstimators"],
        num_leaves=hyperparameters["numLeaves"],
        max_depth=hyperparameters["maxDepth"],
        learning_rate=hyperparameters["learningRate"],
        min_child_samples=hyperparameters["minChildSamples"],
        subsample=hyperparameters["subsample"],
        subsample_freq=1,
        colsample_bytree=hyperparameters["colsampleByTree"],
        reg_lambda=hyperparameters["regLambda"],
        random_state=random_state,
        n_jobs=1,
        deterministic=True,
        force_row_wise=True,
        verbose=-1,
    )
    return _fitted_result(
        algorithm=LIGHTGBM_ALGORITHM,
        pipeline=_boosting_pipeline(classifier),
        split=split,
        selected_schema=selected_schema,
        train_labels=train_labels,
        validation_labels=validation_labels,
        hyperparameters=hyperparameters,
    )


TRAINERS = {
    "logistic": train_logistic_regression_baseline,
    "xgboost": train_xgboost_classifier,
    "lightgbm": train_lightgbm_classifier,
}


def train_model(
    algorithm_choice: str,
    split: TemporalSplit,
    *,
    schema: Sequence[str] | None = None,
    random_state: int = 42,
    hyperparameters: Mapping[str, Any] | None = None,
) -> BaselineTrainingResult:
    """Train one registered algorithm so callers stay free of library imports.

    ``hyperparameters`` are the trainer's own keyword arguments. An unknown key
    fails loudly rather than being silently dropped, so a mistyped CLI flag can
    never produce a model trained with defaults it did not ask for.
    """

    trainer = TRAINERS.get(algorithm_choice)
    if trainer is None:
        raise TrainingError(
            f"Unknown algorithm {algorithm_choice!r}. Choose one of {', '.join(sorted(TRAINERS))}."
        )
    supplied = dict(hyperparameters or {})
    try:
        return trainer(split, schema=schema, random_state=random_state, **supplied)
    except TypeError as error:
        raise TrainingError(f"Invalid hyperparameters for {algorithm_choice}: {error}") from error


def algorithm_identifier(algorithm_choice: str) -> str:
    """Return the persisted algorithm identifier for a CLI algorithm choice."""

    identifier = ALGORITHM_BY_CHOICE.get(algorithm_choice)
    if identifier is None:
        raise TrainingError(
            f"Unknown algorithm {algorithm_choice!r}. Choose one of {', '.join(sorted(ALGORITHM_BY_CHOICE))}."
        )
    return identifier


def training_metadata(result: BaselineTrainingResult) -> dict[str, Any]:
    """Return JSON-compatible metadata to persist alongside a pickle artifact."""

    def metrics_to_mapping(metrics: EvaluationMetrics) -> dict[str, Any]:
        return {
            "accuracy": metrics.accuracy,
            "balancedAccuracy": metrics.balanced_accuracy,
            "macroF1": metrics.macro_f1,
            "directionalPredictions": metrics.directional_predictions,
            "directionalHitRate": metrics.directional_hit_rate,
            "coverage": metrics.coverage,
            "sampleCount": metrics.sample_count,
            "classCounts": dict(metrics.class_counts),
        }

    return {
        "algorithm": result.algorithm,
        "hyperparameters": dict(result.hyperparameters),
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureSchema": list(result.feature_schema),
        "featureDefinition": feature_definition(),
        "trainingRows": result.training_rows,
        "validationRows": result.validation_rows,
        "trainingMetrics": metrics_to_mapping(result.training_metrics),
        "validationMetrics": metrics_to_mapping(result.validation_metrics),
    }


__all__ = [
    "TRAINERS",
    "BaselineTrainingResult",
    "TrainingError",
    "TrainingResult",
    "algorithm_identifier",
    "evaluate_predictions",
    "predict_labels",
    "train_lightgbm_classifier",
    "train_logistic_regression_baseline",
    "train_model",
    "train_xgboost_classifier",
    "training_metadata",
]
