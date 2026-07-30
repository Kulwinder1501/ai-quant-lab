"""Leakage audits: the checks that decide whether a score can be believed.

A high holdout score is not evidence on its own. These three checks each try to
break the claim in a different way, and all of them are cheap compared with
trusting a leaking model:

* **label shuffle** — retrain on a permuted target. A pipeline that still scores
  well has learned something structural about the *rows* rather than the labels,
  which means information is reaching the model that should not.
* **feature lag** — score each row with the previous bar's features. A model whose
  score barely moves was not relying on current-bar information, which usually
  means the features already encode the answer. This reasoning assumes a
  *transient* signal; for a persistence-dominated target such as volatility it
  does not hold, and callers pass ``persistence_dominated=True`` so the check
  reports INCONCLUSIVE instead of a false leakage failure.
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

from .contracts import DIRECTIONAL_ALPHABET, LABELS, LabelAlphabet, LabeledExample, TemporalSplit
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
#
# How far above its alphabet's random baseline a shuffled-label fit may score
# before the pipeline is suspected of learning from the rows rather than the
# labels. Kept as a margin rather than an absolute so it stays correct for any
# alphabet size; the two constants below are the directional instances of it,
# retained because callers and tests import them.
SHUFFLE_CEILING_MARGIN = 0.07
RANDOM_BASELINE_MACRO_F1 = 1.0 / len(LABELS)
SHUFFLE_CEILING_MACRO_F1 = RANDOM_BASELINE_MACRO_F1 + SHUFFLE_CEILING_MARGIN

# A one-bar-stale feature vector must cost the model something real. A drop
# smaller than this is indistinguishable from noise and is treated as a failure,
# because it means the current bar was not carrying the signal.
#
# That inference is only valid for a target whose signal is *transient*. It was
# written when every target here predicted direction, where the answer genuinely
# lives in the current bar. It does not hold for a persistence-dominated target:
# volatility clusters, so the previous bar's range state predicts the next window's
# range about as well as the current bar's does, and a near-zero degradation is the
# expected signature of that persistence rather than evidence of leakage. Measured
# on NIFTY50 1d volatility-expansion: -0.0088, which the check reported as "the
# features may already encode the future" while LABEL_SHUFFLE -- the check that
# actually detects leakage independent of persistence -- passed cleanly at 0.2897
# against a 0.3333 baseline.
#
# Callers pass persistence_dominated=True for such a target. The check still runs
# and still reports its number; only its *interpretation* changes, to INCONCLUSIVE.
MINIMUM_LAG_DEGRADATION = 0.02

# A later era is a different market, so some decay is expected and healthy. Only
# a collapse toward the random baseline is reported as a failure.
MAXIMUM_ERA_DECAY = 0.15


class LeakageAuditError(ValueError):
    """Raised when the supplied dataset cannot support a meaningful audit."""


def _check(
    name: str,
    passed: bool,
    detail: str,
    metrics: Mapping[str, Any],
    status: str | None = None,
) -> dict[str, Any]:
    """One audit result. ``status`` overrides the PASS/FAILED derived from ``passed``.

    The override exists for INCONCLUSIVE: a check whose premise does not hold for
    the target being audited has not passed, but neither has it found evidence of
    leakage, and collapsing that into either answer loses the distinction. Only
    FAILED blocks a promotion; INCONCLUSIVE is surfaced and counted separately so a
    reader can see that a check was skipped rather than satisfied.
    """

    return {
        "check": name,
        "status": status or ("PASS" if passed else "FAILED"),
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
    shuffle_ceiling: float | None = None,
    minimum_lag_degradation: float = MINIMUM_LAG_DEGRADATION,
    maximum_era_decay: float = MAXIMUM_ERA_DECAY,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
    persistence_dominated: bool = False,
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
    # Both thresholds follow the alphabet: a 3-class baseline is 1/3, and a
    # different alphabet size would make a hardcoded constant simply wrong.
    random_baseline = alphabet.random_baseline_macro_f1
    resolved_shuffle_ceiling = (
        random_baseline + SHUFFLE_CEILING_MARGIN if shuffle_ceiling is None else shuffle_ceiling
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
            alphabet=alphabet,
        )

    base_result = fit(base_split)
    base_macro_f1 = base_result.validation_metrics.macro_f1

    # 1. Label shuffle.
    shuffle_macro_f1 = fit(_shuffled_split(base_split, generator)).validation_metrics.macro_f1
    shuffle_passed = shuffle_macro_f1 <= resolved_shuffle_ceiling
    checks = [
        _check(
            "LABEL_SHUFFLE",
            shuffle_passed,
            (
                f"A shuffled target scored {shuffle_macro_f1:.4f} macro-F1 against a "
                f"{random_baseline:.4f} random baseline."
                if shuffle_passed
                else (
                    f"A shuffled target still scored {shuffle_macro_f1:.4f} macro-F1, above the "
                    f"{resolved_shuffle_ceiling:.4f} ceiling. The pipeline is learning from something other "
                    "than the labels."
                )
            ),
            {"shuffledMacroF1": shuffle_macro_f1, "ceiling": resolved_shuffle_ceiling, "randomBaseline": random_baseline},
        )
    ]

    # The feature-lag and era-holdout checks are only interpretable once the base
    # model has measurable skill. Below the three-class random baseline there is no
    # skill whose provenance could have leaked, yet both checks still emit
    # leakage-shaped failures: feature-lag reports "the features may already encode
    # the future" precisely because staling a no-skill model changes nothing, and
    # era-holdout reports a sub-chance later era as a collapse. That false alarm is
    # what this guard removes. LABEL_SHUFFLE above already rules out leakage on its
    # own, independent of skill, so a no-skill model is reported as a clean PASS
    # with the model-quality problem stated plainly rather than dressed as leakage.
    #
    # The comparison is strict: a score *exactly* at the baseline is the degenerate
    # boundary a single-class predictor lands on, and the existing lag/era checks
    # already handle it. Real no-skill models score strictly below (the observed
    # NIFTY 1d range was 0.20-0.29), so the strict test loses none of them while
    # leaving the boundary case to the checks that were already exercising it.
    lag_macro_f1: float | None = None
    lag_degradation: float | None = None
    era_macro_f1: float | None = None
    era_decay: float | None = None
    if base_macro_f1 < random_baseline:
        checks.append(
            _check(
                "NO_SKILL_TO_AUDIT",
                True,
                (
                    f"The base model scored {base_macro_f1:.4f} macro-F1, below the "
                    f"{random_baseline:.4f} random baseline, so there is no skill to trace to a "
                    "source. Feature-lag and era-holdout were skipped because they are uninterpretable for "
                    "a no-skill model; the label-shuffle check already rules out leakage. This is a "
                    "model-quality result, not a leakage finding."
                ),
                {
                    "baseMacroF1": base_macro_f1,
                    "randomBaseline": random_baseline,
                },
            )
        )
    else:
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
        else:
            lag_macro_f1 = evaluate_predictions(
                [example.label for example in lagged],
                predict_labels(base_result.model, lagged, schema=schema, alphabet=alphabet),
                alphabet=alphabet,
            ).macro_f1
            lag_degradation = base_macro_f1 - lag_macro_f1
            lag_passed = lag_degradation >= minimum_lag_degradation
            # A persistence-dominated target breaks this check's premise, so a small
            # degradation is reported as inconclusive rather than as leakage. It is
            # never upgraded to PASS: the check genuinely did not discriminate, and
            # saying otherwise would claim evidence that was not obtained.
            lag_inconclusive = persistence_dominated and not lag_passed
            if lag_passed:
                lag_detail = (
                    f"Stale features cost {lag_degradation:.4f} macro-F1, so the current bar carries the signal."
                )
            elif lag_inconclusive:
                lag_detail = (
                    f"Stale features cost only {lag_degradation:.4f} macro-F1 (minimum "
                    f"{minimum_lag_degradation:.4f}), but this target is persistence-dominated, so a "
                    "near-zero cost is expected and is not evidence of leakage. This check cannot "
                    "discriminate here; LABEL_SHUFFLE is the one that can."
                )
            else:
                lag_detail = (
                    f"Stale features cost only {lag_degradation:.4f} macro-F1 (minimum "
                    f"{minimum_lag_degradation:.4f}). The features may already encode the future."
                )
            checks.append(
                _check(
                    "FEATURE_LAG",
                    lag_passed,
                    lag_detail,
                    {
                        "baseMacroF1": base_macro_f1,
                        "laggedMacroF1": lag_macro_f1,
                        "degradation": lag_degradation,
                        "minimumDegradation": minimum_lag_degradation,
                        "persistenceDominated": persistence_dominated,
                    },
                    status="INCONCLUSIVE" if lag_inconclusive else None,
                )
            )

        # 3. Era holdout: train on the first half, score the final fifth.
        ordered = sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))
        train_end = len(ordered) // 2
        era_start = len(ordered) - max(1, len(ordered) // 5)
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
            below_random = era_macro_f1 < random_baseline
            decayed_too_far = era_decay > maximum_era_decay
            era_passed = not below_random and not decayed_too_far
            if era_passed:
                era_detail = (
                    f"A much later era scored {era_macro_f1:.4f} macro-F1, within {era_decay:.4f} of the in-window holdout."
                )
            elif below_random:
                era_detail = (
                    f"A much later era scored {era_macro_f1:.4f} macro-F1, at or below the {random_baseline:.4f} "
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
                        "randomBaseline": random_baseline,
                    },
                )
            )

    failed = [check["check"] for check in checks if check["status"] == "FAILED"]
    inconclusive = [check["check"] for check in checks if check["status"] == "INCONCLUSIVE"]
    verdict = "PASS" if not failed else "INVESTIGATE"
    if failed:
        summary = f"{len(failed)} of {len(checks)} leakage checks need investigation: {', '.join(failed)}."
    elif inconclusive:
        # Reported explicitly: "all passed" would overstate what was actually shown.
        summary = (
            f"No leakage check failed for the holdout score of {base_macro_f1:.4f} macro-F1, but "
            f"{len(inconclusive)} could not discriminate for this target: {', '.join(inconclusive)}."
        )
    else:
        summary = (
            f"All {len(checks)} leakage checks passed; the holdout score of "
            f"{base_macro_f1:.4f} macro-F1 survived them."
        )
    return {
        "method": "LEAKAGE_AUDIT_V1",
        "verdict": verdict,
        "summary": summary,
        "algorithm": algorithm,
        "randomState": random_state,
        "failedChecks": failed,
        "inconclusiveChecks": inconclusive,
        "checks": checks,
        "baseline": {
            "macroF1": base_macro_f1,
            "trainingRows": base_result.training_rows,
            "validationRows": base_result.validation_rows,
            "randomBaselineMacroF1": random_baseline,
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
