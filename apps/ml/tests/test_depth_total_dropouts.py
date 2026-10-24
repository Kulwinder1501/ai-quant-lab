"""A one-sided zero whole-book total is a feed dropout, not a measurement.

`total_buy_qty` / `total_sell_qty` drop to 0 on ONE side for a single frame (567 of 42,943
BANKNIFTY26OCTFUT frames on 2026-10-22, 1.3%, never both). A 50-level book cannot be empty on one
side in session, so read as data that is an imbalance of exactly -1 / +1.
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

import evaluate_microstructure_incremental as micro
from ai_quant_lab_ml.confluence_gate import fetch_latest_depth_di

AS_OF = datetime(2026, 10, 22, 5, 30, tzinfo=timezone.utc)


class _Cursor:
    def __init__(self, row):
        self._row = row

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        pass

    def fetchone(self):
        return self._row


class _Conn:
    def __init__(self, row):
        self._row = row

    def cursor(self):
        return _Cursor(self._row)


@pytest.mark.parametrize(
    "row",
    [
        (0, 47400),
        (47400, 0),
        (None, 47400),
        (47400, None),
        (-5, 47400),
        (float("nan"), 47400),
        (0, 0),
        None,
    ],
)
def test_fetch_latest_depth_di_is_unavailable_for_a_dropout_or_missing_total(row):
    assert fetch_latest_depth_di(_Conn(row), AS_OF) == (None, None)


def test_fetch_latest_depth_di_still_reads_a_real_book():
    raw_di, di_tilde = fetch_latest_depth_di(_Conn((30, 10)), AS_OF)
    assert raw_di == pytest.approx(0.5)
    assert di_tilde == pytest.approx(-0.5)
    # A genuinely balanced book is a real 0, distinct from unavailable.
    assert fetch_latest_depth_di(_Conn((500, 500)), AS_OF)[0] == 0.0


def _depth_frame_rows(totals: list[tuple[float | None, float | None]]) -> pd.DataFrame:
    n = len(totals)
    return pd.DataFrame(
        {
            "distance_bps": [5.0] * n,
            "contacted": [1, 0, 1, 0, 1, 0][:n],
            "pool_type": ["SESSION_HIGH"] * n,
            "side": ["UP"] * n,
            "timeframe": ["5m"] * n,
            "best_bid": [100.0] * n,
            "best_ask": [100.05] * n,
            "bid_qty_1": [500.0] * n,
            "ask_qty_1": [100.0] * n,
            "bid_qty_3": [[500.0, 400.0, 300.0]] * n,
            "ask_qty_3": [[100.0, 200.0, 300.0]] * n,
            "bid_qty_5": [[500.0] * 5] * n,
            "ask_qty_5": [[100.0] * 5] * n,
            "bid_qty_10": [[500.0] * 10] * n,
            "ask_qty_10": [[100.0] * 10] * n,
            "total_buy_qty": [t[0] for t in totals],
            "total_sell_qty": [t[1] for t in totals],
        }
    )


MIXED_TOTALS = [(650.0, 1350.0), (0.0, 47400.0), (47400.0, 0.0), (None, 47400.0), (500.0, 500.0)]


def test_usable_total_mask_requires_both_totals_finite_and_positive():
    df = _depth_frame_rows(MIXED_TOTALS)
    mask = micro.usable_total_mask(df["total_buy_qty"], df["total_sell_qty"])
    assert mask.tolist() == [True, False, False, False, True]


def test_features_are_nan_not_zero_or_one_for_a_dropout_frame():
    feats, _ = micro.engineer_microstructure_features(_depth_frame_rows(MIXED_TOTALS))
    qi = feats["total_book_qi"]
    assert qi.iloc[0] == pytest.approx(-0.35)
    assert qi.iloc[4] == 0.0  # a genuinely balanced book is a real 0
    assert qi.iloc[[1, 2, 3]].isna().all()  # not 0.0, not -1 / +1
    # A one-sided dropout also halves the apparent book size; that is masked too.
    assert feats["total_depth_log"].iloc[[1, 2, 3]].isna().all()
    assert feats["total_depth_log"].iloc[0] == pytest.approx(np.log1p(2000.0))


def test_dataset_loader_skips_dropout_samples_instead_of_zero_filling(monkeypatch, capsys):
    class _Connect:
        def __enter__(self):
            return object()

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(micro.psycopg, "connect", lambda *_a, **_k: _Connect())
    monkeypatch.setattr(micro.pd, "read_sql_query", lambda *_a, **_k: _depth_frame_rows(MIXED_TOTALS))

    df = micro.load_microstructure_dataset(300)

    assert len(df) == 2
    assert df["total_buy_qty"].tolist() == [650.0, 500.0]
    assert df.index.tolist() == [0, 1]  # contiguous: the caller masks by position over len(df)
    assert "Excluded 3 of 5 samples" in capsys.readouterr().out
