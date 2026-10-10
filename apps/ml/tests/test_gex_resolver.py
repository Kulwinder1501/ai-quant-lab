"""
Tests for ai_quant_lab_ml.gex_resolver: PCR and GEX must describe the SAME resolved snapshot,
unavailable PCR resolutions must short-circuit before any strike-row query, and the per-snapshot
cache must avoid re-solving IV for repeat candles.
"""

from datetime import date, datetime, timedelta

import pytest

from ai_quant_lab_ml.gex_aggregator import price_european_option
from ai_quant_lab_ml.gex_resolver import resolve_options_context
from ai_quant_lab_ml.option_chain_pcr import IST, ExpiryBook, OptionChainBooks


def ist(day: str, clock: str) -> datetime:
    return datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=IST)


def _book(expiry: date, observed_at: datetime, call_oi=100_000.0, put_oi=140_000.0, missing=0) -> ExpiryBook:
    return ExpiryBook(
        observed_at=observed_at, expiry_date=expiry, call_oi=call_oi, put_oi=put_oi,
        contracts=2, missing_oi_contracts=missing,
        call_oi_change_vs_prev_day=0.0, put_oi_change_vs_prev_day=0.0,
    )


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self._connection = connection
        self._rows: list = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        return False

    def execute(self, query, params=None) -> None:
        self._connection.calls.append(params)
        self._rows = self._connection.rows

    def fetchall(self):
        return list(self._rows)


class FakeConnection:
    def __init__(self, rows: list) -> None:
        self.rows = rows
        self.calls: list = []

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)


EXPIRY = date(2026, 9, 29)
CALENDAR = [(ist("2026-09-21", "09:20:00"), frozenset({EXPIRY}))]


def _strike_rows(spot: float, true_vol: float, observed_at: datetime, expiry: datetime, strike: float, oi: int):
    time_to_expiry = (expiry - observed_at).total_seconds() / (365 * 24 * 3600)
    call = price_european_option(spot, strike, time_to_expiry, 0.065, true_vol, "CE")
    put = price_european_option(spot, strike, time_to_expiry, 0.065, true_vol, "PE")
    return [
        (strike, "CE", call.premium - 0.01, call.premium + 0.01, oi),
        (strike, "PE", put.premium - 0.01, put.premium + 0.01, oi),
    ]


def test_unavailable_pcr_resolution_short_circuits_before_any_db_query():
    as_of = ist("2026-09-21", "11:00:00")
    books = OptionChainBooks(books_by_expiry={}, calendar=CALENDAR)  # no books at all -> NO_SNAPSHOT
    conn = FakeConnection(rows=[])

    result = resolve_options_context(
        conn, books, "NIFTY50", spot=57700.0, contract_multiplier=75, as_of=as_of,
    )
    assert result.state == "UNAVAILABLE"
    assert result.pcr_windowed is None
    assert result.net_dealer_gamma_exposure is None
    assert conn.calls == []  # never queried strike rows for an unavailable PCR resolution


def test_pcr_and_gex_describe_the_identical_resolved_snapshot():
    observed_at = ist("2026-09-21", "10:54:00")
    as_of = ist("2026-09-21", "11:00:00")
    expiry_settlement = datetime(2026, 9, 29, 15, 30, tzinfo=IST)
    spot = 57700.0

    books = OptionChainBooks(
        books_by_expiry={EXPIRY: [_book(EXPIRY, observed_at, call_oi=100_000.0, put_oi=140_000.0)]},
        calendar=CALENDAR,
    )
    rows = _strike_rows(spot, 0.15, observed_at, expiry_settlement, strike=57700.0, oi=500)
    conn = FakeConnection(rows=rows)

    result = resolve_options_context(
        conn, books, "NIFTY50", spot=spot, contract_multiplier=75, as_of=as_of,
    )

    assert result.state == "FRESH"
    assert result.pcr_windowed == pytest.approx(1.4)  # 140_000 / 100_000, from the OI-summed book
    assert result.expiry_date == EXPIRY
    assert result.observed_at == observed_at
    assert result.net_dealer_gamma_exposure is not None
    assert result.contracts_priced == 2
    # Exactly the resolved snapshot's rows were requested -- not some other poll or expiry.
    assert conn.calls == [{
        "underlying_symbol": "NIFTY50", "expiry_date": EXPIRY, "observed_at": observed_at,
    }]


def test_stale_pcr_resolution_is_unavailable_and_never_queries_strike_rows():
    observed_at = ist("2026-09-21", "09:00:00")
    as_of = observed_at + timedelta(minutes=45)  # past MAX_SNAPSHOT_AGE_MINUTES=20
    books = OptionChainBooks(
        books_by_expiry={EXPIRY: [_book(EXPIRY, observed_at)]}, calendar=CALENDAR,
    )
    conn = FakeConnection(rows=[])

    result = resolve_options_context(
        conn, books, "NIFTY50", spot=57700.0, contract_multiplier=75, as_of=as_of,
    )
    assert result.state == "UNAVAILABLE"
    assert result.reason == "STALE"
    assert conn.calls == []


def test_gex_cache_avoids_a_second_db_query_for_the_same_resolved_snapshot():
    observed_at = ist("2026-09-21", "10:54:00")
    expiry_settlement = datetime(2026, 9, 29, 15, 30, tzinfo=IST)
    spot = 57700.0
    books = OptionChainBooks(
        books_by_expiry={EXPIRY: [_book(EXPIRY, observed_at)]}, calendar=CALENDAR,
    )
    rows = _strike_rows(spot, 0.15, observed_at, expiry_settlement, strike=57700.0, oi=500)
    conn = FakeConnection(rows=rows)
    cache: dict = {}

    first = resolve_options_context(
        conn, books, "NIFTY50", spot=spot, contract_multiplier=75,
        as_of=ist("2026-09-21", "11:00:00"), gex_cache=cache,
    )
    second = resolve_options_context(
        conn, books, "NIFTY50", spot=spot, contract_multiplier=75,
        as_of=ist("2026-09-21", "11:05:00"), gex_cache=cache,  # same poll, next candle
    )

    assert len(conn.calls) == 1  # the second resolution reused the cache, not a new query
    assert second.net_dealer_gamma_exposure == pytest.approx(first.net_dealer_gamma_exposure)


def test_non_positive_spot_is_unavailable():
    observed_at = ist("2026-09-21", "10:54:00")
    books = OptionChainBooks(
        books_by_expiry={EXPIRY: [_book(EXPIRY, observed_at)]}, calendar=CALENDAR,
    )
    conn = FakeConnection(rows=[])
    result = resolve_options_context(
        conn, books, "NIFTY50", spot=0.0, contract_multiplier=75, as_of=ist("2026-09-21", "11:00:00"),
    )
    assert result.state == "UNAVAILABLE"
    assert result.reason == "INVALID_SPOT"
    assert conn.calls == []
