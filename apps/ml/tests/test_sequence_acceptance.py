"""Tests for sequence_acceptance.py: calibration, fold significance, cost, latency, explanation sanity."""

from __future__ import annotations

import importlib.util
import unittest
from datetime import UTC, datetime

from ai_quant_lab_ml.contracts import ClassMetrics, EvaluationMetrics
from ai_quant_lab_ml.sequence_acceptance import (
    SequenceAcceptanceError,
    benchmark_tcn_inference,
    cost_relevant_precision_report,
    explanation_sanity_check,
    fold_improvement_significance,
    tcn_calibration_report,
)
from ai_quant_lab_ml.sequences import SequenceExample
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET

TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None
START = datetime(2026, 3, 2, 3, 45, tzinfo=UTC)


class CalibrationReportTests(unittest.TestCase):
    def test_perfectly_confident_and_correct_scores_zero_error(self) -> None:
        labels = ["EXPANSION", "STABLE", "CONTRACTION"]
        proba = [
            {"EXPANSION": 1.0, "STABLE": 0.0, "CONTRACTION": 0.0},
            {"EXPANSION": 0.0, "STABLE": 1.0, "CONTRACTION": 0.0},
            {"EXPANSION": 0.0, "STABLE": 0.0, "CONTRACTION": 1.0},
        ]
        report = tcn_calibration_report(labels, proba, alphabet=VOLATILITY_ALPHABET)
        self.assertEqual(report["method"], "TCN_CALIBRATION_V1")
        self.assertAlmostEqual(report["brierScore"], 0.0, places=9)
        self.assertAlmostEqual(report["expectedCalibrationError"], 0.0, places=9)

    def test_rejects_empty_input(self) -> None:
        with self.assertRaises(SequenceAcceptanceError):
            tcn_calibration_report([], [], alphabet=VOLATILITY_ALPHABET)


class FoldImprovementSignificanceTests(unittest.TestCase):
    def test_large_consistent_improvement_is_significant(self) -> None:
        fold_rows = [
            {"tcn": {"macroF1": 0.5}, "lagLightgbm": {"macroF1": 0.3}},
            {"tcn": {"macroF1": 0.52}, "lagLightgbm": {"macroF1": 0.31}},
            {"tcn": {"macroF1": 0.49}, "lagLightgbm": {"macroF1": 0.29}},
        ]
        report = fold_improvement_significance(fold_rows)
        self.assertTrue(report["significant"])
        self.assertGreater(report["meanImprovement"], 0.0)

    def test_noisy_improvement_is_not_significant(self) -> None:
        fold_rows = [
            {"tcn": {"macroF1": 0.60}, "lagLightgbm": {"macroF1": 0.30}},
            {"tcn": {"macroF1": 0.20}, "lagLightgbm": {"macroF1": 0.35}},
            {"tcn": {"macroF1": 0.10}, "lagLightgbm": {"macroF1": 0.32}},
        ]
        report = fold_improvement_significance(fold_rows)
        self.assertFalse(report["significant"])

    def test_single_fold_has_no_stderr(self) -> None:
        report = fold_improvement_significance([{"tcn": {"macroF1": 0.4}, "lagLightgbm": {"macroF1": 0.3}}])
        self.assertIsNone(report["stderrImprovement"])
        self.assertTrue(report["significant"])

    def test_rejects_empty_input(self) -> None:
        with self.assertRaises(SequenceAcceptanceError):
            fold_improvement_significance([])


class CostRelevantPrecisionReportTests(unittest.TestCase):
    def test_surfaces_expansion_precision_without_a_verdict(self) -> None:
        metrics = EvaluationMetrics(
            accuracy=0.5,
            balanced_accuracy=0.5,
            macro_f1=0.4,
            sample_count=10,
            class_counts={"EXPANSION": 4, "STABLE": 3, "CONTRACTION": 3},
            per_class={
                "EXPANSION": ClassMetrics(precision=0.5, recall=0.4, f1=0.44, predicted_count=6, actual_count=4),
            },
        )
        report = cost_relevant_precision_report(metrics)
        self.assertEqual(report["expansionPrecision"], 0.5)
        self.assertIsNone(report["verifiedBreakeven"])
        self.assertIn("do not transfer", report["note"])

    def test_missing_class_reports_none_rather_than_zero(self) -> None:
        metrics = EvaluationMetrics(
            accuracy=0.5, balanced_accuracy=0.5, macro_f1=0.4, sample_count=10,
            class_counts={"EXPANSION": 0, "STABLE": 5, "CONTRACTION": 5}, per_class={},
        )
        report = cost_relevant_precision_report(metrics)
        self.assertIsNone(report["expansionPrecision"])


@unittest.skipUnless(TORCH_AVAILABLE, "torch is not installed")
class TcnInferenceAndExplanationTests(unittest.TestCase):
    def _sequence(self) -> SequenceExample:
        lookback = 4
        return SequenceExample(
            candle_id="c-0",
            instrument_id="inst-1",
            symbol="NIFTYBEES",
            timeframe="1m",
            sequence_start_at=START,
            observed_at=START,
            label_available_at=START,
            label="EXPANSION",
            features=tuple(tuple([float(i), float(i) / 2.0]) for i in range(lookback)),
            feature_names=("a", "b"),
            source_candle_ids=tuple(f"c-{i}" for i in range(lookback)),
        )

    def test_benchmark_reports_latency_and_parameter_footprint(self) -> None:
        from ai_quant_lab_ml.tcn_model import build_causal_tcn

        model = build_causal_tcn(n_features=2, n_classes=3, channels=4, dilations=(1, 2))
        model.eval()
        report = benchmark_tcn_inference(
            model, [self._sequence()], medians=[0.0, 0.0], alphabet=VOLATILITY_ALPHABET,
            warmup=1, iterations=3,
        )
        self.assertEqual(report["method"], "TCN_INFERENCE_BENCHMARK_V1")
        self.assertGreaterEqual(report["latencyMsMean"], 0.0)
        self.assertGreater(report["parameterCount"], 0)
        self.assertGreater(report["parameterBytes"], 0)

    def test_benchmark_rejects_empty_sample(self) -> None:
        from ai_quant_lab_ml.tcn_model import build_causal_tcn

        model = build_causal_tcn(n_features=2, n_classes=3, channels=4, dilations=(1, 2))
        with self.assertRaises(SequenceAcceptanceError):
            benchmark_tcn_inference(model, [], medians=[0.0, 0.0], alphabet=VOLATILITY_ALPHABET)

    def test_identical_untrained_model_fails_the_ratio_floor(self) -> None:
        # An "explanation" measured against itself must score a ratio of exactly
        # 1.0 -- below the pass floor -- proving the check does not trivially pass.
        import torch

        from ai_quant_lab_ml.tcn_model import build_causal_tcn

        torch.manual_seed(99)
        model = build_causal_tcn(n_features=2, n_classes=3, channels=4, dilations=(1, 2))
        model.eval()
        result = explanation_sanity_check(
            model,
            self._sequence(),
            medians=[0.0, 0.0],
            alphabet=VOLATILITY_ALPHABET,
            n_features=2,
            channels=4,
            dilations=(1, 2),
            random_state=99,
        )
        self.assertAlmostEqual(result["ratio"], 1.0, places=6)
        self.assertFalse(result["passes"])


if __name__ == "__main__":
    unittest.main()
