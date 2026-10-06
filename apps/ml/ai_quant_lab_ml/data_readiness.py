"""Fail-closed data-readiness gate for training runs (Phase 25, Workstream A).

The TypeScript audit (``npm run data:audit``) measures every stored candle
series and persists a machine-readable report with per-series states:

- ``READY``: training may proceed.
- ``DEGRADED``: coverage or derived-evidence gaps; training is blocked.
- ``STALE``: the series is older than its allowed cadence; training is blocked.
- ``INVALID``: integrity/provenance failure; the series is quarantined.

Training must not fit a series the audit has not cleared, and the artifact must
record exactly which audit cleared it — a research score whose data health
cannot be reproduced is not evidence. ``require_series_ready`` returns the
provenance block that travels in ``validationProtocol.dataReadiness``.

A refusal here is the audit doing its job, not an infrastructure error. The
remedy is to fix the data (or re-run the audit after collection catches up),
never to lower the gate.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Mapping, Sequence

READY_STATE = "READY"

# The audit runs inside the daily EOD pipeline, so a report older than this
# means the pipeline itself has been broken for a week — training on top of
# that would compound one failure with another.
MAXIMUM_REPORT_AGE = timedelta(days=7)


class DataReadinessError(RuntimeError):
    """Training refused because the data-readiness audit does not clear it."""


def load_latest_report(connection) -> Mapping[str, Any] | None:
    """Fetch the most recent persisted audit, or ``None`` when none exists."""

    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT id, report_hash, report, created_at"
            " FROM data_readiness_reports"
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


def require_series_ready(
    report_row: Mapping[str, Any] | None,
    symbols: Sequence[str],
    timeframe: str,
    as_of: datetime,
) -> dict[str, Any]:
    """Refuse unless every requested series is READY in a fresh audit.

    Returns the provenance block recorded in the artifact's validation
    protocol. Raises :class:`DataReadinessError` with every failing series
    listed — a pooled run should learn about all twenty problems at once, not
    one per attempt.
    """

    if report_row is None:
        raise DataReadinessError(
            "No data-readiness report exists. Run `npm run data:audit` before training; "
            "the audit is the evidence that this data is fit to fit."
        )

    created_at = report_row["createdAt"]
    age = as_of - created_at
    if age > MAXIMUM_REPORT_AGE:
        raise DataReadinessError(
            f"The latest data-readiness report ({report_row['id']}) is {age.days} day(s) old, "
            f"beyond the {MAXIMUM_REPORT_AGE.days}-day tolerance. Re-run `npm run data:audit` "
            "so training reflects current data health."
        )

    report = report_row.get("report")
    series_entries = report.get("series") if isinstance(report, Mapping) else None
    if not isinstance(series_entries, list):
        raise DataReadinessError(
            f"Data-readiness report {report_row['id']} carries no series list; it cannot clear anything."
        )

    by_key: dict[tuple[str, str], Mapping[str, Any]] = {}
    for entry in series_entries:
        if isinstance(entry, Mapping):
            by_key[(str(entry.get("symbol", "")).upper(), str(entry.get("timeframe", "")))] = entry

    states: dict[str, str] = {}
    failures: list[str] = []
    for symbol in symbols:
        normalized = symbol.upper()
        entry = by_key.get((normalized, timeframe))
        if entry is None:
            failures.append(
                f"{normalized} {timeframe}: not measured by the audit — the series has no stored bars "
                "or the audit predates its collection."
            )
            continue
        state = str(entry.get("state", ""))
        states[normalized] = state
        if state != READY_STATE:
            reasons = entry.get("reasons")
            reason_text = "; ".join(str(reason) for reason in reasons) if isinstance(reasons, list) and reasons else "no reasons recorded"
            failures.append(f"{normalized} {timeframe}: {state} ({reason_text})")

    if failures:
        raise DataReadinessError(
            "Data-readiness audit "
            f"{report_row['id']} does not clear this training run:\n- " + "\n- ".join(failures)
        )

    return {
        "reportId": report_row["id"],
        "reportHash": report_row["reportHash"],
        "reportCreatedAt": created_at.isoformat(),
        "timeframe": timeframe,
        "states": states,
    }
