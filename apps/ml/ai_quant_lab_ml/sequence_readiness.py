"""Fail-closed sequence-readiness gate for TCN research (Phase 25, Stage 5).

The TypeScript audit (``npm run data:audit:sequence``) evaluates Workstream D
gates and persists a hashed report. A TCN training run may open only for a
candidate whose latest report verdict is ``PASS`` — bar counts alone are not
authorization.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Mapping


MAXIMUM_REPORT_AGE = timedelta(days=7)
PASS_VERDICT = "PASS"
SEQUENCE_WINDOW_GATES: dict[str, dict[str, Any]] = {
    "tcn-1m": {
        "minimumBars": 200_000,
        "minimumSessions": 250,
        "maximumZeroVolumeFraction": 0.01,
        "requiredProvider": "fyers-api-v3",
    },
    "tcn-5m": {
        "minimumBars": 100_000,
        "minimumSessions": 250,
        "maximumZeroVolumeFraction": 0.01,
        "requiredProvider": "fyers-api-v3",
    },
    "tcn-15m": {
        "minimumBars": 50_000,
        "minimumSessions": 250,
        "maximumZeroVolumeFraction": 0.01,
        "requiredProvider": "fyers-api-v3",
    },
}


class SequenceReadinessError(RuntimeError):
    """TCN research refused because the sequence-readiness gate did not clear."""


def assess_training_window(
    measurements: Mapping[str, Any],
    *,
    candidate: str,
) -> dict[str, Any]:
    """Assess the exact source window a sequence run will actually consume."""

    thresholds = SEQUENCE_WINDOW_GATES.get(candidate)
    if thresholds is None:
        raise SequenceReadinessError(f"No exact-window gate is defined for {candidate!r}.")

    findings: list[dict[str, str]] = []
    bar_count = int(measurements.get("barCount") or 0)
    session_count = int(measurements.get("sessionCount") or 0)
    zero_volume_fraction = float(measurements.get("zeroVolumeFraction") or 0.0)
    providers = sorted(str(item) for item in (measurements.get("providers") or []))
    instrument_semantics = str(measurements.get("instrumentSemantics") or "OTHER")

    if bar_count < thresholds["minimumBars"]:
        findings.append({
            "code": "INSUFFICIENT_WINDOW_BARS",
            "detail": f"{bar_count} bars is below the {thresholds['minimumBars']} exact-window floor.",
        })
    if session_count < thresholds["minimumSessions"]:
        findings.append({
            "code": "INSUFFICIENT_WINDOW_SESSIONS",
            "detail": (
                f"{session_count} sessions is below the "
                f"{thresholds['minimumSessions']} exact-window floor."
            ),
        })
    if zero_volume_fraction > thresholds["maximumZeroVolumeFraction"]:
        findings.append({
            "code": "WINDOW_ZERO_VOLUME",
            "detail": (
                f"Zero-volume fraction {zero_volume_fraction:.6f} exceeds "
                f"{thresholds['maximumZeroVolumeFraction']:.6f}."
            ),
        })
    if providers != [thresholds["requiredProvider"]]:
        findings.append({
            "code": "WINDOW_PROVIDER_MISMATCH",
            "detail": (
                f"Exact window providers are {providers or ['<none>']}; "
                f"required sole provider is {thresholds['requiredProvider']}."
            ),
        })
    if instrument_semantics == "SPOT_INDEX":
        findings.append({
            "code": "SPOT_INDEX_SEMANTICS",
            "detail": "Volume-dependent sequence research requires an ETF proxy or futures lineage.",
        })

    return {
        "verdict": "PASS" if not findings else "FAIL",
        "findings": findings,
        "thresholds": dict(thresholds),
        "measurements": dict(measurements),
    }


def measure_training_window(
    connection,
    *,
    symbol: str,
    timeframe: str,
    candidate: str,
    window_start: datetime,
    window_end: datetime,
    data_cutoff_at: datetime,
) -> dict[str, Any]:
    """Measure and require the precise cutoff-bounded candle window."""

    with connection.cursor() as cursor:
        cursor.execute(
            """
            SELECT
              i.instrument_type,
              i.metadata ->> 'purpose' AS metadata_purpose,
              count(*)::bigint AS bar_count,
              count(DISTINCT (c.open_time AT TIME ZONE 'Asia/Kolkata')::date)::bigint AS session_count,
              count(*) FILTER (WHERE c.volume = 0)::bigint AS zero_volume_bars,
              array_agg(DISTINCT c.source ORDER BY c.source) AS providers,
              min(c.open_time) AS first_open_time,
              max(c.open_time) AS last_open_time
            FROM instruments i
            JOIN candles c ON c.instrument_id = i.id
            WHERE i.exchange = 'NSE'
              AND upper(i.symbol) = upper(%s)
              AND c.timeframe = %s
              AND c.is_complete = TRUE
              AND c.received_at <= %s
              AND c.close_time <= %s
              AND c.open_time >= %s
              AND c.close_time <= %s
            GROUP BY i.id, i.instrument_type, i.metadata ->> 'purpose'
            """,
            (
                symbol,
                timeframe,
                data_cutoff_at,
                data_cutoff_at,
                window_start,
                window_end,
            ),
        )
        row = cursor.fetchone()

    if row is None:
        measurements: dict[str, Any] = {
            "symbol": symbol.upper(),
            "timeframe": timeframe,
            "windowStart": window_start.isoformat(),
            "windowEnd": window_end.isoformat(),
            "dataCutoffAt": data_cutoff_at.isoformat(),
            "instrumentSemantics": "OTHER",
            "barCount": 0,
            "sessionCount": 0,
            "zeroVolumeFraction": 0.0,
            "providers": [],
            "firstOpenTime": None,
            "lastOpenTime": None,
        }
    else:
        instrument_type, purpose, bars, sessions, zero_bars, providers, first_at, last_at = row
        purpose_text = str(purpose or "").lower()
        semantics = (
            "ETF_PROXY"
            if instrument_type == "ETF" or "proxy" in purpose_text
            else "SPOT_INDEX" if instrument_type == "INDEX" else str(instrument_type or "OTHER")
        )
        bar_count = int(bars)
        measurements = {
            "symbol": symbol.upper(),
            "timeframe": timeframe,
            "windowStart": window_start.isoformat(),
            "windowEnd": window_end.isoformat(),
            "dataCutoffAt": data_cutoff_at.isoformat(),
            "instrumentSemantics": semantics,
            "barCount": bar_count,
            "sessionCount": int(sessions),
            "zeroVolumeFraction": 0.0 if bar_count == 0 else int(zero_bars) / bar_count,
            "providers": list(providers or []),
            "firstOpenTime": None if first_at is None else first_at.isoformat(),
            "lastOpenTime": None if last_at is None else last_at.isoformat(),
        }

    assessment = assess_training_window(measurements, candidate=candidate)
    if assessment["verdict"] != PASS_VERDICT:
        detail = "; ".join(
            f"{finding['code']}: {finding['detail']}" for finding in assessment["findings"]
        )
        raise SequenceReadinessError(
            f"Exact training window for {symbol.upper()} {timeframe} ({candidate}) failed: {detail}"
        )
    return assessment


def load_latest_sequence_report(connection) -> Mapping[str, Any] | None:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, report_hash, report, created_at"
            " FROM sequence_readiness_reports"
            " ORDER BY created_at DESC"
            " LIMIT 1"
        )
        row = cursor.fetchone()
    if row is None:
        return None
    return {
        "id": str(row[0]),
        "reportHash": str(row[1]),
        "report": row[2],
        "createdAt": row[3],
    }


def require_sequence_candidate_pass(
    report_row: Mapping[str, Any] | None,
    *,
    symbol: str,
    timeframe: str,
    candidate: str,
    as_of: datetime,
) -> dict[str, Any]:
    """Refuse unless the named candidate is PASS in a fresh sequence audit."""

    if report_row is None:
        raise SequenceReadinessError(
            "No sequence-readiness report exists. Run `npm run data:audit:sequence` "
            "before TCN research; Stage 4's gate is the authorization to open Stage 5."
        )

    created_at = report_row["createdAt"]
    if created_at.tzinfo is None:
        raise SequenceReadinessError("Sequence-readiness report created_at must be timezone-aware.")
    age = as_of - created_at
    if age > MAXIMUM_REPORT_AGE:
        raise SequenceReadinessError(
            f"Sequence-readiness report {report_row['id']} is {age.days} days old "
            f"(limit {MAXIMUM_REPORT_AGE.days}). Re-run `npm run data:audit` then "
            "`npm run data:audit:sequence`."
        )

    report = report_row["report"]
    if not isinstance(report, Mapping):
        raise SequenceReadinessError("Sequence-readiness report payload is malformed.")
    entries = report.get("candidates")
    if not isinstance(entries, list):
        raise SequenceReadinessError("Sequence-readiness report is missing candidates.")

    target_symbol = symbol.upper()
    match: Mapping[str, Any] | None = None
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        measurements = entry.get("measurements")
        if not isinstance(measurements, Mapping):
            continue
        if (
            str(measurements.get("symbol", "")).upper() == target_symbol
            and str(measurements.get("timeframe", "")) == timeframe
            and str(measurements.get("candidate", "")) == candidate
        ):
            match = entry
            break

    if match is None:
        raise SequenceReadinessError(
            f"Sequence-readiness report {report_row['id']} does not measure "
            f"{target_symbol} {timeframe} ({candidate})."
        )

    verdict = str(match.get("verdict", ""))
    if verdict != PASS_VERDICT:
        findings = match.get("findings")
        detail = ""
        if isinstance(findings, list) and findings:
            detail = "; ".join(
                f"{f.get('code')}: {f.get('detail')}" if isinstance(f, Mapping) else str(f)
                for f in findings
            )
        raise SequenceReadinessError(
            f"{target_symbol} {timeframe} ({candidate}) verdict is {verdict or 'missing'}"
            + (f" — {detail}" if detail else "")
        )

    return {
        "reportId": report_row["id"],
        "reportHash": report_row["reportHash"],
        "reportCreatedAt": created_at.isoformat(),
        "symbol": target_symbol,
        "timeframe": timeframe,
        "candidate": candidate,
        "verdict": verdict,
    }
