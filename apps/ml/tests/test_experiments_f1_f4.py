"""
Unit Tests for Phase C Experiments F1–F4 Runner & Statistical Pipeline
Implementation Contract v1.4.1 & Research Specification v1.1
"""

import numpy as np
import pytest
from ai_quant_lab_ml.experiments_f1_f4 import (
    MatchedPair,
    ObservationEpisode,
    PropensityMatcher,
    apply_holm_bonferroni,
    run_null_centered_bootstrap,
    run_phase_c_experiments,
)


def make_episode(ep_id: str, session: str, timestamp: int, is_treat: bool, zone: str,
                 has_anchor: bool, r: float, mfe: float) -> ObservationEpisode:
    return ObservationEpisode(
        episodeId=ep_id,
        symbol="NIFTY",
        sessionDate=session,
        entryTimestamp=timestamp,
        isSessionCloseExcluded=False,
        isTreatment=is_treat,
        fibZone=zone,
        hasRealActiveAnchor=has_anchor,
        retracementRatio=r,
        mfeNetBps=mfe,
        impulseRange=10.0,
        yzVolRatio=1.2,
        anchorAgeBars=5.0,
        todSin=0.1,
        todCos=0.2,
        breadthAd=0.5,
        l2DepthLiquidity=500.0
    )


def test_propensity_matcher_real_active_anchor_restriction():
    means = [10.0, 1.2, 5.0, 0.1, 0.2, 0.5, 500.0]
    stds = [2.0, 0.3, 2.0, 0.5, 0.5, 0.2, 100.0]
    matcher = PropensityMatcher(means=means, stds=stds, caliper_sd=0.20)

    t_eps = [make_episode(f"T_{i}", "2026-10-05", 1000000 + i * 1000, True, "GOLDEN_POCKET", True, 0.62, 5.0) for i in range(5)]

    # Mix of active anchor controls and synthetic/no-anchor controls
    c_active = [make_episode(f"C_act_{i}", "2026-10-05", 1000000 + i * 1000 + 500, False, "NONE", True, 0.50, 2.0) for i in range(5)]
    c_no_anchor = [make_episode(f"C_noact_{i}", "2026-10-05", 1000000 + i * 1000 + 600, False, "NONE", False, 0.50, 2.0) for i in range(5)]

    all_controls = c_active + c_no_anchor
    pairs, trimmed, asmd, counts = matcher.match_1to1_deterministic(t_eps, all_controls)

    # Verify synthetic/no-anchor observations were strictly excluded
    assert counts["ACTIVE_ANCHOR"] == 5
    assert counts["SYNTHETIC_FALLBACK"] == 0
    assert len(pairs) <= 5
    # All matched control episode IDs must belong to c_active
    active_ids = {ep.episodeId for ep in c_active}
    for p in pairs:
        assert p.controlEpisodeId in active_ids


def test_deterministic_matching_tie_break():
    means = [10.0, 1.2, 5.0, 0.1, 0.2, 0.5, 500.0]
    stds = [2.0, 0.3, 2.0, 0.5, 0.5, 0.2, 100.0]
    matcher = PropensityMatcher(means=means, stds=stds, caliper_sd=1.0)

    t_ep = make_episode("T_1", "2026-10-05", 1000000, True, "GOLDEN_POCKET", True, 0.62, 5.0)

    # 2 Identical control episodes (same distance) but different episode IDs ("C_B" vs "C_A")
    c1 = make_episode("C_B", "2026-10-05", 1000100, False, "NONE", True, 0.50, 2.0)
    c2 = make_episode("C_A", "2026-10-05", 1000100, False, "NONE", True, 0.50, 2.0)

    pairs, trimmed, asmd, counts = matcher.match_1to1_deterministic([t_ep], [c1, c2])

    assert len(pairs) == 1
    # Secondary tie-break = episodeId ascending -> "C_A" must be selected over "C_B"
    assert pairs[0].controlEpisodeId == "C_A"


def test_null_centered_bootstrap_math():
    pairs = [
        MatchedPair(f"T_{i}", f"C_{i}", f"2026-10-0{1 + (i % 3)}", 0.01, 3.0)
        for i in range(30)
    ]

    hat_delta, lower_ci, p_raw = run_null_centered_bootstrap(pairs, B=1000, seed=42)

    assert hat_delta == pytest.approx(3.0)
    assert lower_ci <= hat_delta
    # Since observed mean difference (3.0 bp) is strictly greater than 1.0 bp null boundary, p_raw should be < 0.05
    assert p_raw < 0.05


def test_apply_holm_bonferroni():
    raw_p = [0.01, 0.04, 0.03]  # Sorted: 0.01 (rank 1), 0.03 (rank 2), 0.04 (rank 3)
    # m = 3
    # Rank 1 (0.01): 3 * 0.01 = 0.03
    # Rank 2 (0.03): 2 * 0.03 = 0.06 -> max(0.03, 0.06) = 0.06
    # Rank 3 (0.04): 1 * 0.04 = 0.04 -> max(0.06, 0.04) = 0.06
    adj_p = apply_holm_bonferroni(raw_p)

    assert adj_p[0] == pytest.approx(0.03)  # for 0.01
    assert adj_p[2] == pytest.approx(0.06)  # for 0.03
    assert adj_p[1] == pytest.approx(0.06)  # for 0.04


def test_run_phase_c_experiments_full_manifest():
    episodes = []
    # Create 30 sessions of synthetic data
    for s in range(1, 31):
        session_str = f"2026-10-{s:02d}"
        t_base = 10000000 + s * 86400000

        # Golden pocket treatment (mfe = 5.0)
        episodes.append(make_episode(f"T_GP_{s}", session_str, t_base + 1000, True, "GOLDEN_POCKET", True, 0.62, 5.0))
        # OTE treatment (mfe = 4.0)
        episodes.append(make_episode(f"T_OTE_{s}", session_str, t_base + 2000, True, "OTE", True, 0.75, 4.0))
        # Deep treatment (mfe = 3.5)
        episodes.append(make_episode(f"T_DEEP_{s}", session_str, t_base + 3000, True, "DEEP_RETRACEMENT", True, 0.82, 3.5))

        # Real active anchor controls (mfe = 1.0)
        episodes.append(make_episode(f"C_ACT_{s}_1", session_str, t_base + 1100, False, "NONE", True, 0.50, 1.0))
        episodes.append(make_episode(f"C_ACT_{s}_2", session_str, t_base + 2100, False, "NONE", True, 0.50, 1.0))
        episodes.append(make_episode(f"C_ACT_{s}_3", session_str, t_base + 3100, False, "NONE", True, 0.50, 1.0))

    means = [10.0, 1.2, 5.0, 0.1, 0.2, 0.5, 500.0]
    stds = [2.0, 0.3, 2.0, 0.5, 0.5, 0.2, 100.0]

    manifest = run_phase_c_experiments(episodes, means, stds, B=100, seed=42)

    assert manifest["protocolVersion"] == "RESEARCH_SPECIFICATION_V1.1_CONTRACT_V1.4.1"
    assert manifest["tradingExecutionAuthorized"] is False  # Sole authority behind Phase E!
    assert len(manifest["familyAResults"]) == 3
    assert len(manifest["familyBResults"]) == 5
    assert "zoneBoundingVerdicts" in manifest
