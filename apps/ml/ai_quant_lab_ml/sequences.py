"""Intrasession sequence construction and purged CV for TCN research.

Implements the Workstream E contract defaults:

- windows are built per instrument/timeframe;
- scalping sequences do not cross the overnight session boundary;
- only completed, labelled bars participate;
- purge uses the full information interval ``[sequence_start_at, label_available_at]``.

Bar counts from the sequence-readiness gate are necessary, not sufficient —
overlapping windows are not independent observations.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from .contracts import AnyLabel, LabeledExample

IST = timezone(timedelta(hours=5, minutes=30))


class SequenceError(ValueError):
    """Raised when a leakage-safe sequence dataset cannot be formed."""


@dataclass(frozen=True)
class SequenceExample:
    """One fixed-lookback intrasession window ending at the decision bar."""

    candle_id: str
    instrument_id: str
    symbol: str
    timeframe: str
    sequence_start_at: datetime
    observed_at: datetime
    label_available_at: datetime
    label: AnyLabel
    # Shape (lookback, n_features), oldest → newest. NaNs preserved for the imputer.
    features: tuple[tuple[float, ...], ...]
    feature_names: tuple[str, ...]
    source_candle_ids: tuple[str, ...]

    @property
    def lookback(self) -> int:
        return len(self.features)


@dataclass(frozen=True)
class SequenceSplit:
    train: tuple[SequenceExample, ...]
    validation: tuple[SequenceExample, ...]
    purge_count: int


def _ist_session_key(moment: datetime) -> str:
    return moment.astimezone(IST).date().isoformat()


def _interval_seconds(timeframe: str) -> int:
    mapping = {"1m": 60, "3m": 180, "5m": 300, "15m": 900}
    if timeframe not in mapping:
        raise SequenceError(f"Unsupported sequence timeframe {timeframe!r}.")
    return mapping[timeframe]


def _finite_or_nan(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return float("nan")
    return parsed if math.isfinite(parsed) else float("nan")


def build_intrasession_sequences(
    examples: Sequence[LabeledExample],
    *,
    lookback: int,
    feature_names: Sequence[str],
    timeframe: str,
) -> list[SequenceExample]:
    """Build fixed-lookback sequences that never cross an IST session boundary.

    Within a session, consecutive bars must land on the native timeframe grid.
    A missing minute rejects every window that would include the gap rather than
    forward-filling prices or volume.
    """

    if isinstance(lookback, bool) or not isinstance(lookback, int) or lookback < 2:
        raise SequenceError("lookback must be an integer >= 2.")
    names = tuple(feature_names)
    if not names:
        raise SequenceError("At least one feature name is required.")
    if not examples:
        return []

    ordered = sorted(examples, key=lambda ex: (ex.observed_at, ex.candle_id))
    step = timedelta(seconds=_interval_seconds(timeframe))
    sequences: list[SequenceExample] = []

    session_rows: list[LabeledExample] = []
    current_session: str | None = None

    def flush(session_examples: list[LabeledExample]) -> None:
        if len(session_examples) < lookback:
            return
        for end in range(lookback - 1, len(session_examples)):
            window = session_examples[end - lookback + 1 : end + 1]
            contiguous = True
            for left, right in zip(window, window[1:]):
                delta = right.observed_at - left.observed_at
                if abs(delta.total_seconds() - step.total_seconds()) > 1e-6:
                    contiguous = False
                    break
            if not contiguous:
                continue
            decision = window[-1]
            matrix = tuple(
                tuple(_finite_or_nan(row.features.get(name)) for name in names)
                for row in window
            )
            sequences.append(
                SequenceExample(
                    candle_id=decision.candle_id,
                    instrument_id=decision.instrument_id,
                    symbol=decision.symbol,
                    timeframe=decision.timeframe,
                    sequence_start_at=window[0].observed_at,
                    observed_at=decision.observed_at,
                    label_available_at=decision.label_available_at,
                    label=decision.label,
                    features=matrix,
                    feature_names=names,
                    source_candle_ids=tuple(row.candle_id for row in window),
                )
            )

    for example in ordered:
        key = _ist_session_key(example.observed_at)
        if current_session is None:
            current_session = key
            session_rows = [example]
            continue
        if key != current_session:
            flush(session_rows)
            current_session = key
            session_rows = [example]
            continue
        session_rows.append(example)
    flush(session_rows)
    return sequences


def intervals_overlap(start_a: datetime, end_a: datetime, start_b: datetime, end_b: datetime) -> bool:
    return start_a <= end_b and start_b <= end_a


def _group_into_ist_sessions(sequences: Sequence[SequenceExample]) -> list[list[SequenceExample]]:
    """Order sequences chronologically and group them by IST session (trading day)."""

    ordered = sorted(sequences, key=lambda s: (s.observed_at, s.label_available_at, s.candle_id))
    sessions: list[list[SequenceExample]] = []
    for item in ordered:
        key = _ist_session_key(item.observed_at)
        if not sessions or _ist_session_key(sessions[-1][0].observed_at) != key:
            sessions.append([item])
        else:
            sessions[-1].append(item)
    return sessions


def sequence_purged_walk_forward(
    sequences: Sequence[SequenceExample],
    *,
    folds: int,
    validation_fraction: float = 0.2,
) -> list[SequenceSplit]:
    """Expanding-train walk-forward with information-interval purge.

    A training example is dropped when its
    ``[sequence_start_at, label_available_at]`` overlaps any validation
    example's information interval. That is stricter than bar-count purge and
    matches Workstream E.
    """

    if isinstance(folds, bool) or not isinstance(folds, int) or folds <= 0:
        raise SequenceError("folds must be a positive integer.")
    if not math.isfinite(validation_fraction) or not 0 < validation_fraction < 1:
        raise SequenceError("validation_fraction must be strictly between zero and one.")
    if not sequences:
        raise SequenceError("At least one sequence example is required.")

    sessions = _group_into_ist_sessions(sequences)
    if len(sessions) <= folds:
        raise SequenceError(
            f"Need at least {folds + 1} complete IST sessions for {folds} session-grouped folds."
        )

    total_validation_sessions = max(folds, math.ceil(len(sessions) * validation_fraction))
    total_validation_sessions = min(total_validation_sessions, len(sessions) - 1)
    validation_start_session = len(sessions) - total_validation_sessions
    fold_size = total_validation_sessions // folds
    remainder = total_validation_sessions % folds
    splits: list[SequenceSplit] = []
    session_cursor = validation_start_session

    for fold_idx in range(folds):
        session_count = fold_size + (1 if fold_idx < remainder else 0)
        validation_sessions = sessions[session_cursor : session_cursor + session_count]
        validation = tuple(item for session in validation_sessions for item in session)
        val_start = min(item.sequence_start_at for item in validation)
        val_end = max(item.label_available_at for item in validation)
        train_pool = [item for session in sessions[:session_cursor] for item in session]
        train = tuple(
            item
            for item in train_pool
            if not intervals_overlap(item.sequence_start_at, item.label_available_at, val_start, val_end)
        )
        purge_count = len(train_pool) - len(train)
        if not train:
            raise SequenceError(f"Fold {fold_idx + 1} has an empty training set after sequence purge.")
        if not validation:
            raise SequenceError(f"Fold {fold_idx + 1} has an empty validation set.")
        splits.append(SequenceSplit(train=train, validation=validation, purge_count=purge_count))
        session_cursor += session_count

    return splits


def sequence_era_holdout_split(
    sequences: Sequence[SequenceExample],
    *,
    train_fraction: float = 0.5,
    holdout_fraction: float = 0.2,
) -> SequenceSplit:
    """Train on the earliest era, score a disjoint, much later one.

    Unlike ``sequence_purged_walk_forward``, the middle era is dropped entirely
    rather than trained on -- the point is to measure whether a score survives a
    large temporal gap, not merely the adjacent-fold purge a walk-forward split
    already exercises.
    """

    if not math.isfinite(train_fraction) or not 0 < train_fraction < 1:
        raise SequenceError("train_fraction must be strictly between zero and one.")
    if not math.isfinite(holdout_fraction) or not 0 < holdout_fraction < 1:
        raise SequenceError("holdout_fraction must be strictly between zero and one.")
    if train_fraction + holdout_fraction >= 1:
        raise SequenceError("train_fraction and holdout_fraction must leave a gap between them.")
    if not sequences:
        raise SequenceError("At least one sequence example is required.")

    sessions = _group_into_ist_sessions(sequences)
    train_end_session = int(len(sessions) * train_fraction)
    holdout_start_session = len(sessions) - max(1, int(len(sessions) * holdout_fraction))
    if train_end_session <= 0 or holdout_start_session <= train_end_session:
        raise SequenceError(
            f"Need enough IST sessions ({len(sessions)} available) to leave a gap between "
            "the training era and a disjoint, later holdout era."
        )

    train_pool = [item for session in sessions[:train_end_session] for item in session]
    validation = tuple(item for session in sessions[holdout_start_session:] for item in session)
    if not validation:
        raise SequenceError("Era holdout produced an empty validation set.")
    val_start = min(item.sequence_start_at for item in validation)
    val_end = max(item.label_available_at for item in validation)
    train = tuple(
        item
        for item in train_pool
        if not intervals_overlap(item.sequence_start_at, item.label_available_at, val_start, val_end)
    )
    if not train:
        raise SequenceError("Era holdout produced an empty training set after purge.")
    return SequenceSplit(train=train, validation=validation, purge_count=len(train_pool) - len(train))


def flatten_lag_features(sequence: SequenceExample) -> dict[str, float]:
    """Tabular lag baseline: the same lookback information as a flat feature map.

    Column names are ``{feature}__lag{k}`` with ``k=0`` the decision bar and
    ``k=lookback-1`` the oldest bar in the window. This is the honest tree
    baseline Stage 5 requires — equivalent lagged information, not a weaker
    single-bar schema.
    """

    values: dict[str, float] = {}
    lookback = sequence.lookback
    for lag_from_end, row in enumerate(reversed(sequence.features)):
        for name, value in zip(sequence.feature_names, row):
            values[f"{name}__lag{lag_from_end}"] = value
    # Keep lookback explicit so artifact metadata can prove the window width.
    values["sequence.lookback"] = float(lookback)
    return values


def lag_feature_schema(feature_names: Sequence[str], lookback: int) -> tuple[str, ...]:
    names = tuple(feature_names)
    columns = [f"{name}__lag{lag}" for lag in range(lookback) for name in names]
    columns.append("sequence.lookback")
    return tuple(columns)
