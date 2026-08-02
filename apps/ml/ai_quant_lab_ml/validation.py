"""Chronological validation utilities with a label-horizon purge gap."""

from __future__ import annotations

import math
from collections.abc import Sequence
from datetime import datetime
from itertools import combinations

from .contracts import LabeledExample, TemporalSplit


class TemporalSplitError(ValueError):
    """Raised when a leakage-safe train/validation split cannot be formed."""


def chronological_purged_split(
    examples: Sequence[LabeledExample],
    *,
    horizon_bars: int,
    validation_fraction: float = 0.2,
) -> TemporalSplit:
    """Split ordered market observations and remove the horizon before validation.

    If validation starts at bar ``i`` and the label horizon is ``h``, the last
    training source is at most ``i - h - 1``.  The intervening ``h`` examples
    are omitted entirely, preventing a training target from using a future
    close that overlaps the unseen validation period.
    """

    if isinstance(horizon_bars, bool) or not isinstance(horizon_bars, int) or horizon_bars <= 0:
        raise TemporalSplitError("horizon_bars must be a positive integer.")
    if not math.isfinite(validation_fraction) or not 0 < validation_fraction < 1:
        raise TemporalSplitError("validation_fraction must be strictly between zero and one.")
    if not examples:
        raise TemporalSplitError("At least one labeled example is required.")

    ordered = sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))
    validation_count = max(1, math.ceil(len(ordered) * validation_fraction))
    validation_start = len(ordered) - validation_count
    train_end = validation_start - horizon_bars
    if train_end <= 0:
        raise TemporalSplitError(
            "Not enough examples for a non-empty training set after applying the requested validation window and purge gap."
        )
    if horizon_bars > 0 and validation_start <= train_end:
        raise TemporalSplitError("The purge gap must leave at least one observation between train and validation.")

    train = tuple(ordered[:train_end])
    validation = tuple(ordered[validation_start:])
    if not validation:
        raise TemporalSplitError("The validation set cannot be empty.")
    return TemporalSplit(train=train, validation=validation, purge_count=validation_start - train_end)


# A readable alias for applications that use the phrase in a command option.
purged_chronological_split = chronological_purged_split


def walk_forward_splits(
    examples: Sequence[LabeledExample],
    *,
    horizon_bars: int,
    folds: int,
    validation_fraction: float = 0.2,
) -> list[TemporalSplit]:
    """Create multiple sequential evaluation splits across the time series.
    
    Each fold preserves its own purge gap between the expanding training
    window and its specific validation block.
    """

    if isinstance(folds, bool) or not isinstance(folds, int) or folds <= 0:
        raise TemporalSplitError("folds must be a positive integer.")
    if folds == 1:
        return [chronological_purged_split(examples, horizon_bars=horizon_bars, validation_fraction=validation_fraction)]

    if isinstance(horizon_bars, bool) or not isinstance(horizon_bars, int) or horizon_bars <= 0:
        raise TemporalSplitError("horizon_bars must be a positive integer.")
    if not math.isfinite(validation_fraction) or not 0 < validation_fraction < 1:
        raise TemporalSplitError("validation_fraction must be strictly between zero and one.")
    if not examples:
        raise TemporalSplitError("At least one labeled example is required.")

    ordered = sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))
    total_validation_count = max(1, math.ceil(len(ordered) * validation_fraction))
    
    if total_validation_count < folds:
        raise TemporalSplitError("Not enough validation examples to populate the requested number of folds.")
        
    validation_start_idx = len(ordered) - total_validation_count
    fold_size = total_validation_count // folds
    remainder = total_validation_count % folds

    splits = []
    current_start = validation_start_idx
    
    for fold_idx in range(folds):
        current_fold_size = fold_size + (1 if fold_idx < remainder else 0)
        validation_end = current_start + current_fold_size
        
        train_end = current_start - horizon_bars
        if train_end <= 0:
            raise TemporalSplitError(
                f"Not enough examples for a non-empty training set in fold {fold_idx + 1}."
            )
        
        train = tuple(ordered[:train_end])
        validation = tuple(ordered[current_start:validation_end])
        
        if not validation:
            raise TemporalSplitError(f"Validation set cannot be empty for fold {fold_idx + 1}.")
            
        splits.append(
            TemporalSplit(
                train=train,
                validation=validation,
                purge_count=current_start - train_end,
            )
        )
        current_start = validation_end
        
    return splits


#: Recorded alongside any score produced by :func:`combinatorial_purged_splits`.
#: A CPCV score and a walk-forward score are not comparable -- they are averages
#: over different test distributions -- so the method name travels with the number
#: and the promotion gate can refuse to rank one against the other.
CPCV_METHOD_NAME = "CPCV_V1"

#: The chronological method the promotion gate uses. Named for the same reason.
WALK_FORWARD_METHOD_NAME = "PURGED_CHRONOLOGICAL_V1"


def _label_span(block: Sequence[LabeledExample]) -> tuple[datetime, datetime]:
    """Earliest observation and latest label availability inside a test block."""

    return (
        min(example.observed_at for example in block),
        max(example.label_available_at for example in block),
    )


def combinatorial_purged_splits(
    examples: Sequence[LabeledExample],
    *,
    groups: int,
    test_groups: int = 2,
    embargo_fraction: float = 0.01,
) -> list[TemporalSplit]:
    """Combinatorial Purged Cross-Validation splits (Lopez de Prado, ch. 12).

    ``walk_forward_splits`` only ever tests the trailing ``validation_fraction``
    of the series, so on a 787-row dataset 629 rows are never scored and every
    quality judgement rests on whichever regime the final months happened to be.
    CPCV instead partitions the whole series into ``groups`` contiguous blocks and
    tests every combination of ``test_groups`` of them, so each observation lands
    in a test set ``C(groups-1, test_groups-1)`` times and the result is a
    *distribution* of scores rather than one number.

    What it does not do is create information. The training sets overlap heavily,
    so the scores are correlated and the spread is not a standard error over
    independent samples. It buys an honest picture of how much a score moves with
    the evaluation window; it cannot conjure an edge out of a series that has none.

    Two leakage defences, both required because test blocks now sit *inside* the
    training range rather than after it:

    ``purge``  drops any training example whose label window overlaps a test
        block's label window. Overlap is evaluated on real timestamps --
        ``observed_at`` to ``label_available_at`` -- rather than a bar count, so a
        triple-barrier label that resolved early purges exactly as much as it must
        and no more. This catches leakage in both directions: an earlier example
        whose label resolves inside the test period, and a later example whose
        features are drawn from bars the test labels depend on.

    ``embargo`` additionally drops the training examples immediately following a
        test block. Serial correlation means a bar just after the test period
        carries much of the same information even once label windows no longer
        overlap.

    Because CPCV trains on later data to score earlier data in some combinations,
    it is a research measurement and not a deployment simulation. It must not
    replace the chronological gate that decides promotion.
    """

    if isinstance(groups, bool) or not isinstance(groups, int) or groups < 2:
        raise TemporalSplitError("groups must be an integer of at least two.")
    if isinstance(test_groups, bool) or not isinstance(test_groups, int) or test_groups < 1:
        raise TemporalSplitError("test_groups must be a positive integer.")
    if test_groups >= groups:
        raise TemporalSplitError("test_groups must be smaller than groups, or no training data remains.")
    if not math.isfinite(embargo_fraction) or not 0 <= embargo_fraction < 1:
        raise TemporalSplitError("embargo_fraction must be in [0, 1).")
    if not examples:
        raise TemporalSplitError("At least one labeled example is required.")
    if len(examples) < groups:
        raise TemporalSplitError("There are fewer examples than requested groups, so a group would be empty.")

    ordered = sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))
    total = len(ordered)

    # Contiguous, near-equal blocks. The remainder is spread across the earliest
    # blocks so no block is short by more than one.
    block_size, remainder = divmod(total, groups)
    bounds: list[tuple[int, int]] = []
    start = 0
    for index in range(groups):
        stop = start + block_size + (1 if index < remainder else 0)
        bounds.append((start, stop))
        start = stop

    embargo_size = math.ceil(embargo_fraction * total) if embargo_fraction > 0 else 0

    splits: list[TemporalSplit] = []
    for combination in combinations(range(groups), test_groups):
        test_indices: set[int] = set()
        for group_index in combination:
            begin, stop = bounds[group_index]
            test_indices.update(range(begin, stop))

        embargoed: set[int] = set()
        if embargo_size:
            for group_index in combination:
                _, stop = bounds[group_index]
                embargoed.update(range(stop, min(stop + embargo_size, total)))

        validation = [ordered[index] for index in sorted(test_indices)]
        spans = [_label_span([ordered[index] for index in range(*bounds[group_index])]) for group_index in combination]

        train: list[LabeledExample] = []
        removed = 0
        for index, example in enumerate(ordered):
            if index in test_indices:
                continue
            if index in embargoed:
                removed += 1
                continue
            overlaps = any(
                example.observed_at <= span_end and example.label_available_at >= span_start
                for span_start, span_end in spans
            )
            if overlaps:
                removed += 1
                continue
            train.append(example)

        if not train:
            raise TemporalSplitError(
                "Purging and embargoing left no training examples; use fewer groups, "
                "fewer test groups, or a shorter label horizon."
            )
        splits.append(TemporalSplit(train=tuple(train), validation=tuple(validation), purge_count=removed))

    return splits


__all__ = [
    "CPCV_METHOD_NAME",
    "TemporalSplitError",
    "WALK_FORWARD_METHOD_NAME",
    "chronological_purged_split",
    "combinatorial_purged_splits",
    "purged_chronological_split",
    "walk_forward_splits",
]
