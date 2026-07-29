from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.validation import (
    TemporalSplitError,
    chronological_purged_split,
    walk_forward_splits,
)


START = datetime(2024, 1, 2, tzinfo=UTC)


def example(index: int) -> LabeledExample:
    observed_at = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=2),
        forward_return=0.01,
        label="BULLISH" if index % 2 else "BEARISH",
        features={"x": float(index)},
    )


class ChronologicalPurgedSplitTests(unittest.TestCase):
    def test_sorts_then_leaves_exact_horizon_between_train_and_validation(self) -> None:
        split = chronological_purged_split(
            list(reversed([example(index) for index in range(10)])),
            horizon_bars=2,
            validation_fraction=0.2,
        )

        self.assertEqual([item.candle_id for item in split.train], [f"candle-{index}" for index in range(6)])
        self.assertEqual([item.candle_id for item in split.validation], ["candle-8", "candle-9"])
        self.assertEqual(split.purge_count, 2)
        self.assertLess(split.train[-1].label_available_at, split.validation[0].observed_at)

    def test_rejects_a_zero_horizon(self) -> None:
        with self.assertRaisesRegex(TemporalSplitError, "positive integer"):
            chronological_purged_split([example(index) for index in range(6)], horizon_bars=0, validation_fraction=0.25)

    def test_rejects_too_small_a_dataset_after_purge(self) -> None:
        with self.assertRaises(TemporalSplitError):
            chronological_purged_split([example(index) for index in range(3)], horizon_bars=2, validation_fraction=0.34)


class WalkForwardSplitTests(unittest.TestCase):
    def examples(self, count: int) -> list[LabeledExample]:
        return [example(index) for index in range(count)]

    def test_one_fold_matches_the_single_chronological_split(self) -> None:
        rows = self.examples(100)

        single = chronological_purged_split(rows, horizon_bars=5, validation_fraction=0.2)
        folds = walk_forward_splits(rows, horizon_bars=5, folds=1, validation_fraction=0.2)

        self.assertEqual(len(folds), 1)
        self.assertEqual([item.candle_id for item in folds[0].validation], [item.candle_id for item in single.validation])
        self.assertEqual(folds[0].purge_count, single.purge_count)

    def test_each_fold_keeps_its_own_purge_gap_and_expanding_training_window(self) -> None:
        rows = self.examples(200)

        folds = walk_forward_splits(rows, horizon_bars=5, folds=4, validation_fraction=0.4)

        self.assertEqual(len(folds), 4)
        previous_training_size = 0
        for index, split in enumerate(folds):
            with self.subTest(fold=index):
                # The purge gap is what stops a training label whose horizon
                # overlaps the holdout from reaching the model.
                self.assertGreaterEqual(split.purge_count, 5)
                last_training = split.train[-1].observed_at
                first_validation = split.validation[0].observed_at
                self.assertLess(last_training, first_validation)
                # Training expands as later folds absorb earlier holdouts.
                self.assertGreater(len(split.train), previous_training_size)
                previous_training_size = len(split.train)

    def test_validation_blocks_are_disjoint_and_chronological(self) -> None:
        rows = self.examples(200)

        folds = walk_forward_splits(rows, horizon_bars=5, folds=4, validation_fraction=0.4)
        blocks = [[item.candle_id for item in split.validation] for split in folds]
        flattened = [candle_id for block in blocks for candle_id in block]

        # No bar may be scored twice, or a single period would carry extra weight
        # in the mean the promotion gate reads.
        self.assertEqual(len(flattened), len(set(flattened)))
        # Compare timestamps, not ids: "candle-9" sorts after "candle-10" as text.
        for earlier, later in zip(folds, folds[1:]):
            self.assertLess(earlier.validation[-1].observed_at, later.validation[0].observed_at)

    def test_rejects_a_fold_count_the_dataset_cannot_support(self) -> None:
        with self.assertRaisesRegex(TemporalSplitError, "folds must be a positive integer"):
            walk_forward_splits(self.examples(100), horizon_bars=5, folds=0)
        with self.assertRaisesRegex(TemporalSplitError, "Not enough validation examples"):
            walk_forward_splits(self.examples(40), horizon_bars=2, folds=20, validation_fraction=0.1)

    def test_refuses_a_fold_whose_training_window_would_be_empty(self) -> None:
        with self.assertRaisesRegex(TemporalSplitError, "non-empty training set"):
            walk_forward_splits(self.examples(20), horizon_bars=9, folds=2, validation_fraction=0.9)


if __name__ == "__main__":
    unittest.main()
