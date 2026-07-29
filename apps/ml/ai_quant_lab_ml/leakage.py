"""Leakage audits: the checks that decide whether a score can be believed.

A high holdout score is not evidence on its own. These three checks each try to
break the claim in a different way, and all of them are cheap compared with
trusting a leaking model:

* **label shuffle** — retrain on a permuted target. A pipeline that still scores
  well has learned something structural about the *rows* rather than the labels,
  which means information is reaching the model that should not.
* **feature lag** — score each row with the previous bar's features. A model whose
  score barely moves was not relying on current-bar information, which usually
  means the features already encode the answer.
* **era holdout** — train on an early period and score a much later one. A score
  that collapses means the model only works inside the window it was fitted on.

Each check reports its own numbers so a verdict can be argued with, not just
accepted. Randomness is confined to a local generator so a rerun reproduces.
"""

from __future__ import annotations

import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any

from .contracts import LABELS, LabeledExample, TemporalSplit
from .training import evaluate_predictions, predict_labels, train_model
from .validation import TemporalSplitError, chronological_purged_split


# A shuffled-label model should land near the three-class random baseline of
# 1/3. The tolerance leaves room for class imbalance in a short history while
# still catching a pipeline that reproduces real skill from noise.
#
# This assumes a schema wide enough that a random fit cannot land on the true
# decision boundary by luck. With only two or three features a shuffled linear
# fit can align with the real direction by chance and score well above the
# baseline; the ml-feature schema has over a hundred columns, so that is not a
# practical concern here.
RANDOM_BASELINE_MACRO_F1 = 1.0 / len(LABELS)
SHUFFLE_CEILING_MACRO_F1 = RANDOM_BASELINE_MACRO_F1 + 0.07

# A one-bar-stale feature vector must cost the model something real. A drop
# smaller than this is indistinguishable from noise and is treated as a failure,
# because it means the current bar was not carrying the signal.
MINIMUM_LAG_DEGRADATION = 0.02

# A later era is a different market, so some decay is expected and healthy. Only
# a collapse toward the random baseline is reported as a failure.
MAXIMUM_ERA_DECAY = 0.15


class LeakageAuditError(ValueError):
    """Raised when the supplied dataset cannot support a meaningful audit."""


def _check(name: str, passed: bool, detail: str, metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "check": name,
        "status": "PASS" if passed else "FAILED",
        "detail": detail,
        "metrics": dict(metrics),
    }


def _shuffled_split(split: TemporalSplit, generator: random.Random) -> TemporalSplit:
    """Permute only the training labels, leaving the holdout target intact."""

    labels = [example.label for example in split.train]
    generator.shuffle(labels)
    return TemporalSplit(
        train=tuple(replace(example, label=label) for example, label in zip(split.train, labels, strict=True)),
        validation=split.validation,
        purge_count=split.purge_count,
    )


def _lagged_validation(validation: Sequence[LabeledExample]) -> list[LabeledExample]:
    """Pair each holdout row's label with the previous row's feature vector."""

    return [
        replace(validation[index], features=validation[index - 1].features)
        for index in range(1, len(validation))
    ]


def run_leakage_audit(
    examples: Sequence[LabeledExample],
    *,
    algorithm: str,
    horizon_bars: int,
    schema: Sequence[str] | None = None,
    hyperparameters: Mapping[str, Any] | None = None,
    random_state: int = 42,
    validation_fraction: float = 0.2,
    shuffle_ceiling: float = SHUFFLE_CEILING_MACRO_F1,
    minimum_lag_degradation: float = MINIMUM_LAG_DEGRADATION,
    maximum_era_decay: float = MAXIMUM_ERA_DECAY,
) -> dict[str, Any]:
    """Run all three checks and return a JSON-safe verdict.

    ``hyperparameters`` are the trainer's own keyword arguments, in snake_case —
    the same mapping ``train_model`` accepts, not the camelCase metadata form.
    """

    if not examples:
        raise LeakageAuditError("At least one labeled example is required to audit.")
    for example in examples:
        if example.vix_observed_at is not None and example.vix_observed_at > example.observed_at:
            raise LeakageAuditError(
                f"STRICT LEAKAGE PREVENTION: Candle {example.candle_id} at {example.observed_at} "
                f"was joined with future VIX data from {example.vix_observed_at}. "
                "This violates the chronological isolation guarantee."
            )
    settings = dict(hyperparameters or {})
    generator = random.Random(random_state)

    try:
        base_split = chronological_purged_split(
            examples, horizon_bars=horizon_bars, validation_fraction=validation_fraction,
        )
    except TemporalSplitError as error:
        raise LeakageAuditError(f"The dataset cannot be split for an audit: {error}") from error

    def fit(split: TemporalSplit) -> Any:
        return train_model(
            algorithm, split, schema=schema, random_state=random_state, hyperparameters=settings,
        )

    base_result = fit(base_split)
    base_macro_f1 = base_result.validation_metrics.macro_f1

    # 1. Label shuffle.
    shuffle_macro_f1 = fit(_shuffled_split(base_split, generator)).validation_metrics.macro_f1
    shuffle_passed = shuffle_macro_f1 <= shuffle_ceiling
    checks = [
        _check(
            "LABEL_SHUFFLE",
            shuffle_passed,
            (
                f"A shuffled target scored {shuffle_macro_f1:.4f} macro-F1 against a "
                f"{RANDOM_BASELINE_MACRO_F1:.4f} random baseline."
                if shuffle_passed
                else (
                    f"A shuffled target still scored {shuffle_macro_f1:.4f} macro-F1, above the "
                    f"{shuffle_ceiling:.4f} ceiling. The pipeline is learning from something other "
                    "than the labels."
                )
            ),
            {"shuffledMacroF1": shuffle_macro_f1, "ceiling": shuffle_ceiling, "randomBaseline": RANDOM_BASELINE_MACRO_F1},
        )
    ]

    # 2. Feature lag.
    lagged = _lagged_validation(base_split.validation)
    if len(lagged) < 2:
        checks.append(
            _check(
                "FEATURE_LAG",
                False,
                "The holdout is too short to build a lagged comparison.",
                {"laggedRows": len(lagged)},
            )
        )
        lag_macro_f1: float | None = None
        lag_degradation: float | None = None
    else:
        lag_macro_f1 = evaluate_predictions(
            [example.label for example in lagged],
            predict_labels(base_result.model, lagged, schema=schema),
        ).macro_f1
        lag_degradation = base_macro_f1 - lag_macro_f1
        lag_passed = lag_degradation >= minimum_lag_degradation
        checks.append(
            _check(
                "FEATURE_LAG",
                lag_passed,
                (
                    f"Stale features cost {lag_degradation:.4f} macro-F1, so the current bar carries the signal."
                    if lag_passed
                    else (
                        f"Stale features cost only {lag_degradation:.4f} macro-F1 (minimum "
                        f"{minimum_lag_degradation:.4f}). The features may already encode the future."
                    )
                ),
                {
                    "baseMacroF1": base_macro_f1,
                    "laggedMacroF1": lag_macro_f1,
                    "degradation": lag_degradation,
                    "minimumDegradation": minimum_lag_degradation,
                },
            )
        )

    # 3. Era holdout: train on the first half, score the final fifth.
    ordered = sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))
    train_end = len(ordered) // 2
    era_start = len(ordered) - max(1, len(ordered) // 5)
    era_macro_f1: float | None = None
    era_decay: float | None = None
    if train_end <= horizon_bars or era_start - train_end < horizon_bars:
        checks.append(
            _check(
                "ERA_HOLDOUT",
                False,
                "The dataset is too short to train on an early era and score a disjoint later one.",
                {"orderedRows": len(ordered), "trainEnd": train_end, "eraStart": era_start},
            )
        )
    else:
        era_split = TemporalSplit(
            train=tuple(ordered[:train_end]),
            validation=tuple(ordered[era_start:]),
            purge_count=era_start - train_end,
        )
        era_macro_f1 = fit(era_split).validation_metrics.macro_f1
        era_decay = base_macro_f1 - era_macro_f1
        # Two distinct ways to fail, and the reason has to say which: a score that
        # never rises above chance in the later era, or one that decays too far
        # from the in-window holdout.
        below_random = era_macro_f1 < RANDOM_BASELINE_MACRO_F1
        decayed_too_far = era_decay > maximum_era_decay
        era_passed = not below_random and not decayed_too_far
        if era_passed:
            era_detail = (
                f"A much later era scored {era_macro_f1:.4f} macro-F1, within {era_decay:.4f} of the in-window holdout."
            )
        elif below_random:
            era_detail = (
                f"A much later era scored {era_macro_f1:.4f} macro-F1, at or below the {RANDOM_BASELINE_MACRO_F1:.4f} "
                "random baseline. Whatever the in-window holdout measured does not exist outside that window."
            )
        else:
            era_detail = (
                f"A much later era scored {era_macro_f1:.4f} macro-F1, {era_decay:.4f} below the in-window holdout "
                f"(limit {maximum_era_decay:.4f}). The score does not survive outside its own window."
            )
        checks.append(
            _check(
                "ERA_HOLDOUT",
                era_passed,
                era_detail,
                {
                    "eraMacroF1": era_macro_f1,
                    "decay": era_decay,
                    "maximumDecay": maximum_era_decay,
                    "randomBaseline": RANDOM_BASELINE_MACRO_F1,
                },
            )
        )

    failed = [check["check"] for check in checks if check["status"] == "FAILED"]
    verdict = "PASS" if not failed else "INVESTIGATE"
    summary = (
        f"All {len(checks)} leakage checks passed; the holdout score of {base_macro_f1:.4f} macro-F1 survived them."
        if verdict == "PASS"
        else f"{len(failed)} of {len(checks)} leakage checks need investigation: {', '.join(failed)}."
    )
    return {
        "method": "LEAKAGE_AUDIT_V1",
        "verdict": verdict,
        "summary": summary,
        "algorithm": algorithm,
        "randomState": random_state,
        "failedChecks": failed,
        "checks": checks,
        "baseline": {
            "macroF1": base_macro_f1,
            "trainingRows": base_result.training_rows,
            "validationRows": base_result.validation_rows,
            "randomBaselineMacroF1": RANDOM_BASELINE_MACRO_F1,
        },
        "metrics": {
            "baseMacroF1": base_macro_f1,
            "shuffledMacroF1": shuffle_macro_f1,
            "laggedMacroF1": lag_macro_f1,
            "lagDegradation": lag_degradation,
            "eraMacroF1": era_macro_f1,
            "eraDecay": era_decay,
        },
    }


def audit_is_conclusive(audit: Mapping[str, Any]) -> bool:
    """Return whether an audit mapping carries a usable verdict."""

    verdict = audit.get("verdict")
    return isinstance(verdict, str) and verdict in {"PASS", "INVESTIGATE"} and not _has_nan(audit)


def _has_nan(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(_has_nan(item) for item in value.values())
    if isinstance(value, (list, tuple)):
        return any(_has_nan(item) for item in value)
    return isinstance(value, float) and not math.isfinite(value)


__all__ = [
    "MAXIMUM_ERA_DECAY",
    "MINIMUM_LAG_DEGRADATION",
    "RANDOM_BASELINE_MACRO_F1",
    "SHUFFLE_CEILING_MACRO_F1",
    "LeakageAuditError",
    "audit_is_conclusive",
    "run_leakage_audit",
]
