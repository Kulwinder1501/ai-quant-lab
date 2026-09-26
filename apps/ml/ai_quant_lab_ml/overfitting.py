"""Multiple-testing correction for a registry of independently trained models.

Running many experiments against the same market and keeping the best one is
exactly the setup the deflated-Sharpe-ratio / probability-of-backtest-
overfitting literature warns about (Bailey & Lopez de Prado). Their formulas
are built for Sharpe ratios on return series; this module adapts the same
idea to the macro-F1 classification score this project's own promotion gate
actually reports, so the registry can be judged the same way.

For one trial, ``no_skill_macro_f1_p_value`` asks: if a classifier carried no
real information at all -- if its predicted label were independent of the
true one, both drawn from the same observed class frequencies -- how often
would it score at least as well as the trial actually did, on a validation
set of exactly this size and class balance? That is a single-trial p-value,
calibrated to the trial's own data rather than an idealized uniform baseline.

``sidak_adjusted_p_value`` then answers the question that matters once a
result was chosen as "the best of everything tried" rather than judged on its
own: given N independent attempts, how likely is it that *at least one* would
look this good by chance alone?
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np


class OverfittingCheckError(ValueError):
    """Raised when a trial's stored evidence cannot support this analysis."""


def _validated_class_counts(class_counts: Mapping[str, int]) -> tuple[str, ...]:
    labels = tuple(class_counts)
    if len(labels) < 2:
        raise OverfittingCheckError("At least two classes are required to simulate a null distribution.")
    if any(isinstance(count, bool) or not isinstance(count, int) or count < 0 for count in class_counts.values()):
        raise OverfittingCheckError("classCounts values must be non-negative integers.")
    if sum(class_counts.values()) <= 0:
        raise OverfittingCheckError("classCounts must contain at least one observation.")
    return labels


def _macro_f1_batch(actual: np.ndarray, predicted: np.ndarray, num_classes: int) -> np.ndarray:
    """Macro-F1 for each row of a ``(trials, n)`` batch of simulated label pairs.

    Matches scikit-learn's ``f1_score(average="macro", zero_division=0)``: a
    class that never appears as either the true or the predicted label in a
    row contributes 0 to that row's average rather than an undefined value.
    """

    f1_sum = np.zeros(actual.shape[0], dtype=np.float64)
    for class_index in range(num_classes):
        is_actual = actual == class_index
        is_predicted = predicted == class_index
        true_positive = (is_actual & is_predicted).sum(axis=1)
        false_positive = (~is_actual & is_predicted).sum(axis=1)
        false_negative = (is_actual & ~is_predicted).sum(axis=1)
        denominator = 2 * true_positive + false_positive + false_negative
        f1 = np.divide(
            2 * true_positive,
            denominator,
            out=np.zeros_like(denominator, dtype=np.float64),
            where=denominator > 0,
        )
        f1_sum += f1
    return f1_sum / num_classes


def no_skill_macro_f1_p_value(
    *,
    class_counts: Mapping[str, int],
    observed_macro_f1: float,
    trials: int = 2000,
    random_state: int = 42,
) -> float:
    """P(a classifier with no real information scores >= observed on this exact validation set).

    The null model draws both the "true" and "predicted" label independently
    from the same marginal frequencies actually observed -- the best an
    uninformed classifier could do is match the class balance it is scored
    against. Calibrating to the trial's own sample size and class counts,
    rather than a generic 1-over-k baseline, is what makes the comparison fair
    between a lopsided validation slice and a balanced one.
    """

    if isinstance(observed_macro_f1, bool) or not isinstance(observed_macro_f1, (int, float)) or not math.isfinite(observed_macro_f1):
        raise OverfittingCheckError("observed_macro_f1 must be a finite number.")
    if isinstance(trials, bool) or not isinstance(trials, int) or trials <= 0:
        raise OverfittingCheckError("trials must be a positive integer.")
    labels = _validated_class_counts(class_counts)
    counts = np.array([class_counts[label] for label in labels], dtype=np.float64)
    sample_count = int(counts.sum())
    probabilities = counts / counts.sum()

    generator = np.random.default_rng(random_state)
    actual = generator.choice(len(labels), size=(trials, sample_count), p=probabilities)
    predicted = generator.choice(len(labels), size=(trials, sample_count), p=probabilities)
    null_scores = _macro_f1_batch(actual, predicted, len(labels))
    return float(np.mean(null_scores >= observed_macro_f1))


def sidak_adjusted_p_value(single_trial_p_value: float, *, independent_trials: int) -> float:
    """P(at least one of N independent no-skill trials scores this well or better).

    This is the exact Sidak correction under independence -- the natural
    question once a result was chosen as "the best of everything tried" rather
    than judged on its own.
    """

    if isinstance(single_trial_p_value, bool) or not isinstance(single_trial_p_value, (int, float)):
        raise OverfittingCheckError("single_trial_p_value must be a number between 0 and 1.")
    if not 0.0 <= single_trial_p_value <= 1.0:
        raise OverfittingCheckError("single_trial_p_value must be between 0 and 1.")
    if isinstance(independent_trials, bool) or not isinstance(independent_trials, int) or independent_trials <= 0:
        raise OverfittingCheckError("independent_trials must be a positive integer.")
    return 1.0 - (1.0 - single_trial_p_value) ** independent_trials


@dataclass(frozen=True)
class TrialEvidence:
    """One independent idea's best recorded validation result."""

    model_key: str
    algorithm: str
    macro_f1: float
    sample_count: int
    class_counts: Mapping[str, int]


@dataclass(frozen=True)
class TrialVerdict(TrialEvidence):
    """A trial's evidence plus how surprising that score is, N trials considered."""

    single_trial_p_value: float
    adjusted_p_value: float


def rank_trials_by_overfitting_risk(
    trials: Sequence[TrialEvidence],
    *,
    simulation_trials: int = 2000,
    random_state: int = 42,
) -> list[TrialVerdict]:
    """Rank a registry of independent trials by how surprising each score is.

    ``len(trials)`` is used as the number of independent attempts made against
    this market -- the correction the whole registry earns, not just the ones
    that happen to look good. Results are sorted with the least-likely-to-be-
    chance trial first. Each trial gets its own simulation seed so one trial's
    result cannot be an artifact of reusing another's random draws.
    """

    independent_trials = len(trials)
    if independent_trials == 0:
        return []
    verdicts: list[TrialVerdict] = []
    for index, trial in enumerate(trials):
        single_trial_p_value = no_skill_macro_f1_p_value(
            class_counts=trial.class_counts,
            observed_macro_f1=trial.macro_f1,
            trials=simulation_trials,
            random_state=random_state + index,
        )
        verdicts.append(
            TrialVerdict(
                model_key=trial.model_key,
                algorithm=trial.algorithm,
                macro_f1=trial.macro_f1,
                sample_count=trial.sample_count,
                class_counts=trial.class_counts,
                single_trial_p_value=single_trial_p_value,
                adjusted_p_value=sidak_adjusted_p_value(single_trial_p_value, independent_trials=independent_trials),
            )
        )
    return sorted(verdicts, key=lambda verdict: verdict.adjusted_p_value)


__all__ = [
    "OverfittingCheckError",
    "TrialEvidence",
    "TrialVerdict",
    "no_skill_macro_f1_p_value",
    "rank_trials_by_overfitting_risk",
    "sidak_adjusted_p_value",
]
