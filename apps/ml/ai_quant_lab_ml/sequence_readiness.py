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


class SequenceReadinessError(RuntimeError):
    """TCN research refused because the sequence-readiness gate did not clear."""


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
