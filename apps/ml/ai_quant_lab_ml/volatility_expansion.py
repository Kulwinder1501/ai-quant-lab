"""Volatility-expansion labelling: does the next N bars' range widen or narrow?

A deliberately *non-directional* target. Both direction schemes measured on this
data (fixed-horizon and triple-barrier) failed once compared against the trivial
majority-class predictor, and both failed for the same structural reason: the sign
of a future move is close to unpredictable here. Range *magnitude* is a different
question, and a more tractable one, because volatility is strongly
autocorrelated — quiet periods cluster and so do violent ones.

The label compares two equal-length windows around the source bar:

* ``trailing_range`` — high-low envelope of the K bars ending at the source bar
* ``forward_range``  — high-low envelope of the K bars after it

and classifies their ratio:

* ratio >= ``1 + band``       -> ``EXPANSION``
* ratio <= ``1 / (1 + band)`` -> ``CONTRACTION``
* otherwise                   -> ``STABLE``

The contraction threshold is the *reciprocal* of the expansion one, not
``1 - band``: a range ratio is multiplicative, so 2x wider and 2x narrower are the
symmetric pair. Using ``1 - band`` would make contraction a materially smaller
target than expansion and bias the class balance for no reason.

Equal window lengths make the ratio directly interpretable as "wider or narrower
than the recent past" with no horizon-dependent constant to calibrate — the
weakness that forced per-timeframe neutral bands on the fixed-horizon target.

**This module deliberately does not reuse ``MarketLabel``.** Its labels are not
directional, and the directional alphabet is wired into the strategy engine, the
autonomous agent, the dashboards, and a ``CHECK`` constraint on
``model_predictions``. Emitting ``BULLISH`` to mean "range expanded" would be read
downstream as a signal to go long. A separate alphabet keeps that impossible, at
the cost of needing its own persistence path before such a model can be promoted.
"""

from __future__ import annotations

import math
import re
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from .contracts import LABEL_SCHEME_VOLATILITY_EXPANSION, ForwardBar, LabelAlphabet
from .volume_intelligence import INDIA_TZ

VolatilityLabel = Literal["CONTRACTION", "STABLE", "EXPANSION"]

#: Canonical order, mirroring how ``LABELS`` orders the directional alphabet.
VOLATILITY_LABELS: tuple[VolatilityLabel, ...] = ("CONTRACTION", "STABLE", "EXPANSION")

#: Pass this to training, evaluation, and the leakage audit for a volatility model.
#: ``STABLE`` is the abstain class, the structural counterpart of ``NEUTRAL``: it is
#: the prediction that declines to call a change in range.
VOLATILITY_ALPHABET = LabelAlphabet(
    name="volatility-expansion",
    labels=VOLATILITY_LABELS,
    abstain_label="STABLE",
)

# LABEL_SCHEME_VOLATILITY_EXPANSION is imported above from contracts, where it sits
# alongside the other scheme names so the CLI's choice list stays complete in one
# place. It stays in this module's __all__ so callers can import it from either.

#: Default band. 0.25 puts the thresholds at 1.25x and 0.8x, which on NIFTY50 1d
#: splits the three classes far more evenly than any directional band achieved.
DEFAULT_EXPANSION_BAND = 0.25


class VolatilityExpansionError(ValueError):
    """Raised when the inputs cannot support a well-defined range comparison."""


@dataclass(frozen=True)
class VolatilityExpansionResult:
    label: VolatilityLabel
    #: forward_range / trailing_range. 1.0 means an unchanged envelope.
    range_ratio: float
    forward_range: float
    trailing_range: float
    #: When the label became known: the close of the last bar in the forward window.
    label_available_at: object


def volatility_expansion_label(
    *,
    trailing_range: float,
    forward_path: Sequence[ForwardBar],
    expected_forward_bars: int,
    band: float = DEFAULT_EXPANSION_BAND,
) -> VolatilityExpansionResult | None:
    """Label a bar by whether the forward range widened or narrowed.

    Returns ``None`` when the comparison is not well defined rather than guessing:

    * a non-positive ``trailing_range`` (a flat window has no scale to compare to)
    * fewer forward bars than ``expected_forward_bars`` — right-censored at the end
      of the data, so the forward envelope is not yet complete and would look
      artificially narrow. This is the same censoring rule the triple-barrier
      labeller applies, and skipping it would manufacture spurious CONTRACTIONs at
      the most recent (and most interesting) end of the series.
    """

    if band <= 0 or not math.isfinite(band):
        raise VolatilityExpansionError("band must be a positive, finite number.")
    if not isinstance(expected_forward_bars, int) or isinstance(expected_forward_bars, bool) or expected_forward_bars <= 0:
        raise VolatilityExpansionError("expected_forward_bars must be a positive integer.")
    if not math.isfinite(trailing_range):
        raise VolatilityExpansionError("trailing_range must be finite.")

    if trailing_range <= 0:
        return None

    path = list(forward_path)
    if len(path) < expected_forward_bars:
        return None

    for bar in path:
        if not (math.isfinite(bar.high) and math.isfinite(bar.low)):
            raise VolatilityExpansionError("A forward bar has a non-finite high or low.")
        if bar.high < bar.low:
            raise VolatilityExpansionError("A forward bar has high below low.")

    forward_range = max(bar.high for bar in path) - min(bar.low for bar in path)
    ratio = forward_range / trailing_range

    expansion_threshold = 1.0 + band
    contraction_threshold = 1.0 / (1.0 + band)
    if ratio >= expansion_threshold:
        label: VolatilityLabel = "EXPANSION"
    elif ratio <= contraction_threshold:
        label = "CONTRACTION"
    else:
        label = "STABLE"

    return VolatilityExpansionResult(
        label=label,
        range_ratio=ratio,
        forward_range=forward_range,
        trailing_range=trailing_range,
        label_available_at=path[-1].close_time,
    )


def trailing_range_of(highs: Sequence[float], lows: Sequence[float]) -> float:
    """High-low envelope of a trailing window, or 0.0 for an empty window.

    A separate helper because the source bar's own window is built by walking
    already-seen bars, which is the only way to keep it free of future information.
    """

    if not highs or not lows:
        return 0.0
    return max(highs) - min(lows)


#: A silence this long between consecutive intraday bars is a session boundary (overnight,
#: weekend or holiday), not a gap inside a session. Indian cash sessions are 6h15m long, so any
#: in-session gap is far below this, and 24-hour markets never reach it (their trailing window
#: correctly keeps rolling).
SESSION_GAP = timedelta(hours=4)

#: Bars at or above this length are not "intraday" for session scoping purposes.
_INTRADAY_LIMIT_MINUTES = 240


def timeframe_minutes(timeframe: str) -> int | None:
    """Bar length in minutes for ``"15m"``/``"1h"``-style names, ``None`` for daily and above."""

    match = re.fullmatch(r"(\d+)(m|h)", timeframe.strip().lower())
    if match is None:
        return None
    return int(match.group(1)) * (60 if match.group(2) == "h" else 1)


def is_intraday_timeframe(timeframe: str) -> bool:
    minutes = timeframe_minutes(timeframe)
    return minutes is not None and minutes < _INTRADAY_LIMIT_MINUTES


class SessionScopedTrailingWindow:
    """The K-bar trailing high-low window of the expansion label, confined to one session.

    The label divides the forward range by the trailing range of the K bars ending at the
    source bar. Rolled across the overnight gap, the first K-1 bars of a session carry a
    trailing window made partly of the previous day's bars, so the "range ratio" compares a
    morning forward window with a stale, differently-scaled envelope. Measured on NIFTY 15m h=5
    the class mix is 13/25/62% (EXPANSION/STABLE/CONTRACTION) at bar 0 and 6/16/78% at bar 4 against
    30/34/37% from bar 5 on -- a time-of-day artefact a clock feature alone can learn.

    With ``session_scoped`` the window is cleared when consecutive bars are more than
    ``SESSION_GAP`` apart, so it is full again only K bars into the session and the contaminated
    bars are skipped by the builder's existing "trailing window not yet full" rule. Daily and
    longer bars (``session_scoped=False``) keep rolling continuously: for them every bar is a
    new session and the gap is the data.
    """

    def __init__(self, window: int, *, session_scoped: bool) -> None:
        if not isinstance(window, int) or window <= 0:
            raise VolatilityExpansionError("window must be a positive integer.")
        self._window = window
        self._session_scoped = session_scoped
        self._highs: deque[float] = deque(maxlen=window)
        self._lows: deque[float] = deque(maxlen=window)
        self._previous_close_time: datetime | None = None

    def push(self, close_time: datetime, high: float, low: float) -> None:
        if (
            self._session_scoped
            and self._previous_close_time is not None
            and close_time - self._previous_close_time > SESSION_GAP
        ):
            self._highs.clear()
            self._lows.clear()
        self._previous_close_time = close_time
        self._highs.append(high)
        self._lows.append(low)

    @property
    def full(self) -> bool:
        return len(self._highs) >= self._window

    @property
    def highs(self) -> list[float]:
        return list(self._highs)

    @property
    def lows(self) -> list[float]:
        return list(self._lows)


def time_of_day_key(close_time: datetime, bar_minutes: int) -> int:
    """The bar-of-day bucket of a bar: IST minute-of-day of its OPEN, over the bar length.

    Derived from the clock rather than counted from the first example of a session, because
    examples are dropped (trailing window not full, censored label) and a count would drift.
    A naive ``close_time`` is taken to already be IST wall clock, which is this package's
    fixture convention.
    """

    if bar_minutes <= 0:
        raise VolatilityExpansionError("bar_minutes must be positive.")
    ist = close_time if close_time.tzinfo is None else close_time.astimezone(INDIA_TZ)
    open_minute = ist.hour * 60 + ist.minute - bar_minutes
    return open_minute // bar_minutes


def time_of_day_majority_predictions(
    *,
    train_keys: Sequence[int],
    train_labels: Sequence[str],
    holdout_keys: Sequence[int],
) -> list[str]:
    """The time-of-day-stratified trivial predictor: the TRAINING majority class per bar-of-day.

    Label-alphabet agnostic (2026-10-10 follow-up): it only counts label strings, so the directional
    target (BEARISH/NEUTRAL/BULLISH) reuses it unchanged via ``train.time_of_day_baseline_metrics``.

    The global majority baseline lets a model that has merely learned the clock beat "trivial":
    the class mix differs sharply by bar of day (see ``SessionScopedTrailingWindow``), so the
    honest trivial competitor is the best constant *per time-of-day bucket*. The majority is
    taken from the training partition only -- the only thing a deployed predictor could have
    known -- with ties broken towards the larger label string, exactly as
    ``train.trivial_majority_metrics`` does. A bucket unseen in training falls back to the
    global training majority. Compare a model against ``max(global trivial, this)`` on both
    accuracy and macro-F1.
    """

    if len(train_keys) != len(train_labels):
        raise VolatilityExpansionError("train_keys and train_labels must be the same length.")
    if not train_labels:
        raise VolatilityExpansionError("A time-of-day baseline needs a non-empty training partition.")

    def majority(counts: dict[str, int]) -> str:
        return max(counts.items(), key=lambda entry: (entry[1], entry[0]))[0]

    by_key: dict[int, dict[str, int]] = {}
    overall: dict[str, int] = {}
    for key, label_value in zip(train_keys, train_labels):
        by_key.setdefault(key, {})
        by_key[key][label_value] = by_key[key].get(label_value, 0) + 1
        overall[label_value] = overall.get(label_value, 0) + 1
    majority_by_key = {key: majority(counts) for key, counts in by_key.items()}
    fallback = majority(overall)
    return [majority_by_key.get(key, fallback) for key in holdout_keys]


def trivial_scores(
    actual: Sequence[VolatilityLabel], predicted: Sequence[VolatilityLabel]
) -> tuple[float, float]:
    """(accuracy, macro-F1 over the three-label alphabet) of a prediction list."""

    if len(actual) != len(predicted) or not actual:
        raise VolatilityExpansionError("actual and predicted must be the same non-zero length.")
    accuracy = sum(1 for a, p in zip(actual, predicted) if a == p) / len(actual)
    f1_total = 0.0
    for volatility_label in VOLATILITY_LABELS:
        true_positive = sum(1 for a, p in zip(actual, predicted) if a == p == volatility_label)
        denominator = sum(1 for a in actual if a == volatility_label) + sum(
            1 for p in predicted if p == volatility_label
        )
        f1_total += 0.0 if denominator == 0 else 2 * true_positive / denominator
    return accuracy, f1_total / len(VOLATILITY_LABELS)


__all__ = [
    "SESSION_GAP",
    "SessionScopedTrailingWindow",
    "is_intraday_timeframe",
    "time_of_day_key",
    "time_of_day_majority_predictions",
    "timeframe_minutes",
    "trivial_scores",
    "DEFAULT_EXPANSION_BAND",
    "LABEL_SCHEME_VOLATILITY_EXPANSION",
    "VOLATILITY_LABELS",
    "VolatilityExpansionError",
    "VolatilityExpansionResult",
    "VolatilityLabel",
    "trailing_range_of",
    "volatility_expansion_label",
]
