"""Triple-barrier labelling.

Instead of asking "what is the sign of the close-to-close return exactly N bars
from now" (the fixed-horizon target, which measured no edge on NIFTY 1d), this
asks the question a trade's risk geometry actually poses: **which barrier does the
forward path reach first?**

* an **upper** barrier at ``source_close + upper_multiple * atr`` (a profit target)
* a **lower** barrier at ``source_close - lower_multiple * atr`` (a stop)
* a **vertical** barrier at ``len(forward_path)`` bars (a time limit)

The label is the first barrier the path touches: UPPER -> BULLISH, LOWER ->
BEARISH, neither-within-the-window -> NEUTRAL (a genuine time-out, not chop).

Two deliberate properties:

* **ATR-scaled barriers.** A fixed basis-point barrier means something different
  in a calm regime than a volatile one; scaling the distance to ATR makes the
  same label mean the same thing across regimes and instruments -- the same
  reasoning behind the scale-free features already in the schema.
* **Same-bar double touch is dropped, not guessed.** When a single bar's range
  engulfs both barriers, OHLC cannot order the two touches, so the direction is
  genuinely indeterminable without intra-bar data. Returning ``None`` drops the
  example rather than injecting a coin-flip label into training. This is a known
  limitation resolvable later with a finer-grained forward series.

This module is pure: it takes a source price, an ATR, the barrier multiples, and a
forward path, and returns a label. Loading the forward path from the database is a
separate adapter concern (it must obey the same as-of cutoff every other label
does), kept out of here so the labelling rule can be unit-tested in isolation.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

# ForwardBar lives in contracts (next to CandleEvidence, which now carries a
# forward_path) so the shared evidence types have one home and there is no import
# cycle. It is re-exported here so callers of the labelling rule can import it
# alongside the function.
from .contracts import ForwardBar, MarketLabel

BarrierTouch = Literal["UPPER", "LOWER", "VERTICAL"]


class TripleBarrierError(ValueError):
    """Raised when the inputs cannot support a well-defined barrier evaluation."""


@dataclass(frozen=True)
class TripleBarrierResult:
    label: MarketLabel
    touched: BarrierTouch
    #: 0-based index into the forward path where the label was decided.
    touch_index: int
    #: When the label became known -- the touching bar's close (VERTICAL: last bar).
    touch_close_time: datetime
    #: Fractional return from the source close to the deciding bar's close.
    forward_return: float


def _require_positive_finite(value: float, name: str) -> None:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value <= 0:
        raise TripleBarrierError(f"{name} must be a positive, finite number.")


def triple_barrier_label(
    *,
    source_close: float,
    atr: float,
    upper_multiple: float,
    lower_multiple: float,
    forward_path: Sequence[ForwardBar],
) -> TripleBarrierResult | None:
    """Label a source bar by the first barrier its forward path reaches.

    Returns ``None`` when the label is unknowable rather than guessing: an empty
    forward path (no evidence yet) or a same-bar double touch (order
    indeterminable from OHLC). A path that reaches the end without touching either
    horizontal barrier is a real NEUTRAL time-out, not ``None``.

    ``forward_path`` must be chronological and must already be bounded to the
    vertical barrier by the caller -- its length *is* the time barrier.
    """

    _require_positive_finite(source_close, "source_close")
    _require_positive_finite(atr, "atr")
    _require_positive_finite(upper_multiple, "upper_multiple")
    _require_positive_finite(lower_multiple, "lower_multiple")

    path = list(forward_path)
    if not path:
        return None

    upper = source_close + upper_multiple * atr
    lower = source_close - lower_multiple * atr
    # A tolerance so a barrier touched exactly -- e.g. high == upper -- counts,
    # rather than being lost to binary floating-point representation. Scaled to the
    # price so it is meaningful across instruments of very different magnitudes.
    tolerance = source_close * 1e-9

    for index, bar in enumerate(path):
        _require_positive_finite(bar.high, "forward bar high")
        _require_positive_finite(bar.low, "forward bar low")
        _require_positive_finite(bar.close, "forward bar close")
        if bar.high < bar.low:
            raise TripleBarrierError("A forward bar has high below low.")

        hit_upper = bar.high >= upper - tolerance
        hit_lower = bar.low <= lower + tolerance
        if hit_upper and hit_lower:
            # One bar engulfed both barriers; the touch order is indeterminable.
            return None
        if hit_upper:
            return TripleBarrierResult(
                label="BULLISH",
                touched="UPPER",
                touch_index=index,
                touch_close_time=bar.close_time,
                forward_return=bar.close / source_close - 1.0,
            )
        if hit_lower:
            return TripleBarrierResult(
                label="BEARISH",
                touched="LOWER",
                touch_index=index,
                touch_close_time=bar.close_time,
                forward_return=bar.close / source_close - 1.0,
            )

    last = path[-1]
    return TripleBarrierResult(
        label="NEUTRAL",
        touched="VERTICAL",
        touch_index=len(path) - 1,
        touch_close_time=last.close_time,
        forward_return=last.close / source_close - 1.0,
    )


__all__ = [
    "BarrierTouch",
    "ForwardBar",
    "TripleBarrierError",
    "TripleBarrierResult",
    "triple_barrier_label",
]
