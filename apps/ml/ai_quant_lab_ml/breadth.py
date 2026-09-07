"""Point-in-time market breadth from the research-equity daily panel.

The v6 swing schema carries seven cross-sectional columns computed from the
twenty research equities plus the two indices. This module holds all of the
math as pure functions over already-loaded bars, so the exact same code path
serves training and inference and can be unit-tested without a database.

Point-in-time discipline: every statistic for session D reads only bars that
closed at or before D's close. Trailing windows (SMA, volume median) include
the session being scored and never a later one, matching the convention of the
per-candle features in :mod:`features`. A bar being scored may only read a
breadth context whose ``observed_at`` is at or before its own close time --
:func:`latest_breadth_at` enforces that plus a staleness budget.
"""

from __future__ import annotations

import bisect
import collections
import math
import statistics
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Mapping, Sequence

from .contracts import (
    BREADTH_BANK_SYMBOLS,
    BREADTH_IT_SYMBOLS,
    BREADTH_MINIMUM_PARTICIPANTS,
    BREADTH_SECTOR_MINIMUM,
    BREADTH_SMA_SESSIONS,
    BREADTH_STALENESS_DAYS,
    BREADTH_VOLUME_MEDIAN_SESSIONS,
    BreadthContext,
)


@dataclass(frozen=True)
class PanelBar:
    """One completed daily bar of a panel member, the minimum breadth needs."""

    close_time: datetime
    close: float
    volume: float


@dataclass(frozen=True)
class _MemberSession:
    """One member's contribution to one session, after its own trailing walk."""

    symbol: str
    close_time: datetime
    return_bps: float | None
    above_sma: bool | None
    volume_ratio: float | None


def _session_key(close_time: datetime) -> date:
    """The calendar date (UTC) a daily bar settles on.

    Daily bars from every collector in this project close inside the NSE
    session (15:30 IST is 10:00 UTC), so the UTC date is stable across
    providers and never rolls into the next day.
    """

    return close_time.date()


def _walk_member(symbol: str, bars: Sequence[PanelBar]) -> list[_MemberSession]:
    """Chronological walk of one member producing per-session statistics.

    Trailing windows are *full-window only*: a share-above-SMA20 computed from
    six sessions is a different feature wearing the same name, so incomplete
    windows report ``None`` and the session aggregate simply has one fewer
    participant for that statistic.
    """

    ordered = sorted(bars, key=lambda bar: bar.close_time)
    sessions: list[_MemberSession] = []
    closes: collections.deque[float] = collections.deque(maxlen=BREADTH_SMA_SESSIONS)
    volumes: collections.deque[float] = collections.deque(maxlen=BREADTH_VOLUME_MEDIAN_SESSIONS)
    prior_close = math.nan
    seen_dates: set[date] = set()

    for bar in ordered:
        key = _session_key(bar.close_time)
        # A duplicated session inside one series is corrupt evidence; the data
        # audit flags it INVALID upstream. Keeping the first print here keeps
        # this function total without inventing an average of two bars.
        if key in seen_dates:
            continue
        seen_dates.add(key)

        close = bar.close if math.isfinite(bar.close) and bar.close > 0 else math.nan
        return_bps: float | None = None
        if math.isfinite(close) and math.isfinite(prior_close) and prior_close > 0:
            return_bps = (close / prior_close - 1.0) * 10_000.0

        above_sma: bool | None = None
        if math.isfinite(close):
            closes.append(close)
            if len(closes) == BREADTH_SMA_SESSIONS:
                above_sma = close > (sum(closes) / len(closes))

        volume_ratio: float | None = None
        if math.isfinite(bar.volume) and bar.volume >= 0:
            volumes.append(bar.volume)
            if len(volumes) == BREADTH_VOLUME_MEDIAN_SESSIONS:
                median_volume = statistics.median(volumes)
                if median_volume > 0:
                    volume_ratio = bar.volume / median_volume

        sessions.append(
            _MemberSession(
                symbol=symbol,
                close_time=bar.close_time,
                return_bps=return_bps,
                above_sma=above_sma,
                volume_ratio=volume_ratio,
            )
        )
        if math.isfinite(close):
            prior_close = close
    return sessions


def _index_returns_by_session(closes: Sequence[PanelBar]) -> dict[date, float]:
    """Close-to-close return in bps per session for one index series."""

    ordered = sorted(closes, key=lambda bar: bar.close_time)
    returns: dict[date, float] = {}
    prior_close = math.nan
    seen_dates: set[date] = set()
    for bar in ordered:
        key = _session_key(bar.close_time)
        if key in seen_dates:
            continue
        seen_dates.add(key)
        close = bar.close if math.isfinite(bar.close) and bar.close > 0 else math.nan
        if math.isfinite(close) and math.isfinite(prior_close) and prior_close > 0:
            returns[key] = (close / prior_close - 1.0) * 10_000.0
        if math.isfinite(close):
            prior_close = close
    return returns


def compute_breadth_contexts(
    panel: Mapping[str, Sequence[PanelBar]],
    *,
    primary_index_bars: Sequence[PanelBar] = (),
    secondary_index_bars: Sequence[PanelBar] = (),
) -> list[BreadthContext]:
    """Turn the equity panel plus the two index series into per-session breadth.

    A session below :data:`BREADTH_MINIMUM_PARTICIPANTS` measurable returns is
    omitted entirely: a handful of names cannot describe breadth, and omitting
    the session lets the attach rule fall back to the last session that could,
    bounded by the staleness budget. Statistics whose own participant floor is
    not met within an otherwise publishable session are ``None`` individually.
    """

    member_sessions: dict[date, list[_MemberSession]] = collections.defaultdict(list)
    for symbol, bars in panel.items():
        for session in _walk_member(symbol.upper(), bars):
            member_sessions[_session_key(session.close_time)].append(session)

    primary_returns = _index_returns_by_session(primary_index_bars)
    secondary_returns = _index_returns_by_session(secondary_index_bars)

    contexts: list[BreadthContext] = []
    bank_set = set(BREADTH_BANK_SYMBOLS)
    it_set = set(BREADTH_IT_SYMBOLS)
    for key in sorted(member_sessions):
        members = member_sessions[key]
        returns = [m.return_bps for m in members if m.return_bps is not None]
        if len(returns) < BREADTH_MINIMUM_PARTICIPANTS:
            continue

        advances = sum(1 for value in returns if value > 0)
        declines = sum(1 for value in returns if value < 0)
        advance_decline = (advances - declines) / len(returns)
        median_return_bps = statistics.median(returns)
        return_dispersion_bps = statistics.stdev(returns)

        sma_flags = [m.above_sma for m in members if m.above_sma is not None]
        above_sma20_share = (
            sum(1.0 for flag in sma_flags if flag) / len(sma_flags)
            if len(sma_flags) >= BREADTH_MINIMUM_PARTICIPANTS
            else None
        )

        volume_ratios = [m.volume_ratio for m in members if m.volume_ratio is not None]
        median_volume_ratio = (
            statistics.median(volume_ratios)
            if len(volume_ratios) >= BREADTH_MINIMUM_PARTICIPANTS
            else None
        )

        bank_returns = [m.return_bps for m in members if m.symbol in bank_set and m.return_bps is not None]
        it_returns = [m.return_bps for m in members if m.symbol in it_set and m.return_bps is not None]
        bank_it_spread_bps = (
            (sum(bank_returns) / len(bank_returns)) - (sum(it_returns) / len(it_returns))
            if len(bank_returns) >= BREADTH_SECTOR_MINIMUM and len(it_returns) >= BREADTH_SECTOR_MINIMUM
            else None
        )

        primary = primary_returns.get(key)
        secondary = secondary_returns.get(key)
        index_return_gap_bps = primary - secondary if primary is not None and secondary is not None else None

        contexts.append(
            BreadthContext(
                observed_at=max(m.close_time for m in members),
                advance_decline=advance_decline,
                median_return_bps=median_return_bps,
                return_dispersion_bps=return_dispersion_bps,
                above_sma20_share=above_sma20_share,
                median_volume_ratio=median_volume_ratio,
                bank_it_spread_bps=bank_it_spread_bps,
                index_return_gap_bps=index_return_gap_bps,
            )
        )
    return contexts


def latest_breadth_at(
    contexts: Sequence[BreadthContext],
    close_time: datetime,
    *,
    staleness_days: int = BREADTH_STALENESS_DAYS,
) -> BreadthContext | None:
    """The freshest context observable at ``close_time``, or None when too stale.

    ``contexts`` must be sorted ascending by ``observed_at`` (the order
    :func:`compute_breadth_contexts` returns). Equality is allowed: a daily bar
    and the panel settle at the same session close, and its label only starts
    after that close, so same-close breadth is as-of evidence, not lookahead.
    """

    observed = [context.observed_at for context in contexts]
    position = bisect.bisect_right(observed, close_time)
    if position == 0:
        return None
    candidate = contexts[position - 1]
    if close_time - candidate.observed_at > timedelta(days=staleness_days):
        return None
    return candidate


__all__ = ["PanelBar", "compute_breadth_contexts", "latest_breadth_at"]
