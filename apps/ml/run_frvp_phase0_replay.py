"""FRVP-MSP Phase 0 confirmatory replay (signal-only).

1. Requires DATA_GATE_PASS.
2. Loads the unchanged baseline export.
3. Attaches prior-session estimated FRVP + LVN_AHEAD (causal).
4. Runs frozen PROFILE_POLICY_LVN_AHEAD_v1 vs baseline on locked OOS.

Research-only. No production wiring.
Normative: docs/2026-10-12-frvp-momentum-scalp-phase0-preregistration.md
"""

from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg

from ai_quant_lab_ml.estimated_fixed_range_volume_profile import (
    OhlcvBar,
    build_estimated_session_profile,
    classify_profile_events_at_decision,
    map_futures_level_to_index,
    profile_policy_lvn_ahead_v1,
)
from run_frvp_phase0_data_gate import EXPERIMENT_ID, audit

IST = ZoneInfo("Asia/Kolkata")
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
BASELINE_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-baseline-candidates.jsonl"
MANIFEST_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-baseline-manifest.json"
ATTACHED_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-candidates-attached.jsonl"
RESULT_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-replay-result.json"
SPLIT_PATH = REPO_ROOT / "logs" / "frvp-msp-phase0-chronological-splits.json"

POLICY_NAME = "PROFILE_POLICY_LVN_AHEAD_v1"
UNDERLYING_TO_INDEX = {"NIFTY50": "NIFTY50", "BANKNIFTY": "BANKNIFTY"}
INDEX_TO_UNDERLYING = {"NIFTY50": "NIFTY50", "BANKNIFTY": "BANKNIFTY"}
BASIS_SYNC_TOLERANCE = timedelta(seconds=60)
BOOTSTRAP_REPLICATES = 2000
RNG_SEED = 20261012


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is not set; refusing to fall back to a built-in credential.")
    return url


def _parse_ts(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        ts = value
    else:
        ts = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.astimezone(timezone.utc)


def ist_session_date(ts: datetime) -> date:
    return _parse_ts(ts).astimezone(IST).date()


@dataclass(frozen=True)
class FutContract:
    symbol: str
    underlying: str
    expiry: date
    tick_size: float


@dataclass
class BarSeries:
    bars: list[OhlcvBar]

    def by_session(self) -> dict[date, list[OhlcvBar]]:
        out: dict[date, list[OhlcvBar]] = defaultdict(list)
        for bar in self.bars:
            out[ist_session_date(bar.open_time)].append(bar)
        return dict(out)


def load_baseline() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not MANIFEST_PATH.is_file() or not BASELINE_PATH.is_file():
        raise RuntimeError(
            f"Baseline export missing. Run apps/api export-frvp-phase0-baseline.ts first "
            f"(expected {MANIFEST_PATH.name} and {BASELINE_PATH.name})."
        )
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    rows = [
        json.loads(line)
        for line in BASELINE_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return manifest, rows


def load_market(conn: psycopg.Connection) -> tuple[list[FutContract], dict[str, BarSeries], dict[str, BarSeries]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT symbol, underlying_symbol, expiry_date::text, tick_size::float8
            FROM instruments
            WHERE instrument_type = 'FUTURE'
              AND underlying_symbol IN ('NIFTY50', 'BANKNIFTY')
            ORDER BY symbol
            """
        )
        contracts = [
            FutContract(
                symbol=r[0],
                underlying=r[1],
                expiry=date.fromisoformat(r[2]),
                tick_size=float(r[3]),
            )
            for r in cur.fetchall()
            if r[1] and r[2]
        ]

        def load_symbol_bars(symbols: list[str]) -> dict[str, BarSeries]:
            out: dict[str, BarSeries] = {}
            for symbol in symbols:
                cur.execute(
                    """
                    SELECT c.open_time, c.open::float8, c.high::float8, c.low::float8,
                           c.close::float8, c.volume::float8
                    FROM candles c
                    JOIN instruments i ON i.id = c.instrument_id
                    WHERE i.symbol = %s AND c.timeframe = '1m' AND c.is_complete = TRUE
                    ORDER BY c.open_time ASC
                    """,
                    (symbol,),
                )
                bars = [
                    OhlcvBar(
                        open_time=_parse_ts(row[0]),
                        open=float(row[1]),
                        high=float(row[2]),
                        low=float(row[3]),
                        close=float(row[4]),
                        volume=float(row[5]),
                    )
                    for row in cur.fetchall()
                ]
                out[symbol] = BarSeries(bars=bars)
            return out

        fut_symbols = [c.symbol for c in contracts]
        idx_symbols = ["NIFTY50", "BANKNIFTY"]
        return contracts, load_symbol_bars(fut_symbols), load_symbol_bars(idx_symbols)


def session_volume(bars: list[OhlcvBar]) -> float:
    return float(sum(b.volume for b in bars if b.volume > 0))


def prior_completed_session(session: date, available: set[date]) -> date | None:
    earlier = [d for d in available if d < session]
    return max(earlier) if earlier else None


def causal_contract_for_session(
    *,
    session: date,
    underlying: str,
    contracts: list[FutContract],
    fut_sessions: dict[str, dict[date, list[OhlcvBar]]],
    roll_streak: dict[str, int],
) -> tuple[str | None, str]:
    """Return (contract_symbol_or_None, reason).

    Implements the frozen rule using only prior completed session volumes.
    If an eligible listed contract has no bar history at all while another has
    volume, selection is marked untrusted (incomplete master) rather than
    silently preferring the only observed series.
    """
    eligible = [c for c in contracts if c.underlying == underlying and c.expiry >= session]
    if not eligible:
        return None, "NO_ELIGIBLE_CONTRACT"

    prior_dates = {
        sym: prior_completed_session(session, set(fut_sessions.get(sym, {})))
        for sym in {c.symbol for c in eligible}
    }
    # Incomplete master: eligible contract never ingested any bars while peers have history.
    missing_history = [
        c.symbol
        for c in eligible
        if not fut_sessions.get(c.symbol)
        and any(fut_sessions.get(o.symbol) for o in eligible if o.symbol != c.symbol)
    ]
    if missing_history and len(eligible) > 1:
        return None, f"INCOMPLETE_CONTRACT_MASTER:{','.join(sorted(missing_history))}"

    vols: dict[str, float] = {}
    for c in eligible:
        prior = prior_dates.get(c.symbol)
        if prior is None:
            vols[c.symbol] = 0.0
        else:
            vols[c.symbol] = session_volume(fut_sessions.get(c.symbol, {}).get(prior, []))

    # Highest prior-session volume among eligible.
    ranked = sorted(eligible, key=lambda c: (-vols[c.symbol], c.expiry, c.symbol))
    selected = ranked[0].symbol

    # Two-session roll: next expiry exceeds current for two consecutive prior sessions.
    by_expiry = sorted(eligible, key=lambda c: c.expiry)
    cur_idx = next(i for i, c in enumerate(by_expiry) if c.symbol == selected)
    if cur_idx + 1 < len(by_expiry):
        nxt = by_expiry[cur_idx + 1].symbol
        key = f"{underlying}:{selected}->{nxt}"
        if vols[nxt] > vols[selected]:
            roll_streak[key] = roll_streak.get(key, 0) + 1
        else:
            roll_streak[key] = 0
        if roll_streak.get(key, 0) >= 2:
            selected = nxt
            return selected, "ROLLED_TWO_SESSION_VOLUME"
    return selected, "MAX_PRIOR_SESSION_VOLUME"


def last_close_le(bars: list[OhlcvBar], as_of: datetime) -> OhlcvBar | None:
    chosen: OhlcvBar | None = None
    for bar in bars:
        if bar.open_time <= as_of:
            chosen = bar
        else:
            break
    return chosen


def atr14_from_1m(bars: list[OhlcvBar], as_of: datetime) -> float | None:
    window = [b for b in bars if b.open_time <= as_of][-15:]
    if len(window) < 15:
        return None
    trs: list[float] = []
    for i in range(1, len(window)):
        prev = window[i - 1]
        cur = window[i]
        tr = max(cur.high - cur.low, abs(cur.high - prev.close), abs(cur.low - prev.close))
        trs.append(tr)
    if len(trs) < 14:
        return None
    return sum(trs[-14:]) / 14.0


def map_profile_to_index(profile, basis: float):
    from dataclasses import replace

    return replace(
        profile,
        poc=map_futures_level_to_index(profile.poc, basis),
        vah=map_futures_level_to_index(profile.vah, basis),
        val=map_futures_level_to_index(profile.val, basis),
        hvns=tuple(map_futures_level_to_index(x, basis) for x in profile.hvns),
        lvns=tuple(map_futures_level_to_index(x, basis) for x in profile.lvns),
        session_vwap=map_futures_level_to_index(profile.session_vwap, basis),
    )


def attach_features(
    rows: list[dict[str, Any]],
    contracts: list[FutContract],
    fut_bars: dict[str, BarSeries],
    idx_bars: dict[str, BarSeries],
) -> list[dict[str, Any]]:
    fut_sessions = {sym: series.by_session() for sym, series in fut_bars.items()}
    idx_sessions = {sym: series.by_session() for sym, series in idx_bars.items()}
    roll_streak: dict[str, int] = {}
    contract_by_symbol = {c.symbol: c for c in contracts}
    attached: list[dict[str, Any]] = []

    # Precompute profiles keyed by (contract, prior_session).
    profile_cache: dict[tuple[str, date], Any] = {}

    for row in rows:
        decision = _parse_ts(row["decisionTime"])
        session = date.fromisoformat(row["decisionSessionDateIst"])
        underlying = INDEX_TO_UNDERLYING[row["instrumentSymbol"]]
        index_symbol = row["instrumentSymbol"]

        contract_sym, select_reason = causal_contract_for_session(
            session=session,
            underlying=underlying,
            contracts=contracts,
            fut_sessions=fut_sessions,
            roll_streak=roll_streak,
        )

        events: list[str] = []
        attach_status = "OK"
        detail: dict[str, Any] = {
            "causalContract": contract_sym,
            "selectionReason": select_reason,
            "decisionSession": session.isoformat(),
        }

        if contract_sym is None:
            events = ["PROFILE_UNAVAILABLE"]
            attach_status = "PROFILE_UNAVAILABLE"
            detail["unavailableReason"] = select_reason
        else:
            prior = prior_completed_session(session, set(fut_sessions.get(contract_sym, {})))
            if prior is None:
                events = ["PROFILE_UNAVAILABLE"]
                attach_status = "PROFILE_UNAVAILABLE"
                detail["unavailableReason"] = "NO_PRIOR_SESSION"
            else:
                detail["priorSession"] = prior.isoformat()
                # Profile from the active decision-session contract's prior-session bars only
                # (never merge across expiries). Missing prior volume → UNAVAILABLE.
                cache_key = (contract_sym, prior)
                if cache_key not in profile_cache:
                    prior_bars = fut_sessions[contract_sym].get(prior, [])
                    tick = contract_by_symbol[contract_sym].tick_size
                    profile_cache[cache_key] = build_estimated_session_profile(
                        prior_bars,
                        tick_size=tick,
                        contract_symbol=contract_sym,
                    )
                profile = profile_cache[cache_key]
                if profile is None:
                    events = ["PROFILE_UNAVAILABLE"]
                    attach_status = "PROFILE_UNAVAILABLE"
                    detail["unavailableReason"] = "NO_TRADE_PROFILE_UNAVAILABLE"
                else:
                    fut_close = last_close_le(fut_bars[contract_sym].bars, decision)
                    idx_close = last_close_le(idx_bars[index_symbol].bars, decision)
                    if fut_close is None or idx_close is None:
                        events = ["PROFILE_UNAVAILABLE"]
                        attach_status = "PROFILE_UNAVAILABLE"
                        detail["unavailableReason"] = "BASIS_MISSING_CLOSE"
                    elif abs((fut_close.open_time - idx_close.open_time).total_seconds()) > BASIS_SYNC_TOLERANCE.total_seconds():
                        events = ["PROFILE_UNAVAILABLE"]
                        attach_status = "PROFILE_UNAVAILABLE"
                        detail["unavailableReason"] = "BASIS_STALE"
                        detail["futCloseTime"] = fut_close.open_time.isoformat()
                        detail["idxCloseTime"] = idx_close.open_time.isoformat()
                    else:
                        basis = fut_close.close - idx_close.close
                        mapped = map_profile_to_index(profile, basis)
                        atr = row.get("atr14")
                        if atr is None:
                            atr = atr14_from_1m(idx_bars[index_symbol].bars, decision)
                        prior_idx_bars = idx_sessions[index_symbol].get(session, [])
                        prior_idx = [b for b in prior_idx_bars if b.open_time < decision][-3:]
                        if atr is None or atr <= 0:
                            events = ["PROFILE_UNAVAILABLE"]
                            attach_status = "PROFILE_UNAVAILABLE"
                            detail["unavailableReason"] = "ATR_UNAVAILABLE"
                        else:
                            events = list(
                                classify_profile_events_at_decision(
                                    side=row["side"],
                                    entry_price_index=float(row["entryPrice"]),
                                    profile_index=mapped,
                                    atr_1m=float(atr),
                                    prior_bars_index=prior_idx,
                                )
                            )
                            detail.update(
                                {
                                    "basis": basis,
                                    "pocIndex": mapped.poc,
                                    "vahIndex": mapped.vah,
                                    "valIndex": mapped.val,
                                    "lvnCount": len(mapped.lvns),
                                    "hvnCount": len(mapped.hvns),
                                    "estimationLabel": mapped.estimation_label,
                                    "profileTotalVolume": mapped.total_volume,
                                }
                            )

        policy_take = profile_policy_lvn_ahead_v1(events)
        out = dict(row)
        out["frvp"] = {
            "attachStatus": attach_status,
            "events": events,
            "policyLvnAheadV1": policy_take,
            "detail": detail,
        }
        attached.append(out)
    return attached


def freeze_splits(session_dates: list[date]) -> dict[str, Any]:
    """60/20/20 by complete IST sessions with one-session embargo at boundaries.

    Allocate from the end (locked test first) so short OCT windows still keep a
    non-empty test slice when at least 3 sessions exist.
    """
    unique = sorted(set(session_dates))
    n = len(unique)
    if n == 0:
        payload = {"sessions": [], "development": [], "validation": [], "test": [], "embargo": []}
        SPLIT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return payload

    n_test = max(1, int(round(n * 0.20))) if n >= 3 else 0
    n_val = max(1, int(round(n * 0.20))) if n >= 5 else 0
    # Embargo slots consume sessions between blocks; reserve them up front.
    embargo_budget = (1 if n_test and n > n_test else 0) + (1 if n_val and n > n_test + n_val + 1 else 0)
    while n_test + n_val + embargo_budget > n:
        if n_val > 0:
            n_val -= 1
        elif n_test > 1:
            n_test -= 1
        else:
            break
        embargo_budget = (1 if n_test and n > n_test else 0) + (
            1 if n_val and n > n_test + n_val + 1 else 0
        )

    embargo: list[str] = []
    cursor = n
    test = unique[cursor - n_test : cursor] if n_test else []
    cursor -= n_test
    if n_test and cursor > 0:
        embargo.append(unique[cursor - 1].isoformat())
        cursor -= 1
    val = unique[cursor - n_val : cursor] if n_val and cursor >= n_val else []
    cursor -= len(val)
    if n_val and cursor > 0 and len(val) == n_val:
        embargo.append(unique[cursor - 1].isoformat())
        cursor -= 1
    embargo.reverse()
    dev = unique[:cursor]

    payload = {
        "frozenAt": datetime.now(timezone.utc).isoformat(),
        "method": "60/20/20 complete IST sessions with one-session embargo at each split boundary",
        "sessions": [d.isoformat() for d in unique],
        "development": [d.isoformat() for d in dev],
        "validation": [d.isoformat() for d in val],
        "test": [d.isoformat() for d in test],
        "embargo": embargo,
        "note": "Frozen before locked-test outcome inspection for PROFILE_POLICY_LVN_AHEAD_v1.",
    }
    SPLIT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def apply_one_position(rows: list[dict[str, Any]], *, policy_filter: bool) -> list[dict[str, Any]]:
    """Chronological one-position-per (instrument,timeframe) using expiresAt horizon."""
    ordered = sorted(rows, key=lambda r: (r["decisionTime"], r["instrumentSymbol"], r["timeframe"]))
    busy_until: dict[tuple[str, str], datetime] = {}
    taken: list[dict[str, Any]] = []
    for row in ordered:
        if row["settlement"]["resolverOutcome"] == "UNSETTLEABLE":
            continue
        if row["settlement"].get("signalR") is None:
            continue
        if policy_filter and not row["frvp"]["policyLvnAheadV1"]:
            continue
        key = (row["instrumentSymbol"], row["timeframe"])
        decision = _parse_ts(row["decisionTime"])
        if key in busy_until and decision < busy_until[key]:
            continue
        expires = _parse_ts(row["expiresAt"])
        # If resolved earlier, free the slot at resolution — approximate with expiresAt
        # for baseline parity (signal-only; same rule both arms).
        bars = row["settlement"].get("barsToResolution")
        if isinstance(bars, int) and bars > 0:
            # timeframe minutes
            tf = row["timeframe"]
            minutes = int(tf[:-1]) if tf.endswith("m") else 5
            free_at = decision + timedelta(minutes=minutes * bars)
        else:
            free_at = expires
        busy_until[key] = free_at
        taken.append(row)
    return taken


def mean_r(rows: list[dict[str, Any]]) -> float | None:
    vals = [float(r["settlement"]["signalR"]) for r in rows if r["settlement"].get("signalR") is not None]
    if not vals:
        return None
    return sum(vals) / len(vals)


def day_clustered_diff_ci(
    baseline: list[dict[str, Any]],
    policy: list[dict[str, Any]],
    *,
    replicates: int = BOOTSTRAP_REPLICATES,
    seed: int = RNG_SEED,
) -> dict[str, Any]:
    """Bootstrap CI for (policy mean R − baseline mean R), resampling IST session days."""
    import random

    rng = random.Random(seed)
    base_by_day: dict[str, list[float]] = defaultdict(list)
    pol_by_day: dict[str, list[float]] = defaultdict(list)
    for r in baseline:
        if r["settlement"].get("signalR") is None:
            continue
        base_by_day[r["decisionSessionDateIst"]].append(float(r["settlement"]["signalR"]))
    for r in policy:
        if r["settlement"].get("signalR") is None:
            continue
        pol_by_day[r["decisionSessionDateIst"]].append(float(r["settlement"]["signalR"]))

    days = sorted(set(base_by_day) | set(pol_by_day))
    if len(days) < 2:
        return {
            "estimable": False,
            "reason": "fewer than 2 session clusters",
            "days": len(days),
        }

    def day_means(selected: list[str]) -> tuple[float | None, float | None]:
        bvals: list[float] = []
        pvals: list[float] = []
        for d in selected:
            bvals.extend(base_by_day.get(d, []))
            pvals.extend(pol_by_day.get(d, []))
        bmean = sum(bvals) / len(bvals) if bvals else None
        pmean = sum(pvals) / len(pvals) if pvals else None
        return bmean, pmean

    obs_b, obs_p = day_means(days)
    if obs_b is None or obs_p is None:
        return {"estimable": False, "reason": "empty arm after clustering", "days": len(days)}
    observed_diff = obs_p - obs_b

    diffs: list[float] = []
    for _ in range(replicates):
        sample = [rng.choice(days) for _ in days]
        bmean, pmean = day_means(sample)
        if bmean is None or pmean is None:
            continue
        diffs.append(pmean - bmean)
    if len(diffs) < max(100, replicates // 5):
        return {
            "estimable": False,
            "reason": "insufficient successful bootstrap replicates",
            "days": len(days),
            "observedDiff": observed_diff,
        }
    diffs.sort()
    lo = diffs[int(0.025 * (len(diffs) - 1))]
    hi = diffs[int(0.975 * (len(diffs) - 1))]
    return {
        "estimable": True,
        "days": len(days),
        "replicates": len(diffs),
        "observedDiff": observed_diff,
        "ci95": [lo, hi],
        "excludesZero": lo > 0 or hi < 0,
        "policyBetterPoint": observed_diff > 0,
    }


def decide(result_body: dict[str, Any]) -> str:
    """PASS / FAIL / INCONCLUSIVE per prereg §8."""
    oos = result_body["lockedOos"]
    n_base = oos["baselineTrades"]
    n_pol = oos["policyTrades"]
    ci = oos["dayClusteredBootstrap"]
    if n_base < 250 or n_pol < 100:
        return "INCONCLUSIVE"
    if not ci.get("estimable"):
        return "INCONCLUSIVE"
    if ci["policyBetterPoint"] and ci["excludesZero"] and ci["observedDiff"] > 0:
        return "PASS"
    if ci["estimable"] and (not ci["policyBetterPoint"] or (ci["excludesZero"] and ci["observedDiff"] < 0)):
        return "FAIL"
    return "INCONCLUSIVE"


def main() -> int:
    gate = audit()
    if gate["decision"] != "DATA_GATE_PASS":
        payload = {
            "experiment_id": EXPERIMENT_ID,
            "status": "REFUSED",
            "reason": "DATA_GATE_FAIL",
            "gate": gate,
        }
        print(json.dumps(payload, indent=2, default=str))
        return 2

    manifest, baseline_rows = load_baseline()
    conn = psycopg.connect(_database_url())
    try:
        with conn.cursor() as cur:
            cur.execute("SET TRANSACTION READ ONLY")
        contracts, fut_bars, idx_bars = load_market(conn)
    finally:
        conn.close()

    attached = attach_features(baseline_rows, contracts, fut_bars, idx_bars)
    ATTACHED_PATH.parent.mkdir(parents=True, exist_ok=True)
    ATTACHED_PATH.write_text(
        "".join(json.dumps(r, default=str) + "\n" for r in attached),
        encoding="utf-8",
    )

    sessions = [date.fromisoformat(r["decisionSessionDateIst"]) for r in attached]
    # Freeze splits BEFORE reading locked-test outcomes for the decision.
    if SPLIT_PATH.is_file():
        splits = json.loads(SPLIT_PATH.read_text(encoding="utf-8"))
    else:
        splits = freeze_splits(sessions)

    test_days = set(splits.get("test", []))
    oos_rows = [r for r in attached if r["decisionSessionDateIst"] in test_days]
    # If the OCT window is too short for a non-empty test slice, use full window as smoke
    # evaluation but force INCONCLUSIVE on sample-size grounds (still report numbers).
    smoke_full_window = False
    if not oos_rows:
        oos_rows = list(attached)
        smoke_full_window = True

    baseline_taken = apply_one_position(oos_rows, policy_filter=False)
    policy_taken = apply_one_position(oos_rows, policy_filter=True)
    ci = day_clustered_diff_ci(baseline_taken, policy_taken)

    unavailable = sum(1 for r in attached if "PROFILE_UNAVAILABLE" in r["frvp"]["events"])
    lvn_ahead = sum(1 for r in attached if "LVN_AHEAD" in r["frvp"]["events"])

    locked = {
        "splitSource": str(SPLIT_PATH.relative_to(REPO_ROOT)).replace("\\", "/"),
        "testSessions": sorted(test_days),
        "smokeFullWindowFallback": smoke_full_window,
        "baselineCandidatesInSlice": len(oos_rows),
        "baselineTrades": len(baseline_taken),
        "policyTrades": len(policy_taken),
        "baselineMeanR": mean_r(baseline_taken),
        "policyMeanR": mean_r(policy_taken),
        "dayClusteredBootstrap": ci,
        "policy": POLICY_NAME,
    }
    body = {
        "experiment_id": EXPERIMENT_ID,
        "status": "EVALUATED",
        "audited_at": datetime.now(timezone.utc).isoformat(),
        "baseline_manifest": {
            "configurationHash": manifest.get("configurationHash"),
            "candidateCount": manifest.get("candidateCount"),
            "evalFrom": manifest.get("evalFrom"),
            "evalTo": manifest.get("evalTo"),
            "candidatesPath": manifest.get("candidatesPath"),
        },
        "attach_summary": {
            "candidates": len(attached),
            "profileUnavailable": unavailable,
            "lvnAhead": lvn_ahead,
            "policyTakesRaw": sum(1 for r in attached if r["frvp"]["policyLvnAheadV1"]),
        },
        "chronological_splits": splits,
        "lockedOos": locked,
        "acceptance_thresholds": {
            "minBaselineOos": 250,
            "minPolicyOos": 100,
            "ci": "95% day-clustered bootstrap on (policyMeanR - baselineMeanR)",
        },
        "notes": [
            "Signal-only index R; friction 0; not Sniper options P&L.",
            "PASS authorizes options-level historical replay only — not production.",
            "Candidates with PROFILE_UNAVAILABLE retained in baseline; excluded from policy by rule.",
        ],
    }
    decision = decide(body)
    if smoke_full_window and decision == "PASS":
        decision = "INCONCLUSIVE"
    body["decision"] = decision
    body["confirmatory_hypothesis_a"] = decision
    body["next_gate"] = (
        "options-level historical replay through Sniper entry + cost stack"
        if decision == "PASS"
        else "no options replay authorization"
    )

    RESULT_PATH.write_text(json.dumps(body, indent=2, default=str), encoding="utf-8")
    print(json.dumps(body, indent=2, default=str))
    print(f"Wrote {RESULT_PATH}", file=sys.stderr)
    return 0 if decision in {"PASS", "FAIL", "INCONCLUSIVE"} else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
