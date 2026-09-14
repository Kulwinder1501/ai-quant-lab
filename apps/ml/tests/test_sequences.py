"""Tests for intrasession sequence construction and purged CV."""

from __future__ import annotations

import math
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.sequences import (
    SequenceError,
    build_intrasession_sequences,
    flatten_lag_features,
    intervals_overlap,
    sequence_purged_walk_forward,
)


START = datetime(2026, 3, 2, 3, 45, tzinfo=UTC)  # 09:15 IST


def bar(index: int, *, session_offset_days: int = 0, label: str = "STABLE") -> LabeledExample:
    observed = START + timedelta(days=session_offset_days, minutes=index)
    return LabeledExample(
        candle_id=f"c-{session_offset_days}-{index}",
        instrument_id="inst-1",
        symbol="NIFTYBEES",
        timeframe="1m",
        observed_at=observed,
        label_available_at=observed + timedelta(minutes=5),
        forward_return=0.0,
        label=label,  # type: ignore[arg-type]
        features={"a": float(index), "b": float(index) / 10.0},
    )


class SequenceBuilderTests(unittest.TestCase):
    def test_builds_intrasession_windows_and_rejects_gaps(self) -> None:
        session = [bar(i) for i in range(10)]
        # Drop minute 5 → windows that need that bar are rejected.
        gapped = session[:5] + session[6:]
        sequences = build_intrasession_sequences(
            gapped, lookback=4, feature_names=("a", "b"), timeframe="1m",
        )
        self.assertTrue(sequences)
        self.assertTrue(all(seq.lookback == 4 for seq in sequences))
        # No window may include the gap between index 4 and 6.
        for seq in sequences:
            ids = seq.source_candle_ids
            self.assertFalse("c-0-4" in ids and "c-0-6" in ids and "c-0-5" not in ids)

    def test_does_not_cross_sessions(self) -> None:
        day1 = [bar(i, session_offset_days=0) for i in range(6)]
        day2 = [bar(i, session_offset_days=1) for i in range(6)]
        sequences = build_intrasession_sequences(
            day1 + day2, lookback=4, feature_names=("a", "b"), timeframe="1m",
        )
        from ai_quant_lab_ml.sequences import _ist_session_key

        for seq in sequences:
            self.assertEqual(_ist_session_key(seq.sequence_start_at), _ist_session_key(seq.observed_at))
            # Source candles never mix the two synthetic sessions.
            self.assertTrue(
                all(cid.startswith("c-0-") for cid in seq.source_candle_ids)
                or all(cid.startswith("c-1-") for cid in seq.source_candle_ids)
            )

    def test_flatten_lag_features_orders_from_decision_bar(self) -> None:
        sequences = build_intrasession_sequences(
            [bar(i) for i in range(6)], lookback=3, feature_names=("a", "b"), timeframe="1m",
        )
        flat = flatten_lag_features(sequences[-1])
        self.assertEqual(flat["a__lag0"], sequences[-1].features[-1][0])
        self.assertEqual(flat["a__lag2"], sequences[-1].features[0][0])
        self.assertEqual(flat["sequence.lookback"], 3.0)


class SequenceCvTests(unittest.TestCase):
    def test_purge_drops_overlapping_information_intervals(self) -> None:
        examples = [
            bar(i, session_offset_days=day, label="EXPANSION" if i % 2 else "CONTRACTION")
            for day in range(6)
            for i in range(12)
        ]
        sequences = build_intrasession_sequences(
            examples, lookback=4, feature_names=("a", "b"), timeframe="1m",
        )
        splits = sequence_purged_walk_forward(sequences, folds=2, validation_fraction=0.4)
        self.assertEqual(len(splits), 2)
        for split in splits:
            self.assertTrue(split.train)
            self.assertTrue(split.validation)
            val_start = min(item.sequence_start_at for item in split.validation)
            val_end = max(item.label_available_at for item in split.validation)
            for item in split.train:
                self.assertFalse(
                    intervals_overlap(item.sequence_start_at, item.label_available_at, val_start, val_end)
                )
            validation_sessions = {item.observed_at.astimezone().date() for item in split.validation}
            for session in validation_sessions:
                all_in_session = [item for item in sequences if item.observed_at.astimezone().date() == session]
                self.assertTrue(all(item in split.validation for item in all_in_session))

    def test_rejects_empty_input(self) -> None:
        with self.assertRaises(SequenceError):
            sequence_purged_walk_forward([], folds=1)


if __name__ == "__main__":
    unittest.main()
