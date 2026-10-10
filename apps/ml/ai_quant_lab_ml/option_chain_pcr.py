"""Point-in-time option-chain PCR selection, shared by the offline research scripts.

This is the Python twin of ``apps/api/src/modules/strategy-engine/domain/option-chain-signal.ts``
(the live gate). Both implement ONE rule so the gate that was validated offline is the gate that
runs live (they previously differed: live 15 min, backtest 60 min, signal check 15 min):

1. **Expiry first.** From the stored ``option_expiry_calendar`` choose the nearest expiry whose
   settlement -- 15:30 IST on the expiry date -- is strictly AFTER the decision time. A date-only
   test (``expiry_date >= observed_at::date``) kept counting books of contracts that had already
   settled once the 15:30 close passed.
2. **Then the snapshot.** Take the latest snapshot of THAT expiry observed at or before the
   decision time. The collector stores the front book and the "tradable roll" book ~0.2 s apart,
   one expiry per snapshot, so "latest observed_at across expiries" is the FARTHER expiry; the old
   ``MIN(expiry_date)`` per observed_at had a single expiry to minimise and was a no-op.
3. **Session hygiene.** Only snapshots observed inside 09:15:00-15:30:00 IST are eligible: a 09:11
   pre-open poll still carries the previous day's OI and a 15:53 poll is post-close.
4. **Staleness.** At most ``MAX_SNAPSHOT_AGE_MINUTES`` old (see below); otherwise the PCR is
   unavailable with an explicit reason (``STALE``), never a silent None.
5. **Completeness.** Any contract in the aggregate with missing OI makes the PCR unavailable
   (``INCOMPLETE_OPEN_INTEREST``). Missing OI is unknown, not zero.

What the number is: the sums cover the collector's spot-recentred strike WINDOW
(``strikecount`` strikes per side at collection time), NOT the whole exchange chain. It is a
windowed PCR (``pcr_windowed``), not a full-chain PCR.

What ``open_interest_change`` is: the vendor's ``open_interest - previous_open_interest`` -- the
change versus the PREVIOUS DAY's close, not versus the previous poll. A poll-to-poll delta, where
a script needs one, is computed here from consecutive snapshots of the SAME expiry only.
"""

from __future__ import annotations

import dataclasses
import math
from bisect import bisect_right
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Iterable

# Fixed UTC+05:30 (India has no DST), avoiding a tz-database dependency on Windows.
IST = timezone(timedelta(hours=5, minutes=30))

# Shared staleness ceiling, in minutes. Mirrors OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES in
# option-chain-signal.ts. Cadence math: the chain collector polls every 12 minutes (median) and up
# to 18 minutes (measured p90 17.999 over 30 days of in-session NIFTY50 polls), so a bar closing
# just before the next poll sees a snapshot up to ~18 minutes old on a perfectly healthy collector.
# 15 minutes rejected that healthy case (33% of NIFTY 5m bars got pcr=null) and the backtest's 60
# admitted snapshots that have missed several polls. 20 admits one full cycle plus jitter and still
# refuses a snapshot that has missed a poll (>= ~24 minutes).
MAX_SNAPSHOT_AGE_MINUTES = 20.0

SESSION_OPEN_IST = time(9, 15, 0)
SESSION_CLOSE_IST = time(15, 30, 0)

PCR_SCOPE = "STRIKE_WINDOW_AROUND_SPOT"

REASON_NO_SNAPSHOT = "NO_SNAPSHOT"
REASON_NO_UNSETTLED_EXPIRY = "NO_UNSETTLED_EXPIRY"
REASON_STALE = "STALE"
REASON_INCOMPLETE_OI = "INCOMPLETE_OPEN_INTEREST"
REASON_NO_CALL_OI = "NO_CALL_OPEN_INTEREST"

UNAVAILABLE_MESSAGES = {
    REASON_NO_SNAPSHOT: "PCR unavailable (no in-session option-chain snapshot for the nearest expiry)",
    REASON_NO_UNSETTLED_EXPIRY: "PCR unavailable (no listed expiry settles after the decision time)",
    REASON_STALE: "PCR unavailable (stale)",
    REASON_INCOMPLETE_OI: "PCR unavailable (a contract in the window has missing open interest)",
    REASON_NO_CALL_OI: "PCR unavailable (zero call open interest)",
}


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def expiry_settlement(expiry: date) -> datetime:
    """15:30 IST on the expiry date."""
    return datetime(expiry.year, expiry.month, expiry.day, 15, 30, tzinfo=IST)


def select_nearest_unsettled_expiry(expiries: Iterable[date], decision_time: datetime) -> date | None:
    """Rule 1: the earliest expiry whose 15:30 IST settlement is strictly after ``decision_time``."""
    decision_time = _aware(decision_time)
    unsettled = sorted({e for e in expiries if expiry_settlement(e) > decision_time})
    return unsettled[0] if unsettled else None


def is_within_cash_session(observed_at: datetime) -> bool:
    """Rule 3: observed inside 09:15:00-15:30:00 IST (inclusive)."""
    local = _aware(observed_at).astimezone(IST).time()
    return SESSION_OPEN_IST <= local <= SESSION_CLOSE_IST


@dataclasses.dataclass(frozen=True)
class ExpiryBook:
    """One expiry's aggregate at one snapshot instant (session-hygienic rows only)."""

    observed_at: datetime
    expiry_date: date
    call_oi: float
    put_oi: float
    contracts: int
    missing_oi_contracts: int
    # Vendor `open_interest_change`: change versus the PREVIOUS DAY's close, NOT the previous poll.
    call_oi_change_vs_prev_day: float
    put_oi_change_vs_prev_day: float


@dataclasses.dataclass(frozen=True)
class PcrResolution:
    pcr_windowed: float | None
    reason: str | None  # None when available
    expiry_date: date | None
    observed_at: datetime | None
    age_minutes: float | None
    book: ExpiryBook | None
    # The previous snapshot of the SAME expiry, for poll-to-poll deltas.
    prior_book: ExpiryBook | None

    @property
    def message(self) -> str | None:
        return UNAVAILABLE_MESSAGES.get(self.reason) if self.reason else None


@dataclasses.dataclass
class OptionChainBooks:
    """Per-expiry book series plus the calendar, ready for as-of lookups."""

    books_by_expiry: dict[date, list[ExpiryBook]]
    calendar: list[tuple[datetime, frozenset[date]]]  # sorted by observation time

    def __post_init__(self) -> None:
        self.books_by_expiry = {
            expiry: sorted(books, key=lambda b: b.observed_at) for expiry, books in self.books_by_expiry.items()
        }
        self.calendar = sorted(self.calendar, key=lambda entry: entry[0])
        self._times_by_expiry = {
            expiry: [b.observed_at for b in books] for expiry, books in self.books_by_expiry.items()
        }
        self._calendar_times = [entry[0] for entry in self.calendar]

    def expiries_listed_as_of(self, as_of: datetime) -> frozenset[date]:
        """Newest calendar observation at or before ``as_of``; else expiries seen in the prior day."""
        as_of = _aware(as_of)
        index = bisect_right(self._calendar_times, as_of) - 1
        if index >= 0:
            return self.calendar[index][1]
        # No calendar yet (it began ~1.5 h after the first snapshots): fall back to the expiries
        # whose books were observed in the preceding 24 h. Same fallback as the live repository.
        window_start = as_of - timedelta(days=1)
        listed = set()
        for expiry, times in self._times_by_expiry.items():
            hi = bisect_right(times, as_of)
            if hi > 0 and times[hi - 1] > window_start:
                listed.add(expiry)
        return frozenset(listed)

    def resolve(self, as_of: datetime, max_age_minutes: float = MAX_SNAPSHOT_AGE_MINUTES) -> PcrResolution:
        """Apply rules 1-5 at ``as_of``."""
        as_of = _aware(as_of)

        def unavailable(reason: str, **kw: Any) -> PcrResolution:
            return PcrResolution(None, reason, kw.get("expiry"), kw.get("observed_at"), kw.get("age"), None, None)

        expiry = select_nearest_unsettled_expiry(self.expiries_listed_as_of(as_of), as_of)
        if expiry is None:
            return unavailable(REASON_NO_UNSETTLED_EXPIRY)
        times = self._times_by_expiry.get(expiry, [])
        index = bisect_right(times, as_of) - 1
        if index < 0:
            return unavailable(REASON_NO_SNAPSHOT, expiry=expiry)
        book = self.books_by_expiry[expiry][index]
        prior = self.books_by_expiry[expiry][index - 1] if index > 0 else None
        age = (as_of - book.observed_at).total_seconds() / 60.0
        common = {"expiry": expiry, "observed_at": book.observed_at, "age": age}
        if age > max_age_minutes:
            return unavailable(REASON_STALE, **common)
        if book.missing_oi_contracts > 0:
            return unavailable(REASON_INCOMPLETE_OI, **common)
        if not (book.call_oi > 0):
            return unavailable(REASON_NO_CALL_OI, **common)
        return PcrResolution(book.put_oi / book.call_oi, None, expiry, book.observed_at, age, book, prior)


_BOOKS_SQL = """
    SELECT
        observed_at,
        expiry_date,
        SUM(CASE WHEN option_type = 'CE' THEN open_interest ELSE 0 END) AS call_oi,
        SUM(CASE WHEN option_type = 'PE' THEN open_interest ELSE 0 END) AS put_oi,
        COUNT(*) AS contracts,
        COUNT(*) FILTER (WHERE open_interest IS NULL) AS missing_oi,
        SUM(CASE WHEN option_type = 'CE' THEN open_interest_change ELSE 0 END) AS call_oi_change,
        SUM(CASE WHEN option_type = 'PE' THEN open_interest_change ELSE 0 END) AS put_oi_change
    FROM option_chain_snapshots
    WHERE underlying_symbol = %s
      AND (observed_at AT TIME ZONE 'Asia/Kolkata')::time BETWEEN TIME '09:15:00' AND TIME '15:30:00'
    GROUP BY observed_at, expiry_date
    ORDER BY observed_at ASC
"""

_CALENDAR_SQL = """
    SELECT observed_at, expiry_date
    FROM option_expiry_calendar
    WHERE underlying_symbol = %s
    ORDER BY observed_at ASC
"""


def load_option_chain_books(connection: Any, underlying_symbol: str) -> OptionChainBooks:
    """Read-only load of per-(expiry, observed_at) aggregates and the expiry calendar.

    ``connection`` is anything exposing ``.cursor()`` as a context manager (a psycopg connection).
    """
    with connection.cursor() as cursor:
        cursor.execute(_BOOKS_SQL, (underlying_symbol,))
        book_rows = cursor.fetchall()
        cursor.execute(_CALENDAR_SQL, (underlying_symbol,))
        calendar_rows = cursor.fetchall()

    books: dict[date, list[ExpiryBook]] = {}
    for observed_at, expiry, call_oi, put_oi, contracts, missing, call_chg, put_chg in book_rows:
        books.setdefault(expiry, []).append(
            ExpiryBook(
                observed_at=_aware(observed_at),
                expiry_date=expiry,
                call_oi=float(call_oi or 0),
                put_oi=float(put_oi or 0),
                contracts=int(contracts),
                missing_oi_contracts=int(missing),
                call_oi_change_vs_prev_day=float(call_chg or 0),
                put_oi_change_vs_prev_day=float(put_chg or 0),
            )
        )
    by_observation: dict[datetime, set[date]] = {}
    for observed_at, expiry in calendar_rows:
        by_observation.setdefault(_aware(observed_at), set()).add(expiry)
    calendar = [(observed, frozenset(expiries)) for observed, expiries in by_observation.items()]
    return OptionChainBooks(books_by_expiry=books, calendar=calendar)


def safe_ratio(numerator: float, denominator: float) -> float:
    if not math.isfinite(numerator) or not math.isfinite(denominator) or denominator == 0:
        return float("nan")
    return numerator / denominator


def poll_to_poll_pcr_change(resolution: PcrResolution) -> float:
    """Windowed-PCR change since the previous snapshot of the SAME expiry (nan when unavailable).

    Never differences across expiries: the previous snapshot in time is usually the other expiry's
    book from the same collector run, and its PCR is a different contract's.
    """
    if resolution.book is None or resolution.prior_book is None:
        return float("nan")
    prior = safe_ratio(resolution.prior_book.put_oi, resolution.prior_book.call_oi)
    if not math.isfinite(prior) or resolution.pcr_windowed is None:
        return float("nan")
    return resolution.pcr_windowed - prior
