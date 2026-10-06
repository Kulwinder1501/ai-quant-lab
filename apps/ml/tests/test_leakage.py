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


def no_skill_dataset(rows: int = 320, seed: int = 5) -> list[LabeledExample]:
    """Labels drawn independently of every feature: the model cannot beat chance.

    This is the shape the real 5-bar direction target turned out to have — every
    algorithm at or below the three-class baseline. The audit must not describe
    that as leakage.
    """

    generator = random.Random(seed)
    labels = ("BULLISH", "BEARISH", "NEUTRAL")
    examples: list[LabeledExample] = []
    for index in range(rows):
        label = generator.choice(labels)
        features = with_noise(generator, signal=generator.gauss(0.0, 1.0), momentum=generator.gauss(0.0, 1.0))
        examples.append(example(index, label, features))
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

    def test_a_no_skill_model_passes_without_leakage_shaped_failures(self) -> None:
        """A model at or below the random baseline must not be reported as leaking.

        Feature-lag and era-holdout are uninterpretable when there is no skill to
        trace, and previously both reported FAILED for a no-skill model, burying
        the real "the target has no edge" conclusion under a false leakage alarm.
        """

        # Seed pinned to one whose deterministic holdout lands below the baseline;
        # a small random-label holdout scores either side of 1/3 depending on seed,
        # and this test is specifically about the below-baseline branch.
        audit = self.audit(no_skill_dataset(seed=2))

        # Precondition: the fixture really is no-skill.
        self.assertLessEqual(audit["metrics"]["baseMacroF1"], RANDOM_BASELINE_MACRO_F1)

        names = [check["check"] for check in audit["checks"]]
        self.assertEqual(names, ["LABEL_SHUFFLE", "NO_SKILL_TO_AUDIT"])
        self.assertNotIn("FEATURE_LAG", names)
        self.assertNotIn("ERA_HOLDOUT", names)

        # The short-circuit is a clean PASS, not an INVESTIGATE, and stays conclusive.
        self.assertEqual(audit["verdict"], "PASS")
        self.assertEqual(audit["failedChecks"], [])
        self.assertTrue(audit_is_conclusive(audit))

        # Label-shuffle still runs — it is what actually rules out leakage.
        shuffle = next(check for check in audit["checks"] if check["check"] == "LABEL_SHUFFLE")
        self.assertEqual(shuffle["status"], "PASS")

    def test_feature_lag_is_inconclusive_not_failed_for_a_persistent_target(self) -> None:
        """The check's premise does not hold for a persistence-dominated target.

        ``persistent_dataset`` is exactly that shape: a slow-drifting state, so the
        previous bar's features predict about as well as the current bar's. For a
        directional target that pattern is a leakage smell and must FAIL. For a
        target that is *known* to be persistent -- volatility clusters -- a near-zero
        degradation is expected, and calling it leakage buried the real finding.
        """

        examples = persistent_dataset()

        # Default (transient assumption): still a hard failure. Not weakened.
        strict = self.audit(examples)
        strict_lag = next(check for check in strict["checks"] if check["check"] == "FEATURE_LAG")
        self.assertEqual(strict_lag["status"], "FAILED")
        self.assertEqual(strict["verdict"], "INVESTIGATE")

        # Declared persistent: reported as inconclusive, and it no longer blocks.
        lenient = self.audit(examples, persistence_dominated=True)
        lenient_lag = next(check for check in lenient["checks"] if check["check"] == "FEATURE_LAG")
        self.assertEqual(lenient_lag["status"], "INCONCLUSIVE")
        self.assertEqual(lenient["verdict"], "PASS")
        self.assertNotIn("FEATURE_LAG", lenient["failedChecks"])
        self.assertIn("FEATURE_LAG", lenient["inconclusiveChecks"])

        # It is never upgraded to PASS, and the number is still reported.
        self.assertNotEqual(lenient_lag["status"], "PASS")
        self.assertEqual(lenient_lag["metrics"]["degradation"], strict_lag["metrics"]["degradation"])
        self.assertTrue(lenient_lag["metrics"]["persistenceDominated"])
        # The summary must not claim every check passed when one could not decide.
        self.assertNotIn("All", lenient["summary"])
        self.assertIn("could not discriminate", lenient["summary"])

    def test_a_persistent_flag_cannot_mask_a_real_leak(self) -> None:
        """LABEL_SHUFFLE still blocks, so the flag is not a general escape hatch."""

        examples = persistent_dataset()
        # An impossibly low ceiling forces the shuffle check to fail, standing in for
        # a pipeline that learns from row structure.
        audit = self.audit(examples, persistence_dominated=True, shuffle_ceiling=0.0)

        self.assertEqual(audit["verdict"], "INVESTIGATE")
        self.assertIn("LABEL_SHUFFLE", audit["failedChecks"])

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
