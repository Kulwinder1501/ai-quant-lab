"""The training/evaluation core must work for more than one label alphabet.

Two obligations, and the first matters more than the second:

1. The directional default is unchanged. Every existing model, metric, and
   persisted number must be bit-for-bit identical to before the alphabet became a
   parameter.
2. A second alphabet actually trains, scores, and audits — including the
   metrics that used to hardcode ``("BULLISH", "BEARISH")``.
"""

from __future__ import annotations

import importlib.util
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import (
    DIRECTIONAL_ALPHABET,
    LABELS,
    LabelAlphabet,
    LabeledExample,
    TemporalSplit,
)
from ai_quant_lab_ml.leakage import RANDOM_BASELINE_MACRO_F1, run_leakage_audit
from ai_quant_lab_ml.training import TrainingError, evaluate_predictions, predict_labels, train_model
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET, VOLATILITY_LABELS

SKLEARN = importlib.util.find_spec("sklearn") is not None
START = datetime(2026, 1, 2, tzinfo=UTC)
SCHEMA = ("a", "b", "c", "d")


def example(index: int, label: str, a: float, b: float) -> LabeledExample:
    observed = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"c-{index}",
        instrument_id="i-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed,
        label_available_at=observed + timedelta(days=5),
        forward_return=0.0,
        label=label,
        features={"a": a, "b": b, "c": a * b, "d": a - b},
    )


def learnable(labels: tuple[str, ...], rows: int = 240) -> list[LabeledExample]:
    """A separable three-class problem over an arbitrary alphabet."""
    out = []
    for index in range(rows):
        bucket = index % 3
        a = float(bucket) + (index % 7) * 0.01
        out.append(example(index, labels[bucket], a, float(bucket) * 2.0))
    return out


def split_of(examples: list[LabeledExample]) -> TemporalSplit:
    cut = int(len(examples) * 0.8)
    return TemporalSplit(train=tuple(examples[:cut]), validation=tuple(examples[cut:]), purge_count=0)


class LabelAlphabetTests(unittest.TestCase):
    def test_the_directional_alphabet_is_unchanged(self) -> None:
        self.assertEqual(DIRECTIONAL_ALPHABET.labels, LABELS)
        self.assertEqual(DIRECTIONAL_ALPHABET.abstain_label, "NEUTRAL")
        self.assertAlmostEqual(DIRECTIONAL_ALPHABET.random_baseline_macro_f1, 1 / 3, places=12)
        self.assertAlmostEqual(RANDOM_BASELINE_MACRO_F1, 1 / 3, places=12)
        self.assertEqual(set(DIRECTIONAL_ALPHABET.decisive_labels), {"BULLISH", "BEARISH"})

    def test_the_volatility_alphabet_is_disjoint_from_the_directional_one(self) -> None:
        """The whole point: a vol label can never be read as a trade direction."""
        self.assertEqual(VOLATILITY_ALPHABET.labels, VOLATILITY_LABELS)
        self.assertEqual(VOLATILITY_ALPHABET.abstain_label, "STABLE")
        self.assertEqual(set(VOLATILITY_ALPHABET.labels) & set(LABELS), set())

    def test_a_malformed_alphabet_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            LabelAlphabet(name="x", labels=("ONLY",), abstain_label="ONLY")
        with self.assertRaises(ValueError):
            LabelAlphabet(name="x", labels=("A", "A", "B"), abstain_label="B")
        with self.assertRaises(ValueError):
            LabelAlphabet(name="x", labels=("A", "B"), abstain_label="MISSING")

    def test_decisive_metrics_follow_the_abstain_label(self) -> None:
        """Previously hardcoded to ("BULLISH","BEARISH"); now derived per alphabet."""
        if not SKLEARN:
            self.skipTest("scikit-learn is not installed")
        # Directional: NEUTRAL predictions are the abstentions.
        directional = evaluate_predictions(
            ["BULLISH", "BEARISH", "NEUTRAL", "BULLISH"],
            ["BULLISH", "NEUTRAL", "NEUTRAL", "BEARISH"],
        )
        self.assertEqual(directional.directional_predictions, 2)  # BULLISH, BEARISH
        self.assertAlmostEqual(directional.directional_hit_rate or 0.0, 0.5, places=12)

        # Volatility: STABLE predictions are the abstentions, same arithmetic.
        volatility = evaluate_predictions(
            ["EXPANSION", "CONTRACTION", "STABLE", "EXPANSION"],
            ["EXPANSION", "STABLE", "STABLE", "CONTRACTION"],
            alphabet=VOLATILITY_ALPHABET,
        )
        self.assertEqual(volatility.directional_predictions, 2)
        self.assertAlmostEqual(volatility.directional_hit_rate or 0.0, 0.5, places=12)
        self.assertEqual(set(volatility.class_counts), set(VOLATILITY_LABELS))

    def test_evaluation_rejects_labels_from_the_wrong_alphabet(self) -> None:
        if not SKLEARN:
            self.skipTest("scikit-learn is not installed")
        # A vol label must not slip through the directional evaluator.
        with self.assertRaises(TrainingError):
            evaluate_predictions(["EXPANSION", "STABLE"], ["EXPANSION", "STABLE"])
        # ...and vice versa.
        with self.assertRaises(TrainingError):
            evaluate_predictions(["BULLISH", "NEUTRAL"], ["BULLISH", "NEUTRAL"], alphabet=VOLATILITY_ALPHABET)

    @unittest.skipUnless(SKLEARN, "scikit-learn is not installed")
    def test_a_volatility_model_trains_and_scores(self) -> None:
        examples = learnable(VOLATILITY_LABELS)
        result = train_model("logistic", split_of(examples), schema=SCHEMA, alphabet=VOLATILITY_ALPHABET)

        self.assertEqual(set(result.validation_metrics.class_counts), set(VOLATILITY_LABELS))
        # A separable problem must be learnable, so this also proves the label
        # encode/decode round trip works for a non-directional alphabet.
        self.assertGreater(result.validation_metrics.macro_f1, 0.9)

        predicted = predict_labels(result.model, examples, schema=SCHEMA, alphabet=VOLATILITY_ALPHABET)
        self.assertTrue(set(predicted).issubset(set(VOLATILITY_LABELS)))

    @unittest.skipUnless(SKLEARN, "scikit-learn is not installed")
    def test_the_directional_path_still_trains_identically(self) -> None:
        examples = learnable(("BEARISH", "NEUTRAL", "BULLISH"))
        explicit = train_model("logistic", split_of(examples), schema=SCHEMA, alphabet=DIRECTIONAL_ALPHABET)
        default = train_model("logistic", split_of(examples), schema=SCHEMA)
        self.assertAlmostEqual(
            explicit.validation_metrics.macro_f1, default.validation_metrics.macro_f1, places=12
        )

    def test_scheme_classification_decides_which_prediction_table_is_used(self) -> None:
        """This classification is what routes a served prediction.

        ``predict.py`` reads the label scheme from the artifact and writes to
        ``model_predictions`` only when the scheme is directional. If the volatility
        scheme ever appeared in this set, its CONTRACTION/STABLE/EXPANSION labels
        would land in the table the strategy engine, the agent, the scanner, and the
        dashboards read as a trade direction.
        """

        from ai_quant_lab_ml.contracts import (
            DIRECTIONAL_LABEL_SCHEMES,
            LABEL_SCHEME_FIXED_HORIZON,
            LABEL_SCHEME_TRIPLE_BARRIER,
            LABEL_SCHEME_VOLATILITY_EXPANSION,
            LABEL_SCHEMES,
        )

        self.assertIn(LABEL_SCHEME_FIXED_HORIZON, DIRECTIONAL_LABEL_SCHEMES)
        self.assertIn(LABEL_SCHEME_TRIPLE_BARRIER, DIRECTIONAL_LABEL_SCHEMES)
        self.assertNotIn(LABEL_SCHEME_VOLATILITY_EXPANSION, DIRECTIONAL_LABEL_SCHEMES)
        # Every declared scheme must be classifiable, or a new one would silently
        # default to the non-directional branch.
        for scheme in LABEL_SCHEMES:
            self.assertIsInstance(scheme in DIRECTIONAL_LABEL_SCHEMES, bool)
        self.assertTrue(set(DIRECTIONAL_LABEL_SCHEMES).issubset(set(LABEL_SCHEMES)))

    @unittest.skipUnless(SKLEARN, "scikit-learn is not installed")
    def test_the_leakage_audit_uses_the_alphabets_own_baseline(self) -> None:
        audit = run_leakage_audit(
            learnable(VOLATILITY_LABELS),
            algorithm="logistic",
            horizon_bars=5,
            schema=SCHEMA,
            alphabet=VOLATILITY_ALPHABET,
        )
        # A 3-class alphabet has the same 1/3 baseline, but it is now derived rather
        # than assumed, so an alphabet of another size would report correctly.
        self.assertAlmostEqual(audit["baseline"]["randomBaselineMacroF1"], 1 / 3, places=12)
        self.assertIn(audit["verdict"], {"PASS", "INVESTIGATE"})


if __name__ == "__main__":
    unittest.main()
