"""Tests for the volatility-expansion labelling rule."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import ForwardBar
from ai_quant_lab_ml.volatility_expansion import (
    VOLATILITY_LABELS,
    VolatilityExpansionError,
    trailing_range_of,
    volatility_expansion_label,
)

START = datetime(2026, 1, 2, tzinfo=UTC)


def path(*ranges: tuple[float, float]) -> list[ForwardBar]:
    """Forward bars from (high, low) pairs, one day apart."""
    return [
        ForwardBar(high=high, low=low, close=(high + low) / 2, close_time=START + timedelta(days=index + 1))
        for index, (high, low) in enumerate(ranges)
    ]


def label(**overrides):
    arguments = {
        "trailing_range": 10.0,
        "expected_forward_bars": 2,
        "band": 0.25,
    }
    arguments.update(overrides)
    return volatility_expansion_label(**arguments)


class VolatilityExpansionTests(unittest.TestCase):
    # trailing_range 10, band 0.25 => EXPANSION at >= 12.5, CONTRACTION at <= 8.0.

    def test_a_wider_forward_envelope_is_expansion(self) -> None:
        # Envelope 105..90 = 15 -> ratio 1.5
        result = label(forward_path=path((105.0, 95.0), (100.0, 90.0)))
        assert result is not None
        self.assertEqual(result.label, "EXPANSION")
        self.assertAlmostEqual(result.range_ratio, 1.5, places=10)
        self.assertAlmostEqual(result.forward_range, 15.0, places=10)

    def test_a_narrower_forward_envelope_is_contraction(self) -> None:
        # Envelope 101..96 = 5 -> ratio 0.5
        result = label(forward_path=path((101.0, 97.0), (100.0, 96.0)))
        assert result is not None
        self.assertEqual(result.label, "CONTRACTION")
        self.assertAlmostEqual(result.range_ratio, 0.5, places=10)

    def test_a_similar_envelope_is_stable(self) -> None:
        # Envelope 105..95 = 10 -> ratio 1.0
        result = label(forward_path=path((105.0, 98.0), (102.0, 95.0)))
        assert result is not None
        self.assertEqual(result.label, "STABLE")
        self.assertAlmostEqual(result.range_ratio, 1.0, places=10)

    def test_the_envelope_spans_the_whole_window_not_single_bars(self) -> None:
        # No single bar is wide, but the window high-low is 110-90 = 20 -> 2.0.
        result = label(forward_path=path((110.0, 108.0), (92.0, 90.0)))
        assert result is not None
        self.assertAlmostEqual(result.range_ratio, 2.0, places=10)
        self.assertEqual(result.label, "EXPANSION")

    def test_thresholds_are_multiplicatively_symmetric(self) -> None:
        """2x wider and 2x narrower must be the symmetric pair, not 1+band/1-band."""
        # Exactly at the expansion threshold 1.25 -> EXPANSION (inclusive).
        at_expansion = label(forward_path=path((112.5, 100.0), (112.5, 100.0)))
        assert at_expansion is not None
        self.assertEqual(at_expansion.label, "EXPANSION")
        # Exactly at the reciprocal threshold 1/1.25 = 0.8 -> CONTRACTION (inclusive).
        at_contraction = label(forward_path=path((108.0, 100.0), (108.0, 100.0)))
        assert at_contraction is not None
        self.assertAlmostEqual(at_contraction.range_ratio, 0.8, places=10)
        self.assertEqual(at_contraction.label, "CONTRACTION")

    def test_a_short_forward_window_is_censored(self) -> None:
        # Only 1 of 2 expected bars: the envelope is incomplete and would look
        # artificially narrow, manufacturing a false CONTRACTION.
        self.assertIsNone(label(forward_path=path((105.0, 95.0)), expected_forward_bars=2))

    def test_an_empty_forward_window_is_censored(self) -> None:
        self.assertIsNone(label(forward_path=[]))

    def test_a_flat_trailing_window_has_no_scale(self) -> None:
        self.assertIsNone(label(trailing_range=0.0, forward_path=path((105.0, 95.0), (100.0, 90.0))))
        self.assertIsNone(label(trailing_range=-1.0, forward_path=path((105.0, 95.0), (100.0, 90.0))))

    def test_invalid_band_and_window_length_are_rejected(self) -> None:
        for bad_band in (0.0, -0.5, float("nan")):
            with self.assertRaises(VolatilityExpansionError):
                label(band=bad_band, forward_path=path((105.0, 95.0), (100.0, 90.0)))
        with self.assertRaises(VolatilityExpansionError):
            label(expected_forward_bars=0, forward_path=path((105.0, 95.0)))

    def test_a_malformed_forward_bar_is_rejected(self) -> None:
        bad = [ForwardBar(high=90.0, low=100.0, close=95.0, close_time=START)]
        with self.assertRaises(VolatilityExpansionError):
            label(forward_path=bad, expected_forward_bars=1)

    def test_label_available_at_is_the_end_of_the_forward_window(self) -> None:
        bars = path((105.0, 95.0), (100.0, 90.0))
        result = label(forward_path=bars)
        assert result is not None
        self.assertEqual(result.label_available_at, bars[-1].close_time)

    def test_the_label_alphabet_is_not_the_directional_one(self) -> None:
        """A vol label must never be mistakable for a trade direction."""
        self.assertEqual(VOLATILITY_LABELS, ("CONTRACTION", "STABLE", "EXPANSION"))
        for directional in ("BULLISH", "BEARISH", "NEUTRAL"):
            self.assertNotIn(directional, VOLATILITY_LABELS)

    def test_trailing_range_helper(self) -> None:
        self.assertAlmostEqual(trailing_range_of([10.0, 12.0, 11.0], [8.0, 9.0, 7.0]), 5.0, places=10)
        self.assertEqual(trailing_range_of([], []), 0.0)


if __name__ == "__main__":
    unittest.main()


class GoldenVectorParityTests(unittest.TestCase):
    """The same vectors apps/api asserts against its TypeScript settlement grader.

    The volatility rule has two implementations: this module labels bars for training,
    and ``volatility-expansion-label.ts`` grades live predictions at settlement.
    Nothing in either codebase forces them to agree, so a drift would silently make a
    model's live scoreboard measure something other than what it was trained on. These
    vectors are the only thing pinning them together -- if this test fails, the
    TypeScript suite is now wrong too, and vice versa.
    """

    GOLDEN = (
        Path(__file__).resolve().parents[2]
        / "api" / "src" / "modules" / "model-predictions" / "domain"
        / "volatility-expansion-golden.json"
    )

    def test_golden_file_is_present(self) -> None:
        self.assertTrue(
            self.GOLDEN.is_file(),
            f"Shared golden vectors missing at {self.GOLDEN}. The two implementations are unpinned.",
        )

    def test_python_labeller_matches_every_shared_vector(self) -> None:
        payload = json.loads(self.GOLDEN.read_text(encoding="utf-8"))
        self.assertGreater(len(payload["cases"]), 0, "The golden file declares no cases.")

        for case in payload["cases"]:
            with self.subTest(case=case["name"]):
                forward_path = [
                    ForwardBar(
                        high=high,
                        low=case["forwardLows"][index],
                        close=high,
                        close_time=datetime(2026, 1, 5 + index, tzinfo=UTC),
                    )
                    for index, high in enumerate(case["forwardHighs"])
                ]
                result = volatility_expansion_label(
                    trailing_range=case["trailingRange"],
                    forward_path=forward_path,
                    expected_forward_bars=len(forward_path),
                    band=case["band"],
                )
                self.assertIsNotNone(result, "Vector should be measurable.")
                assert result is not None
                self.assertEqual(result.label, case["expectedLabel"])
                self.assertAlmostEqual(result.range_ratio, case["expectedRatio"], places=8)
