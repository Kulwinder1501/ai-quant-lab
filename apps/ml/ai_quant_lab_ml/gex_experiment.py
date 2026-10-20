"""
GEX Experiment Module: Standalone & Conditioned Golden Pocket Interaction Tests
Implementation Contract v1.4.1 & Pre-Registration PREREG-2026-10-20-GEX-FIB-INTERACTION-V1
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
import numpy as np
from scipy import stats

from ai_quant_lab_ml.experiments_f1_f4 import (
    MDE_Z_FACTOR,
    MatchedPair,
    ObservationEpisode,
    PropensityMatcher,
)

MIN_MATCHED_PAIRS_PER_GEX_BUCKET = 15


@dataclasses.dataclass(frozen=True)
class GexConditionedResult:
    verdict: str  # 'SUPPORTED' | 'FALSIFIED' | 'INCONCLUSIVE_INSUFFICIENT_DATA'
    nTotalMatchedPairs: int
    nShortGammaMatched: int
    nLongGammaMatched: int
    floorThreshold: int
    floorPassed: bool
    estimateHatDeltaBps: Optional[float]
    lowerCi95Bps: Optional[float]
    upperCi95Bps: Optional[float]
    bootstrapSeBps: Optional[float]
    minDetectableEffectBps: Optional[float]
    pValRaw: Optional[float]
    meanShortGammaBps: Optional[float]
    meanLongGammaBps: Optional[float]
    details: Dict[str, Any]


def session_block_bootstrap_diff_means(
    short_records: List[Tuple[str, float]],  # (sessionDate, netReturnBps)
    long_records: List[Tuple[str, float]],   # (sessionDate, netReturnBps)
    B: int = 2000,
    seed: int = 42,
) -> Tuple[float, float, float, float, float]:
    """
    Session-block bootstrap difference in means: mean(short) - mean(long).
    Resamples whole sessions to preserve intra-session serial correlation.
    Returns: (estimate, lower_ci_95, upper_ci_95, se, p_val_two_sided_vs_zero)
    """
    if not short_records or not long_records:
        return 0.0, 0.0, 0.0, 0.0, 1.0

    mean_short = float(np.mean([r[1] for r in short_records]))
    mean_long = float(np.mean([r[1] for r in long_records]))
    hat_diff = mean_short - mean_long

    # Map sessions
    sessions_short: Dict[str, List[float]] = {}
    for s, val in short_records:
        sessions_short.setdefault(s, []).append(val)

    sessions_long: Dict[str, List[float]] = {}
    for s, val in long_records:
        sessions_long.setdefault(s, []).append(val)

    all_sessions = sorted(set(sessions_short.keys()) | set(sessions_long.keys()))
    if len(all_sessions) < 2:
        return hat_diff, hat_diff, hat_diff, 0.0, 1.0

    rng = np.random.RandomState(seed)
    boot_diffs = []

    for _ in range(B):
        resampled_sessions = rng.choice(all_sessions, size=len(all_sessions), replace=True)
        boot_s = []
        boot_l = []
        for s in resampled_sessions:
            if s in sessions_short:
                boot_s.extend(sessions_short[s])
            if s in sessions_long:
                boot_l.extend(sessions_long[s])
        if boot_s and boot_l:
            boot_diffs.append(np.mean(boot_s) - np.mean(boot_l))

    if not boot_diffs:
        return hat_diff, hat_diff, hat_diff, 0.0, 1.0

    boot_arr = np.array(boot_diffs)
    se = float(np.std(boot_arr, ddof=1))
    lower_ci = float(np.percentile(boot_arr, 2.5))
    upper_ci = float(np.percentile(boot_arr, 97.5))

    # Two-sided empirical p-value for H0: diff == 0
    null_centered = boot_arr - hat_diff
    p_val = float(np.mean(np.abs(null_centered) >= np.abs(hat_diff)))

    return hat_diff, lower_ci, upper_ci, se, p_val


def evaluate_gex_conditioned_golden_pocket(
    matched_pairs: List[MatchedPair],
    treatment_episodes_by_id: Dict[str, ObservationEpisode],
    B: int = 2000,
    seed: int = 42,
    min_floor: int = MIN_MATCHED_PAIRS_PER_GEX_BUCKET,
) -> GexConditionedResult:
    """
    Track 2: Pre-registered Conditioned Golden Pocket interaction test.
    Splits matched treatments by sign(netDealerGammaExposure).
    Enforces the min_floor (15) per bucket. Emits INCONCLUSIVE_INSUFFICIENT_DATA
    if floor is violated.
    """
    short_records: List[Tuple[str, float]] = []
    long_records: List[Tuple[str, float]] = []

    for pair in matched_pairs:
        treat_ep = treatment_episodes_by_id.get(pair.treatmentEpisodeId)
        if treat_ep is None or treat_ep.netDealerGammaExposure is None:
            continue
        gex = treat_ep.netDealerGammaExposure
        if gex < 0:
            short_records.append((pair.sessionDate, treat_ep.netReturnBps))
        elif gex > 0:
            long_records.append((pair.sessionDate, treat_ep.netReturnBps))

    n_short = len(short_records)
    n_long = len(long_records)
    n_total = len(matched_pairs)
    floor_passed = (n_short >= min_floor and n_long >= min_floor)

    if not floor_passed:
        return GexConditionedResult(
            verdict="INCONCLUSIVE_INSUFFICIENT_DATA",
            nTotalMatchedPairs=n_total,
            nShortGammaMatched=n_short,
            nLongGammaMatched=n_long,
            floorThreshold=min_floor,
            floorPassed=False,
            estimateHatDeltaBps=None,
            lowerCi95Bps=None,
            upperCi95Bps=None,
            bootstrapSeBps=None,
            minDetectableEffectBps=None,
            pValRaw=None,
            meanShortGammaBps=float(np.mean([r[1] for r in short_records])) if short_records else None,
            meanLongGammaBps=float(np.mean([r[1] for r in long_records])) if long_records else None,
            details={
                "reason": f"Sample floor violated: n_short={n_short}, n_long={n_long}, required={min_floor}",
                "refusalToEstimate": True,
            },
        )

    mean_s = float(np.mean([r[1] for r in short_records]))
    mean_l = float(np.mean([r[1] for r in long_records]))
    hat_diff, lower_ci, upper_ci, se, p_val = session_block_bootstrap_diff_means(
        short_records, long_records, B=B, seed=seed
    )
    mde = MDE_Z_FACTOR * se

    # Theory-consistent prediction: continuation setup works better in short gamma (diff > 0)
    verdict = "SUPPORTED" if lower_ci > 0.0 else "FALSIFIED"

    return GexConditionedResult(
        verdict=verdict,
        nTotalMatchedPairs=n_total,
        nShortGammaMatched=n_short,
        nLongGammaMatched=n_long,
        floorThreshold=min_floor,
        floorPassed=True,
        estimateHatDeltaBps=hat_diff,
        lowerCi95Bps=lower_ci,
        upperCi95Bps=upper_ci,
        bootstrapSeBps=se,
        minDetectableEffectBps=mde,
        pValRaw=p_val,
        meanShortGammaBps=mean_s,
        meanLongGammaBps=mean_l,
        details={
            "hypothesis": "Short gamma (trending) > Long gamma (pinning) for continuation",
            "oneSidedPass": (lower_ci > 0.0),
        },
    )


def evaluate_gex_standalone_bars(
    bars: List[Dict[str, Any]],  # each has 'sessionDate', 'gex', 'netReturnBps'
    B: int = 2000,
    seed: int = 42,
) -> Dict[str, Any]:
    """
    Track 1: Standalone continuous GEX signal check across all eligible 5m bars.
    Primary test: Session-block bootstrap difference in means (Short Gamma vs Long Gamma).
    Descriptive only: Pearson r, Spearman rho, Welch's t-test (explicitly flagged for overlap).
    """
    valid = [b for b in bars if b.get("gex") is not None and b.get("netReturnBps") is not None]
    if len(valid) < 30:
        return {"status": "INSUFFICIENT_DATA", "nBars": len(valid)}

    gex_vals = np.array([b["gex"] for b in valid], dtype=np.float64)
    returns = np.array([b["netReturnBps"] for b in valid], dtype=np.float64)

    # Descriptive metrics (flagged)
    pearson_r, pearson_p = stats.pearsonr(gex_vals, returns)
    spearman_rho, spearman_p = stats.spearmanr(gex_vals, returns)

    short_bars = [b for b in valid if b["gex"] < 0]
    long_bars = [b for b in valid if b["gex"] > 0]

    short_ret = [b["netReturnBps"] for b in short_bars]
    long_ret = [b["netReturnBps"] for b in long_bars]

    welch_t, welch_p = (
        stats.ttest_ind(short_ret, long_ret, equal_var=False)
        if len(short_ret) > 5 and len(long_ret) > 5
        else (0.0, 1.0)
    )

    # Primary decision-bearing test: Session-block bootstrap
    short_records = [(b["sessionDate"], b["netReturnBps"]) for b in short_bars]
    long_records = [(b["sessionDate"], b["netReturnBps"]) for b in long_bars]

    hat_diff, lower_ci, upper_ci, se, boot_p = session_block_bootstrap_diff_means(
        short_records, long_records, B=B, seed=seed
    )
    mde = MDE_Z_FACTOR * se

    # Accuracy / F1 against trivial baseline (binary sign of return)
    actual_pos = (returns > 0).astype(int)
    baseline_acc = float(max(np.mean(actual_pos), 1.0 - np.mean(actual_pos)))

    # Short gamma prediction: positive continuation (1)
    # Long gamma prediction: negative / reversal (0)
    pred_dir = (gex_vals < 0).astype(int)
    acc = float(np.mean(pred_dir == actual_pos))

    from sklearn.metrics import f1_score
    macro_f1 = float(f1_score(actual_pos, pred_dir, average="macro", zero_division=0))

    primary_verdict = (
        "SIGNIFICANT_EDGE" if (lower_ci > 0.0 or upper_ci < 0.0)
        else "NULL_NO_EDGE"
    )

    return {
        "status": "EVALUATED",
        "nBars": len(valid),
        "nShortGammaBars": len(short_bars),
        "nLongGammaBars": len(long_bars),
        "primaryDecisionBearingTest": {
            "test": "Session-Block Bootstrap Difference in Means (Short Gamma - Long Gamma)",
            "estimateBps": hat_diff,
            "lowerCi95Bps": lower_ci,
            "upperCi95Bps": upper_ci,
            "bootstrapSeBps": se,
            "minDetectableEffectBps": mde,
            "pValTwoSided": boot_p,
            "verdict": primary_verdict,
        },
        "descriptiveConfoundedDiagnostics": {
            "warning": "DESCRIPTIVE_ONLY_OVERLAPPING_WINDOW_CONFOUND: 15m returns over 5m bars share 2/3 bars; standard iid tests overstate significance",
            "pearsonR": float(pearson_r),
            "pearsonP": float(pearson_p),
            "spearmanRho": float(spearman_rho),
            "spearmanP": float(spearman_p),
            "welchT": float(welch_t),
            "welchP": float(welch_p),
            "meanShortGammaReturnBps": float(np.mean(short_ret)) if short_ret else 0.0,
            "meanLongGammaReturnBps": float(np.mean(long_ret)) if long_ret else 0.0,
        },
        "classificationPerformance": {
            "directionalAccuracy": acc,
            "trivialMajorityBaselineAccuracy": baseline_acc,
            "accuracyBeatsBaseline": acc > baseline_acc,
            "macroF1": macro_f1,
        },
    }


def generate_synthetic_gex_interaction_episodes(
    n_sessions: int = 60,
    effect_short_bps: float = 10.0,
    effect_long_bps: float = -2.0,
    seed: int = 42,
    force_thin_pairs: bool = False,
) -> Tuple[List[ObservationEpisode], List[float], List[float]]:
    """
    Generates synthetic episodes for plumbing validation.
    Treatments have assigned GEX signs (short vs long).
    Outcomes are controlled by effect_short_bps and effect_long_bps.
    """
    rng = np.random.RandomState(seed)
    episodes: List[ObservationEpisode] = []

    def covariates():
        return dict(
            impulseRange=float(max(1.0, rng.normal(12.0, 2.5))),
            yzVolRatio=float(max(0.3, rng.normal(1.1, 0.2))),
            anchorAgeBars=float(rng.uniform(2, 15)),
            todSin=float(rng.normal(0.1, 0.5)),
            todCos=float(rng.normal(0.0, 0.5)),
            breadthAd=float(rng.normal(0.2, 0.3)),
            l2DepthLiquidity=float(rng.normal(475.0, 85.0)),
        )

    base_net_bps = -1.0
    outcome_sd = 2.0

    if force_thin_pairs:
        # Generate exactly 12 pairs (9 long, 3 short) across 10 sessions
        for s in range(10):
            session_str = f"2026-10-{s+1:02d}"
            t_base = 1000000 + s * 86400000
            # 1 or 2 treatments per session
            n_treat = 2 if s < 2 else 1
            for i in range(n_treat):
                idx = len([e for e in episodes if e.isTreatment])
                if idx >= 12:
                    break
                is_short = (idx < 3)  # exactly 3 short, 9 long
                gex_val = -1e9 if is_short else 1e9
                effect = effect_short_bps if is_short else effect_long_bps
                episodes.append(ObservationEpisode(
                    episodeId=f"T_{s}_{i}", symbol="NIFTY50", sessionDate=session_str,
                    entryTimestamp=t_base + i * 60_000, isSessionCloseExcluded=False, isTreatment=True,
                    fibZone="GOLDEN_POCKET", hasRealActiveAnchor=True, retracementRatio=0.62,
                    netReturnBps=float(base_net_bps + effect + rng.normal(0, 0.5)),
                    netDealerGammaExposure=gex_val, **covariates()
                ))
            # Plentiful controls
            for c in range(10):
                episodes.append(ObservationEpisode(
                    episodeId=f"C_{s}_{c}", symbol="NIFTY50", sessionDate=session_str,
                    entryTimestamp=t_base + (c + 1) * 60_000, isSessionCloseExcluded=False, isTreatment=False,
                    fibZone="NONE", hasRealActiveAnchor=True, retracementRatio=0.50,
                    netReturnBps=float(base_net_bps + rng.normal(0, 0.5)),
                    netDealerGammaExposure=None, **covariates()
                ))
    else:
        # Well-powered generation: ~60 sessions, 2 treatments per session -> ~120 treatments
        for s in range(n_sessions):
            session_str = f"2026-10-{s+1:02d}"
            t_base = 1000000 + s * 86400000

            # 2 Golden Pocket treatments per session: 1 short gamma, 1 long gamma
            for i, is_short in enumerate([True, False]):
                gex_val = -5e9 if is_short else 5e9
                effect = effect_short_bps if is_short else effect_long_bps
                episodes.append(ObservationEpisode(
                    episodeId=f"T_{s}_{i}", symbol="NIFTY50", sessionDate=session_str,
                    entryTimestamp=t_base + i * 60_000, isSessionCloseExcluded=False, isTreatment=True,
                    fibZone="GOLDEN_POCKET", hasRealActiveAnchor=True, retracementRatio=0.62,
                    netReturnBps=float(rng.normal(base_net_bps + effect, outcome_sd)),
                    netDealerGammaExposure=gex_val, **covariates()
                ))

            # Controls: 10 per session
            for c in range(10):
                episodes.append(ObservationEpisode(
                    episodeId=f"C_{s}_{c}", symbol="NIFTY50", sessionDate=session_str,
                    entryTimestamp=t_base + (c + 2) * 60_000, isSessionCloseExcluded=False, isTreatment=False,
                    fibZone="NONE", hasRealActiveAnchor=True, retracementRatio=0.50,
                    netReturnBps=float(rng.normal(base_net_bps, outcome_sd)),
                    netDealerGammaExposure=None, **covariates()
                ))

    means = [12.0, 1.1, 8.0, 0.1, 0.0, 0.2, 475.0]
    stds = [2.5, 0.2, 3.5, 0.5, 0.5, 0.3, 85.0]
    return episodes, means, stds


def run_synthetic_gex_validation() -> Dict[str, Any]:
    """
    Executes Step 5 synthetic plumbing validation across all 3 pre-registered gates:
    Gate A: Injected interaction (+10 bps short vs -2 bps long) must reach SUPPORTED.
    Gate B: Known null (0 bps short vs 0 bps long) must NOT reach SUPPORTED.
    Gate C: Under-floor sample (12 pairs: 9 vs 3) must strictly emit INCONCLUSIVE_INSUFFICIENT_DATA.
    """
    results = {}

    # Gate A: Injected
    episodes_a, means_a, stds_a = generate_synthetic_gex_interaction_episodes(
        n_sessions=60, effect_short_bps=10.0, effect_long_bps=-2.0, seed=42
    )
    treatments_a = [e for e in episodes_a if e.isTreatment]
    controls_a = [e for e in episodes_a if not e.isTreatment]
    matcher_a = PropensityMatcher(means_a, stds_a)
    pairs_a, _, _, _, _, _ = matcher_a.match_1to1_deterministic(treatments_a, controls_a)
    treat_map_a = {e.episodeId: e for e in treatments_a}
    res_a = evaluate_gex_conditioned_golden_pocket(pairs_a, treat_map_a, B=1000, seed=42)
    results["gateA_injectedEffect"] = {
        "verdict": res_a.verdict,
        "nShort": res_a.nShortGammaMatched,
        "nLong": res_a.nLongGammaMatched,
        "estimateBps": res_a.estimateHatDeltaBps,
        "lowerCi95Bps": res_a.lowerCi95Bps,
        "passed": (res_a.verdict == "SUPPORTED" and res_a.lowerCi95Bps is not None and res_a.lowerCi95Bps > 0.0),
    }

    # Gate B: Known Null
    episodes_b, means_b, stds_b = generate_synthetic_gex_interaction_episodes(
        n_sessions=60, effect_short_bps=0.0, effect_long_bps=0.0, seed=123
    )
    treatments_b = [e for e in episodes_b if e.isTreatment]
    controls_b = [e for e in episodes_b if not e.isTreatment]
    matcher_b = PropensityMatcher(means_b, stds_b)
    pairs_b, _, _, _, _, _ = matcher_b.match_1to1_deterministic(treatments_b, controls_b)
    treat_map_b = {e.episodeId: e for e in treatments_b}
    res_b = evaluate_gex_conditioned_golden_pocket(pairs_b, treat_map_b, B=1000, seed=123)
    results["gateB_knownNull"] = {
        "verdict": res_b.verdict,
        "nShort": res_b.nShortGammaMatched,
        "nLong": res_b.nLongGammaMatched,
        "estimateBps": res_b.estimateHatDeltaBps,
        "lowerCi95Bps": res_b.lowerCi95Bps,
        "passed": (res_b.verdict != "SUPPORTED"),
    }

    # Gate C: Sample Floor Binding
    episodes_c, means_c, stds_c = generate_synthetic_gex_interaction_episodes(
        force_thin_pairs=True, seed=999
    )
    treatments_c = [e for e in episodes_c if e.isTreatment]
    controls_c = [e for e in episodes_c if not e.isTreatment]
    matcher_c = PropensityMatcher(means_c, stds_c)
    pairs_c, _, _, _, _, _ = matcher_c.match_1to1_deterministic(treatments_c, controls_c)
    treat_map_c = {e.episodeId: e for e in treatments_c}
    res_c = evaluate_gex_conditioned_golden_pocket(pairs_c, treat_map_c, B=500, seed=999)
    results["gateC_sampleFloorBinding"] = {
        "verdict": res_c.verdict,
        "nShort": res_c.nShortGammaMatched,
        "nLong": res_c.nLongGammaMatched,
        "floorThreshold": res_c.floorThreshold,
        "passed": (res_c.verdict == "INCONCLUSIVE_INSUFFICIENT_DATA" and res_c.estimateHatDeltaBps is None),
    }

    all_passed = (
        results["gateA_injectedEffect"]["passed"] and
        results["gateB_knownNull"]["passed"] and
        results["gateC_sampleFloorBinding"]["passed"]
    )
    results["allGatesPassed"] = all_passed
    return results
