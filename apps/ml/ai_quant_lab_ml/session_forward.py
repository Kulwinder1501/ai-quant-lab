"""Session-scoped forward windows for intraday labels (2026-10-10 follow-up, code gaps, GAP 3).

An intraday forward label that reaches past the session close does not measure the intended
horizon: the last ``horizon`` bars of a session would take their "future" from the NEXT morning, so
the label contains the overnight gap (median |overnight gap| ~71 bps against a 99th-percentile
5-bar intraday move of ~21 bps on ^NSEI 1m). The SQL loader already partitions by IST trading date
(``postgres_repository._INTRADAY_SESSION_PARTITION``); this module is the Python-side guarantee for
every other path that walks a bar list by index or receives a forward path.

Rule: the whole forward window must lie inside the SAME IST trading session as the source bar. A bar
whose full horizon would extend past the session close gets NO label (``None`` / skipped), it is
never filled from the next day. Daily and longer bars are not intraday and are left alone: for them
every bar is its own session and the next bar IS the horizon.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime, timezone
from typing import Any, TypeVar

from .volume_intelligence import INDIA_TZ

T = TypeVar("T")


def is_intraday_label_timeframe(timeframe: str) -> bool:
    """Whether a timeframe has more than one bar per session.

    Mirrors ``postgres_repository._is_intraday_timeframe`` exactly (minute and hour codes), so the
    Python guard and the SQL partition can never disagree about which series are scoped.
    """

    return timeframe.strip().lower().endswith(("m", "h"))


def ist_session_date(moment: datetime | str) -> date:
    """IST trading-session date of a bar time. ISO strings are parsed; a naive value is UTC."""

    if isinstance(moment, str):
        moment = datetime.fromisoformat(moment)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.astimezone(INDIA_TZ).date()


def crosses_session(source_time: datetime | str, later_time: datetime | str) -> bool:
    """True when ``later_time`` falls on a different IST trading date than ``source_time``."""

    return ist_session_date(source_time) != ist_session_date(later_time)


def same_session_prefix(source_close_time: datetime, path: Sequence[T]) -> list[T]:
    """The leading bars of a forward ``path`` (objects with ``close_time``) in the source's session.

    The path is in time order, so the first bar on another session ends the window: it and every
    later bar are dropped. A caller that needs a full ``horizon`` of bars then sees a short path
    and treats the label as censored (unlabelled), exactly as for the end of the data.
    """

    session = ist_session_date(source_close_time)
    kept: list[T] = []
    for bar in path:
        if ist_session_date(bar.close_time) != session:  # type: ignore[attr-defined]
            break
        kept.append(bar)
    return kept


def forward_index_in_session(
    session_dates: Sequence[date], index: int, horizon: int
) -> int | None:
    """``index + horizon`` when that bar is on the same session as ``index``, else ``None``.

    ``session_dates[i]`` is the IST session date of bar ``i`` of a chronologically ordered series.
    ``None`` also covers running off the end of the series, so callers have one "no label" case.
    Because the series is in time order, equal dates at both ends mean every bar between them is in
    the same session too.
    """

    if horizon <= 0:
        raise ValueError("horizon must be a positive number of bars.")
    target = index + horizon
    if index < 0 or target >= len(session_dates):
        return None
    return target if session_dates[target] == session_dates[index] else None


def session_dates_of(bars: Sequence[Any], key: str = "open_time") -> list[date]:
    """IST session date per bar mapping, for ``forward_index_in_session``."""

    return [ist_session_date(bar[key]) for bar in bars]


__all__ = [
    "crosses_session",
    "forward_index_in_session",
    "is_intraday_label_timeframe",
    "ist_session_date",
    "same_session_prefix",
    "session_dates_of",
]
