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
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from .contracts import LABEL_SCHEME_VOLATILITY_EXPANSION, ForwardBar, LabelAlphabet

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


__all__ = [
    "DEFAULT_EXPANSION_BAND",
    "LABEL_SCHEME_VOLATILITY_EXPANSION",
    "VOLATILITY_LABELS",
    "VolatilityExpansionError",
    "VolatilityExpansionResult",
    "VolatilityLabel",
    "trailing_range_of",
    "volatility_expansion_label",
]
