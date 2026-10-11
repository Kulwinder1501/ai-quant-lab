"""
2026-10-10 follow-up (code gaps), GAP 2: the baseline reported next to a model is now BOTH the trivial
global-majority predictor and the time-of-day-stratified majority (fitted on TRAIN rows only), and the
promotion verdict compares the model against the STRONGER of the two. Synthetic data only.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from ai_quant_lab_ml.contracts import (
    DIRECTIONAL_ALPHABET,
    EvaluationMetrics,
    LabeledExample,
    TemporalSplit,
)
from tests.test_train import assess, labeled, metrics
from train import (
    compare_to_baselines,
    cpcv_summary,
    time_of_day_baseline_metrics,
    trivial_majority_metrics,
)

# 2026-09-01 03:45 UTC = 09:15 IST: a 15m bar closing at 03:45 + (k+1) * 15m has bar-of-day bucket 37 + k.
OPEN = datetime(2026, 9, 1, 3, 45, tzinfo=UTC)
BAR = timedelta(minutes=15)
MORNING, AFTERNOON = 0, 20  # bar index within the session


def bar_example(day: int, bar: int, label: str, *, timeframe: str = "15m") -> LabeledExample:
    observed_at = OPEN + timedelta(days=day) + (bar + 1) * BAR
    return LabeledExample(
        candle_id=f"c-{day}-{bar}-{label}",
        instrument_id="i",
        symbol="NIFTY50",
        timeframe=timeframe,
        observed_at=observed_at,
        label_available_at=observed_at + 2 * BAR,
        forward_return=0.0,
        label=label,
        features={"feature.one": 0.0},
    )


def clock_determined_split() -> TemporalSplit:
    """The label is PERFECTLY determined by time of day: every morning bar is BULLISH, every
    afternoon bar is BEARISH, in equal numbers -- so a global majority is a coin flip."""
    train = [
        bar_example(day, bar, "BULLISH" if bar == MORNING else "BEARISH")
        for day in range(10)
        for bar in (MORNING, AFTERNOON)
    ]
    validation = [
        bar_example(day, bar, "BULLISH" if bar == MORNING else "BEARISH")
        for day in range(10, 14)
        for bar in (MORNING, AFTERNOON)
    ]
    return TemporalSplit(train=tuple(train), validation=tuple(validation), purge_count=0)


def test_label_determined_by_time_of_day_trivial_is_poor_and_stratified_is_perfect():
    split = clock_determined_split()
    trivial = trivial_majority_metrics(split, alphabet=DIRECTIONAL_ALPHABET)
    stratified = time_of_day_baseline_metrics(split, alphabet=DIRECTIONAL_ALPHABET, timeframe="15m")

    assert trivial.accuracy == pytest.approx(0.5)       # one class for everything: half right at best
    assert stratified.accuracy == pytest.approx(1.0)    # per-bucket majority recovers the clock exactly
    assert stratified.macro_f1 > trivial.macro_f1


def test_baseline_fit_uses_train_only_so_holdout_labels_cannot_leak_in():
    split = clock_determined_split()
    base = time_of_day_baseline_metrics(split, alphabet=DIRECTIONAL_ALPHABET, timeframe="15m")

    # Flip every HOLDOUT label to the opposite class. If the baseline peeked at the holdout labels
    # its predictions would change with them; fitted on train it predicts exactly the same, so the
    # accuracy against the flipped labels is exactly the complement.
    flipped = [
        bar_example(day, bar, "BEARISH" if bar == MORNING else "BULLISH")
        for day in range(10, 14)
        for bar in (MORNING, AFTERNOON)
    ]
    flipped_split = TemporalSplit(train=split.train, validation=tuple(flipped), purge_count=0)
    after = time_of_day_baseline_metrics(flipped_split, alphabet=DIRECTIONAL_ALPHABET, timeframe="15m")

    assert base.accuracy == pytest.approx(1.0)
    assert after.accuracy == pytest.approx(0.0)


def test_a_bucket_unseen_in_train_falls_back_to_the_global_train_majority():
    train = [bar_example(0, MORNING, "BULLISH")] * 1 + [bar_example(d, MORNING, "BULLISH") for d in range(1, 4)]
    train += [bar_example(5, 10, "BEARISH")]  # BULLISH 4 vs BEARISH 1: global majority BULLISH
    validation = [bar_example(9, 15, "BULLISH"), bar_example(9, 16, "BULLISH")]  # buckets never trained
    split = TemporalSplit(train=tuple(train), validation=tuple(validation), purge_count=0)

    stratified = time_of_day_baseline_metrics(split, alphabet=DIRECTIONAL_ALPHABET, timeframe="15m")
    assert stratified.accuracy == pytest.approx(1.0)


def test_daily_timeframe_has_no_time_of_day_so_the_two_baselines_coincide():
    train = [labeled(i, "BULLISH") for i in range(7)] + [labeled(100 + i, "BEARISH") for i in range(3)]
    validation = [labeled(200 + i, "BEARISH") for i in range(8)] + [labeled(300, "BULLISH")]
    split = TemporalSplit(train=tuple(train), validation=tuple(validation), purge_count=0)

    trivial = trivial_majority_metrics(split, alphabet=DIRECTIONAL_ALPHABET)
    stratified = time_of_day_baseline_metrics(split, alphabet=DIRECTIONAL_ALPHABET, timeframe="1d")
    assert stratified.accuracy == pytest.approx(trivial.accuracy)
    assert stratified.accuracy == pytest.approx(1 / 9)


def test_compare_reports_both_and_uses_the_stronger_baseline():
    split = clock_determined_split()
    trivial = trivial_majority_metrics(split, alphabet=DIRECTIONAL_ALPHABET)
    stratified = time_of_day_baseline_metrics(split, alphabet=DIRECTIONAL_ALPHABET, timeframe="15m")
    # A model that has learned only the clock scores exactly like the stratified baseline.
    clock_only = EvaluationMetrics(
        accuracy=stratified.accuracy, balanced_accuracy=1.0, macro_f1=stratified.macro_f1, sample_count=8, class_counts={}
    )

    report = compare_to_baselines(clock_only, trivial, stratified)

    assert report["trivial"]["accuracy"] == pytest.approx(trivial.accuracy)
    assert report["timeOfDay"]["accuracy"] == pytest.approx(1.0)
    assert report["strongestMacroF1Baseline"] == "TIME_OF_DAY"
    assert report["strongestAccuracyBaseline"] == "TIME_OF_DAY"
    assert report["strongestAccuracy"] == pytest.approx(1.0)
    # It beats the trivial baseline by a mile but NOT the stronger one.
    assert clock_only.accuracy > trivial.accuracy
    assert report["beatsStrongestOnAccuracy"] is False
    assert report["beatsStrongestOnMacroF1"] is False
    assert report["macroF1MinusStrongest"] == pytest.approx(0.0)


def test_ties_go_to_the_trivial_baseline():
    same = EvaluationMetrics(accuracy=0.5, balanced_accuracy=0.5, macro_f1=0.4, sample_count=4, class_counts={})
    report = compare_to_baselines(same, same, same)
    assert report["strongestMacroF1Baseline"] == "TRIVIAL" and report["strongestAccuracyBaseline"] == "TRIVIAL"


def test_verdict_refuses_a_model_that_only_beats_the_trivial_baseline():
    model = metrics(0.45)  # clears the 0.38 floor and plateau checks
    trivial = metrics(0.20)
    stratified = metrics(0.47)  # the clock alone does better than the model
    baselines = compare_to_baselines(model, trivial, stratified)

    passes, assessment = assess(0.45, baselines=baselines)

    assert passes is False
    assert assessment["decision"] == "DID_NOT_BEAT_STRONGEST_BASELINE"
    assert assessment["baselines"]["timeOfDay"]["macroF1"] == pytest.approx(0.47)
    assert "TIME_OF_DAY" in str(assessment["reason"])


def test_verdict_passes_when_the_model_beats_both_baselines_and_is_unchanged_without_them():
    model = metrics(0.45)
    baselines = compare_to_baselines(model, metrics(0.20), metrics(0.30))

    passes, assessment = assess(0.45, baselines=baselines)
    assert passes is True and assessment["decision"] == "INITIAL_BASELINE_THRESHOLD_MET"
    assert assessment["baselines"]["beatsStrongestOnMacroF1"] is True

    # Omitting the baselines keeps the pre-existing gate behaviour exactly.
    passes_without, assessment_without = assess(0.45)
    assert passes_without is True and "baselines" not in assessment_without


def test_cpcv_summary_reports_both_baselines_and_the_edge_over_the_stronger_one():
    model = [
        EvaluationMetrics(accuracy=0.60, balanced_accuracy=0.5, macro_f1=0.50, sample_count=100, class_counts={}),
        EvaluationMetrics(accuracy=0.62, balanced_accuracy=0.5, macro_f1=0.52, sample_count=100, class_counts={}),
    ]
    trivial = [
        EvaluationMetrics(accuracy=0.40, balanced_accuracy=0.33, macro_f1=0.20, sample_count=100, class_counts={}),
        EvaluationMetrics(accuracy=0.41, balanced_accuracy=0.33, macro_f1=0.21, sample_count=100, class_counts={}),
    ]
    time_of_day = [
        EvaluationMetrics(accuracy=0.65, balanced_accuracy=0.5, macro_f1=0.55, sample_count=100, class_counts={}),  # beats model
        EvaluationMetrics(accuracy=0.50, balanced_accuracy=0.5, macro_f1=0.30, sample_count=100, class_counts={}),  # loses to model
    ]

    summary = cpcv_summary(
        model, trivial, groups=6, test_groups=2, embargo_fraction=0.01, time_of_day_metrics=time_of_day
    )

    # Existing trivial-only keys are untouched ...
    assert summary["macroF1WinRateVsTrivial"] == 1.0
    # ... and the stronger-baseline view is added: the model wins 1 of 2 splits against it.
    assert summary["macroF1WinRateVsStrongest"] == pytest.approx(0.5)
    assert summary["strongestBaselineMacroF1"]["max"] == pytest.approx(0.55)
    assert summary["macroF1MinusStrongest"]["mean"] == pytest.approx(((0.50 - 0.55) + (0.52 - 0.30)) / 2)
    assert "timeOfDayAccuracy" in summary

    without = cpcv_summary(model, trivial, groups=6, test_groups=2, embargo_fraction=0.01)
    assert "macroF1WinRateVsStrongest" not in without
