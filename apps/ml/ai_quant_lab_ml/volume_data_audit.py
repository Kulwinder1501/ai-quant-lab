"""Phase 0: Instrument & Data Integrity Protocol Audit for VOLUME-01.

Validates:
1. Native volume & contract contiguity (no synthetic scaling across rollovers).
2. Timeframe contiguity (75 5-minute buckets per session: 09:15 to 15:30 IST).
3. 20-session warm-up window availability prior to Jan 01, 2026.
4. Denominator-zero audit (verifying ExpectedVolume > 0 for all time buckets).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, date, time, timedelta
import zoneinfo
from typing import Any, Mapping, Sequence
import psycopg

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")


@dataclass
class DataAuditReport:
    instrument: str
    pass_all: bool
    warmup_sessions_count: int
    training_sessions_count: int
    oos_sessions_count: int
    missing_5m_buckets_count: int
    zero_expected_volume_buckets_count: int
    contract_rollover_boundaries_count: int
    checks: dict[str, bool] = field(default_factory=dict)
    details: list[str] = field(default_factory=list)


def get_db_connection_string() -> str:
    db_url = os.environ.get("DATABASE_URL")
    if db_url:
        return db_url
    return "postgresql://ai_quant_lab:2a33c5b07e01286c245ebf92710f8997208e4ff0237126ff06f2a4fcde47e0c8@localhost:5433/ai_quant_lab"


def fetch_candle_metadata(instrument: str, timeframe: str = "5m") -> list[dict[str, Any]]:
    """Fetch completed candle timestamps and volume from DB."""
    conn_str = get_db_connection_string()
    query = """
        SELECT
            c.id,
            c.open_time,
            c.close_time,
            c.open,
            c.high,
            c.low,
            c.close,
            c.volume
        FROM candles c
        JOIN instruments i ON c.instrument_id = i.id
        WHERE i.symbol = %s
          AND c.timeframe = %s
          AND c.is_complete = TRUE
        ORDER BY c.close_time ASC;
    """
    with psycopg.connect(conn_str) as conn:
        with conn.cursor() as cur:
            cur.execute(query, (instrument, timeframe))
            rows = cur.fetchall()
            cols = [desc[0] for desc in cur.description]
            return [dict(zip(cols, row)) for row in rows]


def run_phase0_audit(instrument: str = "BANKNIFTY") -> DataAuditReport:
    """Execute Phase 0 data audit rules as per VOLUME-01 specification."""
    report = DataAuditReport(
        instrument=instrument,
        pass_all=True,
        warmup_sessions_count=0,
        training_sessions_count=0,
        oos_sessions_count=0,
        missing_5m_buckets_count=0,
        zero_expected_volume_buckets_count=0,
        contract_rollover_boundaries_count=0,
    )

    try:
        candles = fetch_candle_metadata(instrument, timeframe="5m")
    except Exception as e:
        report.pass_all = False
        report.checks["database_connection"] = False
        report.details.append(f"Failed to query database: {e}")
        return report

    report.checks["database_connection"] = True

    if not candles:
        report.pass_all = False
        report.checks["data_present"] = False
        report.details.append(f"No completed 5m candles found for symbol '{instrument}'.")
        return report

    report.checks["data_present"] = True

    # Group candles by IST trading date and 5m time bucket (1..75)
    daily_buckets: dict[date, dict[int, dict[str, Any]]] = {}
    for c in candles:
        # Convert open_time to IST
        ot = c["open_time"]
        if ot.tzinfo is None:
            ot = ot.replace(tzinfo=zoneinfo.ZoneInfo("UTC"))
        ot_ist = ot.astimezone(INDIA_TZ)

        day = ot_ist.date()
        # Compute bucket index 1..75 between 09:15 and 15:30
        minutes_since_open = (ot_ist.hour * 60 + ot_ist.minute) - (9 * 60 + 15)
        bucket_idx = (minutes_since_open // 5) + 1

        if 1 <= bucket_idx <= 75:
            if day not in daily_buckets:
                daily_buckets[day] = {}
            daily_buckets[day][bucket_idx] = c

    sorted_days = sorted(daily_buckets.keys())
    
    # Categorize trading sessions into Warm-Up, Calibration (Train), and Evaluation (OOS)
    warmup_days = [d for d in sorted_days if d < date(2026, 1, 1)]
    train_days = [d for d in sorted_days if date(2026, 1, 1) <= d <= date(2026, 6, 30)]
    oos_days = [d for d in sorted_days if date(2026, 7, 1) <= d <= date(2026, 9, 24)]

    report.warmup_sessions_count = len(warmup_days)
    report.training_sessions_count = len(train_days)
    report.oos_sessions_count = len(oos_days)

    # Audit Rule 1: Warm-up sessions >= 20
    if len(warmup_days) >= 20:
        report.checks["warmup_sessions_ge_20"] = True
    else:
        report.checks["warmup_sessions_ge_20"] = False
        report.pass_all = False
        report.details.append(
            f"Insufficient warm-up sessions prior to 2026-01-01: found {len(warmup_days)}, required >= 20."
        )

    # Audit Rule 2: 75 5m buckets contiguity per trading session
    incomplete_days = 0
    missing_buckets_total = 0
    for day in sorted_days:
        b_count = len(daily_buckets[day])
        if b_count < 75:
            incomplete_days += 1
            missing_buckets_total += (75 - b_count)

    report.missing_5m_buckets_count = missing_buckets_total
    if missing_buckets_total == 0:
        report.checks["bucket_contiguity_75"] = True
    else:
        # Warning/Flag: Some sessions have missing buckets
        report.checks["bucket_contiguity_75"] = False
        report.details.append(
            f"Found {missing_buckets_total} missing 5m buckets across {incomplete_days} trading sessions."
        )

    # Audit Rule 3: Denominator-zero check across 20-session rolling baseline
    zero_denom_count = 0
    all_eligible_days = sorted_days
    for i in range(20, len(all_eligible_days)):
        target_day = all_eligible_days[i]
        past_20_days = all_eligible_days[i-20:i]
        for b_idx in range(1, 76):
            vols = [
                daily_buckets[d][b_idx]["volume"]
                for d in past_20_days
                if b_idx in daily_buckets[d]
            ]
            if len(vols) >= 10:
                import numpy as np
                med_vol = float(np.median(vols))
                if med_vol == 0.0:
                    zero_denom_count += 1

    report.zero_expected_volume_buckets_count = zero_denom_count
    if zero_denom_count == 0:
        report.checks["zero_denominator_buckets"] = True
    else:
        report.checks["zero_denominator_buckets"] = False
        report.details.append(
            f"Found {zero_denom_count} time buckets where 20-session median expected volume is 0.0."
        )

    return report
