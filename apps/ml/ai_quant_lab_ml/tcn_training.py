"""Training and evaluation helpers for the compact causal TCN."""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .contracts import AnyLabel, EvaluationMetrics, LabelAlphabet, LabeledExample, TemporalSplit
from .sequences import SequenceExample, SequenceSplit, flatten_lag_features, lag_feature_schema
from .tcn_model import TCN_ALGORITHM, build_causal_tcn, require_torch
from .training import TrainingError, evaluate_predictions, train_lightgbm_classifier
from .volatility_expansion import VOLATILITY_ALPHABET


@dataclass(frozen=True)
class TcnTrainingResult:
    algorithm: str
    model: Any
    feature_names: tuple[str, ...]
    lookback: int
    labels: tuple[str, ...]
    training_metrics: EvaluationMetrics
    validation_metrics: EvaluationMetrics
    training_rows: int
    validation_rows: int
    hyperparameters: Mapping[str, Any]
    parameter_count: int


def _impute_matrix(matrix: Sequence[Sequence[float]], medians: Sequence[float]) -> list[list[float]]:
    rows: list[list[float]] = []
    for row in matrix:
        rows.append([
            medians[index] if not math.isfinite(value) else float(value)
            for index, value in enumerate(row)
        ])
    return rows


def _feature_medians(sequences: Sequence[SequenceExample], width: int) -> list[float]:
    columns: list[list[float]] = [[] for _ in range(width)]
    for sequence in sequences:
        for row in sequence.features:
            for index, value in enumerate(row):
                if math.isfinite(value):
                    columns[index].append(float(value))
    medians: list[float] = []
    for values in columns:
        if not values:
            medians.append(0.0)
            continue
        ordered = sorted(values)
        mid = len(ordered) // 2
        if len(ordered) % 2:
            medians.append(ordered[mid])
        else:
            medians.append(0.5 * (ordered[mid - 1] + ordered[mid]))
    return medians


def _encode_labels(labels: Sequence[AnyLabel], alphabet: LabelAlphabet) -> list[int]:
    index = {label: i for i, label in enumerate(alphabet.labels)}
    return [index[str(label)] for label in labels]


def _tensor_batch(
    sequences: Sequence[SequenceExample],
    medians: Sequence[float],
    alphabet: LabelAlphabet,
) -> tuple[Any, Any]:
    torch = require_torch()
    features = [
        _impute_matrix(sequence.features, medians)
        for sequence in sequences
    ]
    labels = _encode_labels([sequence.label for sequence in sequences], alphabet)
    return (
        torch.tensor(features, dtype=torch.float32),
        torch.tensor(labels, dtype=torch.long),
    )


def train_tcn_classifier(
    split: SequenceSplit,
    *,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    lookback: int,
    channels: int = 16,
    kernel_size: int = 3,
    dilations: tuple[int, ...] = (1, 2, 4, 8),
    dropout: float = 0.1,
    learning_rate: float = 1e-3,
    weight_decay: float = 1e-4,
    epochs: int = 40,
    batch_size: int = 256,
    patience: int = 6,
    grad_clip: float = 1.0,
    random_state: int = 42,
) -> TcnTrainingResult:
    """Fit a compact causal TCN on one purged sequence split."""

    if not split.train or not split.validation:
        raise TrainingError("TCN training requires non-empty train and validation sequence partitions.")
    feature_names = split.train[0].feature_names
    if any(seq.lookback != lookback for seq in (*split.train, *split.validation)):
        raise TrainingError("Every sequence must share the training lookback.")
    if any(seq.feature_names != feature_names for seq in (*split.train, *split.validation)):
        raise TrainingError("Every sequence must share the feature schema.")

    torch = require_torch()
    random.seed(random_state)
    torch.manual_seed(random_state)

    medians = _feature_medians(split.train, len(feature_names))
    model = build_causal_tcn(
        n_features=len(feature_names),
        n_classes=len(alphabet.labels),
        channels=channels,
        kernel_size=kernel_size,
        dilations=dilations,
        dropout=dropout,
    )
    optimizer = torch.optim.AdamW(model.parameters(), lr=learning_rate, weight_decay=weight_decay)
    loss_fn = torch.nn.CrossEntropyLoss()

    x_train, y_train = _tensor_batch(split.train, medians, alphabet)
    x_val, y_val = _tensor_batch(split.validation, medians, alphabet)

    best_state = None
    best_val_loss = float("inf")
    stalled = 0
    model.train()
    n = x_train.shape[0]
    for _epoch in range(epochs):
        permutation = torch.randperm(n)
        epoch_loss = 0.0
        batches = 0
        for start in range(0, n, batch_size):
            index = permutation[start : start + batch_size]
            logits = model(x_train[index])
            loss = loss_fn(logits, y_train[index])
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
            optimizer.step()
            epoch_loss += float(loss.item())
            batches += 1
        model.eval()
        with torch.no_grad():
            val_loss = float(loss_fn(model(x_val), y_val).item())
        model.train()
        if val_loss + 1e-6 < best_val_loss:
            best_val_loss = val_loss
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            stalled = 0
        else:
            stalled += 1
            if stalled >= patience:
                break

    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()

    train_pred = predict_tcn_labels(model, split.train, medians=medians, alphabet=alphabet)
    val_pred = predict_tcn_labels(model, split.validation, medians=medians, alphabet=alphabet)
    hyperparameters = {
        "lookback": lookback,
        "channels": channels,
        "kernelSize": kernel_size,
        "dilations": list(dilations),
        "dropout": dropout,
        "learningRate": learning_rate,
        "weightDecay": weight_decay,
        "epochs": epochs,
        "batchSize": batch_size,
        "patience": patience,
        "gradClip": grad_clip,
        "randomState": random_state,
        "imputer": "train-fold-median",
        "featureMedians": medians,
    }
    return TcnTrainingResult(
        algorithm=TCN_ALGORITHM,
        model=model,
        feature_names=feature_names,
        lookback=lookback,
        labels=tuple(alphabet.labels),
        training_metrics=evaluate_predictions(
            [s.label for s in split.train], train_pred, alphabet=alphabet,
        ),
        validation_metrics=evaluate_predictions(
            [s.label for s in split.validation], val_pred, alphabet=alphabet,
        ),
        training_rows=len(split.train),
        validation_rows=len(split.validation),
        hyperparameters=hyperparameters,
        parameter_count=int(model.parameter_count()),
    )


def predict_tcn_labels(
    model: Any,
    sequences: Sequence[SequenceExample],
    *,
    medians: Sequence[float],
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> list[AnyLabel]:
    torch = require_torch()
    if not sequences:
        return []
    model.eval()
    x, _ = _tensor_batch(sequences, medians, alphabet)
    with torch.no_grad():
        logits = model(x)
        indices = logits.argmax(dim=1).tolist()
    return [alphabet.labels[int(index)] for index in indices]


def predict_tcn_proba(
    model: Any,
    sequences: Sequence[SequenceExample],
    *,
    medians: Sequence[float],
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> list[dict[str, float]]:
    torch = require_torch()
    if not sequences:
        return []
    model.eval()
    x, _ = _tensor_batch(sequences, medians, alphabet)
    with torch.no_grad():
        probs = torch.softmax(model(x), dim=1).tolist()
    rows: list[dict[str, float]] = []
    for row in probs:
        rows.append({label: float(value) for label, value in zip(alphabet.labels, row)})
    return rows


def train_lag_lightgbm_baseline(
    split: SequenceSplit,
    *,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    random_state: int = 42,
) -> Any:
    """Strongest tabular baseline Stage 5 requires: LightGBM on flattened lags."""

    if not split.train:
        raise TrainingError("Lag baseline requires a non-empty training partition.")
    lookback = split.train[0].lookback
    schema = lag_feature_schema(split.train[0].feature_names, lookback)

    def to_labeled(sequences: Sequence[SequenceExample]) -> tuple[LabeledExample, ...]:
        rows: list[LabeledExample] = []
        for sequence in sequences:
            rows.append(
                LabeledExample(
                    candle_id=sequence.candle_id,
                    instrument_id=sequence.instrument_id,
                    symbol=sequence.symbol,
                    timeframe=sequence.timeframe,
                    observed_at=sequence.observed_at,
                    label_available_at=sequence.label_available_at,
                    forward_return=0.0,
                    label=sequence.label,
                    features=flatten_lag_features(sequence),
                )
            )
        return tuple(rows)

    temporal = TemporalSplit(
        train=to_labeled(split.train),
        validation=to_labeled(split.validation),
        purge_count=split.purge_count,
    )
    return train_lightgbm_classifier(
        temporal,
        schema=schema,
        random_state=random_state,
        alphabet=alphabet,
        n_estimators=200,
        num_leaves=15,
        max_depth=4,
        learning_rate=0.05,
        min_child_samples=40,
    )


__all__ = [
    "TcnTrainingResult",
    "predict_tcn_labels",
    "predict_tcn_proba",
    "train_lag_lightgbm_baseline",
    "train_tcn_classifier",
]
