"""OFVP Phase-2 cost-floor recompute v1.1 — corrected gate on saved events.

Target size vs cost on a post-hoc population only — not tradeability.
Gate labels: TARGET_EXCEEDS_COST / TARGET_BELOW_COST / INSUFFICIENT_SESSIONS.
Default is print-only; pass --write-json / --write-md to overwrite outputs.

Does not overwrite the original baseline JSON/report. Reads
logs/ofvp-phase2-baseline.json.

Corrections (audit 2026-10-13):
- H1 measured on RETURNED events only (not all probes).
- H2 measured on structural nearest_hvn_outside targets only (no 25% range fallback).
- One value per (underlying, session): median of that session's eligible events;
  then median across sessions (sessions are the independent unit).
- Gap opens (first probe at/near 09:15 IST) reported separately from intraday probes.
- Sessions split by prior-day contract volume (thin September vs front-month-like).

Research only. Not a trading authorization.
"""

from __future__ import annotations

import json
import math
import os
import statistics
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
IN_JSON = REPO_ROOT / "logs" / "ofvp-phase2-baseline.json"
# Default outputs; pass --write to actually overwrite (avoids accidental clobber on inspect runs).
OUT_JSON = REPO_ROOT / "logs" / "ofvp-phase2-cost-floor-v1.1.json"
OUT_MD = (
    REPO_ROOT
    / "docs"
    / "research"
    / "orderflow-volume-profile"
    / "OFVP_PHASE2_COST_FLOOR_V1.1.md"
)

COST_FLOOR_BPS = 9.7
IST = ZoneInfo("Asia/Kolkata")
# First RTH minute; probes starting here (or within 2 minutes) on the session's
# first probe are treated as gap opens, not intraday value probes.
GAP_OPEN_MINUTES = {(9, 15), (9, 16), (9, 17)}
# Front-month-like: densest contract that day printed at least this many contracts.
FRONT_MONTH_MIN_VOLUME = 1_000_000


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env_path = REPO_ROOT / "apps" / "api" / ".env"
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL=") and not line.startswith("#"):
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            if value:
                return value
    raise RuntimeError("DATABASE_URL is not set")


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    return float(statistics.median(xs))


def _pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    i = int(round(p * (len(s) - 1)))
    return float(s[i])


def _ist_hm(probe_time: str) -> tuple[int, int]:
    dt = datetime.fromisoformat(probe_time)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    local = dt.astimezone(IST)
    return local.hour, local.minute


def _load_contract_day_volume() -> dict[tuple[str, str], float]:
    """(contract_symbol, IST session_date) -> sum of 1m futures volume."""
    with psycopg.connect(_database_url()) as conn:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
            cur.execute(
                """
                SELECT f.symbol,
                       (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS d,
                       SUM(c.volume)::float8 AS vol
                  FROM instruments f
                  JOIN candles c
                    ON c.instrument_id = f.id
                   AND c.timeframe = '1m'
                   AND c.is_complete
                 WHERE f.instrument_type = 'FUTURE'
                   AND f.underlying_symbol = ANY(%s)
                GROUP BY 1, 2
                """,
                [["BANKNIFTY", "NIFTY50"]],
            )
            return {(str(sym), str(d)): float(vol or 0) for sym, d, vol in cur.fetchall()}


def _session_key(e: dict) -> tuple[str, str]:
    return e["underlying"], e["session_date"]


def _tag_gap_opens(events: list[dict]) -> None:
    """Mark each event with is_gap_open / is_intraday relative to its session's first probe."""
    first_by_session: dict[tuple[str, str], dict] = {}
    for e in events:
        key = _session_key(e)
        prev = first_by_session.get(key)
        if prev is None or e["probe_time"] < prev["probe_time"]:
            first_by_session[key] = e

    for e in events:
        key = _session_key(e)
        first = first_by_session[key]
        hm = _ist_hm(e["probe_time"])
        is_first = e["probe_time"] == first["probe_time"]
        e["is_gap_open"] = bool(is_first and hm in GAP_OPEN_MINUTES)
        e["is_intraday_probe"] = not e["is_gap_open"]


def _session_medians(
    events: list[dict],
    value_key: str,
    *,
    underlying: str | None = None,
    intraday_only: bool = False,
    volume_class: str | None = None,
) -> list[float]:
    """One median per (underlying, session); returns the list of session medians."""
    buckets: dict[tuple[str, str], list[float]] = defaultdict(list)
    for e in events:
        if underlying and e["underlying"] != underlying:
            continue
        if intraday_only and not e.get("is_intraday_probe"):
            continue
        if volume_class and e.get("volume_class") != volume_class:
            continue
        buckets[_session_key(e)].append(float(e[value_key]))
    return [float(statistics.median(vs)) for vs in buckets.values() if vs]


MIN_SESSIONS_FOR_GATE = 5


def _gate(median_bps: float | None, n_sessions: int = 0) -> str:
    """Target size vs cost only — not tradeability.

    TARGET_EXCEEDS_COST / TARGET_BELOW_COST replace the old CLEARS_COST_FLOOR /
    REJECT_UNECONOMIC wording, which overstated what a target>cost comparison means.
    """
    if median_bps is None or n_sessions == 0:
        return "NO_EVENTS"
    if n_sessions < MIN_SESSIONS_FOR_GATE:
        return "INSUFFICIENT_SESSIONS"
    if median_bps < COST_FLOOR_BPS:
        return "TARGET_BELOW_COST"
    return "TARGET_EXCEEDS_COST"


def _summarize_series(session_medians: list[float], label: str) -> dict[str, Any]:
    med = _median(session_medians)
    n = len(session_medians)
    return {
        "label": label,
        "n_sessions": n,
        "median_of_session_medians_bps": med,
        "p25_session_bps": _pct(session_medians, 0.25),
        "p75_session_bps": _pct(session_medians, 0.75),
        "gate": _gate(med, n),
    }


def _payoff_note(returned: list[dict]) -> dict[str, Any]:
    """Stop/excursion vs H1 target — descriptive, not a P&L."""
    if not returned:
        return {"n": 0}
    by_u: dict[str, list[dict]] = defaultdict(list)
    for e in returned:
        by_u[e["underlying"]].append(e)
    out: dict[str, Any] = {"n": len(returned)}
    for u, xs in by_u.items():
        exc = [float(e["excursion_beyond_boundary_points"]) for e in xs]
        tgt = [float(e["h1_target_points"]) for e in xs]
        mids = [float(e["mid_price"]) for e in xs]
        mid = statistics.mean(mids)
        cost_pts = (COST_FLOOR_BPS / 10_000.0) * mid
        out[u] = {
            "n": len(xs),
            "median_excursion_points": _median(exc),
            "median_h1_target_points": _median(tgt),
            "cost_floor_points_at_mean_mid": cost_pts,
            "note": (
                "Median excursion beyond boundary vs median |boundary-POC| target; "
                "costs ~cost_floor_points. Net payoff thinner than target-only gate."
            ),
        }
    return out


def run() -> dict:
    payload = json.loads(IN_JSON.read_text(encoding="utf-8"))
    events: list[dict] = payload["events"]
    volumes = _load_contract_day_volume()

    for e in events:
        # Volume class from the PRIOR session's profile contract day (what built the levels).
        # Fall back to today's contract volume if prior day missing.
        prior_vol = volumes.get((e["contract"], e["prior_session_date"]))
        today_vol = volumes.get((e["contract"], e["session_date"]), 0.0)
        # Prefer volume on the profile day: densest contract that day may differ; use
        # today's printed volume of the stamped contract as the liquidity context for
        # the evaluation session (matches the audit's "sessions built from thin contract").
        vol = today_vol if today_vol > 0 else (prior_vol or 0.0)
        # Also try prior date with same contract for profile thinness.
        profile_vol = volumes.get((e["contract"], e["prior_session_date"]), vol)
        e["session_contract_volume"] = vol
        e["prior_contract_volume"] = profile_vol
        # Thin if the evaluation day's contract print is below front-month bar.
        e["volume_class"] = "FRONT_MONTH_LIKE" if vol >= FRONT_MONTH_MIN_VOLUME else "THIN"

    _tag_gap_opens(events)

    returned = [e for e in events if e["outcome"] == "RETURNED"]
    structural_h2 = [e for e in events if e["h2_target_kind"] == "nearest_hvn_outside"]
    # H2 "held outside" with structural target (closer to the accepted-breakout idea).
    structural_held = [
        e
        for e in structural_h2
        if e["outcome"] in ("HELD_OUTSIDE", "TIMEOUT_STILL_OUT", "AMBIGUOUS")
    ]

    sessions = sorted({_session_key(e) for e in events})
    gap_first = sum(
        1
        for key in sessions
        if any(e.get("is_gap_open") for e in events if _session_key(e) == key)
    )

    # Event-level (for transparency; not the gate).
    event_level = {
        "h1_returned_all": {
            "n_events": len(returned),
            "median_bps": _median([e["h1_target_bps"] for e in returned]),
            "p25_bps": _pct([e["h1_target_bps"] for e in returned], 0.25),
            "by_underlying": {
                u: {
                    "n": sum(1 for e in returned if e["underlying"] == u),
                    "median_bps": _median(
                        [e["h1_target_bps"] for e in returned if e["underlying"] == u]
                    ),
                    "p25_bps": _pct(
                        [e["h1_target_bps"] for e in returned if e["underlying"] == u],
                        0.25,
                    ),
                }
                for u in ("BANKNIFTY", "NIFTY50")
            },
        },
        "h2_structural_all_probes": {
            "n_events": len(structural_h2),
            "n_fallback_excluded": sum(
                1 for e in events if e["h2_target_kind"] == "fallback_25pct_prior_range"
            ),
            "median_bps": _median([e["h2_target_bps"] for e in structural_h2]),
            "by_underlying": {
                u: {
                    "n": sum(1 for e in structural_h2 if e["underlying"] == u),
                    "median_bps": _median(
                        [e["h2_target_bps"] for e in structural_h2 if e["underlying"] == u]
                    ),
                }
                for u in ("BANKNIFTY", "NIFTY50")
            },
        },
    }

    # Session-level gate (the corrected primary).
    gate = {
        "h1_returned_session_median": {
            "all": _summarize_series(
                _session_medians(returned, "h1_target_bps"),
                "H1 RETURNED, all sessions",
            ),
            "intraday_only": _summarize_series(
                _session_medians(returned, "h1_target_bps", intraday_only=True),
                "H1 RETURNED, intraday probes only",
            ),
            "BANKNIFTY": _summarize_series(
                _session_medians(returned, "h1_target_bps", underlying="BANKNIFTY"),
                "H1 RETURNED BANKNIFTY",
            ),
            "NIFTY50": _summarize_series(
                _session_medians(returned, "h1_target_bps", underlying="NIFTY50"),
                "H1 RETURNED NIFTY50",
            ),
            "front_month_like": _summarize_series(
                _session_medians(
                    returned, "h1_target_bps", volume_class="FRONT_MONTH_LIKE"
                ),
                "H1 RETURNED front-month-like sessions",
            ),
            "thin": _summarize_series(
                _session_medians(returned, "h1_target_bps", volume_class="THIN"),
                "H1 RETURNED thin-contract sessions",
            ),
        },
        "h2_structural_session_median": {
            "all_probes_with_hvn": _summarize_series(
                _session_medians(structural_h2, "h2_target_bps"),
                "H2 structural HVN, all such probes",
            ),
            "held_or_timeout_with_hvn": _summarize_series(
                _session_medians(structural_held, "h2_target_bps"),
                "H2 structural HVN among non-return outcomes",
            ),
            "intraday_held_with_hvn": _summarize_series(
                _session_medians(
                    structural_held, "h2_target_bps", intraday_only=True
                ),
                "H2 structural HVN, intraday, non-return",
            ),
            "BANKNIFTY": _summarize_series(
                _session_medians(
                    structural_h2, "h2_target_bps", underlying="BANKNIFTY"
                ),
                "H2 structural BANKNIFTY",
            ),
            "NIFTY50": _summarize_series(
                _session_medians(structural_h2, "h2_target_bps", underlying="NIFTY50"),
                "H2 structural NIFTY50",
            ),
            "front_month_like": _summarize_series(
                _session_medians(
                    structural_h2, "h2_target_bps", volume_class="FRONT_MONTH_LIKE"
                ),
                "H2 structural front-month-like",
            ),
            "thin": _summarize_series(
                _session_medians(structural_h2, "h2_target_bps", volume_class="THIN"),
                "H2 structural thin",
            ),
        },
    }

    # Volume-class session counts
    session_vol = {}
    for e in events:
        key = _session_key(e)
        session_vol[key] = {
            "volume": e["session_contract_volume"],
            "volume_class": e["volume_class"],
            "contract": e["contract"],
        }
    n_front = sum(1 for v in session_vol.values() if v["volume_class"] == "FRONT_MONTH_LIKE")
    n_thin = sum(1 for v in session_vol.values() if v["volume_class"] == "THIN")

    h1_primary = gate["h1_returned_session_median"]["intraday_only"]
    h2_primary = gate["h2_structural_session_median"]["intraday_held_with_hvn"]
    # Fall back for H2 primary if intraday held is empty
    if h2_primary["n_sessions"] == 0:
        h2_primary = gate["h2_structural_session_median"]["held_or_timeout_with_hvn"]
    if h2_primary["n_sessions"] == 0:
        h2_primary = gate["h2_structural_session_median"]["all_probes_with_hvn"]

    verdict = {
        "h1_primary_gate": h1_primary["gate"],
        "h2_primary_gate": h2_primary["gate"],
        "h1_primary": h1_primary,
        "h2_primary": h2_primary,
        "reading": _verdict_reading(h1_primary, h2_primary),
    }

    result = {
        "documentId": "OFVP-PHASE2-COST-FLOOR-V1.1",
        "supersedesGateIn": "OFVP-PHASE2-BASELINE-2026-10-13 (gate section only; events reused)",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "tradingExecutionAuthorized": False,
        "costFloorBps": COST_FLOOR_BPS,
        "frontMonthMinVolume": FRONT_MONTH_MIN_VOLUME,
        "corrections": [
            "H1 on RETURNED only",
            "H2 on nearest_hvn_outside only (no 25% range fallback)",
            "one median per (underlying, session), then median across sessions",
            "gap opens (first probe at 09:15-09:17 IST) separated",
            "sessions split by evaluation-day contract volume vs 1M bar",
        ],
        "inventory": {
            "n_events": len(events),
            "n_sessions": len(sessions),
            "n_returned": len(returned),
            "n_structural_h2": len(structural_h2),
            "n_fallback_h2": sum(
                1 for e in events if e["h2_target_kind"] == "fallback_25pct_prior_range"
            ),
            "n_sessions_first_probe_is_gap_open": gap_first,
            "n_front_month_like_sessions": n_front,
            "n_thin_sessions": n_thin,
        },
        "eventLevel": event_level,
        "sessionLevelGate": gate,
        "payoffNote": _payoff_note(returned),
        "verdict": verdict,
        "sessions": [
            {
                "underlying": u,
                "session_date": s,
                **session_vol[(u, s)],
            }
            for u, s in sessions
        ],
    }
    return result


def _verdict_reading(h1: dict, h2: dict) -> str:
    g1, g2 = h1["gate"], h2["gate"]
    base = (
        "Labeling is target size vs cost on a post-hoc population only — "
        "tradeability untested. Do not build a selector/backtester on this history; "
        "use forward FRVP_OBS stamps with a probe-time-only rule."
    )
    if g1 == "TARGET_EXCEEDS_COST" and g2 == "TARGET_BELOW_COST":
        return (
            "H1 target exceeds cost among returned events; H2 structural HVN target does not. "
            + base
        )
    if g1 == "TARGET_EXCEEDS_COST" and g2 == "TARGET_EXCEEDS_COST":
        return "Both targets exceed cost on their restricted populations. " + base
    if g1 == "TARGET_BELOW_COST" and g2 == "TARGET_BELOW_COST":
        return "Both targets sit below the cost floor. Stop before any trading study. " + base
    return f"H1={g1}, H2={g2}. " + base


def _fmt(x: float | None) -> str:
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return "—"
    return f"{x:.2f}"


def _write_md(result: dict) -> None:
    v = result["verdict"]
    inv = result["inventory"]
    el = result["eventLevel"]
    lines = [
        "# OFVP Phase-2 cost-floor gate v1.1 (corrected)",
        "",
        f"**Document ID:** `{result['documentId']}`  ",
        f"**Generated:** `{result['generatedAt']}`  ",
        f"**Status:** Research only — `tradingExecutionAuthorized: false`  ",
        f"**Supersedes:** gate section of `{result['supersedesGateIn']}` (events unchanged)  ",
        "",
        "## Why this exists",
        "",
        "The v1.0 baseline report used a sensible cost-floor idea but measured H1 and H2 on the",
        "wrong populations: H1 on all probes (not returned events), H2 including an arbitrary",
        "25% prior-range fallback when no HVN existed. This recompute fixes those gates.",
        "It does **not** claim an edge.",
        "",
        "## Verdict",
        "",
        f"- **H1 primary:** `{v['h1_primary_gate']}` — "
        f"median session target **{_fmt(v['h1_primary'].get('median_of_session_medians_bps'))} bps** "
        f"over **{v['h1_primary']['n_sessions']}** sessions "
        f"({v['h1_primary']['label']})",
        f"- **H2 primary:** `{v['h2_primary_gate']}` — "
        f"median session target **{_fmt(v['h2_primary'].get('median_of_session_medians_bps'))} bps** "
        f"over **{v['h2_primary']['n_sessions']}** sessions "
        f"({v['h2_primary']['label']})",
        f"- **Reading:** {v['reading']}",
        "",
        "## Corrections applied",
        "",
    ]
    for c in result["corrections"]:
        lines.append(f"- {c}")
    lines.extend(
        [
            "",
            f"Cost floor remains **{result['costFloorBps']} bps**. "
            f"Front-month-like bar: evaluation-day contract volume ≥ "
            f"**{result['frontMonthMinVolume']:,}**.",
            "",
            "## Inventory",
            "",
            f"- Events: {inv['n_events']} across {inv['n_sessions']} underlying-sessions",
            f"- RETURNED (H1 population): {inv['n_returned']} ({100 * inv['n_returned'] / inv['n_events']:.1f}%)",
            f"- Structural H2 targets: {inv['n_structural_h2']}; "
            f"fallback excluded: {inv['n_fallback_h2']}",
            f"- Sessions whose first probe is a 09:15–09:17 IST gap open: "
            f"{inv['n_sessions_first_probe_is_gap_open']}",
            f"- Front-month-like sessions: {inv['n_front_month_like_sessions']}; "
            f"thin: {inv['n_thin_sessions']}",
            "",
            "## Event-level (transparency; not the gate)",
            "",
            f"- H1 RETURNED median target: **{_fmt(el['h1_returned_all']['median_bps'])} bps** "
            f"(p25 {_fmt(el['h1_returned_all']['p25_bps'])}); "
            f"NIFTY {_fmt(el['h1_returned_all']['by_underlying']['NIFTY50']['median_bps'])}, "
            f"BANKNIFTY {_fmt(el['h1_returned_all']['by_underlying']['BANKNIFTY']['median_bps'])}",
            f"- H2 structural median target: **{_fmt(el['h2_structural_all_probes']['median_bps'])} bps** "
            f"(n={el['h2_structural_all_probes']['n_events']}); "
            f"NIFTY {_fmt(el['h2_structural_all_probes']['by_underlying']['NIFTY50']['median_bps'])}, "
            f"BANKNIFTY {_fmt(el['h2_structural_all_probes']['by_underlying']['BANKNIFTY']['median_bps'])}",
            "",
            "## Session-level gate (primary)",
            "",
            "| Slice | Sessions | Median bps | p25 | p75 | Gate |",
            "|---|---:|---:|---:|---:|---|",
        ]
    )

    def add_rows(block: dict) -> None:
        for key, s in block.items():
            lines.append(
                f"| {s['label']} | {s['n_sessions']} | "
                f"{_fmt(s['median_of_session_medians_bps'])} | "
                f"{_fmt(s['p25_session_bps'])} | {_fmt(s['p75_session_bps'])} | "
                f"`{s['gate']}` |"
            )

    add_rows(result["sessionLevelGate"]["h1_returned_session_median"])
    add_rows(result["sessionLevelGate"]["h2_structural_session_median"])

    pay = result["payoffNote"]
    lines.extend(["", "## Stop / excursion note (returned events)", ""])
    if pay.get("n"):
        for u in ("NIFTY50", "BANKNIFTY"):
            if u not in pay:
                continue
            p = pay[u]
            lines.append(
                f"- **{u}** (n={p['n']}): median excursion beyond boundary "
                f"**{_fmt(p['median_excursion_points'])} pts** vs median H1 target "
                f"**{_fmt(p['median_h1_target_points'])} pts**; cost floor ≈ "
                f"**{_fmt(p['cost_floor_points_at_mean_mid'])} pts** at mean mid."
            )
        lines.append(
            "- Net of costs, the favourable move is much thinner than a target-only “clears” suggests."
        )
    else:
        lines.append("- No returned events.")

    lines.extend(
        [
            "",
            "## What this still does not answer",
            "",
            "- Which probes return (the 9% selectivity problem) — that *is* the strategy question.",
            "- Whether any rule beats costs after stops, slippage path, and realistic fills.",
            "- Edge on ~45 sessions (~14 front-month-like); plan bar remains ~60 sessions.",
            "",
            "## Artifacts",
            "",
            f"- Input events: `{IN_JSON.relative_to(REPO_ROOT).as_posix()}` (unchanged)",
            f"- This JSON: `{OUT_JSON.relative_to(REPO_ROOT).as_posix()}`",
            f"- Original (flawed gate) report kept for audit: "
            "`docs/research/orderflow-volume-profile/OFVP_PHASE2_BASELINE_COST_FLOOR_V1.md`",
            "",
        ]
    )
    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="OFVP Phase-2 corrected cost-floor recompute (target size vs cost only)."
    )
    parser.add_argument(
        "--write-json",
        action="store_true",
        help=f"Overwrite {OUT_JSON.name}. Default is print-only (no file clobber).",
    )
    parser.add_argument(
        "--write-md",
        action="store_true",
        help=(
            f"Overwrite {OUT_MD.name}. Default off: the amended markdown is hand-curated "
            "and should not be regenerated casually."
        ),
    )
    args = parser.parse_args(argv)

    result = run()
    wrote: list[str] = []
    if args.write_json:
        OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        OUT_JSON.write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
        wrote.append(str(OUT_JSON))
    if args.write_md:
        _write_md(result)
        wrote.append(str(OUT_MD))
    print(
        json.dumps(
            {
                "wrote": wrote,
                "note": (
                    "print-only unless --write-json / --write-md; "
                    "labels are TARGET_EXCEEDS_COST / TARGET_BELOW_COST (not tradeability)"
                ),
                "verdict": result["verdict"]["reading"],
                "h1": result["verdict"]["h1_primary"],
                "h2": result["verdict"]["h2_primary"],
                "inventory": result["inventory"],
            },
            indent=2,
            default=str,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
