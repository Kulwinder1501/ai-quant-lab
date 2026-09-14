from __future__ import annotations

import unittest
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.validation import (
    TemporalSplitError,
    chronological_purged_split,
    combinatorial_purged_splits,
    pooled_walk_forward_splits,
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


def _contiguous_spans(rows: Sequence[LabeledExample]) -> list[tuple[datetime, datetime]]:
    """Split a validation set into runs of adjacent bars, with each run's label span.

    Adjacent test blocks merge into one run, which is what the purge rule treats
    them as anyway, so checking a merged run is neither stricter nor looser.
    """

    indices = sorted(int(row.candle_id.removeprefix("candle-")) for row in rows)
    spans: list[tuple[datetime, datetime]] = []
    run_start = indices[0]
    previous = indices[0]
    for index in indices[1:]:
        if index != previous + 1:
            spans.append((example(run_start).observed_at, example(previous).label_available_at))
            run_start = index
        previous = index
    spans.append((example(run_start).observed_at, example(previous).label_available_at))
    return spans


class CombinatorialPurgedSplitTests(unittest.TestCase):
    """CPCV. Each ``example(i)`` observes at day ``i`` and resolves at day ``i + 2``."""

    def examples(self, count: int) -> list[LabeledExample]:
        return [example(index) for index in range(count)]

    def test_produces_every_combination_of_test_blocks(self) -> None:
        splits = combinatorial_purged_splits(self.examples(60), groups=6, test_groups=2, embargo_fraction=0)

        # C(6, 2) = 15.
        self.assertEqual(len(splits), 15)

    def test_scores_every_observation_rather_than_only_the_tail(self) -> None:
        rows = self.examples(60)
        splits = combinatorial_purged_splits(rows, groups=6, test_groups=2, embargo_fraction=0)

        appearances: dict[str, int] = {row.candle_id: 0 for row in rows}
        for split in splits:
            for item in split.validation:
                appearances[item.candle_id] += 1

        # The whole point over walk-forward, which never scores the leading 80%:
        # every row is tested, and exactly C(groups-1, test_groups-1) = C(5,1) times.
        self.assertTrue(all(count == 5 for count in appearances.values()))

    def test_purges_exactly_the_examples_whose_label_window_overlaps_a_test_block(self) -> None:
        # 30 rows, 3 blocks of 10. Testing block 1 spans observations 10..19, whose
        # labels resolve by day 21. A training row overlaps when it is observed on or
        # before day 21 and resolves on or after day 10 -- rows 8, 9, 20 and 21.
        splits = combinatorial_purged_splits(self.examples(30), groups=3, test_groups=1, embargo_fraction=0)
        middle = splits[1]

        self.assertEqual([item.candle_id for item in middle.validation], [f"candle-{index}" for index in range(10, 20)])
        self.assertEqual(middle.purge_count, 4)
        trained = {item.candle_id for item in middle.train}
        for purged in (8, 9, 20, 21):
            self.assertNotIn(f"candle-{purged}", trained)
        self.assertIn("candle-7", trained)
        self.assertIn("candle-22", trained)

    def test_no_training_label_window_overlaps_any_test_label_window(self) -> None:
        splits = combinatorial_purged_splits(self.examples(80), groups=8, test_groups=3, embargo_fraction=0.02)

        for index, split in enumerate(splits):
            with self.subTest(split=index):
                # Test blocks are non-contiguous, so the guarantee is per block: the
                # span from the first to the last test block covers nearly the whole
                # series and would flag every training row.
                for start, end in _contiguous_spans(split.validation):
                    for item in split.train:
                        self.assertFalse(item.observed_at <= end and item.label_available_at >= start)

    def test_embargo_removes_the_rows_immediately_after_a_test_block(self) -> None:
        # Embargo of 10% over 30 rows is 3 rows. After block 1 ends those are rows
        # 20, 21 and 22; the first two were already purged, so row 22 is the one the
        # embargo alone removes.
        embargoed = combinatorial_purged_splits(self.examples(30), groups=3, test_groups=1, embargo_fraction=0.1)[1]
        bare = combinatorial_purged_splits(self.examples(30), groups=3, test_groups=1, embargo_fraction=0)[1]

        self.assertEqual(bare.purge_count, 4)
        self.assertEqual(embargoed.purge_count, 5)
        self.assertIn("candle-22", {item.candle_id for item in bare.train})
        self.assertNotIn("candle-22", {item.candle_id for item in embargoed.train})

    def test_train_and_validation_never_share_a_row(self) -> None:
        splits = combinatorial_purged_splits(self.examples(60), groups=5, test_groups=2, embargo_fraction=0.01)

        for index, split in enumerate(splits):
            with self.subTest(split=index):
                trained = {item.candle_id for item in split.train}
                tested = {item.candle_id for item in split.validation}
                self.assertEqual(trained & tested, set())

    def test_accepts_unordered_input(self) -> None:
        ordered = combinatorial_purged_splits(self.examples(30), groups=3, test_groups=1, embargo_fraction=0)
        shuffled = combinatorial_purged_splits(
            list(reversed(self.examples(30))), groups=3, test_groups=1, embargo_fraction=0,
        )

        for left, right in zip(ordered, shuffled):
            self.assertEqual(
                [item.candle_id for item in left.validation],
                [item.candle_id for item in right.validation],
            )

    def test_rejects_configurations_that_cannot_form_a_split(self) -> None:
        rows = self.examples(30)
        with self.assertRaisesRegex(TemporalSplitError, "groups must be an integer of at least two"):
            combinatorial_purged_splits(rows, groups=1)
        with self.assertRaisesRegex(TemporalSplitError, "test_groups must be smaller than groups"):
            combinatorial_purged_splits(rows, groups=3, test_groups=3)
        with self.assertRaisesRegex(TemporalSplitError, "embargo_fraction"):
            combinatorial_purged_splits(rows, groups=3, test_groups=1, embargo_fraction=1.0)
        with self.assertRaisesRegex(TemporalSplitError, "fewer examples than requested groups"):
            combinatorial_purged_splits(self.examples(2), groups=3, test_groups=1)
        with self.assertRaisesRegex(TemporalSplitError, "At least one labeled example"):
            combinatorial_purged_splits([], groups=3, test_groups=1)

    def test_refuses_when_purging_would_empty_the_training_set(self) -> None:
        # Three blocks of two rows each, and a label window two rows wide: testing the
        # middle block purges everything either side of it.
        with self.assertRaisesRegex(TemporalSplitError, "no training examples"):
            combinatorial_purged_splits(self.examples(6), groups=3, test_groups=1, embargo_fraction=0)


if __name__ == "__main__":
    unittest.main()


def pooled_example(index: int, symbol: str, *, label_days: int = 2) -> LabeledExample:
    """One instrument's bar for session ``index``. Siblings share ``observed_at``."""

    observed_at = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"{symbol}-candle-{index}",
        instrument_id=f"instrument-{symbol}",
        symbol=symbol,
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=label_days),
        forward_return=0.01,
        label="BULLISH" if index % 2 else "BEARISH",
        features={"x": float(index)},
    )


POOL = ("NIFTY50", "SBIN", "INFY", "TCS")


def pooled_rows(sessions: int, symbols: Sequence[str] = POOL) -> list[LabeledExample]:
    return [pooled_example(index, symbol) for index in range(sessions) for symbol in symbols]


class PooledWalkForwardSplitTests(unittest.TestCase):
    """A pooled dataset has N rows per session, so row offsets stop measuring time."""

    def test_never_splits_a_session_across_train_and_validation(self) -> None:
        splits = pooled_walk_forward_splits(pooled_rows(50), folds=2, validation_fraction=0.2)

        for split in splits:
            train_times = {item.observed_at for item in split.train}
            validation_times = {item.observed_at for item in split.validation}
            # The failure this guards against is contemporaneous cross-sectional
            # leakage: SBIN's bar for a session in training while TCS's is in
            # validation. Row-index splitting produces exactly that.
            self.assertEqual(train_times & validation_times, set())

    def test_keeps_every_sibling_of_a_validation_session_together(self) -> None:
        splits = pooled_walk_forward_splits(pooled_rows(50), folds=2, validation_fraction=0.2)

        for split in splits:
            by_time: dict[datetime, set[str]] = {}
            for item in split.validation:
                by_time.setdefault(item.observed_at, set()).add(item.symbol)
            for symbols in by_time.values():
                self.assertEqual(symbols, set(POOL))

    def test_purges_on_timestamps_not_row_counts(self) -> None:
        # Labels resolve 2 sessions out, so the last two training sessions before a
        # validation block must be dropped -- 2 sessions x 4 instruments = 8 rows.
        # A row-count purge of 2 would have removed half a session.
        splits = pooled_walk_forward_splits(pooled_rows(50), folds=1, validation_fraction=0.2)
        split = splits[0]

        opens_at = min(item.observed_at for item in split.validation)
        self.assertTrue(all(item.label_available_at < opens_at for item in split.train))
        self.assertEqual(split.purge_count, 2 * len(POOL))

    def test_a_longer_label_horizon_purges_proportionally_more(self) -> None:
        rows = [pooled_example(index, symbol, label_days=5) for index in range(50) for symbol in POOL]
        split = pooled_walk_forward_splits(rows, folds=1, validation_fraction=0.2)[0]

        self.assertEqual(split.purge_count, 5 * len(POOL))

    def test_folds_are_contiguous_and_ordered(self) -> None:
        splits = pooled_walk_forward_splits(pooled_rows(60), folds=3, validation_fraction=0.3)

        block_starts = [min(item.observed_at for item in split.validation) for split in splits]
        self.assertEqual(block_starts, sorted(block_starts))
        for earlier, later in zip(splits, splits[1:]):
            self.assertLess(
                max(item.observed_at for item in earlier.validation),
                min(item.observed_at for item in later.validation),
            )

    def test_rejects_too_few_distinct_sessions_for_the_fold_count(self) -> None:
        # 200 rows but only 3 sessions: a row-based split would happily make 5 folds.
        rows = [pooled_example(index, f"SYM{n}") for index in range(3) for n in range(50)]
        with self.assertRaises(TemporalSplitError):
            pooled_walk_forward_splits(rows, folds=5, validation_fraction=0.2)

    def test_rejects_a_horizon_that_purges_the_whole_training_window(self) -> None:
        rows = [pooled_example(index, symbol, label_days=400) for index in range(20) for symbol in POOL]
        with self.assertRaises(TemporalSplitError):
            pooled_walk_forward_splits(rows, folds=1, validation_fraction=0.2)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
