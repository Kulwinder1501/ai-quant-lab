"""Unit tests for Equity Stance R0 Step A1 Data Fetcher."""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

import pytest

from apps.ml.equity_stance_r0.fetch import (
    CUTOFF_DATE_STR,
    GranularityError,
    compute_sha256,
    load_universe_symbols,
    parse_and_validate_chart_response,
    timestamp_to_date_str,
)


def test_compute_sha256():
    sample_data = b"Hello, AI Quant Lab R0 Study!"
    expected = hashlib.sha256(sample_data).hexdigest()
    assert compute_sha256(sample_data) == expected


def test_timestamp_to_date_str():
    # 1792122300 corresponds to 2026-10-16 03:45:00 UTC
    date_str = timestamp_to_date_str(1792122300)
    assert date_str == "2026-10-16"


def test_load_universe_symbols():
    with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as f:
        f.write("# Source URL: https://archives.nseindia.com/content/indices/ind_nifty500list.csv\n")
        f.write("# Download Date: 2026-10-18\n")
        f.write("Company Name,Industry,Symbol,Series,ISIN Code\n")
        f.write("Reliance Industries Ltd.,Oil & Gas,RELIANCE,EQ,INE002A01018\n")
        f.write("Tata Consultancy Services Ltd.,IT,TCS,EQ,INE467B01029\n")
        f.write("Duplicate Entry Ltd.,IT,TCS,EQ,INE467B01029\n")
        tmp_path = Path(f.name)

    try:
        symbols = load_universe_symbols(tmp_path)
        assert symbols == ["RELIANCE", "TCS"]
    finally:
        tmp_path.unlink()


def test_parse_and_validate_chart_response_enforces_daily_granularity():
    hourly_payload = {
        "chart": {
            "result": [
                {
                    "meta": {"dataGranularity": "1h"},
                    "timestamp": [1792122300],
                    "indicators": {
                        "quote": [{"open": [100.0], "high": [105.0], "low": [98.0], "close": [102.0], "volume": [1000]}]
                    },
                }
            ]
        }
    }
    with pytest.raises(GranularityError, match="Expected dataGranularity '1d'"):
        parse_and_validate_chart_response(hourly_payload, "TEST_SYM")


def test_parse_and_validate_chart_response_truncates_after_cutoff():
    # Timestamps:
    # 1792122300 -> 2026-10-16
    # 1792208700 -> 2026-10-17
    # 1792295100 -> 2026-10-18 (exceeds cutoff 2026-10-17)
    payload = {
        "chart": {
            "result": [
                {
                    "meta": {"dataGranularity": "1d"},
                    "timestamp": [1792122300, 1792208700, 1792295100],
                    "indicators": {
                        "quote": [
                            {
                                "open": [100.0, 102.0, 104.0],
                                "high": [103.0, 105.0, 106.0],
                                "low": [99.0, 101.0, 103.0],
                                "close": [102.0, 104.0, 105.0],
                                "volume": [1000, 1200, 1100],
                            }
                        ]
                    },
                }
            ]
        }
    }

    parsed = parse_and_validate_chart_response(payload, "TEST_SYM", cutoff_date=CUTOFF_DATE_STR)
    assert parsed["total_bars"] == 2
    assert parsed["first_date"] == "2026-10-16"
    assert parsed["last_date"] == "2026-10-17"
    for b in parsed["bars"]:
        assert b["date"] <= CUTOFF_DATE_STR


def test_parse_and_validate_chart_response_detects_artifacts():
    # Bar 1 close: 100
    # Bar 2 close: 55 (drop of 45%, which exceeds 40% artifact threshold)
    payload = {
        "chart": {
            "result": [
                {
                    "meta": {"dataGranularity": "1d"},
                    "timestamp": [1792122300, 1792208700],
                    "indicators": {
                        "quote": [
                            {
                                "open": [100.0, 58.0],
                                "high": [102.0, 60.0],
                                "low": [98.0, 50.0],
                                "close": [100.0, 55.0],
                                "volume": [1000, 5000],
                            }
                        ]
                    },
                }
            ]
        }
    }

    parsed = parse_and_validate_chart_response(payload, "TMPV_TEST", cutoff_date=CUTOFF_DATE_STR)
    assert parsed["total_bars"] == 2
    assert parsed["artifact_count"] == 1
