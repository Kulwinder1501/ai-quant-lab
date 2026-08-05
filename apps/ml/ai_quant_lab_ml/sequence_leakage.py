"""Leakage checks for sequence (TCN) research: label shuffle and era holdout.

Mirrors two of ``leakage.py``'s three checks, adapted to a sequence split:

* **label shuffle** — retrain on a permuted target, holdout intact. A TCN that
  still scores well has learned something structural about the *rows* rather
  than the labels.
* **era holdout** — train on an early era, score a much later, disjoint one
  (the middle era is dropped, not trained on). A score that collapses means
  the model only works inside the window it was fitted on.

Feature-lag has no analogue here: a TCN's input already *is* a lag window, so
staling it further does not isolate current-bar information the way it does
for a single-bar tabular row. It is left to the tabular lag-LightGBM baseline
this module does not touch.

Each check is expensive — it retrains a full TCN — so it is meant to run once
a candidate already looks promising, the same way the tabular leakage audit
only runs when promotion is actually requested. Randomness is confined to a
local generator so a rerun reproduces.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Any

from .contracts import LabelAlphabet
from .leakage import MAXIMUM_ERA_DECAY, SHUFFLE_CEILING_MARGIN
from .sequences import (
    SequenceError,
    SequenceExample,
    SequenceSplit,
    sequence_era_holdout_split,
    sequence_purged_walk_forward,
)
from .tcn_training import train_tcn_classifier
from .volatility_expansion import VOLATILITY_ALPHABET


class SequenceLeakageAuditError(ValueError):
    """Raised when the supplied sequence dataset cannot support a meaningful audit."""


def _check(name: str, passed: bool, detail: str, metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "check": name,
        "status": "PASS" if passed else "FAILED",
        "detail": detail,
        "metrics": dict(metrics),
    }


def _shuffled_split(split: SequenceSplit, generator: random.Random) -> SequenceSplit:
    """Permute only the training labels, leaving the holdout target intact."""

    labels = [sequence.label for sequence in split.train]
    generator.shuffle(labels)
    return SequenceSplit(
        train=tuple(
            replace(sequence, label=label)
            for sequence, label in zip(split.train, labels, strict=True)
        ),
        validation=split.validation,
        purge_count=split.purge_count,
    )


def run_sequence_leakage_audit(
    sequences: Sequence[SequenceExample],
    *,
    lookback: int,
    channels: int,
    epochs: int,
    batch_size: int,
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
    validation_fraction: float = 0.2,
    era_train_fraction: float = 0.5,
    era_holdout_fraction: float = 0.2,
    shuffle_ceiling: float | None = None,
    maximum_era_decay: float = MAXIMUM_ERA_DECAY,
    random_state: int = 42,
) -> dict[str, Any]:
    """Run label-shuffle and era-holdout on a TCN and return a JSON-safe verdict."""

    if not sequences:
        raise SequenceLeakageAuditError("At least one sequence example is required to audit.")

    random_baseline = alphabet.random_baseline_macro_f1
    resolved_shuffle_ceiling = (
        random_baseline + SHUFFLE_CEILING_MARGIN if shuffle_ceiling is None else shuffle_ceiling
    )
    generator = random.Random(random_state)

    def fit(split: SequenceSplit):
        return train_tcn_classifier(
            split,
            alphabet=alphabet,
            lookback=lookback,
            channels=channels,
            epochs=epochs,
            batch_size=batch_size,
            random_state=random_state,
        )

    try:
        base_split = sequence_purged_walk_forward(
            sequences, folds=1, validation_fraction=validation_fraction,
        )[0]
    except SequenceError as error:
        raise SequenceLeakageAuditError(f"The dataset cannot be split for an audit: {error}") from error

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
                    f"{resolved_shuffle_ceiling:.4f} ceiling. The TCN is learning from something other "
                    "than the labels."
                )
            ),
            {
                "shuffledMacroF1": shuffle_macro_f1,
                "ceiling": resolved_shuffle_ceiling,
                "randomBaseline": random_baseline,
            },
        )
    ]

    # 2. Era holdout: train on the earliest era, score a disjoint, much later one.
    era_macro_f1: float | None = None
    era_decay: float | None = None
    try:
        era_split = sequence_era_holdout_split(
            sequences, train_fraction=era_train_fraction, holdout_fraction=era_holdout_fraction,
        )
    except SequenceError as error:
        checks.append(
            _check(
                "ERA_HOLDOUT",
                False,
                f"The dataset is too short to train on an early era and score a disjoint later one: {error}",
                {},
            )
        )
    else:
        era_macro_f1 = fit(era_split).validation_metrics.macro_f1
        era_decay = base_macro_f1 - era_macro_f1
        below_random = era_macro_f1 < random_baseline
        decayed_too_far = era_decay > maximum_era_decay
        era_passed = not below_random and not decayed_too_far
        if era_passed:
            era_detail = (
                f"A much later era scored {era_macro_f1:.4f} macro-F1, within {era_decay:.4f} of "
                "the in-window holdout."
            )
        elif below_random:
            era_detail = (
                f"A much later era scored {era_macro_f1:.4f} macro-F1, at or below the "
                f"{random_baseline:.4f} random baseline. Whatever the in-window holdout measured "
                "does not exist outside that window."
            )
        else:
            era_detail = (
                f"A much later era scored {era_macro_f1:.4f} macro-F1, {era_decay:.4f} below the "
                f"in-window holdout (limit {maximum_era_decay:.4f}). The score does not survive "
                "outside its own window."
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
    verdict = "PASS" if not failed else "INVESTIGATE"
    summary = (
        f"All {len(checks)} sequence leakage checks passed; the holdout score of "
        f"{base_macro_f1:.4f} macro-F1 survived them."
        if not failed
        else f"{len(failed)} of {len(checks)} sequence leakage checks need investigation: {', '.join(failed)}."
    )
    return {
        "method": "SEQUENCE_LEAKAGE_AUDIT_V1",
        "verdict": verdict,
        "summary": summary,
        "randomState": random_state,
        "failedChecks": failed,
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
            "eraMacroF1": era_macro_f1,
            "eraDecay": era_decay,
        },
    }


__all__ = [
    "SequenceLeakageAuditError",
    "run_sequence_leakage_audit",
]
