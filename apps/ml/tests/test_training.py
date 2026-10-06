from __future__ import annotations

import importlib.util
import math
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample, TemporalSplit
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET
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


class PerClassMetricsTests(unittest.TestCase):
    """Per-class precision, and the null that macro-F1 hides.

    A straddle is taken only on a predicted EXPANSION, so that one class's precision --
    not macro-F1 -- decides whether the strategy pays. Measured 2026-08-03, it has to
    reach 44.3% against a 27.6% base rate before fees, and nothing recorded it.
    """

    def test_precision_and_recall_match_their_denominators(self) -> None:
        metrics = evaluate_predictions(
            ["EXPANSION"] * 30 + ["STABLE"] * 40,
            ["EXPANSION"] * 20 + ["STABLE"] * 10 + ["STABLE"] * 40,
            alphabet=VOLATILITY_ALPHABET,
        )

        assert metrics.per_class is not None
        expansion = metrics.per_class["EXPANSION"]
        # 20 EXPANSION calls, all correct.
        self.assertEqual(expansion.predicted_count, 20)
        self.assertEqual(expansion.actual_count, 30)
        self.assertAlmostEqual(expansion.precision or 0.0, 1.0, places=10)
        self.assertAlmostEqual(expansion.recall or 0.0, 20 / 30, places=10)

        stable = metrics.per_class["STABLE"]
        # 50 STABLE calls, 40 correct.
        self.assertEqual(stable.predicted_count, 50)
        self.assertAlmostEqual(stable.precision or 0.0, 40 / 50, places=10)
        self.assertAlmostEqual(stable.recall or 0.0, 1.0, places=10)

    def test_a_never_predicted_class_has_null_precision_not_zero(self) -> None:
        """The distinction the whole field exists for.

        sklearn's ``zero_division=0`` reports precision 0.0 for a class the model never
        predicted, which reads as "always wrong". The truth is "never attempted", and for
        a strategy that only acts on EXPANSION those are opposite situations: one model is
        bad at the trade, the other never takes it.
        """

        metrics = evaluate_predictions(
            ["CONTRACTION"] * 30 + ["STABLE"] * 30,
            ["STABLE"] * 60,
            alphabet=VOLATILITY_ALPHABET,
        )

        assert metrics.per_class is not None
        contraction = metrics.per_class["CONTRACTION"]
        self.assertEqual(contraction.predicted_count, 0)
        self.assertIsNone(contraction.precision)
        # It did occur, and was never caught, so recall is a real zero.
        self.assertEqual(contraction.actual_count, 30)
        self.assertEqual(contraction.recall, 0.0)

    def test_a_never_occurring_class_has_null_recall(self) -> None:
        metrics = evaluate_predictions(
            ["STABLE"] * 40,
            ["STABLE"] * 30 + ["EXPANSION"] * 10,
            alphabet=VOLATILITY_ALPHABET,
        )

        assert metrics.per_class is not None
        expansion = metrics.per_class["EXPANSION"]
        self.assertEqual(expansion.actual_count, 0)
        self.assertIsNone(expansion.recall)
        # It was predicted 10 times and never right, which is a real zero.
        self.assertEqual(expansion.predicted_count, 10)
        self.assertEqual(expansion.precision, 0.0)

    def test_every_alphabet_label_is_present(self) -> None:
        # A missing key would make a consumer's lookup silently undefined rather than
        # explicitly null.
        metrics = evaluate_predictions(["STABLE"] * 5, ["STABLE"] * 5, alphabet=VOLATILITY_ALPHABET)

        assert metrics.per_class is not None
        self.assertEqual(set(metrics.per_class), set(VOLATILITY_ALPHABET.labels))

    def test_the_directional_alphabet_is_broken_out_too(self) -> None:
        metrics = evaluate_predictions(
            ["BULLISH"] * 10 + ["BEARISH"] * 10,
            ["BULLISH"] * 15 + ["BEARISH"] * 5,
        )

        assert metrics.per_class is not None
        self.assertEqual(set(metrics.per_class), {"BULLISH", "BEARISH", "NEUTRAL"})
        self.assertAlmostEqual(metrics.per_class["BULLISH"].precision or 0.0, 10 / 15, places=10)
        self.assertIsNone(metrics.per_class["NEUTRAL"].precision)
