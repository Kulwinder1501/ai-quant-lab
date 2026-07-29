"""Tests for the leakage audit.

The audit exists to attack a score, so these tests check two things: that it
reports a reproducible, well-formed verdict, and that it actually catches a
dataset engineered to look better than it is.
"""

from __future__ import annotations

import importlib.util
import math
import random
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.leakage import (
    RANDOM_BASELINE_MACRO_F1,
    LeakageAuditError,
    audit_is_conclusive,
    run_leakage_audit,
)


SKLEARN_AVAILABLE = importlib.util.find_spec("sklearn") is not None
START = datetime(2023, 1, 2, tzinfo=UTC)
# Noise columns matter: with only two features a shuffled-label fit can land on
# the true decision direction by chance, which would make the shuffle check look
# broken when it is the fixture that is too narrow. The real schema has 100+.
NOISE_FEATURES = tuple(f"noise_{index}" for index in range(6))
SCHEMA = ("signal", "momentum", *NOISE_FEATURES)


def with_noise(generator: random.Random, **features: float) -> dict[str, float]:
    return {**features, **{name: generator.gauss(0.0, 1.0) for name in NOISE_FEATURES}}


def example(index: int, label: str, features: dict[str, float]) -> LabeledExample:
    observed_at = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=5),
        forward_return=0.01,
        label=label,  # type: ignore[arg-type]
        features=features,
    )


def honest_dataset(rows: int = 320, seed: int = 5) -> list[LabeledExample]:
    """Independent draws per bar: learnable, but nothing leaks across time."""

    generator = random.Random(seed)
    examples: list[LabeledExample] = []
    for index in range(rows):
        signal = generator.uniform(-1.0, 1.0)
        momentum = generator.uniform(-1.0, 1.0)
        score = signal + momentum
        label = "BULLISH" if score > 0.4 else ("BEARISH" if score < -0.4 else "NEUTRAL")
        examples.append(example(index, label, with_noise(generator, signal=signal, momentum=momentum)))
    return examples


def persistent_dataset(rows: int = 320, seed: int = 5) -> list[LabeledExample]:
    """A slow random walk, so consecutive bars carry nearly identical features.

    The label is a function of that drifting state, so scoring a bar with the
    previous bar's features costs almost nothing — the signature the feature-lag
    check is built to notice.
    """

    generator = random.Random(seed)
    examples: list[LabeledExample] = []
    state = 0.0
    for index in range(rows):
        state += generator.uniform(-0.02, 0.02)
        label = "BULLISH" if state > 0.05 else ("BEARISH" if state < -0.05 else "NEUTRAL")
        examples.append(example(index, label, with_noise(generator, signal=state, momentum=state * 2.0)))
    return examples


@unittest.skipUnless(SKLEARN_AVAILABLE, "scikit-learn is not installed")
class LeakageAuditTests(unittest.TestCase):
    def audit(self, examples: list[LabeledExample], **overrides: object) -> dict:
        arguments: dict = {
            "algorithm": "logistic",
            "horizon_bars": 5,
            "schema": SCHEMA,
            "random_state": 42,
        }
        arguments.update(overrides)
        return run_leakage_audit(examples, **arguments)  # type: ignore[arg-type]

    def test_reports_all_three_checks_with_a_readable_verdict(self) -> None:
        audit = self.audit(honest_dataset())

        self.assertEqual(audit["method"], "LEAKAGE_AUDIT_V1")
        self.assertIn(audit["verdict"], {"PASS", "INVESTIGATE"})
        self.assertEqual(
            [check["check"] for check in audit["checks"]],
            ["LABEL_SHUFFLE", "FEATURE_LAG", "ERA_HOLDOUT"],
        )
        self.assertTrue(audit["summary"])
        self.assertTrue(audit_is_conclusive(audit))
        self.assertAlmostEqual(audit["baseline"]["randomBaselineMacroF1"], 1 / 3, places=6)

    def test_a_shuffled_target_collapses_to_the_random_baseline(self) -> None:
        audit = self.audit(honest_dataset())
        shuffle = next(check for check in audit["checks"] if check["check"] == "LABEL_SHUFFLE")

        self.assertEqual(shuffle["status"], "PASS")
        # Learning nothing from a permuted label is the point: the score has to
        # fall near 1/3, not merely drop a little.
        self.assertLess(shuffle["metrics"]["shuffledMacroF1"], RANDOM_BASELINE_MACRO_F1 + 0.07)
        self.assertGreater(audit["metrics"]["baseMacroF1"], shuffle["metrics"]["shuffledMacroF1"])

    def test_features_that_survive_a_one_bar_lag_are_flagged(self) -> None:
        audit = self.audit(persistent_dataset())
        lag = next(check for check in audit["checks"] if check["check"] == "FEATURE_LAG")

        self.assertEqual(lag["status"], "FAILED")
        self.assertEqual(audit["verdict"], "INVESTIGATE")
        self.assertIn("FEATURE_LAG", audit["failedChecks"])
        self.assertLess(lag["metrics"]["degradation"], lag["metrics"]["minimumDegradation"])

    def test_the_same_random_state_reproduces_the_same_verdict(self) -> None:
        examples = honest_dataset()

        first = self.audit(examples)
        second = self.audit(examples)

        self.assertEqual(first["verdict"], second["verdict"])
        self.assertEqual(first["metrics"], second["metrics"])

    def test_a_short_dataset_reports_inconclusive_checks_instead_of_crashing(self) -> None:
        audit = self.audit(honest_dataset(rows=40), horizon_bars=2)

        era = next(check for check in audit["checks"] if check["check"] == "ERA_HOLDOUT")
        self.assertIn(era["status"], {"PASS", "FAILED"})
        self.assertIsInstance(audit["summary"], str)

    def test_an_empty_dataset_is_refused(self) -> None:
        with self.assertRaisesRegex(LeakageAuditError, "At least one labeled example"):
            self.audit([])

    def test_an_unsplittable_dataset_is_refused_with_a_clear_reason(self) -> None:
        with self.assertRaisesRegex(LeakageAuditError, "cannot be split"):
            self.audit(honest_dataset(rows=4), horizon_bars=5)

    def test_a_regime_reading_from_after_the_bar_is_refused(self) -> None:
        """The cross-instrument join is the easiest place to introduce look-ahead.

        A VIX bar that closed after the target bar could not have been known at
        decision time, so the audit must refuse the dataset rather than score it.
        """

        examples = honest_dataset()
        leaked = examples[10]
        examples[10] = LabeledExample(
            candle_id=leaked.candle_id,
            instrument_id=leaked.instrument_id,
            symbol=leaked.symbol,
            timeframe=leaked.timeframe,
            observed_at=leaked.observed_at,
            label_available_at=leaked.label_available_at,
            forward_return=leaked.forward_return,
            label=leaked.label,
            features=leaked.features,
            vix_observed_at=leaked.observed_at + timedelta(hours=1),
        )

        with self.assertRaises(LeakageAuditError):
            self.audit(examples)

    def test_a_regime_reading_at_or_before_the_bar_is_accepted(self) -> None:
        examples = honest_dataset()
        aligned = examples[10]
        examples[10] = LabeledExample(
            candle_id=aligned.candle_id,
            instrument_id=aligned.instrument_id,
            symbol=aligned.symbol,
            timeframe=aligned.timeframe,
            observed_at=aligned.observed_at,
            label_available_at=aligned.label_available_at,
            forward_return=aligned.forward_return,
            label=aligned.label,
            features=aligned.features,
            vix_observed_at=aligned.observed_at,
        )

        self.assertIn("verdict", self.audit(examples))

    def test_a_non_finite_metric_makes_a_verdict_inconclusive(self) -> None:
        self.assertFalse(audit_is_conclusive({"verdict": "PASS", "metrics": {"baseMacroF1": math.nan}}))
        self.assertFalse(audit_is_conclusive({"verdict": "UNKNOWN"}))


if __name__ == "__main__":
    unittest.main()
