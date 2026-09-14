from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_quant_lab_ml.data_readiness import (
    MAXIMUM_REPORT_AGE,
    DataReadinessError,
    require_series_ready,
)

NOW = datetime(2026, 8, 3, 18, 0, tzinfo=UTC)


def report_row(
    *,
    series: list[dict[str, Any]] | None = None,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    return {
        "id": "report-1",
        "reportHash": "a" * 64,
        "createdAt": created_at or (NOW - timedelta(hours=1)),
        "report": {
            "version": "data-readiness-v1",
            "series": series
            if series is not None
            else [
                {"symbol": "NIFTY50", "timeframe": "1d", "state": "READY", "reasons": []},
                {"symbol": "SBIN", "timeframe": "1d", "state": "READY", "reasons": []},
            ],
        },
    }


class RequireSeriesReadyTests(unittest.TestCase):
    def test_returns_provenance_when_every_series_is_ready(self) -> None:
        provenance = require_series_ready(report_row(), ["NIFTY50", "SBIN"], "1d", NOW)

        self.assertEqual(provenance["reportId"], "report-1")
        self.assertEqual(provenance["reportHash"], "a" * 64)
        self.assertEqual(provenance["timeframe"], "1d")
        self.assertEqual(provenance["states"], {"NIFTY50": "READY", "SBIN": "READY"})

    def test_refuses_when_no_report_exists(self) -> None:
        with self.assertRaisesRegex(DataReadinessError, "No data-readiness report exists"):
            require_series_ready(None, ["NIFTY50"], "1d", NOW)

    def test_refuses_a_report_older_than_the_tolerance(self) -> None:
        stale = report_row(created_at=NOW - MAXIMUM_REPORT_AGE - timedelta(hours=1))
        with self.assertRaisesRegex(DataReadinessError, "day\\(s\\) old"):
            require_series_ready(stale, ["NIFTY50"], "1d", NOW)

    def test_refuses_a_series_the_audit_never_measured(self) -> None:
        with self.assertRaisesRegex(DataReadinessError, "BANKNIFTY 1d: not measured"):
            require_series_ready(report_row(), ["BANKNIFTY"], "1d", NOW)

    def test_refuses_a_degraded_series_and_carries_its_reasons(self) -> None:
        row = report_row(
            series=[
                {
                    "symbol": "NIFTY50",
                    "timeframe": "15m",
                    "state": "DEGRADED",
                    "reasons": ["ta-v1 ATR covers 0.0% of post-warm-up bars, below the 95% floor."],
                },
            ]
        )
        with self.assertRaisesRegex(DataReadinessError, "DEGRADED \\(ta-v1 ATR covers"):
            require_series_ready(row, ["NIFTY50"], "15m", NOW)

    def test_reports_every_failing_pool_member_at_once(self) -> None:
        row = report_row(
            series=[
                {"symbol": "SBIN", "timeframe": "1d", "state": "STALE", "reasons": ["old"]},
                {"symbol": "INFY", "timeframe": "1d", "state": "READY", "reasons": []},
            ]
        )
        with self.assertRaises(DataReadinessError) as context:
            require_series_ready(row, ["SBIN", "INFY", "TCS"], "1d", NOW)

        message = str(context.exception)
        self.assertIn("SBIN 1d: STALE", message)
        self.assertIn("TCS 1d: not measured", message)
        self.assertNotIn("INFY 1d:", message)

    def test_matches_the_requested_timeframe_not_just_the_symbol(self) -> None:
        # A READY 1d series must not clear a 15m run on the same instrument.
        with self.assertRaisesRegex(DataReadinessError, "NIFTY50 15m: not measured"):
            require_series_ready(report_row(), ["NIFTY50"], "15m", NOW)

    def test_is_case_insensitive_on_symbols(self) -> None:
        provenance = require_series_ready(report_row(), ["nifty50"], "1d", NOW)
        self.assertEqual(provenance["states"], {"NIFTY50": "READY"})
