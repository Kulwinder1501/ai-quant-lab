"""
Regression tests (2026-10-10 realignment) for the Phase C research pipeline
(run_phase_c_pipeline.py) and the F1-F4 statistics (experiments_f1_f4.py).

Each test pins down a defect found in the strategy audit so that it cannot silently return.
"""

import math
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

import run_phase_c_pipeline as pipeline
from ai_quant_lab_ml.experiments_f1_f4 import (
    ASMD_BALANCE_THRESHOLD,
    MatchedPair,
    asmd_balance_threshold,
    minimum_detectable_effect_bps,
)


# ------------------------------------------------------------------ credentials


def test_database_url_comes_from_the_environment_only(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    with pytest.raises(RuntimeError):
        pipeline.get_database_url()
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:pw@host/db")
    assert pipeline.get_database_url() == "postgresql://user:pw@host/db"


def test_no_connection_string_with_an_embedded_password_in_the_pipeline_source():
    source = Path(pipeline.__file__).read_text(encoding="utf-8")
    assert not re.search(r"postgres(?:ql)?://[^\s:@/\"']+:[^\s@/\"']+@", source)


# ------------------------------------------------------------------ outcome


def test_net_return_enters_at_the_next_open_not_the_signal_close():
    opens = [100.0, 100.0, 100.0, 100.0, 100.0]
    closes = [150.0, 100.0, 100.0, 101.0, 100.0]   # the signal bar's own close (150) must not matter
    long_bps = pipeline.compute_net_return_bps(opens, closes, idx=0, horizon_bars=3, direction="BULLISH")
    assert long_bps == pytest.approx(100.0 - pipeline.ROUND_TRIP_FRICTION_BPS)
    short_bps = pipeline.compute_net_return_bps(opens, closes, idx=0, horizon_bars=3, direction="BEARISH")
    assert short_bps == pytest.approx(-100.0 - pipeline.ROUND_TRIP_FRICTION_BPS)


def test_net_return_is_not_non_negative_like_an_excursion():
    """A flat path loses exactly the friction; the old MFE outcome could never be negative."""
    flat = [100.0] * 10
    assert pipeline.compute_net_return_bps(flat, flat, 2, 3, "BULLISH") == pytest.approx(-pipeline.ROUND_TRIP_FRICTION_BPS)
    falling = [100.0 - i for i in range(10)]
    assert pipeline.compute_net_return_bps(falling, falling, 2, 3, "BULLISH") < -pipeline.ROUND_TRIP_FRICTION_BPS
    assert pipeline.compute_net_return_bps(falling, falling, 2, 3, "BEARISH") > 0


# ------------------------------------------------------------------ swing helpers


def test_swing_high_width_controls_what_counts_as_a_swing():
    #            0     1     2     3     4     5     6     7
    highs = [10.0, 11.0, 10.5, 12.0, 11.0, 10.0, 9.0, 8.0]
    w1 = pipeline.compute_confirmed_swing_highs(highs, width=1)
    w2 = pipeline.compute_confirmed_swing_highs(highs, width=2)
    # width 1: bar 1 (11) is a swing high, confirmed at bar 2; bar 3 (12) confirmed at bar 4.
    assert w1[2] == (1, 2, 11.0)
    assert w1[4] == (3, 4, 12.0)
    # width 2: bar 1 lacks two bars on its left, so only bar 3 (12, higher than 2 each side) qualifies,
    # and it is confirmed only once its whole right wing has closed: at bar 5.
    assert w2[4] is None
    assert w2[5] == (3, 5, 12.0)


def test_swing_series_is_causal():
    rng = np.random.RandomState(7)
    highs = list(np.cumsum(rng.normal(0, 1, 80)) + 100.0)
    full = pipeline.compute_confirmed_swing_highs(highs, width=2)
    for cut in (20, 40, 60):
        assert pipeline.compute_confirmed_swing_highs(highs[:cut], width=2) == full[:cut]
    lows = list(np.cumsum(rng.normal(0, 1, 80)) + 100.0)
    full_l = pipeline.compute_confirmed_swing_lows(lows, width=2)
    for cut in (20, 40, 60):
        assert pipeline.compute_confirmed_swing_lows(lows[:cut], width=2) == full_l[:cut]


def test_time_of_day_encoding_maps_open_and_close_to_the_same_point():
    open_ist = datetime(2026, 3, 2, 3, 45, tzinfo=timezone.utc)    # 09:15 IST
    close_ist = datetime(2026, 3, 2, 10, 0, tzinfo=timezone.utc)   # 15:30 IST
    mid_ist = datetime(2026, 3, 2, 6, 52, 30, tzinfo=timezone.utc)  # 12:22:30 IST, mid-session
    s0, c0 = pipeline.time_of_day_sin_cos(open_ist)
    s1, c1 = pipeline.time_of_day_sin_cos(close_ist)
    sm, cm = pipeline.time_of_day_sin_cos(mid_ist)
    assert (s0, c0) == pytest.approx((0.0, 1.0), abs=1e-9)
    assert (s1, c1) == pytest.approx((0.0, 1.0), abs=1e-9)
    assert cm == pytest.approx(-1.0, abs=1e-3)  # encoder works in whole minutes


# ------------------------------------------------------------------ control selection


def _rec(anchor_id, idx, is_treat):
    return {"anchor_id": anchor_id, "idx": idx, "is_treat": is_treat}


def test_controls_come_from_before_first_contact_and_do_not_overlap_the_treatment_window():
    horizon = 3
    touched = [_rec(1, i, i >= 25) for i in range(10, 40)]          # first zone contact at idx 25
    untouched = [_rec(2, i, False) for i in range(100, 111)]
    treatments, controls = pipeline.select_episode_records(touched + untouched, horizon)

    assert [t["idx"] for t in treatments] == [25]                      # one treatment per anchor
    anchor1_controls = [c["idx"] for c in controls if c["anchor_id"] == 1]
    assert anchor1_controls and all(i + horizon < 25 for i in anchor1_controls)
    assert not any(c["is_treat"] for c in controls)
    # Controls of one anchor are spaced by at least the horizon (no shared outcome windows).
    for anchor in (1, 2):
        idxs = [c["idx"] for c in controls if c["anchor_id"] == anchor]
        assert all(b - a >= horizon for a, b in zip(idxs, idxs[1:]))
    # An anchor that never reached a zone contributes spaced controls but no treatment.
    assert [c["idx"] for c in controls if c["anchor_id"] == 2] == [100, 103, 106, 109]


def test_controls_are_not_systematically_younger_than_treatments():
    """The earlier design took the first bar of never-touched anchors (age ~0) against treatments at age ~8+."""
    recs = []
    for anchor in range(1, 21):
        base = anchor * 200
        recs += [{**_rec(anchor, base + i, i >= 12), "anchorAgeBars": float(i)} for i in range(0, 30)]
    treatments, controls = pipeline.select_episode_records(recs, horizon_bars=3)
    assert len(treatments) == 20 and len(controls) >= 60
    assert all(t["anchorAgeBars"] == 12 for t in treatments)
    ctrl_ages = [c["anchorAgeBars"] for c in controls]
    assert max(ctrl_ages) < 12 and min(ctrl_ages) == 0
    assert 3 <= np.median(ctrl_ages) <= 8   # same legs, comparable ages -- not all newborn


# ------------------------------------------------------------------ statistics


def test_asmd_balance_threshold_is_sample_size_aware_and_never_looser_than_the_large_sample_rule():
    assert asmd_balance_threshold(0) == ASMD_BALANCE_THRESHOLD
    assert asmd_balance_threshold(10_000) == ASMD_BALANCE_THRESHOLD
    assert asmd_balance_threshold(25) > 0.5          # chance range of a max-of-7 ASMD at ~25 pairs
    thresholds = [asmd_balance_threshold(n) for n in (20, 40, 80, 160, 320)]
    assert all(a > b for a, b in zip(thresholds, thresholds[1:]))
    assert all(t >= ASMD_BALANCE_THRESHOLD for t in thresholds)


def _pairs(n_sessions, per_session, sd, seed=1):
    rng = np.random.RandomState(seed)
    out = []
    for s in range(n_sessions):
        for k in range(per_session):
            out.append(MatchedPair(f"t{s}_{k}", f"c{s}_{k}", f"2026-02-{s + 1:02d}", 0.0, float(rng.normal(0.0, sd))))
    return out


def test_minimum_detectable_effect_shrinks_with_more_sessions_and_grows_with_noise():
    small = minimum_detectable_effect_bps(_pairs(10, 3, 6.0), B=1000)
    large = minimum_detectable_effect_bps(_pairs(40, 3, 6.0), B=1000)
    noisy = minimum_detectable_effect_bps(_pairs(10, 3, 12.0), B=1000)
    assert small > large > 0
    assert noisy > small
    assert minimum_detectable_effect_bps(_pairs(1, 5, 6.0)) is None  # a single session has no variance estimate


def test_synthetic_validation_distinguishes_a_known_effect_from_a_known_null():
    effect = pipeline.run_synthetic_validation(effect_bps=4.0, B=500)
    null = pipeline.run_synthetic_validation(effect_bps=0.0, B=500)

    for manifest in (effect, null):
        checks = manifest["plumbingChecks"]
        assert checks["everyZoneReachedAVerdict"]
        assert checks["everyZoneHadMinimumMatchedPairs"]
        assert checks["f4CellsWithMinimumMatchedPairs"] >= 3
        for r in manifest["familyAResults"]:
            assert r["minDetectableEffectBps"] is not None
            assert r["asmdBalanceThreshold"] >= ASMD_BALANCE_THRESHOLD

    assert [r["verdict"] for r in effect["familyAResults"]] == ["SUPPORTED"] * 3
    assert all(r["verdict"] == "FALSIFIED" for r in null["familyAResults"])


# ------------------------------------------------------------------ whole-path smoke test


def _oscillating_rows(n_days=25, bars_per_day=75, seed=3):
    """Synthetic 5m OHLCV rows (UTC) with swings that form impulses and pullbacks in both directions."""
    rng = np.random.RandomState(seed)
    rows = []
    price = 20000.0
    day0 = datetime(2026, 2, 2, 3, 45, tzinfo=timezone.utc)
    t = 0
    for d in range(n_days):
        start = day0 + timedelta(days=d)
        for b in range(bars_per_day):
            t += 1
            target = 20000.0 + 90.0 * math.sin(2.0 * math.pi * t / 47.0) + 40.0 * math.sin(2.0 * math.pi * t / 19.0)
            o = price
            c = target + rng.normal(0.0, 4.0)
            h = max(o, c) + abs(rng.normal(0.0, 3.0))
            l = min(o, c) - abs(rng.normal(0.0, 3.0))
            rows.append((start + timedelta(minutes=5 * b), o, h, l, c, 1000.0))
            price = c
    return rows


def test_both_directions_run_through_the_same_scanner_and_yield_clean_episodes():
    rows = _oscillating_rows()
    bull, bear, diag = pipeline.build_instrument_episodes(rows, "NIFTY50", 5)

    for key, episodes in (("bullish", bull), ("bearish", bear)):
        d = diag[key]
        assert d["poiQualifiedCount"] > 0, f"{key}: the engine never formed a POI on a clearly swinging series"
        assert d["treatmentEpisodes"] > 0 and d["controlEpisodes"] > 0, key
        # No trade tape in this feed: Layer 2 must say "unmeasured", never "measured and failed".
        verdicts = d["zoneContactLayerVerdicts"]
        assert verdicts.get("ORDER_FLOW_UNAVAILABLE", 0) > 0, verdicts
        assert set(verdicts) <= {"ORDER_FLOW_UNAVAILABLE", "TOD_SESSION_BOUNDARY_VETO"}, verdicts
        # Treatments are in a zone, controls are not; one treatment per anchor.
        treatments = [e for e in episodes if e.isTreatment]
        controls = [e for e in episodes if not e.isTreatment]
        assert all(e.fibZone != "NONE" for e in treatments)
        assert all(e.fibZone == "NONE" for e in controls)
        assert len({e.episodeId for e in episodes}) == len(episodes)
        # Controls are drawn from comparable leg ages (not all newborn anchors).
        assert d["medianAnchorAgeBarsControl"] is not None and d["medianAnchorAgeBarsTreatment"] is not None
        assert d["anchorExtendedCount"] >= 0
    # Net returns can be negative: the outcome is a tradeable return, not an excursion.
    assert any(e.netReturnBps < 0 for e in bull + bear)


def test_manifest_carries_the_exploratory_notice():
    """A SUPPORTED label in a committed manifest must never travel without its caveat."""
    assert "NOT A TRADING SIGNAL" in pipeline.EXPLORATORY_NOTICE
    source = Path(pipeline.__file__).read_text(encoding="utf-8")
    assert '"exploratoryNotice": EXPLORATORY_NOTICE' in source
