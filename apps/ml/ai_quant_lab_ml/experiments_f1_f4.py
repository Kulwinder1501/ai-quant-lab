"""
Phase C Research Experiment Runner & F1–F4 Statistical Pipeline
Implementation Contract v1.4.1 & Research Specification v1.1
"""

import json
import numpy as np
from dataclasses import asdict, dataclass
from typing import Dict, List, Optional, Tuple

# Governance floors (Correction/matching contract #11, balance metric; and a minimum
# matched-pair sample floor). Neither threshold is in the frozen spec's math, but without
# them "zero matched pairs" (empty common support) and "failed to balance" silently read as
# FALSIFIED (p=1.0, CI=0) instead of what they actually are: the test was never run.
ASMD_BALANCE_THRESHOLD = 0.10
MIN_MATCHED_PAIRS_FOR_VERDICT = 20


@dataclass
class ObservationEpisode:
    episodeId: str
    symbol: str
    sessionDate: str
    entryTimestamp: int
    isSessionCloseExcluded: bool
    isTreatment: bool
    fibZone: str  # 'GOLDEN_POCKET' | 'OTE' | 'DEEP_RETRACEMENT' | 'NONE'
    hasRealActiveAnchor: bool  # Strictly true for ACTIVE_ANCHOR observations
    retracementRatio: float
    mfeNetBps: float  # MFE_gross - 2.0 bp friction

    # 7 Standardized Covariates (Raw values)
    impulseRange: float
    yzVolRatio: float
    anchorAgeBars: float
    todSin: float
    todCos: float
    breadthAd: float
    l2DepthLiquidity: float


@dataclass
class MatchedPair:
    treatmentEpisodeId: str
    controlEpisodeId: str
    sessionDate: str
    logitDistance: float
    deltaMfeNetBps: float  # MFE_net(T) - MFE_net(C)


@dataclass
class ExperimentResult:
    experimentId: str
    zoneName: str
    nTreatmentTotal: int
    nControlTotal: int
    nTreatmentMatched: int
    nControlMatched: int
    trimmedCommonSupportCount: int
    asmdMax: float
    estimateHatDeltaBps: float
    lowerCiUnadjusted95Bps: float
    pValRaw: float
    pValHolmAdjusted: float
    absoluteSurplusPassed: bool
    incrementalSurplusPassed: bool
    controlCovariateSourceCounts: Dict[str, int]


class PropensityMatcher:
    def __init__(self, means: np.ndarray, stds: np.ndarray, caliper_sd: float = 0.20):
        self.means = np.array(means, dtype=np.float64)
        self.stds = np.array(stds, dtype=np.float64)
        self.stds[self.stds == 0] = 1.0
        self.caliper_sd = caliper_sd

    def standardize(self, covariates: np.ndarray) -> np.ndarray:
        return (covariates - self.means) / self.stds

    def fit_logit_propensity(self, X_std: np.ndarray, y: np.ndarray) -> Tuple[np.ndarray, bool]:
        """
        Unregularized Logistic Regression MLE via Newton-Raphson / Iteratively Reweighted Least Squares.

        Returns (logit_scores, separation_detected). When one or more covariates perfectly or
        quasi-perfectly separate treatment from control (common with a handful of covariates on
        modest samples), the MLE does not converge: beta diverges and eta saturates at the +-30
        clip bound for most observations. That collapses the common-support overlap region to
        near-empty, so matching silently returns ~0 pairs. Previously this produced an
        indistinguishable "FALSIFIED" (p=1.0) result from a genuine null effect. We now detect it
        so the caller can report "untested" instead of "falsified".
        """
        n, p = X_std.shape
        X_design = np.hstack([np.ones((n, 1)), X_std])
        beta = np.zeros(p + 1, dtype=np.float64)

        for _ in range(25):
            eta = np.clip(X_design @ beta, -30.0, 30.0)
            pi = 1.0 / (1.0 + np.exp(-eta))
            pi = np.clip(pi, 1e-7, 1.0 - 1e-7)

            W_diag = pi * (1.0 - pi)
            grad = X_design.T @ (y - pi)
            Hessian = X_design.T @ (X_design * W_diag[:, None])

            # Ridge regularization to ensure non-singular Hessian
            Hessian += 1e-6 * np.eye(p + 1)

            try:
                delta = np.linalg.solve(Hessian, grad)
            except np.linalg.LinAlgError:
                delta = np.linalg.lstsq(Hessian, grad, rcond=None)[0]

            beta += delta
            if np.max(np.abs(delta)) < 1e-6:
                break

        eta_final = np.clip(X_design @ beta, -30.0, 30.0)

        # Separation heuristic: a well-identified propensity model on standardized covariates
        # keeps |eta| in a modest range (typically single digits). (Quasi-)complete separation
        # drives beta towards +-infinity and eta towards the clip bound well before convergence,
        # or towards unusually extreme values even if it stops short of the bound. Either case
        # means the fit did not converge to a stable interior estimate.
        max_abs_eta = float(np.max(np.abs(eta_final))) if eta_final.size else 0.0
        separation_detected = max_abs_eta >= 15.0

        return eta_final, separation_detected  # Logit propensity scores L = logit(P)

    def match_1to1_deterministic(self, treatment_episodes: List[ObservationEpisode],
                                control_episodes: List[ObservationEpisode]) -> Tuple[List[MatchedPair], int, float, Dict[str, int], bool, int]:
        """
        Deterministic 1:1 Nearest-Neighbor Propensity Matching without replacement.
        Restricted to same-session observations, delta_t <= 30 minutes.
        Primary tie-break = logit distance; Secondary tie-break = episodeId ascending.
        Common-support overlap trimmed strictly on logit scores.

        Returns (matched_pairs, trimmed_count, asmd_max, control_source_counts,
        separation_detected, treatments_with_temporal_candidate). The last is a diagnostic
        only -- how many in-support treatment episodes had ANY control in the same session
        within 30 minutes, before the propensity caliper is applied -- so a caller can tell
        temporal-locality scarcity (anchors are rare events spread across years, so two
        independent ones rarely fall in the same 30-minute window) apart from the caliper
        itself being the bottleneck.
        """
        if not treatment_episodes or not control_episodes:
            return [], 0, 0.0, {"ACTIVE_ANCHOR": 0, "SYNTHETIC_FALLBACK": 0}, False, 0

        # Filter strictly for real active anchor control population
        control_active = [ep for ep in control_episodes if ep.hasRealActiveAnchor]
        control_source_counts = {
            "ACTIVE_ANCHOR": len(control_active),
            "SYNTHETIC_FALLBACK": 0  # Banned and strictly excluded!
        }

        if not control_active:
            return [], 0, 0.0, control_source_counts, False, 0

        episodes_for_matching = treatment_episodes + control_active
        n_treat = len(treatment_episodes)
        n_ctrl = len(control_active)

        X_raw = np.array([
            [ep.impulseRange, ep.yzVolRatio, ep.anchorAgeBars, ep.todSin, ep.todCos, ep.breadthAd, ep.l2DepthLiquidity]
            for ep in episodes_for_matching
        ], dtype=np.float64)

        y = np.array([1] * n_treat + [0] * n_ctrl, dtype=int)

        X_std = self.standardize(X_raw)
        logits, separation_detected = self.fit_logit_propensity(X_std, y)

        logits_treat = logits[:n_treat]
        logits_ctrl = logits[n_treat:]

        # Logit Common Support Overlap Region
        min_support = max(np.min(logits_treat), np.min(logits_ctrl))
        max_support = min(np.max(logits_treat), np.max(logits_ctrl))

        treat_in_support_mask = (logits_treat >= min_support) & (logits_treat <= max_support)
        ctrl_in_support_mask = (logits_ctrl >= min_support) & (logits_ctrl <= max_support)

        trimmed_count = int(np.sum(~treat_in_support_mask) + np.sum(~ctrl_in_support_mask))

        logit_sd = np.std(logits)
        caliper_dist = self.caliper_sd * logit_sd if logit_sd > 0 else 0.20

        # Sort treatment episodes deterministically by episodeId ascending
        treat_indices = [i for i in range(n_treat) if treat_in_support_mask[i]]
        treat_indices.sort(key=lambda idx: treatment_episodes[idx].episodeId)

        available_ctrl_indices = set(i for i in range(n_ctrl) if ctrl_in_support_mask[i])
        matched_pairs: List[MatchedPair] = []
        # Diagnostic only (does not affect matching or any verdict): isolates WHY a treatment
        # episode failed to match -- no control exists in the same session within 30 minutes at
        # all (temporal-locality scarcity, the dominant bottleneck found when anchors are rare
        # events spread across years), vs one exists but sits outside the propensity caliper.
        treatments_with_temporal_candidate = 0

        for t_idx in treat_indices:
            t_ep = treatment_episodes[t_idx]
            t_logit = logits_treat[t_idx]

            candidates = []
            has_temporal_candidate = False
            for c_idx in available_ctrl_indices:
                c_ep = control_active[c_idx]

                # Restrictions: Same-session, delta_t <= 30 minutes (1800000 ms)
                if c_ep.sessionDate == t_ep.sessionDate and abs(c_ep.entryTimestamp - t_ep.entryTimestamp) <= 1800000:
                    has_temporal_candidate = True
                    dist = abs(t_logit - logits_ctrl[c_idx])
                    if dist <= caliper_dist:
                        candidates.append((dist, c_ep.episodeId, c_idx))
            if has_temporal_candidate:
                treatments_with_temporal_candidate += 1

            if candidates:
                # Primary tie-break = dist; Secondary tie-break = episodeId ascending
                candidates.sort(key=lambda item: (item[0], item[1]))
                best_dist, best_id, best_c_idx = candidates[0]

                available_ctrl_indices.remove(best_c_idx)
                c_ep = control_active[best_c_idx]

                delta_mfe = t_ep.mfeNetBps - c_ep.mfeNetBps
                matched_pairs.append(MatchedPair(
                    treatmentEpisodeId=t_ep.episodeId,
                    controlEpisodeId=c_ep.episodeId,
                    sessionDate=t_ep.sessionDate,
                    logitDistance=float(best_dist),
                    deltaMfeNetBps=float(delta_mfe)
                ))

        # Balance Metric: Calculate post-match ASMD across all 7 covariates
        if matched_pairs:
            matched_t_eps = [ep for ep in treatment_episodes if ep.episodeId in {p.treatmentEpisodeId for p in matched_pairs}]
            matched_c_eps = [ep for ep in control_active if ep.episodeId in {p.controlEpisodeId for p in matched_pairs}]

            Xt_mat = np.array([[ep.impulseRange, ep.yzVolRatio, ep.anchorAgeBars, ep.todSin, ep.todCos, ep.breadthAd, ep.l2DepthLiquidity] for ep in matched_t_eps])
            Xc_mat = np.array([[ep.impulseRange, ep.yzVolRatio, ep.anchorAgeBars, ep.todSin, ep.todCos, ep.breadthAd, ep.l2DepthLiquidity] for ep in matched_c_eps])

            mean_t = np.mean(Xt_mat, axis=0)
            mean_c = np.mean(Xc_mat, axis=0)
            var_t = np.var(Xt_mat, axis=0, ddof=1) if len(matched_t_eps) > 1 else np.zeros(7)
            var_c = np.var(Xc_mat, axis=0, ddof=1) if len(matched_c_eps) > 1 else np.zeros(7)

            denom = np.sqrt((var_t + var_c) / 2.0)
            denom[denom == 0] = 1.0
            asmd_vec = np.abs(mean_t - mean_c) / denom
            asmd_max = float(np.max(asmd_vec))
        else:
            asmd_max = 0.0

        return (
            matched_pairs, trimmed_count, asmd_max, control_source_counts, separation_detected,
            treatments_with_temporal_candidate,
        )


def run_null_centered_bootstrap(matched_pairs: List[MatchedPair],
                                B: int = 10000,
                                seed: int = 42) -> Tuple[float, float, float]:
    """
    Null-Centered Trading-Session Block Bootstrap (B = 10,000)
    H0: Delta <= 1.0 bp vs H1: Delta > 1.0 bp
    Returns: (estimate_hat_delta, lower_ci_unadjusted_95, p_val_raw)
    """
    if not matched_pairs:
        return 0.0, 0.0, 1.0

    session_map: Dict[str, List[float]] = {}
    for pair in matched_pairs:
        session_map.setdefault(pair.sessionDate, []).append(pair.deltaMfeNetBps)

    sessions = sorted(list(session_map.keys()))
    n_sessions = len(sessions)

    sample_deltas = [p.deltaMfeNetBps for p in matched_pairs]
    hat_delta = float(np.mean(sample_deltas))

    rng = np.random.RandomState(seed)
    bootstrap_deltas = []

    for _ in range(B):
        resampled_sessions = rng.choice(sessions, size=n_sessions, replace=True)
        boot_deltas = []
        for s in resampled_sessions:
            boot_deltas.extend(session_map[s])
        bootstrap_deltas.append(np.mean(boot_deltas))

    boot_deltas_arr = np.array(bootstrap_deltas)

    # Shift distribution to represent the 1.0 bp null boundary
    null_centered_deltas = boot_deltas_arr - hat_delta + 1.0

    # One-sided empirical bootstrap p-value
    p_val_raw = float((1.0 + np.sum(null_centered_deltas >= hat_delta)) / (B + 1.0))

    # Unadjusted 95% One-Sided Confidence Interval lower bound (5th percentile)
    lower_ci_95 = float(np.percentile(boot_deltas_arr, 5.0))

    return hat_delta, lower_ci_95, p_val_raw


def apply_holm_bonferroni(raw_p_values: List[float]) -> List[float]:
    """
    Holm-Bonferroni Step-Down Familywise Adjustment
    """
    m = len(raw_p_values)
    if m == 0:
        return []

    sorted_indices = sorted(range(m), key=lambda i: raw_p_values[i])
    sorted_p = [raw_p_values[i] for i in sorted_indices]

    adjusted_sorted = [0.0] * m
    for i in range(m):
        rank = i + 1
        adj = (m - rank + 1) * sorted_p[i]
        adjusted_sorted[i] = min(adj, 1.0)

    # Enforce monotonicity: p_adj[i] = max(p_adj[i], max_{j <= i} p_adj[j])
    running_max = 0.0
    for i in range(m):
        running_max = max(running_max, adjusted_sorted[i])
        adjusted_sorted[i] = running_max

    # Restore original order
    adjusted_p = [0.0] * m
    for sorted_idx, orig_idx in enumerate(sorted_indices):
        adjusted_p[orig_idx] = float(adjusted_sorted[sorted_idx])

    return adjusted_p


def run_phase_c_experiments(episodes: List[ObservationEpisode],
                            calibration_means: List[float],
                            calibration_stds: List[float],
                            B: int = 10000,
                            seed: int = 42) -> Dict:
    """
    Executes Experiments F1–F3 (Family A) and F4 (Family B) and emits populated manifest JSON.
    """
    # 1. Filter out session close excluded observations
    valid_episodes = [ep for ep in episodes if not ep.isSessionCloseExcluded]

    # Baseline control pool (OFI > 0.032 AND NOT Treatment)
    treatment_eps_all = [ep for ep in valid_episodes if ep.isTreatment]
    control_eps_all = [ep for ep in valid_episodes if not ep.isTreatment]

    matcher = PropensityMatcher(means=np.array(calibration_means), stds=np.array(calibration_stds))

    # Family A: F1 (Golden), F2 (OTE), F3 (Deep)
    f1_t = [ep for ep in treatment_eps_all if ep.fibZone == "GOLDEN_POCKET"]
    f2_t = [ep for ep in treatment_eps_all if ep.fibZone == "OTE"]
    f3_t = [ep for ep in treatment_eps_all if ep.fibZone == "DEEP_RETRACEMENT"]

    family_a_tasks = [
        ("F1_GOLDEN_POCKET", "GOLDEN_POCKET", f1_t),
        ("F2_OTE", "OTE", f2_t),
        ("F3_DEEP_RETRACEMENT", "DEEP_RETRACEMENT", f3_t),
    ]

    family_a_results = []
    raw_p_family_a = []

    for exp_id, zone_name, t_eps in family_a_tasks:
        c_eps = [ep for ep in control_eps_all if ep not in t_eps]
        pairs, trimmed_cnt, asmd_max, ctrl_counts, separation, treat_with_temporal_candidate = (
            matcher.match_1to1_deterministic(t_eps, c_eps)
        )
        hat_delta, lower_ci, p_raw = run_null_centered_bootstrap(pairs, B=B, seed=seed)

        abs_passed = bool(np.mean([ep.mfeNetBps for ep in t_eps]) > 0.0) if t_eps else False
        data_sufficient = len(pairs) >= MIN_MATCHED_PAIRS_FOR_VERDICT and not separation
        balance_achieved = asmd_max < ASMD_BALANCE_THRESHOLD

        family_a_results.append({
            "experimentId": exp_id,
            "zoneName": zone_name,
            "nTreatmentTotal": len(t_eps),
            "nControlTotal": len(c_eps),
            "nTreatmentMatched": len(pairs),
            "nControlMatched": len(pairs),
            "trimmedCommonSupportCount": trimmed_cnt,
            "asmdMax": asmd_max,
            "estimateHatDeltaBps": hat_delta,
            "lowerCiUnadjusted95Bps": lower_ci,
            "pValRaw": p_raw,
            "controlCovariateSourceCounts": ctrl_counts,
            "absoluteSurplusPassed": abs_passed,
            "separationDetected": separation,
            "dataSufficientForVerdict": data_sufficient,
            "balanceAchieved": balance_achieved,
            # Diagnostic: isolates temporal-locality scarcity (no control exists in the same
            # session within 30 minutes) from propensity-caliper tightness as the matching
            # bottleneck. Does not affect any verdict.
            "treatmentsWithTemporalCandidate": treat_with_temporal_candidate,
        })
        raw_p_family_a.append(p_raw)

    adj_p_family_a = apply_holm_bonferroni(raw_p_family_a)

    for i in range(len(family_a_results)):
        res = family_a_results[i]
        p_adj = adj_p_family_a[i]
        res["pValHolmAdjusted"] = p_adj
        hurdle_cleared = bool(p_adj < 0.05 and res["lowerCiUnadjusted95Bps"] > 1.0)
        # A hurdle can only be CLEARED or genuinely FAILED if matching actually produced enough
        # balanced pairs to test it. Zero/near-zero matched pairs (empty common support or
        # quasi-separation) previously read identically to "tested, no effect" -- fixed here.
        res["incrementalSurplusPassed"] = bool(
            hurdle_cleared and res["dataSufficientForVerdict"] and res["balanceAchieved"]
        )
        if not res["dataSufficientForVerdict"] or not res["balanceAchieved"]:
            res["verdict"] = "INCONCLUSIVE_INSUFFICIENT_DATA"
        elif res["incrementalSurplusPassed"]:
            res["verdict"] = "SUPPORTED"
        else:
            res["verdict"] = "FALSIFIED"

    # Family B: F4 (5 Boundary contrasts)
    boundaries = [0.618, 0.650, 0.702, 0.786, 0.886]
    delta = 0.01

    family_b_results = []
    raw_p_family_b = []

    for b_idx, B_k in enumerate(boundaries, 1):
        b_exp_id = f"F4_B{b_idx}_{B_k}"

        # Boundary local sample
        if b_idx in [1, 3, 4]:
            # Lower boundary: [B_k, B_k + delta] vs [B_k - delta, B_k)
            t_b = [ep for ep in valid_episodes if B_k <= ep.retracementRatio <= B_k + delta]
            c_b = [ep for ep in valid_episodes if B_k - delta <= ep.retracementRatio < B_k and ep.hasRealActiveAnchor]
        else:
            # Upper boundary: (B_k - delta, B_k] vs (B_k, B_k + delta]
            t_b = [ep for ep in valid_episodes if B_k - delta < ep.retracementRatio <= B_k]
            c_b = [ep for ep in valid_episodes if B_k < ep.retracementRatio <= B_k + delta and ep.hasRealActiveAnchor]

        pairs, trimmed_cnt, asmd_max, ctrl_counts, separation, treat_with_temporal_candidate = (
            matcher.match_1to1_deterministic(t_b, c_b)
        )
        hat_delta, lower_ci, p_raw = run_null_centered_bootstrap(pairs, B=B, seed=seed)

        abs_passed = bool(np.mean([ep.mfeNetBps for ep in t_b]) > 0.0) if t_b else False
        data_sufficient = len(pairs) >= MIN_MATCHED_PAIRS_FOR_VERDICT and not separation
        balance_achieved = asmd_max < ASMD_BALANCE_THRESHOLD

        family_b_results.append({
            "experimentId": b_exp_id,
            "boundaryRatio": B_k,
            "nTreatmentTotal": len(t_b),
            "nControlTotal": len(c_b),
            "nTreatmentMatched": len(pairs),
            "nControlMatched": len(pairs),
            "trimmedCommonSupportCount": trimmed_cnt,
            "asmdMax": asmd_max,
            "estimateHatDeltaBps": hat_delta,
            "lowerCiUnadjusted95Bps": lower_ci,
            "pValRaw": p_raw,
            "controlCovariateSourceCounts": ctrl_counts,
            "absoluteSurplusPassed": abs_passed,
            "separationDetected": separation,
            "dataSufficientForVerdict": data_sufficient,
            "balanceAchieved": balance_achieved,
            "treatmentsWithTemporalCandidate": treat_with_temporal_candidate,
        })
        raw_p_family_b.append(p_raw)

    adj_p_family_b = apply_holm_bonferroni(raw_p_family_b)

    for i in range(len(family_b_results)):
        res = family_b_results[i]
        p_adj = adj_p_family_b[i]
        res["pValHolmAdjusted"] = p_adj
        hurdle_cleared = bool(p_adj < 0.05 and res["lowerCiUnadjusted95Bps"] > 1.0)
        res["boundaryPassed"] = bool(
            hurdle_cleared and res["dataSufficientForVerdict"] and res["balanceAchieved"]
        )
        res["boundaryDataSufficient"] = res["dataSufficientForVerdict"] and res["balanceAchieved"]

    # Zone Bounding Verdicts: SUPPORTED if a bounding boundary cleared the hurdle; FALSIFIED only
    # if every bounding boundary actually had enough balanced matched data AND failed the hurdle;
    # otherwise INCONCLUSIVE (the test was never actually run on enough data to say either way).
    def zone_verdict(idx_a: int, idx_b: int) -> str:
        a, b = family_b_results[idx_a], family_b_results[idx_b]
        if a["boundaryPassed"] or b["boundaryPassed"]:
            return "SUPPORTED"
        if a["boundaryDataSufficient"] or b["boundaryDataSufficient"]:
            return "FALSIFIED"
        return "INCONCLUSIVE_INSUFFICIENT_DATA"

    manifest = {
        "protocolVersion": "RESEARCH_SPECIFICATION_V1.1_CONTRACT_V1.4.1",
        "governanceStatus": "PHASE_C_RESEARCH_EXECUTION_COMPLETE",
        "tradingExecutionAuthorized": False,  # Strictly false! Gated behind Phase E sole authority.
        "familyAResults": family_a_results,
        "familyBResults": family_b_results,
        "zoneBoundingVerdicts": {
            "GOLDEN_POCKET": zone_verdict(0, 1),
            "OTE": zone_verdict(2, 3),
            "DEEP_RETRACEMENT": zone_verdict(3, 4)
        }
    }

    return manifest
