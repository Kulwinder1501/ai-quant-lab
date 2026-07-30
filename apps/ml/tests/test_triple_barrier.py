"""Tests for the pure triple-barrier labelling rule."""

from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import (
    LABEL_SCHEME_TRIPLE_BARRIER,
    CandleEvidence,
    DatasetRequest,
    ForwardBar,
    IndicatorEvidence,
)
from ai_quant_lab_ml.features import FeatureConstructionError, build_triple_barrier_examples
from ai_quant_lab_ml.triple_barrier import (
    TripleBarrierError,
    triple_barrier_label,
)


START = datetime(2026, 1, 2, 9, 15, tzinfo=UTC)


def bar(index: int, high: float, low: float, close: float) -> ForwardBar:
    return ForwardBar(high=high, low=low, close=close, close_time=START + timedelta(minutes=index + 1))


def label(**overrides):
    arguments = {
        "source_close": 100.0,
        "atr": 2.0,
        "upper_multiple": 1.0,
        "lower_multiple": 1.0,
    }
    arguments.update(overrides)
    return triple_barrier_label(**arguments)


class TripleBarrierTests(unittest.TestCase):
    # Barriers at 100 +/- 1*2 = [98, 102].

    def test_upper_barrier_first_is_bullish(self) -> None:
        result = label(forward_path=[
            bar(0, high=101.0, low=99.5, close=100.5),   # no touch
            bar(1, high=102.5, low=100.0, close=102.2),  # touches upper 102
        ])
        assert result is not None
        self.assertEqual(result.label, "BULLISH")
        self.assertEqual(result.touched, "UPPER")
        self.assertEqual(result.touch_index, 1)
        # forward_return is measured at the deciding bar's close, not the barrier.
        self.assertAlmostEqual(result.forward_return, 102.2 / 100.0 - 1.0, places=10)

    def test_lower_barrier_first_is_bearish(self) -> None:
        result = label(forward_path=[
            bar(0, high=100.5, low=98.5, close=99.0),   # no touch
            bar(1, high=99.5, low=97.5, close=97.8),    # touches lower 98
        ])
        assert result is not None
        self.assertEqual(result.label, "BEARISH")
        self.assertEqual(result.touched, "LOWER")
        self.assertEqual(result.touch_index, 1)

    def test_no_touch_within_window_is_a_neutral_time_out(self) -> None:
        result = label(forward_path=[
            bar(0, high=101.0, low=99.0, close=100.2),
            bar(1, high=101.5, low=99.2, close=101.0),
            bar(2, high=101.9, low=98.1, close=100.8),  # never reaches 102 or 98
        ])
        assert result is not None
        self.assertEqual(result.label, "NEUTRAL")
        self.assertEqual(result.touched, "VERTICAL")
        self.assertEqual(result.touch_index, 2)

    def test_first_touch_wins_even_if_a_later_bar_would_touch_the_other_side(self) -> None:
        # Upper is touched on bar 0; a later bar breaching the lower must not change it.
        result = label(forward_path=[
            bar(0, high=102.1, low=100.0, close=101.9),  # upper first
            bar(1, high=100.0, low=97.0, close=97.5),    # would have hit lower, but too late
        ])
        assert result is not None
        self.assertEqual(result.label, "BULLISH")
        self.assertEqual(result.touch_index, 0)

    def test_same_bar_double_touch_is_dropped_not_guessed(self) -> None:
        # One bar's range engulfs both barriers; OHLC cannot order the touches.
        result = label(forward_path=[bar(0, high=103.0, low=97.0, close=100.0)])
        self.assertIsNone(result)

    def test_exact_barrier_touch_counts(self) -> None:
        # high exactly equal to the upper barrier must register as a touch.
        result = label(forward_path=[bar(0, high=102.0, low=100.0, close=101.5)])
        assert result is not None
        self.assertEqual(result.label, "BULLISH")

    def test_asymmetric_multiples_move_the_barriers(self) -> None:
        # Upper at 100 + 3*2 = 106 (far); lower at 100 - 0.5*2 = 99 (near).
        result = label(
            upper_multiple=3.0,
            lower_multiple=0.5,
            forward_path=[bar(0, high=105.0, low=98.9, close=100.0)],
        )
        assert result is not None
        self.assertEqual(result.label, "BEARISH")  # near lower barrier hit, far upper not

    def test_empty_forward_path_has_no_label(self) -> None:
        self.assertIsNone(label(forward_path=[]))

    def test_invalid_source_and_atr_are_rejected(self) -> None:
        for bad in (0.0, -1.0, float("nan"), float("inf")):
            with self.assertRaises(TripleBarrierError):
                label(source_close=bad, forward_path=[bar(0, 102.5, 100.0, 102.0)])
            with self.assertRaises(TripleBarrierError):
                label(atr=bad, forward_path=[bar(0, 102.5, 100.0, 102.0)])

    def test_invalid_multiples_are_rejected(self) -> None:
        with self.assertRaises(TripleBarrierError):
            label(upper_multiple=0.0, forward_path=[bar(0, 102.5, 100.0, 102.0)])
        with self.assertRaises(TripleBarrierError):
            label(lower_multiple=-1.0, forward_path=[bar(0, 102.5, 100.0, 102.0)])

    def test_a_malformed_forward_bar_is_rejected(self) -> None:
        with self.assertRaises(TripleBarrierError):
            label(forward_path=[ForwardBar(high=99.0, low=101.0, close=100.0, close_time=START)])

    def test_touch_close_time_is_the_deciding_bars_close(self) -> None:
        deciding = bar(2, high=102.5, low=100.0, close=102.1)
        result = label(forward_path=[
            bar(0, high=101.0, low=99.5, close=100.5),
            bar(1, high=101.5, low=99.0, close=100.2),
            deciding,
        ])
        assert result is not None
        self.assertEqual(result.touch_close_time, deciding.close_time)


WINDOW_START = datetime(2026, 1, 1, tzinfo=UTC)
WINDOW_END = datetime(2026, 3, 1, tzinfo=UTC)


def source_candle(index, close, atr, path):
    """A source CandleEvidence whose forward path is `path` = [(high, low, close), ...].

    Forward bars are placed one day apart after the source close. `atr=None` omits
    the ATR indicator so the "no volatility scale" skip can be exercised.
    """

    open_time = datetime(2026, 1, 2, tzinfo=UTC) + timedelta(days=index)
    close_time = open_time + timedelta(hours=6)
    indicators = (
        ()
        if atr is None
        else (IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": atr}),)
    )
    forward = tuple(
        ForwardBar(high=high, low=low, close=bar_close, close_time=close_time + timedelta(days=step + 1))
        for step, (high, low, bar_close) in enumerate(path)
    )
    return CandleEvidence(
        candle_id=f"c-{index}",
        instrument_id="i-1",
        symbol="NIFTY50",
        timeframe="1d",
        open_time=open_time,
        close_time=close_time,
        open=close,
        high=close + 1.0,
        low=close - 1.0,
        close=close,
        volume=1_000.0,
        indicators=indicators,
        patterns=(),
        price_action_events=(),
        future_close=None,
        future_close_time=None,
        forward_path=forward,
    )


def tb_request(**overrides):
    arguments = dict(
        instrument_symbol="NIFTY50",
        timeframe="1d",
        data_window_start=WINDOW_START,
        data_window_end=WINDOW_END,
        data_cutoff_at=WINDOW_END,
        horizon_bars=3,
        neutral_threshold_bps=50.0,
        label_scheme=LABEL_SCHEME_TRIPLE_BARRIER,
        barrier_upper_multiple=1.0,
        barrier_lower_multiple=1.0,
    )
    arguments.update(overrides)
    return DatasetRequest(**arguments)


class BuildTripleBarrierExamplesTests(unittest.TestCase):
    # Barriers at close 100, atr 2 => [98, 102].

    def test_upper_touch_becomes_a_bullish_example_with_features(self) -> None:
        candle = source_candle(0, 100.0, 2.0, [(102.5, 100.0, 102.2)])
        examples = build_triple_barrier_examples([candle], tb_request())

        self.assertEqual(len(examples), 1)
        example = examples[0]
        self.assertEqual(example.label, "BULLISH")
        # The label became known at the touching bar's close, not a fixed horizon.
        self.assertEqual(example.label_available_at, candle.close_time + timedelta(days=1))
        self.assertAlmostEqual(example.forward_return, 102.2 / 100.0 - 1.0, places=10)
        # It carries the same feature schema as the fixed-horizon builder.
        self.assertIn("candle.close_return_bps", example.features)

    def test_lower_touch_becomes_bearish_and_timeout_becomes_neutral(self) -> None:
        bearish = source_candle(0, 100.0, 2.0, [(100.5, 97.5, 97.9)])
        # A genuine time-out needs a FULL path (horizon_bars=3 bars), none touching.
        neutral = source_candle(1, 100.0, 2.0, [(101.0, 99.0, 100.1), (101.5, 99.2, 100.4), (101.8, 98.5, 100.6)])
        examples = build_triple_barrier_examples([bearish, neutral], tb_request())

        by_id = {example.candle_id: example.label for example in examples}
        self.assertEqual(by_id["c-0"], "BEARISH")
        self.assertEqual(by_id["c-1"], "NEUTRAL")

    def test_a_short_no_touch_path_is_censored_not_a_neutral(self) -> None:
        # Only 1 of the 3 vertical-barrier bars available and no touch: a later bar
        # could still touch a barrier, so this is unknown and must be dropped.
        candle = source_candle(0, 100.0, 2.0, [(101.0, 99.0, 100.2)])
        self.assertEqual(build_triple_barrier_examples([candle], tb_request(horizon_bars=3)), [])

    def test_a_candle_without_atr_is_skipped(self) -> None:
        candle = source_candle(0, 100.0, None, [(102.5, 100.0, 102.2)])
        self.assertEqual(build_triple_barrier_examples([candle], tb_request()), [])

    def test_an_empty_forward_path_is_skipped(self) -> None:
        candle = source_candle(0, 100.0, 2.0, [])
        self.assertEqual(build_triple_barrier_examples([candle], tb_request()), [])

    def test_a_same_bar_double_touch_is_skipped(self) -> None:
        candle = source_candle(0, 100.0, 2.0, [(103.0, 97.0, 100.0)])
        self.assertEqual(build_triple_barrier_examples([candle], tb_request()), [])

    def test_a_label_after_the_data_window_is_rejected(self) -> None:
        candle = source_candle(0, 100.0, 2.0, [(102.5, 100.0, 102.2)])
        # Window ends between the source close and the forward bar, so the label
        # would fall outside the immutable window.
        tight_end = candle.close_time + timedelta(hours=1)
        with self.assertRaises(FeatureConstructionError):
            build_triple_barrier_examples([candle], tb_request(data_window_end=tight_end, data_cutoff_at=tight_end))

    def test_invalid_barrier_multiples_are_rejected(self) -> None:
        candle = source_candle(0, 100.0, 2.0, [(102.5, 100.0, 102.2)])
        with self.assertRaises(FeatureConstructionError):
            build_triple_barrier_examples([candle], tb_request(barrier_upper_multiple=0.0))

    def test_the_fixed_horizon_defaults_leave_the_request_scheme_intact(self) -> None:
        # A default request is still fixed-horizon; the triple-barrier fields are
        # additive and do not change an untouched caller.
        default = DatasetRequest(
            instrument_symbol="NIFTY50",
            timeframe="1d",
            data_window_start=WINDOW_START,
            data_window_end=WINDOW_END,
            data_cutoff_at=WINDOW_END,
            horizon_bars=5,
            neutral_threshold_bps=50.0,
        )
        self.assertEqual(default.label_scheme, "fixed-horizon-v1")
        self.assertEqual(default.barrier_upper_multiple, 1.0)
        self.assertEqual(default.barrier_lower_multiple, 1.0)


if __name__ == "__main__":
    unittest.main()
