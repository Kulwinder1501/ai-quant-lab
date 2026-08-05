"""Stage 5 TCN acceptance checks beyond raw macro-F1.

``run_sequence_leakage_audit`` (in ``sequence_leakage.py``) answers "is the score
real". This module answers four narrower questions the original Stage 5 plan
also required and the first research runs did not measure:

* **calibration** — are the TCN's class probabilities usable as probabilities,
  not just an argmax (log-loss, Brier, expected calibration error);
* **fold-variability significance** — does TCN's improvement over the lag
  baseline exceed the fold-to-fold noise, not just beat it on average;
* **inference cost** — latency and memory, so a shadow-scoring deployment
  decision is based on a number instead of an assumption;
* **explanation sanity** — do occlusion contributions reflect learned
  structure, verified by collapsing toward a randomly-initialized model of the
  same architecture (see the docstring promise in ``tcn_explain.py``).

Cost/net-utility is deliberately not a fifth check here: the only breakeven
EXPANSION precision on record (44.3% / 43.7%) was measured for daily- and
monthly-tenor NIFTY50/equity straddles, and does not transfer to a different
horizon or instrument. ``cost_relevant_precision_report`` surfaces the number a
future cost study would need without pretending a verdict already exists.
"""

from __future__ import annotations

import math
import statistics
import time
from collections.abc import Mapping, Sequence
from typing import Any

from .contracts import EvaluationMetrics, LabelAlphabet
from .sequences import SequenceExample
from .tcn_explain import temporal_occlusion_contributions
from .tcn_model import build_causal_tcn, require_torch
from .tcn_training import predict_tcn_proba
from .volatility_expansion import VOLATILITY_ALPHABET


class SequenceAcceptanceError(ValueError):
    """Raised when an acceptance check cannot be computed from the supplied inputs."""


def _log_loss(labels: Sequence[str], proba_rows: Sequence[Mapping[str, float]]) -> float:
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


def _expected_calibration_error(
    labels: Sequence[str], proba_rows: Sequence[Mapping[str, float]], *, bins: int = 10,
) -> float:
    """Bucket by the model's top-class confidence; compare to empirical accuracy in each bucket."""

    buckets: list[list[tuple[float, bool]]] = [[] for _ in range(bins)]
    for label, proba in zip(labels, proba_rows):
        predicted = max(proba, key=proba.get)
        confidence = float(proba[predicted])
        index = min(bins - 1, int(confidence * bins))
        buckets[index].append((confidence, predicted == label))
    total = len(labels)
    ece = 0.0
    for bucket in buckets:
        if not bucket:
            continue
        weight = len(bucket) / total
        mean_confidence = statistics.fmean(item[0] for item in bucket)
        accuracy = statistics.fmean(1.0 if item[1] else 0.0 for item in bucket)
        ece += weight * abs(mean_confidence - accuracy)
    return ece


def tcn_calibration_report(
    labels: Sequence[str],
    proba_rows: Sequence[Mapping[str, float]],
    *,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> dict[str, Any]:
    """Log-loss, Brier score and expected calibration error for TCN holdout probabilities."""

    if not labels:
        raise SequenceAcceptanceError("At least one holdout row is required to calibrate.")
    if len(labels) != len(proba_rows):
        raise SequenceAcceptanceError("labels and proba_rows must have matching lengths.")
    return {
        "method": "TCN_CALIBRATION_V1",
        "logLoss": _log_loss(labels, proba_rows),
        "brierScore": _brier(labels, proba_rows, alphabet),
        "expectedCalibrationError": _expected_calibration_error(labels, proba_rows),
        "note": "No temperature/Platt transform applied; raw softmax probabilities used.",
    }


def fold_improvement_significance(
    fold_rows: Sequence[Mapping[str, Any]],
    *,
    candidate_key: str = "tcn",
    baseline_key: str = "lagLightgbm",
    metric: str = "macroF1",
) -> dict[str, Any]:
    """Whether the candidate's mean improvement over the baseline exceeds fold-to-fold noise.

    Beating the baseline's *mean* score says nothing about whether the gap is
    bigger than the spread of the gap itself across folds -- a single lucky
    fold can carry a mean that a fold-by-fold look would not support.
    """

    if not fold_rows:
        raise SequenceAcceptanceError("At least one fold is required.")
    deltas = [
        float(row[candidate_key][metric]) - float(row[baseline_key][metric]) for row in fold_rows
    ]
    mean_delta = statistics.fmean(deltas)
    if len(deltas) < 2:
        return {
            "method": "FOLD_VARIABILITY_V1",
            "folds": len(deltas),
            "meanImprovement": mean_delta,
            "stderrImprovement": None,
            "significant": mean_delta > 0.0,
            "reason": (
                "Only one fold is available, so there is no fold-to-fold spread to test the "
                f"mean improvement of {mean_delta:.4f} against."
            ),
        }
    stdev = statistics.stdev(deltas)
    stderr = stdev / math.sqrt(len(deltas))
    significant = mean_delta > stderr
    return {
        "method": "FOLD_VARIABILITY_V1",
        "folds": len(deltas),
        "perFoldImprovement": deltas,
        "meanImprovement": mean_delta,
        "stdevImprovement": stdev,
        "stderrImprovement": stderr,
        "significant": significant,
        "reason": (
            f"Mean improvement {mean_delta:.4f} exceeds its fold-to-fold standard error {stderr:.4f}."
            if significant
            else (
                f"Mean improvement {mean_delta:.4f} does not exceed its fold-to-fold standard error "
                f"{stderr:.4f}; the gap is not distinguishable from fold-to-fold noise."
            )
        ),
    }


def benchmark_tcn_inference(
    model: Any,
    sample: Sequence[SequenceExample],
    *,
    medians: Sequence[float],
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    warmup: int = 3,
    iterations: int = 20,
) -> dict[str, Any]:
    """Single-batch inference latency and parameter memory footprint."""

    if not sample:
        raise SequenceAcceptanceError("At least one sequence is required to benchmark.")
    if warmup < 0 or iterations < 1:
        raise SequenceAcceptanceError("warmup must be >= 0 and iterations must be >= 1.")

    for _ in range(warmup):
        predict_tcn_proba(model, sample, medians=medians, alphabet=alphabet)

    latencies_ms: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        predict_tcn_proba(model, sample, medians=medians, alphabet=alphabet)
        latencies_ms.append((time.perf_counter() - started) * 1000.0)
    latencies_ms.sort()

    parameter_count = sum(parameter.numel() for parameter in model.parameters())
    parameter_bytes = sum(parameter.numel() * parameter.element_size() for parameter in model.parameters())

    def percentile(sorted_values: Sequence[float], fraction: float) -> float:
        index = min(len(sorted_values) - 1, int(round(fraction * (len(sorted_values) - 1))))
        return sorted_values[index]

    return {
        "method": "TCN_INFERENCE_BENCHMARK_V1",
        "batchSize": len(sample),
        "iterations": iterations,
        "latencyMsMean": statistics.fmean(latencies_ms),
        "latencyMsP50": percentile(latencies_ms, 0.5),
        "latencyMsP95": percentile(latencies_ms, 0.95),
        "parameterCount": int(parameter_count),
        "parameterBytes": int(parameter_bytes),
    }


def explanation_sanity_check(
    trained_model: Any,
    sequence: SequenceExample,
    *,
    medians: Sequence[float],
    alphabet: LabelAlphabet,
    n_features: int,
    channels: int,
    kernel_size: int = 3,
    dilations: tuple[int, ...] = (1, 2, 4, 8),
    dropout: float = 0.1,
    random_state: int = 42,
    window: int = 4,
    minimum_ratio: float = 1.5,
) -> dict[str, Any]:
    """Confirm occlusion contributions collapse toward a randomly-initialized model.

    ``tcn_explain.temporal_occlusion_contributions`` documents this as the
    sanity check its blocks depend on; this is that check, made runnable and
    given a pass/fail threshold instead of only being assumed.
    """

    torch = require_torch()
    trained_explanation = temporal_occlusion_contributions(
        trained_model, sequence, medians=medians, alphabet=alphabet, window=window,
    )
    torch.manual_seed(random_state)
    random_model = build_causal_tcn(
        n_features=n_features,
        n_classes=len(alphabet.labels),
        channels=channels,
        kernel_size=kernel_size,
        dilations=dilations,
        dropout=dropout,
    )
    random_model.eval()
    random_explanation = temporal_occlusion_contributions(
        random_model, sequence, medians=medians, alphabet=alphabet, window=window,
    )

    trained_impact = sum(abs(float(block["logitDrop"])) for block in trained_explanation["blocks"])
    random_impact = sum(abs(float(block["logitDrop"])) for block in random_explanation["blocks"])
    if random_impact <= 1e-9:
        ratio = float("inf") if trained_impact > 1e-9 else 1.0
    else:
        ratio = trained_impact / random_impact
    passes = ratio >= minimum_ratio

    return {
        "method": "EXPLANATION_RANDOMIZED_WEIGHTS_SANITY_V1",
        "trainedTotalAbsLogitDrop": trained_impact,
        "randomTotalAbsLogitDrop": random_impact,
        "ratio": ratio,
        "minimumRatio": minimum_ratio,
        "passes": passes,
        "reason": (
            f"The trained model's total occlusion impact ({trained_impact:.4f}) is "
            f"{ratio:.2f}x a randomly-initialized model of the same architecture "
            f"({random_impact:.4f}), clearing the {minimum_ratio:.2f}x floor."
            if passes
            else (
                f"The trained model's total occlusion impact ({trained_impact:.4f}) is only "
                f"{ratio:.2f}x a randomly-initialized model of the same architecture "
                f"({random_impact:.4f}), below the {minimum_ratio:.2f}x floor. The explanation may "
                "reflect architecture, not learned structure."
            )
        ),
    }


def cost_relevant_precision_report(
    validation_metrics: EvaluationMetrics,
    *,
    expansion_label: str = "EXPANSION",
) -> dict[str, Any]:
    """Surface the EXPANSION-class precision a trading decision would act on.

    Deliberately does not compare it to the 44.3%/43.7% breakevens measured
    for daily/monthly-tenor NIFTY50 and equity straddles -- those numbers do
    not describe this horizon's or instrument's cost structure, and treating
    them as if they did would be a fabricated verdict, not a measured one.
    """

    per_class = validation_metrics.per_class or {}
    expansion = per_class.get(expansion_label)
    return {
        "method": "COST_RELEVANT_PRECISION_V1",
        "expansionPrecision": None if expansion is None else expansion.precision,
        "expansionPredictedCount": None if expansion is None else expansion.predicted_count,
        "expansionActualCount": None if expansion is None else expansion.actual_count,
        "verifiedBreakeven": None,
        "note": (
            "No verified options-cost breakeven exists for this horizon/instrument. The 44.3%/43.7% "
            "EXPANSION breakevens on record were measured for daily/monthly-tenor NIFTY50 and equity "
            "straddles and do not transfer to a different horizon or instrument -- a dedicated cost "
            "study is required before this precision can be read as a trading verdict."
        ),
    }


__all__ = [
    "SequenceAcceptanceError",
    "benchmark_tcn_inference",
    "cost_relevant_precision_report",
    "explanation_sanity_check",
    "fold_improvement_significance",
    "tcn_calibration_report",
]
