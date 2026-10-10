"""
2026-10-10 follow-up (code gaps), GAP 1: run_hybrid_confluence_backtest.py and run_ofi_impulse_oos.py
used to trust the STORED depth-frame flags (`is_regression = FALSE`, or hard-coded
is_snapshot/is_duplicate/gap_before). Pre-fix rows carry is_regression = TRUE on EVERY frame after a
sequence reset without a snapshot, so a stored-flag filter silently drops the rest of the session.
Both scripts now recompute the flags from raw sequence numbers with
cks_ofi_touch.recompute_sequence_flags. Pure unit tests on synthetic frames -- no database.
"""

from datetime import datetime, timedelta, timezone

from ai_quant_lab_ml.cks_ofi_touch import (
    compute_windowed_ofi_series,
    drop_reset_and_duplicate_rows,
    recompute_sequence_flags_by_stream,
)
import run_hybrid_confluence_backtest as hybrid
import run_ofi_impulse_oos as impulse

T0 = datetime(2026, 9, 11, 4, 0, 0, tzinfo=timezone.utc)
SYM = "NSE:BANKNIFTY26SEPFUT"


# A stream whose sequence resets to 1 WITHOUT a snapshot: 1,2,3 | 1,2,3,4,5 (reset at index 3).
RESET_STREAM_SEQS = [1, 2, 3, 1, 2, 3, 4, 5]
# What the pre-fix capture stored for it: every frame from the reset onward flagged as regression.
STORED_IS_REGRESSION = [False, False, False, True, True, True, True, True]


def _hybrid_row(i, seq, snap=False, symbol=SYM, session="s1", buy=100.0, sell=50.0):
    return (T0 + timedelta(seconds=i), buy, sell, symbol, session, seq, snap)


def test_stored_flag_filter_would_drop_every_frame_after_the_reset_but_recomputed_flags_keep_them():
    rows = [_hybrid_row(i, seq) for i, seq in enumerate(RESET_STREAM_SEQS)]

    stored_filter_kept = [r for r, reg in zip(rows, STORED_IS_REGRESSION) if not reg]
    assert len(stored_filter_kept) == 3  # the old SQL `AND is_regression = FALSE`

    kept = hybrid.clean_depth_frames_from_rows(rows)
    # Only the single reset frame (index 3) is dropped; the five clean frames after it survive.
    assert [k[0] for k in kept] == [rows[i][0] for i in (0, 1, 2, 4, 5, 6, 7)]


def test_hybrid_drops_duplicates_but_not_a_snapshot_rebase():
    rows = [
        _hybrid_row(0, 10),
        _hybrid_row(1, 10),            # duplicate
        _hybrid_row(2, 11),
        _hybrid_row(3, 3, snap=True),  # snapshot re-bases the marker: kept, not a reset
        _hybrid_row(4, 4),
    ]
    kept = hybrid.clean_depth_frames_from_rows(rows)
    assert [k[0] for k in kept] == [rows[i][0] for i in (0, 2, 3, 4)]


def test_hybrid_recomputes_per_symbol_and_capture_session_not_across_streams():
    # Two interleaved streams with unrelated sequence numbers: B's lower numbers are NOT a reset of A.
    rows = [
        _hybrid_row(0, 1000, symbol="A"),
        _hybrid_row(1, 5, symbol="B"),
        _hybrid_row(2, 1001, symbol="A"),
        _hybrid_row(3, 6, symbol="B"),
        _hybrid_row(4, 1002, symbol="A"),
        _hybrid_row(5, 1, symbol="A", session="s2"),  # a new capture session restarts the chain
    ]
    assert len(hybrid.clean_depth_frames_from_rows(rows)) == 6


def test_hybrid_missing_totals_stay_missing_not_zero():
    rows = [_hybrid_row(0, 1), (T0 + timedelta(seconds=1), None, 5.0, SYM, "s1", 2, False), _hybrid_row(2, 3)]
    kept = hybrid.clean_depth_frames_from_rows(rows)
    assert len(kept) == 2 and all(isinstance(k[1], float) for k in kept)


class _FakeCursor:
    def __init__(self, rows, sink):
        self._rows, self._sink = rows, sink

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._sink.append(sql)

    def fetchall(self):
        return self._rows


class _FakeConn:
    def __init__(self, rows):
        self.rows, self.sql = rows, []

    def cursor(self):
        return _FakeCursor(self.rows, self.sql)


def test_hybrid_query_no_longer_filters_on_stored_flags_and_loads_sequence_fields():
    rows = [_hybrid_row(i, seq) for i, seq in enumerate(RESET_STREAM_SEQS)]
    conn = _FakeConn(rows)
    out = hybrid.fetch_depth_frames_for_day(conn, datetime(2026, 9, 11).date())
    sql = conn.sql[0]
    assert "is_regression" not in sql and "is_duplicate" not in sql
    assert "sequence_no" in sql and "is_snapshot" in sql and "ORDER BY received_at" in sql
    assert len(out) == 7


def test_stream_helper_aligns_flags_and_marks_each_stream_start():
    flags = recompute_sequence_flags_by_stream(
        [("a", 1, False), ("b", 9, False), ("a", 2, False), ("a", 1, False), ("b", 9, False)]
    )
    assert [f[3] for f in flags] == [True, True, False, False, False]      # stream starts
    assert flags[3][2] is True                                             # a: 2 -> 1 is a reset
    assert flags[4][1] is True                                             # b: 9 -> 9 is a duplicate
    assert drop_reset_and_duplicate_rows(list("abcde"), flags) == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# run_ofi_impulse_oos
# ---------------------------------------------------------------------------

def _impulse_row(i, seq, bid, bid_q, ask, ask_q, snap=False, session="s1"):
    """get_frames_basic layout: received_at, total_buy, total_sell, exch_time, vendor_time,
    bid_price, bid_qty, ask_price, ask_qty, provider_symbol, capture_session_id, sequence_no, is_snapshot."""
    return (
        T0 + timedelta(milliseconds=100 * i), 1.0, 1.0, None, None,
        [bid], [bid_q], [ask], [ask_q], SYM, session, seq, snap,
    )


def test_impulse_recomputes_flags_so_a_reset_breaks_the_chain_and_later_frames_survive():
    rows = [
        _impulse_row(0, 1, 100.0, 50, 101.0, 40),
        _impulse_row(1, 2, 100.0, 60, 101.0, 40),                 # +10
        _impulse_row(2, 3, 100.0, 70, 101.0, 40),                 # +10
        _impulse_row(3, 1, 200.0, 900, 201.0, 900),               # reset WITHOUT snapshot, wild book
        _impulse_row(4, 2, 200.0, 905, 201.0, 900),               # +5 against the new baseline
        _impulse_row(5, 3, 200.0, 910, 201.0, 900),               # +5
    ]
    dframes, quote_rows = impulse.build_ofi_frames_and_quote_rows(rows)

    assert [f.is_regression for f in dframes] == [False, False, False, True, False, False]
    assert dframes[0].is_snapshot is True                          # first frame of the capture session
    assert all(not f.is_duplicate for f in dframes)
    # gap_before is 0 (contiguous), NOT None, on the frames after the reset -- the stored value was NULL.
    assert dframes[4].gap_before == 0 and dframes[5].gap_before == 0
    # Quotes: the reset frame is dropped, the five other frames (including those after it) are kept.
    assert [r[11] for r in quote_rows] == [1, 2, 3, 2, 3]

    obs = compute_windowed_ofi_series(dframes)
    # Nothing is differenced across the reset: 2 observations before it, 2 after.
    assert [o.window_sum for o in obs] == [10.0, 20.0, 5.0, 10.0]


def test_impulse_a_new_capture_session_is_a_chain_baseline():
    rows = [
        _impulse_row(0, 1, 100.0, 50, 101.0, 40, session="s1"),
        _impulse_row(1, 2, 100.0, 60, 101.0, 40, session="s1"),
        _impulse_row(2, 1, 150.0, 10, 151.0, 10, session="s2"),
        _impulse_row(3, 2, 150.0, 15, 151.0, 10, session="s2"),
    ]
    dframes, _ = impulse.build_ofi_frames_and_quote_rows(rows)
    assert [f.is_snapshot for f in dframes] == [True, False, True, False]
    assert not any(f.is_regression for f in dframes)               # different sessions: not a reset
    assert [o.window_sum for o in compute_windowed_ofi_series(dframes)] == [10.0, 5.0]


def test_impulse_duplicates_are_flagged_and_dropped_from_quotes():
    rows = [
        _impulse_row(0, 5, 100.0, 50, 101.0, 40),
        _impulse_row(1, 5, 100.0, 50, 101.0, 40),   # duplicate
        _impulse_row(2, 6, 100.0, 55, 101.0, 40),
    ]
    dframes, quote_rows = impulse.build_ofi_frames_and_quote_rows(rows)
    assert [f.is_duplicate for f in dframes] == [False, True, False]
    assert len(quote_rows) == 2
