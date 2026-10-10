"""Selection rule for the point-in-time option-chain PCR (Python twin of option-chain-signal.ts)."""

import math
from datetime import date, datetime, timedelta, timezone

from ai_quant_lab_ml.option_chain_pcr import (
    IST,
    MAX_SNAPSHOT_AGE_MINUTES,
    ExpiryBook,
    OptionChainBooks,
    is_within_cash_session,
    poll_to_poll_pcr_change,
    select_nearest_unsettled_expiry,
)


def ist(day: str, clock: str) -> datetime:
    return datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=IST)


def book(expiry: date, observed_at: datetime, call_oi=100_000.0, put_oi=140_000.0, missing=0) -> ExpiryBook:
    return ExpiryBook(
        observed_at=observed_at, expiry_date=expiry, call_oi=call_oi, put_oi=put_oi,
        contracts=30, missing_oi_contracts=missing,
        call_oi_change_vs_prev_day=0.0, put_oi_change_vs_prev_day=0.0,
    )


WEEKLY = date(2026, 9, 22)
MONTHLY = date(2026, 9, 29)
CALENDAR = [(ist("2026-09-21", "09:20:00"), frozenset({WEEKLY, MONTHLY}))]


def test_shared_ceiling_is_twenty_minutes():
    assert MAX_SNAPSHOT_AGE_MINUTES == 20.0


def test_nearest_expiry_is_chosen_before_the_snapshot_not_the_latest_observed_at():
    # The collector stores the front book, then the farther "roll" book ~0.2s later. The latest
    # observed_at is the FARTHER expiry; the rule must still return the nearest expiry's PCR.
    t = ist("2026-09-21", "11:00:00")
    books = OptionChainBooks(
        books_by_expiry={
            WEEKLY: [book(WEEKLY, t - timedelta(minutes=6), call_oi=100_000, put_oi=140_000)],
            MONTHLY: [book(MONTHLY, t - timedelta(minutes=6) + timedelta(seconds=0.2), call_oi=100_000, put_oi=50_000)],
        },
        calendar=CALENDAR,
    )

    resolution = books.resolve(t)

    assert resolution.expiry_date == WEEKLY
    assert math.isclose(resolution.pcr_windowed, 1.4)


def test_settled_expiry_day_book_is_not_used_after_15_30_ist():
    t = ist("2026-09-22", "15:31:00")
    books = OptionChainBooks(
        books_by_expiry={
            WEEKLY: [book(WEEKLY, ist("2026-09-22", "15:29:00"))],
            MONTHLY: [book(MONTHLY, ist("2026-09-22", "15:29:00"), put_oi=50_000)],
        },
        calendar=CALENDAR,
    )

    assert select_nearest_unsettled_expiry({WEEKLY, MONTHLY}, t) == MONTHLY
    assert books.resolve(t).expiry_date == MONTHLY


def test_out_of_session_snapshots_are_excluded_by_the_window_helper():
    assert not is_within_cash_session(ist("2026-09-22", "09:11:00"))
    assert not is_within_cash_session(ist("2026-09-22", "15:53:00"))
    assert is_within_cash_session(ist("2026-09-22", "09:15:00"))
    assert is_within_cash_session(ist("2026-09-22", "15:30:00"))
    assert not is_within_cash_session(ist("2026-09-22", "15:30:01"))
    # UTC-naive input is treated as UTC: 03:45Z == 09:15 IST.
    assert is_within_cash_session(datetime(2026, 9, 22, 3, 45))


def test_stale_is_an_explicit_reason_and_18_minutes_is_accepted():
    t = ist("2026-09-21", "11:00:00")
    fresh = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=18))]}, CALENDAR)
    stale = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=25))]}, CALENDAR)

    assert fresh.resolve(t).pcr_windowed is not None
    resolution = stale.resolve(t)
    assert resolution.pcr_windowed is None
    assert resolution.reason == "STALE"
    assert resolution.message == "PCR unavailable (stale)"


def test_missing_open_interest_makes_the_pcr_unavailable_not_zero():
    t = ist("2026-09-21", "11:00:00")
    books = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=1), put_oi=0.0, missing=3)]}, CALENDAR)

    resolution = books.resolve(t)

    assert resolution.pcr_windowed is None
    assert resolution.reason == "INCOMPLETE_OPEN_INTEREST"


def test_no_snapshot_and_no_unsettled_expiry_reasons():
    t = ist("2026-09-21", "11:00:00")
    assert OptionChainBooks({}, CALENDAR).resolve(t).reason == "NO_SNAPSHOT"
    late = ist("2026-09-30", "10:00:00")
    assert OptionChainBooks({}, CALENDAR).resolve(late).reason == "NO_UNSETTLED_EXPIRY"


def test_calendar_is_point_in_time_and_falls_back_to_observed_expiries_without_one():
    t = ist("2026-09-21", "11:00:00")
    books = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=2))]}, [])

    assert books.resolve(t).expiry_date == WEEKLY
    # A calendar observed AFTER the decision time is not visible (falls back instead).
    future_calendar = [(t + timedelta(minutes=5), frozenset({date(2026, 9, 21)}))]
    future_books = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=2))]}, future_calendar)
    assert future_books.resolve(t).expiry_date == WEEKLY


def test_poll_to_poll_change_uses_the_same_expiry_only():
    t = ist("2026-09-21", "11:00:00")
    books = OptionChainBooks(
        books_by_expiry={
            WEEKLY: [
                book(WEEKLY, t - timedelta(minutes=18), call_oi=100_000, put_oi=100_000),  # PCR 1.0
                book(WEEKLY, t - timedelta(minutes=6), call_oi=100_000, put_oi=140_000),   # PCR 1.4
            ],
            # A different expiry observed in between must never be differenced against.
            MONTHLY: [book(MONTHLY, t - timedelta(minutes=6), call_oi=100_000, put_oi=900_000)],
        },
        calendar=CALENDAR,
    )

    change = poll_to_poll_pcr_change(books.resolve(t))

    assert math.isclose(change, 0.4)


def test_poll_to_poll_change_is_nan_without_a_prior_snapshot_of_the_same_expiry():
    t = ist("2026-09-21", "11:00:00")
    books = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=6))]}, CALENDAR)

    assert math.isnan(poll_to_poll_pcr_change(books.resolve(t)))


def test_utc_aware_inputs_are_accepted():
    t = ist("2026-09-21", "11:00:00").astimezone(timezone.utc)
    books = OptionChainBooks({WEEKLY: [book(WEEKLY, t - timedelta(minutes=3))]}, CALENDAR)

    assert books.resolve(t).expiry_date == WEEKLY


def test_options_context_naming_keeps_the_gex_alias():
    from ai_quant_lab_ml.fibonacci_pit_engine import GEXContext, GEXContextState, OptionsContext, OptionsContextState

    assert GEXContext is OptionsContext
    assert GEXContextState is OptionsContextState
    legacy = GEXContext("FRESH", 1.0, 1, 1)
    assert isinstance(legacy, OptionsContext)
    assert legacy.state == "FRESH"
