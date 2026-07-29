from __future__ import annotations

import importlib.util
import math
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample, TemporalSplit
from ai_quant_lab_ml.training import (
    evaluate_predictions,
    predict_labels,
    train_logistic_regression_baseline,
    training_metadata,
)


SKLEARN_AVAILABLE = importlib.util.find_spec("sklearn") is not None
START = datetime(2024, 1, 2, tzinfo=UTC)


def example(index: int, label: str) -> LabeledExample:
    observed_at = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=1),
        forward_return=0.01,
        label=label,  # type: ignore[arg-type]
        features={"signal": float(index % 2), "sometimes_missing": math.nan},
    )


@unittest.skipUnless(SKLEARN_AVAILABLE, "scikit-learn is not installed")
class LogisticRegressionTrainingTests(unittest.TestCase):
    def test_trains_with_imputation_scaling_and_fixed_metrics(self) -> None:
        split = TemporalSplit(
            train=tuple(example(index, "BULLISH" if index % 2 else "BEARISH") for index in range(12)),
            validation=(example(20, "BEARISH"), example(21, "BULLISH"), example(22, "BULLISH")),
            purge_count=2,
        )

        result = train_logistic_regression_baseline(split, schema=("signal", "sometimes_missing"), random_state=7)
        metadata = training_metadata(result)

        self.assertEqual(result.algorithm, "sklearn-logistic-regression-v1")
        self.assertEqual(tuple(result.model.named_steps), ("imputer", "scaler", "classifier"))
        self.assertEqual(result.validation_metrics.sample_count, 3)
        self.assertEqual(dict(result.validation_metrics.class_counts), {"BEARISH": 1, "NEUTRAL": 0, "BULLISH": 2})
        self.assertEqual(metadata["featureSchema"], ["signal", "sometimes_missing"])
        self.assertIn("macroF1", metadata["validationMetrics"])
        self.assertEqual(len(predict_labels(result.model, split.validation, schema=result.feature_schema)), 3)


@unittest.skipUnless(SKLEARN_AVAILABLE, "scikit-learn is not installed")
class DirectionalMetricTests(unittest.TestCase):
    """The hit rate is the number comparable to a binary "right N% of the time"."""

    def test_scores_only_the_rows_the_model_committed_to(self) -> None:
        actual = ["BULLISH", "BEARISH", "NEUTRAL", "BULLISH", "BEARISH"]
        predicted = ["BULLISH", "NEUTRAL", "NEUTRAL", "BEARISH", "BEARISH"]

        metrics = evaluate_predictions(actual, predicted)  # type: ignore[arg-type]

        # Three directional calls (BULLISH, BEARISH, BEARISH); two were right.
        self.assertEqual(metrics.directional_predictions, 3)
        self.assertAlmostEqual(metrics.directional_hit_rate, 2 / 3, places=10)
        self.assertAlmostEqual(metrics.coverage, 3 / 5, places=10)

    def test_a_model_that_never_commits_has_no_hit_rate(self) -> None:
        metrics = evaluate_predictions(
            ["BULLISH", "BEARISH", "NEUTRAL"],  # type: ignore[arg-type]
            ["NEUTRAL", "NEUTRAL", "NEUTRAL"],  # type: ignore[arg-type]
        )

        # A zero hit rate and an absent one are different claims; only null is honest.
        self.assertEqual(metrics.coverage, 0.0)
        self.assertIsNone(metrics.directional_hit_rate)
        self.assertEqual(metrics.directional_predictions, 0)

    def test_perfect_directional_calls_report_full_hit_rate(self) -> None:
        metrics = evaluate_predictions(
            ["BULLISH", "BEARISH"],  # type: ignore[arg-type]
            ["BULLISH", "BEARISH"],  # type: ignore[arg-type]
        )

        self.assertEqual(metrics.directional_hit_rate, 1.0)
        self.assertEqual(metrics.coverage, 1.0)

    def test_directional_metrics_reach_the_persisted_metadata(self) -> None:
        split = TemporalSplit(
            train=tuple(example(index, "BULLISH" if index % 2 else "BEARISH") for index in range(12)),
            validation=(example(20, "BEARISH"), example(21, "BULLISH"), example(22, "BULLISH")),
            purge_count=2,
        )

        metadata = training_metadata(train_logistic_regression_baseline(split, schema=("signal", "sometimes_missing")))

        self.assertIn("directionalHitRate", metadata["validationMetrics"])
        self.assertIn("coverage", metadata["validationMetrics"])


if __name__ == "__main__":
    unittest.main()
