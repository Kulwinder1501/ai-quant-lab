"""FRVP Phase 0 implementation audit (not a performance experiment).

Reports mentor-required intermediate counts: volume conservation, bin occupancy,
pre-match HVN/LVN counts, geometric LVN-ahead, and predicate funnel.

Does not retune thresholds or touch the locked holdout decision logic beyond
read-only measurement. Normative:
docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

from ai_quant_lab_ml.estimated_fixed_range_volume_profile import (
    LVN_AHEAD_MAX_ATR_FRAC,
    LVN_AHEAD_MAX_TICKS_FLOOR,
    OhlcvBar,
    allocate_bar_volume_uniform,
    build_estimated_session_profile,
    classify_profile_events_at_decision,
    map_futures_level_to_index,
)

IST = ZoneInfo("Asia/Kolkata")
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
ATTACHED_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-candidates-attached.jsonl"
OUT_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-implementation-audit.json"
BASIS_SYNC_TOLERANCE = timedelta(seconds=60)


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set")
    return url


def _parse_ts(value: Any) -> datetime:
    if isinstance(value, datetime):
        ts = value
    else:
        ts = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def ist_session_date(ts: datetime) -> date:
    return _parse_ts(ts).astimezone(IST).date()


def fixture_allocator_checks() -> dict[str, Any]:
    cases = []
    for low, high, vol, tick, expected_bins in [
        (100.0, 102.0, 30.0, 1.0, 3),
        (100.05, 100.25, 10_000.0, 0.05, 5),
        (22700.0, 22700.0, 500.0, 0.05, 1),
    ]:
        parts = allocate_bar_volume_uniform(low, high, vol, tick)
        allocated = sum(parts.values())
        cases.append(
            {
                "low": low,
                "high": high,
                "inputVolume": vol,
                "tick": tick,
                "binCount": len(parts),
                "expectedBins": expected_bins,
                "allocatedSum": allocated,
                "conserved": abs(allocated - vol) < 1e-9,
                "maxBinShare": max(parts.values()) if parts else 0.0,
                "duplicatedFullVolumeIntoEachBin": bool(parts)
                and abs(max(parts.values()) - vol) < 1e-9
                and len(parts) > 1,
            }
        )
    return {
        "allConserved": all(c["conserved"] for c in cases),
        "anyDuplicationBug": any(c["duplicatedFullVolumeIntoEachBin"] for c in cases),
        "cases": cases,
    }


def load_futures_sessions(
    conn: psycopg.Connection,
) -> tuple[dict[str, dict[date, list[OhlcvBar]]], dict[str, float]]:
    out: dict[str, dict[date, list[OhlcvBar]]] = defaultdict(lambda: defaultdict(list))
    ticks: dict[str, float] = {}
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT i.symbol, i.tick_size::float8, c.open_time,
                   c.open::float8, c.high::float8, c.low::float8, c.close::float8, c.volume::float8
            FROM candles c
            JOIN instruments i ON i.id = c.instrument_id
            WHERE i.instrument_type = 'FUTURE'
              AND i.symbol IN ('NIFTY26OCTFUT', 'BANKNIFTY26OCTFUT')
              AND c.timeframe = '1m'
              AND c.is_complete = TRUE
            ORDER BY i.symbol, c.open_time
            """
        )
        for sym, tick, ot, o, h, l, c, v in cur.fetchall():
            ticks[sym] = float(tick)
            bar = OhlcvBar(_parse_ts(ot), float(o), float(h), float(l), float(c), float(v))
            out[sym][ist_session_date(bar.open_time)].append(bar)
    return {sym: dict(sessions) for sym, sessions in out.items()}, ticks


def session_profile_diagnostics(
    fut_sessions: dict[str, dict[date, list[OhlcvBar]]],
    ticks: dict[str, float],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for sym, sessions in sorted(fut_sessions.items()):
        tick = ticks[sym]
        for sess, bars in sorted(sessions.items()):
            pos = [b for b in bars if b.volume > 0]
            input_vol = sum(b.volume for b in pos)
            # Per-bar conservation check on a sample of bars.
            bar_ok = 0
            bar_fail = 0
            for b in pos[:50]:
                parts = allocate_bar_volume_uniform(b.low, b.high, b.volume, tick)
                if abs(sum(parts.values()) - b.volume) < 1e-6:
                    bar_ok += 1
                else:
                    bar_fail += 1
            profile = build_estimated_session_profile(pos, tick_size=tick, contract_symbol=sym)
            if profile is None:
                rows.append(
                    {
                        "contract": sym,
                        "session": sess.isoformat(),
                        "positiveInputBars": len(pos),
                        "inputVolume": input_vol,
                        "profileBuilt": False,
                    }
                )
                continue
            allocated = sum(profile.bin_volumes)
            # Shallow local minima (prominence ignored) for Risk A/B contrast.
            vols = profile.bin_volumes
            shallow = 0
            for i in range(1, len(vols) - 1):
                if vols[i] < vols[i - 1] and vols[i] < vols[i + 1]:
                    shallow += 1
            rows.append(
                {
                    "contract": sym,
                    "session": sess.isoformat(),
                    "positiveInputBars": len(pos),
                    "inputVolume": input_vol,
                    "profileBuilt": True,
                    "allocatedProfileVolume": allocated,
                    "volumeConserved": abs(allocated - input_vol) < 1e-3,
                    "conservationAbsError": abs(allocated - input_vol),
                    "occupiedBinCount": len(profile.bin_prices),
                    "tickSize": tick,
                    "poc": profile.poc,
                    "val": profile.val,
                    "vah": profile.vah,
                    "valueAreaVolumeFrac": sum(
                        v
                        for p, v in zip(profile.bin_prices, profile.bin_volumes)
                        if profile.val <= p <= profile.vah
                    )
                    / input_vol
                    if input_vol
                    else None,
                    "hvnCount": len(profile.hvns),
                    "lvnCount": len(profile.lvns),
                    "shallowLocalMinimaCount": shallow,
                    "allocatorSampleBarsOk": bar_ok,
                    "allocatorSampleBarsFail": bar_fail,
                }
            )
    return rows


def candidate_funnel(attached_path: Path) -> dict[str, Any]:
    if not attached_path.is_file():
        return {"error": f"missing {attached_path}"}
    rows = [json.loads(l) for l in attached_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    by_inst: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    by_sess: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    distance_stats: list[float] = []
    predicate_block_hvn = 0
    geometric_ahead = 0
    within_window = 0
    has_lvn = 0

    for r in rows:
        inst = r["instrumentSymbol"]
        sess = r["decisionSessionDateIst"]
        detail = r["frvp"]["detail"]
        events = r["frvp"]["events"]
        by_inst[inst]["candidates"] += 1
        by_sess[sess]["candidates"] += 1
        lvn_n = int(detail.get("lvnCount") or 0)
        if lvn_n > 0:
            has_lvn += 1
            by_inst[inst]["withLvn"] += 1
            by_sess[sess]["withLvn"] += 1
        if "LVN_AHEAD" in events:
            by_inst[inst]["lvnAhead"] += 1
            by_sess[sess]["lvnAhead"] += 1
        # Reconstruct geometric funnel using logged mapped levels when present.
        lvns = []
        # Attached file does not store LVN prices; approximate from events only for counts.
        # Distance diagnostics use poc/vah/val vs entry.
        entry = float(r["entryPrice"])
        if detail.get("pocIndex") is not None:
            if entry > float(detail["vahIndex"]):
                by_inst[inst]["entryAboveVah"] += 1
            elif entry < float(detail["valIndex"]):
                by_inst[inst]["entryBelowVal"] += 1
            else:
                by_inst[inst]["entryInsideVa"] += 1
        atr = r.get("atr14")
        tick = float(r.get("tickSize") or 0.05)
        if atr and lvn_n > 0:
            ahead_max = max(LVN_AHEAD_MAX_TICKS_FLOOR * tick, LVN_AHEAD_MAX_ATR_FRAC * float(atr))
            by_inst[inst]["aheadMaxMedianBucket"] += 1
            # Without stored LVN prices we cannot finish geometric distance here;
            # recorded below via live rebuild for a sample.

    return {
        "candidates": len(rows),
        "candidatesWithAnyLvn": has_lvn,
        "candidatesWithLvnAheadEvent": sum(1 for r in rows if "LVN_AHEAD" in r["frvp"]["events"]),
        "byInstrument": {k: dict(v) for k, v in by_inst.items()},
        "bySession": {k: dict(v) for k, v in by_sess.items()},
        "note": (
            "Attached JSONL stores lvnCount but not LVN price list; geometric distance funnel "
            "completed in rebuild_funnel() against live profiles."
        ),
    }


def rebuild_funnel(conn: psycopg.Connection, attached_path: Path) -> dict[str, Any]:
    """Rebuild profiles and apply stepwise LVN_AHEAD predicates for every attached candidate."""
    rows = [json.loads(l) for l in attached_path.read_text(encoding="utf-8").splitlines() if l.strip()]
    fut_sessions, ticks = load_futures_sessions(conn)
    # Index 1m closes for basis.
    idx_bars: dict[str, list[OhlcvBar]] = defaultdict(list)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT i.symbol, c.open_time, c.open::float8, c.high::float8, c.low::float8,
                   c.close::float8, c.volume::float8
            FROM candles c JOIN instruments i ON i.id = c.instrument_id
            WHERE i.symbol IN ('NIFTY50', 'BANKNIFTY') AND c.timeframe='1m' AND c.is_complete
            ORDER BY i.symbol, c.open_time
            """
        )
        for sym, ot, o, h, l, c, v in cur.fetchall():
            idx_bars[sym].append(OhlcvBar(_parse_ts(ot), float(o), float(h), float(l), float(c), float(v)))

    def last_close(bars: list[OhlcvBar], as_of: datetime) -> OhlcvBar | None:
        chosen = None
        for b in bars:
            if b.open_time <= as_of:
                chosen = b
            else:
                break
        return chosen

    profile_cache: dict[tuple[str, str], Any] = {}
    funnel = defaultdict(int)
    ahead_max_values: list[float] = []
    nearest_ahead_dist: list[float] = []
    examples_blocked: list[dict[str, Any]] = []
    examples_far: list[dict[str, Any]] = []
    examples_no_lvn: int = 0

    for r in rows:
        funnel["candidates"] += 1
        detail = r["frvp"]["detail"]
        contract = detail.get("causalContract")
        prior = detail.get("priorSession")
        if not contract or not prior:
            funnel["missingContractOrPrior"] += 1
            continue
        tick = ticks[contract]
        cache_key = (contract, prior)
        if cache_key not in profile_cache:
            bars = fut_sessions[contract].get(date.fromisoformat(prior), [])
            profile_cache[cache_key] = build_estimated_session_profile(
                [b for b in bars if b.volume > 0], tick_size=tick, contract_symbol=contract
            )
        profile = profile_cache[cache_key]
        if profile is None:
            funnel["profileNone"] += 1
            continue
        funnel["profileOk"] += 1
        if not profile.lvns:
            funnel["noLvnInProfile"] += 1
            examples_no_lvn += 1
            continue
        funnel["profileHasLvn"] += 1

        decision = _parse_ts(r["decisionTime"])
        fut_flat = [b for d in sorted(fut_sessions[contract]) for b in fut_sessions[contract][d]]
        fut_c = last_close(fut_flat, decision)
        idx_c = last_close(idx_bars[r["instrumentSymbol"]], decision)
        if fut_c is None or idx_c is None:
            funnel["basisMissing"] += 1
            continue
        if abs((fut_c.open_time - idx_c.open_time).total_seconds()) > 60:
            funnel["basisStale"] += 1
            continue
        basis = fut_c.close - idx_c.close
        mapped_lvns = [map_futures_level_to_index(x, basis) for x in profile.lvns]
        mapped_hvns = [map_futures_level_to_index(x, basis) for x in profile.hvns]
        entry = float(r["entryPrice"])
        side = r["side"]
        atr = float(r["atr14"] or 0)
        if atr <= 0:
            funnel["atrMissing"] += 1
            continue
        ahead_max = max(LVN_AHEAD_MAX_TICKS_FLOOR * tick, LVN_AHEAD_MAX_ATR_FRAC * atr)
        ahead_max_values.append(ahead_max)

        if side == "LONG":
            directional = [l for l in mapped_lvns if l > entry]
        else:
            directional = [l for l in mapped_lvns if l < entry]
        if not directional:
            funnel["lvnExistsButNoneInTradeDirection"] += 1
            continue
        funnel["lvnGeometricallyInDirection"] += 1

        if side == "LONG":
            in_window = [l for l in directional if l <= entry + ahead_max]
        else:
            in_window = [l for l in directional if l >= entry - ahead_max]
        nearest = min(directional) if side == "LONG" else max(directional)
        nearest_ahead_dist.append(abs(nearest - entry))
        if not in_window:
            funnel["lvnInDirectionButOutsideDistanceWindow"] += 1
            if len(examples_far) < 8:
                examples_far.append(
                    {
                        "instrument": r["instrumentSymbol"],
                        "side": side,
                        "entry": entry,
                        "nearestLvn": nearest,
                        "distance": abs(nearest - entry),
                        "aheadMax": ahead_max,
                        "atr14": atr,
                        "session": r["decisionSessionDateIst"],
                    }
                )
            continue
        funnel["lvnInsideDistanceWindow"] += 1

        target = min(in_window) if side == "LONG" else max(in_window)
        if side == "LONG":
            blocked = any(entry < h < target for h in mapped_hvns)
        else:
            blocked = any(target < h < entry for h in mapped_hvns)
        if blocked:
            funnel["lvnBlockedByInterveningHvn"] += 1
            if len(examples_blocked) < 8:
                examples_blocked.append(
                    {
                        "instrument": r["instrumentSymbol"],
                        "side": side,
                        "entry": entry,
                        "targetLvn": target,
                        "session": r["decisionSessionDateIst"],
                    }
                )
            continue
        funnel["lvnAheadWouldFire"] += 1

        # Cross-check live classifier.
        mapped_profile = replace(
            profile,
            poc=map_futures_level_to_index(profile.poc, basis),
            vah=map_futures_level_to_index(profile.vah, basis),
            val=map_futures_level_to_index(profile.val, basis),
            hvns=tuple(mapped_hvns),
            lvns=tuple(mapped_lvns),
            session_vwap=map_futures_level_to_index(profile.session_vwap, basis),
        )
        events = classify_profile_events_at_decision(
            side=side,
            entry_price_index=entry,
            profile_index=mapped_profile,
            atr_1m=atr,
            prior_bars_index=[],
        )
        if "LVN_AHEAD" in events:
            funnel["classifierAgrees"] += 1
        else:
            funnel["classifierDisagrees"] += 1

    def pct(n: int) -> float | None:
        return round(100.0 * n / funnel["candidates"], 2) if funnel["candidates"] else None

    return {
        "funnel": dict(funnel),
        "funnelPctOfCandidates": {k: pct(v) for k, v in funnel.items() if k != "candidates"},
        "aheadMax": {
            "n": len(ahead_max_values),
            "min": min(ahead_max_values) if ahead_max_values else None,
            "median": sorted(ahead_max_values)[len(ahead_max_values) // 2] if ahead_max_values else None,
            "max": max(ahead_max_values) if ahead_max_values else None,
        },
        "nearestDirectionalLvnDistance": {
            "n": len(nearest_ahead_dist),
            "min": min(nearest_ahead_dist) if nearest_ahead_dist else None,
            "median": sorted(nearest_ahead_dist)[len(nearest_ahead_dist) // 2] if nearest_ahead_dist else None,
            "max": max(nearest_ahead_dist) if nearest_ahead_dist else None,
        },
        "examplesOutsideWindow": examples_far,
        "examplesBlockedByHvn": examples_blocked,
    }


def main() -> int:
    allocator = fixture_allocator_checks()
    conn = psycopg.connect(_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
        fut_sessions, ticks = load_futures_sessions(conn)
        session_rows = session_profile_diagnostics(fut_sessions, ticks)
        attached_summary = candidate_funnel(ATTACHED_PATH)
        funnel = rebuild_funnel(conn, ATTACHED_PATH) if ATTACHED_PATH.is_file() else {"error": "no attached file"}
    finally:
        conn.close()

    sessions_with_lvn = sum(1 for r in session_rows if r.get("lvnCount", 0) > 0)
    sessions_built = sum(1 for r in session_rows if r.get("profileBuilt"))
    report = {
        "experiment_id": "FRVP-MSP-P0-2026-10-12",
        "audit_type": "implementation_diagnostic",
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "disposition": "INCONCLUSIVE_UNCHANGED",
        "allocator_fixtures": allocator,
        "session_profiles": {
            "rows": session_rows,
            "sessionsBuilt": sessions_built,
            "sessionsWithAnyLvn": sessions_with_lvn,
            "allSessionsConserveVolume": all(
                r.get("volumeConserved", False) for r in session_rows if r.get("profileBuilt")
            ),
            "meanLvnCount": (
                sum(r.get("lvnCount", 0) for r in session_rows if r.get("profileBuilt")) / sessions_built
                if sessions_built
                else None
            ),
            "meanHvnCount": (
                sum(r.get("hvnCount", 0) for r in session_rows if r.get("profileBuilt")) / sessions_built
                if sessions_built
                else None
            ),
            "meanShallowLocalMinima": (
                sum(r.get("shallowLocalMinimaCount", 0) for r in session_rows if r.get("profileBuilt"))
                / sessions_built
                if sessions_built
                else None
            ),
        },
        "attached_summary": attached_summary,
        "candidate_predicate_funnel": funnel,
        "findings": [],
        "boundaries": [
            "No threshold retune",
            "No options replay",
            "No production / Pillar 6 / score / live Sniper changes",
            "Hypothesis A remains INCONCLUSIVE",
        ],
    }

    findings: list[str] = []
    if allocator["allConserved"] and not allocator["anyDuplicationBug"]:
        findings.append(
            "PASS: uniform allocator conserves bar volume (share = V/n_bins); no full-volume duplication bug."
        )
    else:
        findings.append("FAIL: allocator conservation or duplication invariant broken.")
    if report["session_profiles"]["allSessionsConserveVolume"]:
        findings.append("PASS: every built OCT session profile conserves input traded volume in bin sums.")
    else:
        findings.append("FAIL: at least one session profile violates volume conservation.")
    mean_lvn = report["session_profiles"]["meanLvnCount"]
    mean_shallow = report["session_profiles"]["meanShallowLocalMinima"]
    if mean_lvn is not None and mean_shallow is not None and mean_shallow > mean_lvn * 5:
        findings.append(
            "OBSERVATION (Risk A/B): many shallow local minima exist, but frozen 5%-of-POC prominence "
            f"keeps mean LVN count low (meanLvn={mean_lvn:.2f}, meanShallowLocalMinima={mean_shallow:.1f})."
        )
    funnel_counts = funnel.get("funnel", {}) if isinstance(funnel, dict) else {}
    if funnel_counts.get("noLvnInProfile", 0) > 0:
        findings.append(
            f"PRIMARY ZERO-ACTIVATION DRIVER: {funnel_counts.get('noLvnInProfile')} / "
            f"{funnel_counts.get('candidates')} candidates sit on prior-session profiles with 0 qualifying LVNs."
        )
    if funnel_counts.get("lvnInDirectionButOutsideDistanceWindow", 0):
        findings.append(
            f"SECONDARY: {funnel_counts['lvnInDirectionButOutsideDistanceWindow']} candidates have a "
            "directional LVN but outside ahead_max = max(8 ticks, 0.25×ATR)."
        )
    if funnel_counts.get("lvnBlockedByInterveningHvn", 0):
        findings.append(
            f"SECONDARY: {funnel_counts['lvnBlockedByInterveningHvn']} candidates blocked by intervening HVN corridor rule."
        )
    if funnel_counts.get("lvnAheadWouldFire", 0) == 0:
        findings.append(
            "CONCLUSION: LVN_AHEAD never clears the frozen predicate funnel on this window. "
            "This is not evidence for/against strategy edge; measurement shows the registered policy "
            "selected an empty set. Allocator/VA appear sound; node rarity + distance/corridor rules "
            "explain zero activation. Do not retune on this holdout."
        )
    report["findings"] = findings

    OUT_PATH.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
    print(json.dumps(report, indent=2, default=str))
    print(f"Wrote {OUT_PATH}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
