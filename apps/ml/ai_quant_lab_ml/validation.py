"""Chronological validation utilities with a label-horizon purge gap."""

from __future__ import annotations

import math
from collections.abc import Sequence

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


__all__ = ["TemporalSplitError", "chronological_purged_split", "purged_chronological_split", "walk_forward_splits"]
