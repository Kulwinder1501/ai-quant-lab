"""Leakage-safe OOF stacking for Stage 6 (TCN + lag LightGBM).

Workstream G: base families must already clear their research gates, emit
probabilities on common outer-fold rows, and show residual diversity. The
meta-learner sees only base probabilities plus compact uncertainty / disagreement
features — never the raw market feature vector.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .contracts import (
    LIGHTGBM_ALGORITHM,
    AnyLabel,
    EvaluationMetrics,
    LabelAlphabet,
)
from .sequences import SequenceExample, SequenceSplit, flatten_lag_features
from .tcn_model import TCN_ALGORITHM
from .tcn_training import (
    predict_tcn_labels,
    predict_tcn_proba,
    train_lag_lightgbm_baseline,
    train_tcn_classifier,
)
from .training import TrainingError, evaluate_predictions
from .volatility_expansion import VOLATILITY_ALPHABET


def _lag_feature_matrix(sequences: Sequence[SequenceExample], schema: Sequence[str]) -> list[list[float]]:
    matrix: list[list[float]] = []
    for sequence in sequences:
        features = flatten_lag_features(sequence)
        row: list[float] = []
        for name in schema:
            value = features.get(name, float("nan"))
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                numeric = float("nan")
            row.append(numeric if math.isfinite(numeric) else float("nan"))
        matrix.append(row)
    return matrix

STACK_ALGORITHM = "oof-logistic-stack-v1"
STACK_CONTRIBUTION_METHOD = "STACK_META_COEFFICIENT_V1"
NESTED_VALIDATION_METHOD = "NESTED_SEQUENCE_OOF_STACK_V1"

BASE_TCN = "tcn"
BASE_LAG_LGBM = "lagLightgbm"


@dataclass(frozen=True)
class OofRow:
    candle_id: str
    fold: int
    label: AnyLabel
    observed_at: Any
    tcn_proba: Mapping[str, float]
    lag_lgbm_proba: Mapping[str, float]
    tcn_pred: AnyLabel
    lag_lgbm_pred: AnyLabel


@dataclass(frozen=True)
class BaseFoldFit:
    fold: int
    tcn_model: Any
    tcn_medians: tuple[float, ...]
    tcn_parameter_count: int
    lag_lgbm_model: Any
    lag_lgbm_schema: tuple[str, ...]
    tcn_metrics: EvaluationMetrics
    lag_lgbm_metrics: EvaluationMetrics
    purge_count: int
    training_rows: int
    validation_rows: int


@dataclass(frozen=True)
class DiversityReport:
    disagreement_rate: float
    error_correlation: float
    both_correct_rate: float
    both_wrong_rate: float
    passes: bool
    reason: str


@dataclass(frozen=True)
class StackTrainingResult:
    algorithm: str
    model: Any
    meta_feature_names: tuple[str, ...]
    labels: tuple[str, ...]
    training_metrics: EvaluationMetrics
    holdout_metrics: EvaluationMetrics
    best_base_holdout_metrics: EvaluationMetrics
    best_base_name: str
    holdout_fold: int
    calibration: Mapping[str, Any]
    diversity: DiversityReport
    hyperparameters: Mapping[str, Any]
    beats_best_base: bool
    beats_trivial: bool
    advances: bool


def _entropy(proba: Mapping[str, float]) -> float:
    total = 0.0
    for value in proba.values():
        if value > 0.0:
            total -= float(value) * math.log(float(value))
    return total


def _argmax_label(proba: Mapping[str, float], alphabet: LabelAlphabet) -> AnyLabel:
    return max(alphabet.labels, key=lambda label: float(proba.get(label, 0.0)))


def _probability_vector(proba: Mapping[str, float], alphabet: LabelAlphabet) -> list[float]:
    return [float(proba.get(label, 0.0)) for label in alphabet.labels]


def _expand_pipeline_proba(
    pipeline: Any,
    matrix: Sequence[Sequence[float]],
    alphabet: LabelAlphabet,
) -> list[dict[str, float]]:
    raw = pipeline.predict_proba(matrix)
    classifier = pipeline.named_steps["classifier"]
    classes = tuple(classifier.classes_)
    rows: list[dict[str, float]] = []
    for values in raw:
        mapped = {label: 0.0 for label in alphabet.labels}
        for index, label in enumerate(classes):
            mapped[str(label)] = float(values[index])
        rows.append(mapped)
    return rows


def predict_lag_lightgbm_proba(
    model: Any,
    sequences: Sequence[SequenceExample],
    *,
    schema: Sequence[str],
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> list[dict[str, float]]:
    if not sequences:
        return []
    matrix = _lag_feature_matrix(sequences, schema)
    return _expand_pipeline_proba(model, matrix, alphabet)


def meta_feature_names(alphabet: LabelAlphabet) -> tuple[str, ...]:
    names: list[str] = []
    for base in (BASE_TCN, BASE_LAG_LGBM):
        for label in alphabet.labels:
            names.append(f"{base}.p.{label}")
        names.append(f"{base}.entropy")
    names.append("disagreement.l1")
    names.append("disagreement.pred")
    return tuple(names)


def build_meta_features(
    tcn_proba: Mapping[str, float],
    lag_proba: Mapping[str, float],
    *,
    alphabet: LabelAlphabet,
) -> list[float]:
    tcn_vec = _probability_vector(tcn_proba, alphabet)
    lag_vec = _probability_vector(lag_proba, alphabet)
    disagreement_l1 = sum(abs(a - b) for a, b in zip(tcn_vec, lag_vec)) / 2.0
    disagreement_pred = (
        1.0
        if _argmax_label(tcn_proba, alphabet) != _argmax_label(lag_proba, alphabet)
        else 0.0
    )
    return [
        *tcn_vec,
        _entropy(tcn_proba),
        *lag_vec,
        _entropy(lag_proba),
        disagreement_l1,
        disagreement_pred,
    ]


def measure_error_diversity(
    rows: Sequence[OofRow],
    *,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    max_error_correlation: float = 0.85,
    min_disagreement_rate: float = 0.05,
) -> DiversityReport:
    if not rows:
        raise TrainingError("Cannot measure diversity on an empty OOF set.")
    tcn_err = [0.0 if row.tcn_pred == row.label else 1.0 for row in rows]
    lag_err = [0.0 if row.lag_lgbm_pred == row.label else 1.0 for row in rows]
    disagree = [
        1.0 if row.tcn_pred != row.lag_lgbm_pred else 0.0
        for row in rows
    ]
    both_correct = sum(
        1 for row in rows if row.tcn_pred == row.label and row.lag_lgbm_pred == row.label
    ) / len(rows)
    both_wrong = sum(
        1 for row in rows if row.tcn_pred != row.label and row.lag_lgbm_pred != row.label
    ) / len(rows)
    disagreement_rate = sum(disagree) / len(rows)

    mean_t = sum(tcn_err) / len(tcn_err)
    mean_l = sum(lag_err) / len(lag_err)
    cov = sum((a - mean_t) * (b - mean_l) for a, b in zip(tcn_err, lag_err)) / len(rows)
    var_t = sum((a - mean_t) ** 2 for a in tcn_err) / len(rows)
    var_l = sum((b - mean_l) ** 2 for b in lag_err) / len(rows)
    if var_t <= 0.0 or var_l <= 0.0:
        corr = 1.0
    else:
        corr = cov / math.sqrt(var_t * var_l)

    passes = disagreement_rate >= min_disagreement_rate and corr <= max_error_correlation
    if passes:
        reason = (
            f"Bases disagree on {disagreement_rate:.1%} of rows with error correlation "
            f"{corr:.3f} (thresholds: disagreement>={min_disagreement_rate:.0%}, "
            f"corr<={max_error_correlation:.2f})."
        )
    else:
        reason = (
            f"Insufficient residual diversity: disagreement={disagreement_rate:.1%}, "
            f"error_correlation={corr:.3f}."
        )
    return DiversityReport(
        disagreement_rate=float(disagreement_rate),
        error_correlation=float(corr),
        both_correct_rate=float(both_correct),
        both_wrong_rate=float(both_wrong),
        passes=passes,
        reason=reason,
    )


def fit_bases_on_split(
    split: SequenceSplit,
    *,
    fold: int,
    lookback: int,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    channels: int = 16,
    epochs: int = 25,
    batch_size: int = 256,
    random_state: int = 42,
) -> BaseFoldFit:
    tcn = train_tcn_classifier(
        split,
        alphabet=alphabet,
        lookback=lookback,
        channels=channels,
        epochs=epochs,
        batch_size=batch_size,
        random_state=random_state,
    )
    lag = train_lag_lightgbm_baseline(split, alphabet=alphabet, random_state=random_state)
    return BaseFoldFit(
        fold=fold,
        tcn_model=tcn.model,
        tcn_medians=tuple(float(v) for v in tcn.hyperparameters["featureMedians"]),
        tcn_parameter_count=tcn.parameter_count,
        lag_lgbm_model=lag.model,
        lag_lgbm_schema=tuple(lag.feature_schema),
        tcn_metrics=tcn.validation_metrics,
        lag_lgbm_metrics=lag.validation_metrics,
        purge_count=split.purge_count,
        training_rows=len(split.train),
        validation_rows=len(split.validation),
    )


def collect_oof_rows(
    fit: BaseFoldFit,
    split: SequenceSplit,
    *,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> list[OofRow]:
    tcn_proba = predict_tcn_proba(
        fit.tcn_model, split.validation, medians=fit.tcn_medians, alphabet=alphabet,
    )
    lag_proba = predict_lag_lightgbm_proba(
        fit.lag_lgbm_model,
        split.validation,
        schema=fit.lag_lgbm_schema,
        alphabet=alphabet,
    )
    tcn_pred = predict_tcn_labels(
        fit.tcn_model, split.validation, medians=fit.tcn_medians, alphabet=alphabet,
    )
    rows: list[OofRow] = []
    for index, sequence in enumerate(split.validation):
        rows.append(
            OofRow(
                candle_id=sequence.candle_id,
                fold=fit.fold,
                label=sequence.label,
                observed_at=sequence.observed_at,
                tcn_proba=tcn_proba[index],
                lag_lgbm_proba=lag_proba[index],
                tcn_pred=tcn_pred[index],
                lag_lgbm_pred=_argmax_label(lag_proba[index], alphabet),
            )
        )
    return rows


def _rows_to_xy(
    rows: Sequence[OofRow],
    *,
    alphabet: LabelAlphabet,
) -> tuple[list[list[float]], list[str]]:
    x = [
        build_meta_features(row.tcn_proba, row.lag_lgbm_proba, alphabet=alphabet)
        for row in rows
    ]
    y = [str(row.label) for row in rows]
    return x, y


def train_meta_learner(
    train_rows: Sequence[OofRow],
    holdout_rows: Sequence[OofRow],
    *,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    c: float = 1.0,
    random_state: int = 42,
) -> tuple[Any, EvaluationMetrics, list[AnyLabel], list[dict[str, float]]]:
    if not train_rows or not holdout_rows:
        raise TrainingError("Meta-learner requires non-empty train and holdout OOF rows.")
    try:
        from sklearn.linear_model import LogisticRegression
    except ImportError as error:  # pragma: no cover
        raise RuntimeError("scikit-learn is required for stacking.") from error

    x_train, y_train = _rows_to_xy(train_rows, alphabet=alphabet)
    x_hold, y_hold = _rows_to_xy(holdout_rows, alphabet=alphabet)
    model = LogisticRegression(
        solver="lbfgs",
        C=c,
        max_iter=1000,
        random_state=random_state,
    )
    model.fit(x_train, y_train)
    pred = list(model.predict(x_hold))
    proba_raw = model.predict_proba(x_hold)
    classes = list(model.classes_)
    proba_rows: list[dict[str, float]] = []
    for values in proba_raw:
        mapped = {label: 0.0 for label in alphabet.labels}
        for index, label in enumerate(classes):
            mapped[str(label)] = float(values[index])
        proba_rows.append(mapped)
    metrics = evaluate_predictions(y_hold, pred, alphabet=alphabet)
    return model, metrics, pred, proba_rows


def _log_loss(labels: Sequence[str], proba_rows: Sequence[Mapping[str, float]], alphabet: LabelAlphabet) -> float:
    total = 0.0
    eps = 1e-12
    for label, proba in zip(labels, proba_rows):
        total -= math.log(max(eps, float(proba.get(label, 0.0))))
    return total / len(labels)


def _brier(labels: Sequence[str], proba_rows: Sequence[Mapping[str, float]], alphabet: LabelAlphabet) -> float:
    total = 0.0
    for label, proba in zip(labels, proba_rows):
        for class_label in alphabet.labels:
            target = 1.0 if class_label == label else 0.0
            total += (float(proba.get(class_label, 0.0)) - target) ** 2
    return total / (len(labels) * len(alphabet.labels))


def calibration_report(
    rows: Sequence[OofRow],
    stack_proba: Sequence[Mapping[str, float]],
    *,
    alphabet: LabelAlphabet,
) -> dict[str, Any]:
    labels = [str(row.label) for row in rows]
    tcn_proba = [row.tcn_proba for row in rows]
    lag_proba = [row.lag_lgbm_proba for row in rows]
    return {
        "holdoutLogLoss": {
            "stack": _log_loss(labels, stack_proba, alphabet),
            "tcn": _log_loss(labels, tcn_proba, alphabet),
            "lagLightgbm": _log_loss(labels, lag_proba, alphabet),
        },
        "holdoutBrier": {
            "stack": _brier(labels, stack_proba, alphabet),
            "tcn": _brier(labels, tcn_proba, alphabet),
            "lagLightgbm": _brier(labels, lag_proba, alphabet),
        },
        "calibrationTransforms": None,
        "note": "No temperature/Platt transform applied in v1; raw multinomial probabilities used.",
    }


def evaluate_base_on_rows(
    rows: Sequence[OofRow],
    *,
    which: str,
    alphabet: LabelAlphabet,
) -> EvaluationMetrics:
    actual = [row.label for row in rows]
    if which == BASE_TCN:
        predicted = [row.tcn_pred for row in rows]
    elif which == BASE_LAG_LGBM:
        predicted = [row.lag_lgbm_pred for row in rows]
    else:
        raise TrainingError(f"Unknown base {which!r}.")
    return evaluate_predictions(actual, predicted, alphabet=alphabet)


def train_oof_stack(
    splits: Sequence[SequenceSplit],
    *,
    lookback: int,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    channels: int = 16,
    epochs: int = 25,
    batch_size: int = 256,
    random_state: int = 42,
    meta_c: float = 1.0,
    progress: Any = None,
) -> tuple[StackTrainingResult, list[BaseFoldFit], list[OofRow]]:
    """Fit bases per outer fold, train meta on earlier OOF, evaluate on last fold."""

    if len(splits) < 2:
        raise TrainingError("Stacking requires at least two outer folds (train OOF + holdout).")

    fits: list[BaseFoldFit] = []
    oof_rows: list[OofRow] = []
    for index, split in enumerate(splits, start=1):
        if progress is not None:
            progress(f"Outer fold {index}/{len(splits)}: fitting TCN + lag LightGBM")
        fit = fit_bases_on_split(
            split,
            fold=index,
            lookback=lookback,
            alphabet=alphabet,
            channels=channels,
            epochs=epochs,
            batch_size=batch_size,
            random_state=random_state,
        )
        fits.append(fit)
        oof_rows.extend(collect_oof_rows(fit, split, alphabet=alphabet))

    diversity = measure_error_diversity(oof_rows, alphabet=alphabet)
    holdout_fold = len(splits)
    train_rows = [row for row in oof_rows if row.fold < holdout_fold]
    holdout_rows = [row for row in oof_rows if row.fold == holdout_fold]
    if not train_rows or not holdout_rows:
        raise TrainingError("Failed to partition OOF rows into train/holdout folds.")

    model, holdout_metrics, _, stack_proba = train_meta_learner(
        train_rows,
        holdout_rows,
        alphabet=alphabet,
        c=meta_c,
        random_state=random_state,
    )
    train_pred = list(model.predict(_rows_to_xy(train_rows, alphabet=alphabet)[0]))
    training_metrics = evaluate_predictions(
        [row.label for row in train_rows], train_pred, alphabet=alphabet,
    )

    tcn_hold = evaluate_base_on_rows(holdout_rows, which=BASE_TCN, alphabet=alphabet)
    lag_hold = evaluate_base_on_rows(holdout_rows, which=BASE_LAG_LGBM, alphabet=alphabet)
    if tcn_hold.macro_f1 >= lag_hold.macro_f1:
        best_name, best_metrics = BASE_TCN, tcn_hold
    else:
        best_name, best_metrics = BASE_LAG_LGBM, lag_hold

    from collections import Counter

    counts = Counter(str(row.label) for row in holdout_rows)
    majority = counts.most_common(1)[0][0]
    trivial = evaluate_predictions(
        [row.label for row in holdout_rows],
        [majority] * len(holdout_rows),
        alphabet=alphabet,
    )

    calib = calibration_report(holdout_rows, stack_proba, alphabet=alphabet)
    beats_best = holdout_metrics.macro_f1 > best_metrics.macro_f1
    beats_trivial = holdout_metrics.macro_f1 > trivial.macro_f1
    # Stage 6: must beat best base; calibration should not worsen vs best base log-loss.
    best_logloss = calib["holdoutLogLoss"][best_name if best_name != BASE_LAG_LGBM else "lagLightgbm"]
    if best_name == BASE_TCN:
        best_logloss = calib["holdoutLogLoss"]["tcn"]
    else:
        best_logloss = calib["holdoutLogLoss"]["lagLightgbm"]
    calib_ok = calib["holdoutLogLoss"]["stack"] <= best_logloss + 1e-9
    accuracy_floor = holdout_metrics.accuracy >= trivial.accuracy - 1e-12
    advances = (
        diversity.passes
        and beats_best
        and beats_trivial
        and accuracy_floor
        and calib_ok
    )

    result = StackTrainingResult(
        algorithm=STACK_ALGORITHM,
        model=model,
        meta_feature_names=meta_feature_names(alphabet),
        labels=tuple(alphabet.labels),
        training_metrics=training_metrics,
        holdout_metrics=holdout_metrics,
        best_base_holdout_metrics=best_metrics,
        best_base_name=best_name,
        holdout_fold=holdout_fold,
        calibration=calib,
        diversity=diversity,
        hyperparameters={
            "metaC": meta_c,
            "metaPenalty": "l2",
            "metaSolver": "lbfgs",
            "randomState": random_state,
            "lookback": lookback,
            "channels": channels,
            "epochs": epochs,
            "batchSize": batch_size,
            "baseAlgorithms": [TCN_ALGORITHM, LIGHTGBM_ALGORITHM],
            "trivialHoldoutMacroF1": trivial.macro_f1,
            "trivialHoldoutAccuracy": trivial.accuracy,
            "holdoutTcnMacroF1": tcn_hold.macro_f1,
            "holdoutLagLightgbmMacroF1": lag_hold.macro_f1,
        },
        beats_best_base=beats_best,
        beats_trivial=beats_trivial,
        advances=advances,
    )
    return result, fits, oof_rows


def meta_coefficients(model: Any, feature_names: Sequence[str], labels: Sequence[str]) -> dict[str, Any]:
    """Serialize multinomial logistic coefficients for the stack artifact."""

    classes = [str(c) for c in model.classes_]
    coef = model.coef_
    intercept = model.intercept_
    per_class: dict[str, Any] = {}
    for class_index, class_label in enumerate(classes):
        weights = {
            str(name): float(coef[class_index][feature_index])
            for feature_index, name in enumerate(feature_names)
        }
        per_class[class_label] = {
            "intercept": float(intercept[class_index]),
            "weights": weights,
        }
    return {
        "probabilityClassOrder": classes,
        "classes": per_class,
        "contributionMethod": STACK_CONTRIBUTION_METHOD,
        "note": "Coefficients act on base-probability meta-features, not raw market features.",
    }


__all__ = [
    "BASE_LAG_LGBM",
    "BASE_TCN",
    "BaseFoldFit",
    "DiversityReport",
    "NESTED_VALIDATION_METHOD",
    "OofRow",
    "STACK_ALGORITHM",
    "STACK_CONTRIBUTION_METHOD",
    "StackTrainingResult",
    "build_meta_features",
    "calibration_report",
    "collect_oof_rows",
    "fit_bases_on_split",
    "measure_error_diversity",
    "meta_coefficients",
    "meta_feature_names",
    "predict_lag_lightgbm_proba",
    "train_meta_learner",
    "train_oof_stack",
]
