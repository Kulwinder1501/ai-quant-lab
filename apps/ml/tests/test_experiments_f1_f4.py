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
                 has_anchor: bool, r: float, mfe: float, symbol: str = "NIFTY") -> ObservationEpisode:
    return ObservationEpisode(
        episodeId=ep_id,
        symbol=symbol,
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
    pairs, trimmed, asmd, counts, separation, _ = matcher.match_1to1_deterministic(t_eps, all_controls)

    # Verify synthetic/no-anchor observations were strictly excluded
    assert counts["ACTIVE_ANCHOR"] == 5
    assert counts["SYNTHETIC_FALLBACK"] == 0
    assert len(pairs) <= 5
    # All matched control episode IDs must belong to c_active
    active_ids = {ep.episodeId for ep in c_active}
    for p in pairs:
        assert p.controlEpisodeId in active_ids


def test_temporal_candidate_diagnostic_isolates_locality_from_caliper():
    """
    Regression test for the funnel diagnostic added after investigating why real-data F1-F3
    runs reported INCONCLUSIVE_INSUFFICIENT_DATA despite dozens of treatment anchors: the
    dominant bottleneck turned out to be temporal locality (no control in the same session
    within 30 minutes), not raw anchor scarcity or the propensity caliper. This asserts the
    diagnostic actually separates those two causes rather than conflating them.
    """
    means = [10.0, 1.2, 5.0, 0.1, 0.2, 0.5, 500.0]
    stds = [2.0, 0.3, 2.0, 0.5, 0.5, 0.2, 100.0]
    matcher = PropensityMatcher(means=means, stds=stds, caliper_sd=0.20)

    t_eps = [
        make_episode("T_near", "2026-10-05", 1000000, True, "GOLDEN_POCKET", True, 0.62, 5.0),
        make_episode("T_far", "2026-10-06", 1000000, True, "GOLDEN_POCKET", True, 0.62, 5.0),
    ]
    c_eps = [
        # Same session as T_near, within 30 minutes -> a temporal candidate for it.
        make_episode("C_same_day", "2026-10-05", 1000000 + 1000, False, "NONE", True, 0.50, 2.0),
        # A different session entirely -> no temporal candidate for either treatment episode.
        make_episode("C_other_day", "2026-10-09", 1000000, False, "NONE", True, 0.50, 2.0),
    ]

    pairs, trimmed, asmd, counts, separation, treat_with_temporal_candidate = (
        matcher.match_1to1_deterministic(t_eps, c_eps)
    )

    # T_near has a temporal candidate (same session, 1s apart); T_far does not (no same-session
    # control at all) -- exactly one of the two should count, regardless of whether a pair
    # actually formed after the caliper.
    assert treat_with_temporal_candidate == 1


def test_matching_never_crosses_symbols():
    """
    Regression test for the cross-instrument matching bug: callers pool episodes from multiple
    instruments into one treatment/control list (e.g. NIFTY50 + BANKNIFTY in the index-based
    manifest, or BANKNIFTY + BANKNIFTY_FUT in the basis-aligned one). Without a symbol check,
    a treatment anchor on one instrument could be matched to a same-minute control on a
    completely different one just because their standardized covariates happened to land close
    together -- not a valid counterfactual. A same-symbol control that is otherwise identical
    must be preferred even when a different-symbol control is a closer propensity match.
    """
    means = [10.0, 1.2, 5.0, 0.1, 0.2, 0.5, 500.0]
    stds = [2.0, 0.3, 2.0, 0.5, 0.5, 0.2, 100.0]
    matcher = PropensityMatcher(means=means, stds=stds, caliper_sd=1.0)

    t_ep = make_episode("T_1", "2026-10-05", 1000000, True, "GOLDEN_POCKET", True, 0.62, 5.0, symbol="NIFTY50")

    # Same session/time window, but a different instrument -- must be excluded no matter how
    # close its covariates are.
    c_other_symbol = make_episode("C_OTHER_SYMBOL", "2026-10-05", 1000100, False, "NONE", True, 0.50, 2.0, symbol="BANKNIFTY")
    # Same instrument as the treatment, further in covariate space -- this is the only valid
    # candidate and must be the one selected.
    c_same_symbol = make_episode("C_SAME_SYMBOL", "2026-10-05", 1000200, False, "NONE", True, 0.50, 2.0, symbol="NIFTY50")

    pairs, trimmed, asmd, counts, separation, treat_with_temporal_candidate = (
        matcher.match_1to1_deterministic([t_ep], [c_other_symbol, c_same_symbol])
    )

    assert len(pairs) == 1
    assert pairs[0].controlEpisodeId == "C_SAME_SYMBOL"
    # The cross-symbol candidate must not even count as a temporal candidate.
    assert treat_with_temporal_candidate == 1


def test_deterministic_matching_tie_break():
    means = [10.0, 1.2, 5.0, 0.1, 0.2, 0.5, 500.0]
    stds = [2.0, 0.3, 2.0, 0.5, 0.5, 0.2, 100.0]
    matcher = PropensityMatcher(means=means, stds=stds, caliper_sd=1.0)

    t_ep = make_episode("T_1", "2026-10-05", 1000000, True, "GOLDEN_POCKET", True, 0.62, 5.0)

    # 2 Identical control episodes (same distance) but different episode IDs ("C_B" vs "C_A")
    c1 = make_episode("C_B", "2026-10-05", 1000100, False, "NONE", True, 0.50, 2.0)
    c2 = make_episode("C_A", "2026-10-05", 1000100, False, "NONE", True, 0.50, 2.0)

    pairs, trimmed, asmd, counts, separation, _ = matcher.match_1to1_deterministic([t_ep], [c1, c2])

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
    # With real (if modest) matched samples here, the pipeline must actually have run the test
    # rather than silently reporting "no common support" as if it had.
    for res in manifest["familyAResults"]:
        assert res["nTreatmentMatched"] > 0
        assert res["separationDetected"] is False


def test_quasi_separation_reports_inconclusive_not_falsified():
    """
    Regression test for the bug found in run_phase_c_pipeline.py's synthetic benchmark: when a
    covariate (e.g. todSin/breadthAd) takes a distinct constant value per group, the propensity
    logistic regression quasi-perfectly separates treatment from control, eta saturates at the
    clip bound, common support collapses to empty, and matching silently returns zero pairs.
    That must surface as "insufficient data to test" (INCONCLUSIVE), never as "FALSIFIED"
    (p=1.0, CI=0 look identical to a genuine null result otherwise).
    """
    episodes = []
    for s in range(1, 31):
        session_str = f"2026-10-{s:02d}"
        t_base = 10000000 + s * 86400000
        # Treatment group: todSin/breadthAd pinned to one constant...
        episodes.append(ObservationEpisode(
            episodeId=f"T_{s}", symbol="NIFTY", sessionDate=session_str, entryTimestamp=t_base + 1000,
            isSessionCloseExcluded=False, isTreatment=True, fibZone="GOLDEN_POCKET", hasRealActiveAnchor=True,
            retracementRatio=0.62, mfeNetBps=5.0, impulseRange=10.0, yzVolRatio=1.2, anchorAgeBars=5.0,
            todSin=0.10, todCos=0.20, breadthAd=0.30, l2DepthLiquidity=500.0
        ))
        # ...control group pinned to a different constant -> perfect separation on that feature alone.
        episodes.append(ObservationEpisode(
            episodeId=f"C_{s}", symbol="NIFTY", sessionDate=session_str, entryTimestamp=t_base + 1100,
            isSessionCloseExcluded=False, isTreatment=False, fibZone="NONE", hasRealActiveAnchor=True,
            retracementRatio=0.50, mfeNetBps=1.0, impulseRange=10.0, yzVolRatio=1.2, anchorAgeBars=5.0,
            todSin=0.12, todCos=0.22, breadthAd=0.32, l2DepthLiquidity=500.0
        ))

    means = [10.0, 1.2, 5.0, 0.11, 0.21, 0.31, 500.0]
    stds = [2.0, 0.3, 2.0, 0.01, 0.01, 0.01, 100.0]

    manifest = run_phase_c_experiments(episodes, means, stds, B=200, seed=42)

    gp_result = manifest["familyAResults"][0]
    assert gp_result["separationDetected"] is True
    assert gp_result["nTreatmentMatched"] == 0
    assert gp_result["dataSufficientForVerdict"] is False
    assert gp_result["incrementalSurplusPassed"] is False
    assert gp_result["verdict"] == "INCONCLUSIVE_INSUFFICIENT_DATA"
    assert manifest["zoneBoundingVerdicts"]["GOLDEN_POCKET"] == "INCONCLUSIVE_INSUFFICIENT_DATA"
