"""
2026-10-10 follow-up (code gaps): ``train_tcn.py`` used to compare the network only with ONE constant
predictor, so a network that merely learned the clock could clear the "beats trivial" gate. The fold
bar is now the STRONGER of the trivial and the time-of-day-stratified baselines (fitted on TRAIN
rows only, via ``train.time_of_day_baseline_metrics``). Synthetic data only.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from train_tcn import (
    beats_strongest_baseline,
    strongest_baseline_macro_f1,
    time_of_day_macro_f1,
    trivial_macro_f1,
)
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET

# 2026-09-01 03:45 UTC = 09:15 IST; 15m bars.
OPEN = datetime(2026, 9, 1, 3, 45, tzinfo=UTC)
BAR = timedelta(minutes=15)
MORNING, AFTERNOON = 0, 20


def example(day: int, bar: int, label: str) -> SimpleNamespace:
    # SequenceExample exposes `.label` and `.observed_at`, which is all the baseline reads.
    return SimpleNamespace(label=label, observed_at=OPEN + timedelta(days=day) + (bar + 1) * BAR)


def clock_split() -> SimpleNamespace:
    """Label fully determined by bar of day: mornings EXPANSION, afternoons CONTRACTION, in equal
    numbers, so a single global constant can be right at most half the time."""
    def label(bar: int) -> str:
        return "EXPANSION" if bar == MORNING else "CONTRACTION"

    train = tuple(example(d, b, label(b)) for d in range(10) for b in (MORNING, AFTERNOON))
    validation = tuple(example(d, b, label(b)) for d in range(10, 14) for b in (MORNING, AFTERNOON))
    return SimpleNamespace(train=train, validation=validation, purge_count=0)


def test_time_of_day_baseline_beats_trivial_when_the_label_is_the_clock():
    split = clock_split()
    trivial = trivial_macro_f1([e.label for e in split.validation], VOLATILITY_ALPHABET.labels)
    tod = time_of_day_macro_f1(split, "15m")
    assert tod > trivial
    assert tod == pytest.approx(2 / 3)  # two of the three classes are perfect; STABLE never occurs


def test_a_clock_only_network_beats_trivial_but_not_the_strongest_baseline():
    split = clock_split()
    trivial = trivial_macro_f1([e.label for e in split.validation], VOLATILITY_ALPHABET.labels)
    tod = time_of_day_macro_f1(split, "15m")
    clock_only_model = (trivial + tod) / 2  # better than trivial, worse than what the clock alone gives

    assert clock_only_model > trivial                       # the old gate would have passed it
    assert not beats_strongest_baseline(clock_only_model, trivial, tod)
    assert beats_strongest_baseline(tod + 0.05, trivial, tod)


def test_time_of_day_baseline_is_fitted_on_train_rows_only():
    split = clock_split()
    flipped_validation = tuple(
        SimpleNamespace(
            label="CONTRACTION" if e.label == "EXPANSION" else "EXPANSION", observed_at=e.observed_at,
        )
        for e in split.validation
    )
    base = time_of_day_macro_f1(split, "15m")
    after = time_of_day_macro_f1(
        SimpleNamespace(train=split.train, validation=flipped_validation, purge_count=0), "15m")
    # Holdout labels changed, the train-fitted predictor did not: the score collapses instead of
    # following the holdout (it would stay 2/3 if the baseline had peeked at validation labels).
    assert base == pytest.approx(2 / 3)
    assert after == pytest.approx(0.0)


def test_nan_baselines_are_ignored_not_treated_as_zero():
    nan = float("nan")
    assert strongest_baseline_macro_f1(0.4, nan) == pytest.approx(0.4)
    assert strongest_baseline_macro_f1(nan, 0.3) == pytest.approx(0.3)
    assert math.isnan(strongest_baseline_macro_f1(nan, nan))
    # With nothing scorable there is nothing to beat, which must NOT read as a pass.
    assert beats_strongest_baseline(0.9, nan, nan) is False
