"""
2026-10-10 follow-up (code gaps), GAP 3: an intraday forward label must stay inside the source bar's
IST trading session. The last `horizon` bars of a session get NO label (omitted, never filled from the
next morning), so a label never measures the overnight gap. Synthetic data only; daily bars are
deliberately unaffected.
"""

from __future__ import annotations

import dataclasses
from datetime import UTC, date, datetime, timedelta

import pytest

import ai_quant_lab_ml.structure_intelligence as structure
from ai_quant_lab_ml.contracts import (
    LABEL_SCHEME_TRIPLE_BARRIER,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
    CandleEvidence,
    DatasetRequest,
    ForwardBar,
    IndicatorEvidence,
)
from ai_quant_lab_ml.features import (
    build_labeled_examples,
    build_triple_barrier_examples,
    build_volatility_expansion_examples,
)
from ai_quant_lab_ml.session_forward import (
    crosses_session,
    forward_index_in_session,
    is_intraday_label_timeframe,
    ist_session_date,
    same_session_prefix,
    session_dates_of,
)
from tests.test_features import evidence, request as daily_request

BARS_PER_SESSION = 26                      # 15m bars from 09:15 IST (a synthetic, round session length)
BAR = timedelta(minutes=15)
DAY1_OPEN = datetime(2026, 3, 2, 3, 45, tzinfo=UTC)   # 09:15 IST
DAY2_OPEN = DAY1_OPEN + timedelta(days=1)
H = 2


def two_session_bars(day2_shift: float = 0.0) -> list[tuple[datetime, datetime, float]]:
    """(open, close, close_price) for two consecutive 26-bar 15m sessions. Day 2 is shifted by
    `day2_shift` so the overnight jump is unmistakable if any label ever reaches it."""
    out = []
    for day_open, shift in ((DAY1_OPEN, 0.0), (DAY2_OPEN, day2_shift)):
        for i in range(BARS_PER_SESSION):
            open_time = day_open + i * BAR
            out.append((open_time, open_time + BAR, 100.0 + shift + 0.01 * i))
    return out


def naive_loader_records(horizon: int, *, day2_shift: float, atr: float | None = None) -> list[CandleEvidence]:
    """What an UNPARTITIONED loader (the bug) would hand the builders: the future/forward bars are
    simply the next `horizon` rows of the series, across the overnight gap."""
    bars = two_session_bars(day2_shift)
    template = evidence(0)
    indicators = (
        (IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": atr}),) if atr is not None else template.indicators
    )
    records = []
    for index, (open_time, close_time, close) in enumerate(bars):
        future = bars[index + horizon] if index + horizon < len(bars) else None
        path = [
            ForwardBar(high=b[2] + 0.05, low=b[2] - 0.05, close=b[2], close_time=b[1])
            for b in bars[index + 1 : index + 1 + horizon]
        ]
        records.append(
            dataclasses.replace(
                template,
                candle_id=f"c-{index}",
                timeframe="15m",
                open_time=open_time,
                close_time=close_time,
                open=close,
                high=close + 0.05,
                low=close - 0.05,
                close=close,
                indicators=indicators,
                future_close=None if future is None else future[2],
                future_close_time=None if future is None else future[1],
                forward_path=path,
            )
        )
    return records


def request_for(scheme: str | None = None, horizon: int = H) -> DatasetRequest:
    base = daily_request()
    return dataclasses.replace(
        base,
        timeframe="15m",
        data_window_start=DAY1_OPEN - timedelta(days=1),
        data_window_end=DAY2_OPEN + timedelta(days=2),
        data_cutoff_at=DAY2_OPEN + timedelta(days=3),
        horizon_bars=horizon,
        neutral_threshold_bps=5.0,
        **({"label_scheme": scheme} if scheme else {}),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def test_session_helpers():
    close_1530 = datetime(2026, 3, 2, 10, 0, tzinfo=UTC)       # 15:30 IST
    next_open = datetime(2026, 3, 3, 3, 45, tzinfo=UTC)        # 09:15 IST next day
    assert crosses_session(close_1530, next_open)
    assert not crosses_session(DAY1_OPEN, close_1530)
    # 21:00 UTC on day 1 is already 02:30 IST on day 2: the IST date, not the UTC date, decides.
    assert ist_session_date(datetime(2026, 3, 2, 21, 0, tzinfo=UTC)) == date(2026, 3, 3)
    assert ist_session_date("2026-03-02T10:00:00+00:00") == date(2026, 3, 2)
    assert ist_session_date(datetime(2026, 3, 2, 10, 0)) == date(2026, 3, 2)  # naive = UTC

    assert is_intraday_label_timeframe("15m") and is_intraday_label_timeframe("1h")
    assert not is_intraday_label_timeframe("1d") and not is_intraday_label_timeframe("1wk")


def test_forward_index_in_session_gives_the_last_bars_of_a_session_no_target():
    dates = [date(2026, 3, 2)] * 5 + [date(2026, 3, 3)] * 5
    assert forward_index_in_session(dates, 0, 3) == 3
    assert forward_index_in_session(dates, 1, 3) == 4
    assert forward_index_in_session(dates, 2, 3) is None      # would land on day 2
    assert forward_index_in_session(dates, 4, 1) is None      # the last bar of day 1
    assert forward_index_in_session(dates, 7, 2) == 9
    assert forward_index_in_session(dates, 8, 2) is None      # runs off the end of the series
    with pytest.raises(ValueError):
        forward_index_in_session(dates, 0, 0)


def test_same_session_prefix_stops_at_the_session_close():
    path = [
        ForwardBar(1.0, 0.0, 0.5, datetime(2026, 3, 2, 9, 45, tzinfo=UTC)),
        ForwardBar(1.0, 0.0, 0.5, datetime(2026, 3, 2, 10, 0, tzinfo=UTC)),
        ForwardBar(9.0, 0.0, 0.5, datetime(2026, 3, 3, 3, 45, tzinfo=UTC)),
    ]
    kept = same_session_prefix(datetime(2026, 3, 2, 9, 30, tzinfo=UTC), path)
    assert [bar.close_time.day for bar in kept] == [2, 2]


# ---------------------------------------------------------------------------
# Builders: fixed-horizon, triple-barrier, volatility-expansion
# ---------------------------------------------------------------------------

def test_fixed_horizon_last_bars_of_a_session_get_no_label_and_none_use_next_day_prices():
    records = naive_loader_records(H, day2_shift=50.0)      # day 2 is +50% higher: a huge overnight jump
    examples = build_labeled_examples(records, request_for())

    # (26 - H) labelled bars per session; the last H bars of day 1 and day 2 have no label.
    assert len(examples) == 2 * (BARS_PER_SESSION - H)
    labelled_ids = {example.candle_id for example in examples}
    for last in range(BARS_PER_SESSION - H, BARS_PER_SESSION):
        assert f"c-{last}" not in labelled_ids
    # No label became known on a later session than its source bar, and none carries the +50% jump.
    for example in examples:
        assert ist_session_date(example.observed_at) == ist_session_date(example.label_available_at)
        assert abs(example.forward_return) < 0.01


def test_fixed_horizon_old_behaviour_would_have_labelled_the_overnight_jump():
    # Sanity check that the fixture really contains the leak the guard removes.
    records = naive_loader_records(H, day2_shift=50.0)
    leaked = [r for r in records if r.future_close_time and crosses_session(r.close_time, r.future_close_time)]
    assert len(leaked) == H and all(r.future_close / r.close > 1.4 for r in leaked)


def test_triple_barrier_path_stops_at_the_session_close():
    horizon = 3
    records = naive_loader_records(horizon, day2_shift=50.0, atr=1.0)
    examples = build_triple_barrier_examples(records, request_for(LABEL_SCHEME_TRIPLE_BARRIER, horizon))

    labelled_ids = {example.candle_id for example in examples}
    # Day 1's last `horizon` bars: in-session path is short and nothing was touched inside the
    # session -> censored, not decided by the +50 jump the next morning.
    for last in range(BARS_PER_SESSION - horizon, BARS_PER_SESSION):
        assert f"c-{last}" not in labelled_ids
    assert len(examples) == 2 * (BARS_PER_SESSION - horizon)
    for example in examples:
        assert example.label == "NEUTRAL"                   # the in-session path never reaches +/-1 ATR
        assert ist_session_date(example.observed_at) == ist_session_date(example.label_available_at)


def test_volatility_expansion_window_never_includes_next_day_bars():
    records = naive_loader_records(H, day2_shift=50.0)
    examples = build_volatility_expansion_examples(
        records, request_for(LABEL_SCHEME_VOLATILITY_EXPANSION)
    )

    # Trailing window needs H bars (index >= H-1) and the forward window needs H more in-session
    # bars (index <= 25-H): 27 - 2H examples per session.
    assert len(examples) == 2 * (BARS_PER_SESSION - 2 * H + 1)
    labelled_ids = {example.candle_id for example in examples}
    for last in range(BARS_PER_SESSION - H, BARS_PER_SESSION):
        assert f"c-{last}" not in labelled_ids
        assert f"c-{BARS_PER_SESSION + last}" not in labelled_ids
    for example in examples:
        assert ist_session_date(example.observed_at) == ist_session_date(example.label_available_at)
        # A forward envelope that touched the +50 jump would give a ratio in the thousands.
        assert example.forward_return < 50.0


def test_daily_bars_are_left_alone_by_the_session_guard():
    # One bar per session: the label necessarily reaches the next session, and must still be built.
    records = [evidence(i) for i in range(6)]
    examples = build_labeled_examples(records, daily_request())
    assert len(examples) == 6
    assert all(crosses_session(e.observed_at, e.label_available_at) for e in examples)


# ---------------------------------------------------------------------------
# Research script: STRUCTURE-01 calibration forward return
# ---------------------------------------------------------------------------

def test_structure_calibration_drops_proximity_events_whose_forward_bar_is_next_day(monkeypatch):
    sessions = [datetime(2026, 3, 2, 3, 45, tzinfo=UTC) + timedelta(days=d) for d in range(3)]
    prices = {0: 100.0, 1: 110.0, 2: 150.0}   # day 1 is flat at 110, day 2 jumps to 150 overnight
    bars_5m = []
    for d, day_open in enumerate(sessions):
        for i in range(75):
            open_time = day_open + timedelta(minutes=5 * i)
            price = prices[d]
            high, low = price + 0.2, price - 0.2
            if d == 1 and i == 10:
                high, low, price = 105.0, 104.0, 104.5     # touches PDH (105) mid-session
            if d == 1 and i == 74:
                high, low, price = 95.1, 94.9, 95.0        # touches PDL (95) on the LAST bar
            bars_5m.append({
                "open_time": open_time, "close_time": open_time + timedelta(minutes=5),
                "open": price, "high": high, "low": low, "close": price, "volume": 1000.0,
            })
    daily = [
        {"open_time": sessions[0].replace(hour=0, minute=0), "high": 105.0, "low": 95.0},
        {"open_time": sessions[1].replace(hour=0, minute=0), "high": 130.0, "low": 90.0},
        {"open_time": sessions[2].replace(hour=0, minute=0), "high": 160.0, "low": 140.0},
    ]

    def fake_fetch(symbol, timeframe="5m", start_dt=None, end_dt=None):
        return bars_5m if timeframe == "5m" else daily

    monkeypatch.setattr(structure, "fetch_candles", fake_fetch)
    summary = structure.run_calibration_experiment(
        start_date=date(2026, 3, 2), end_date=date(2026, 3, 4), forward_window_bars=3
    )

    # The PDL touch on day 2's last bar has its forward bar on day 3 (150): without the guard it
    # would be recorded as a +5800 bps "SWEEP/REJECTION" event. It is dropped; only the mid-session
    # PDH touch (global bar 85) remains.
    assert summary.total_proximity_events == 1
    assert "PDL" not in summary.by_level_type
