"""
Tests for GEX Standalone and Conditioned Interaction Statistical Plumbing & Synthetic Validation
Implementation Contract v1.4.1 & Pre-Registration PREREG-2026-10-20-GEX-FIB-INTERACTION-V1
"""

import pytest
from ai_quant_lab_ml.gex_experiment import (
    run_synthetic_gex_validation,
    evaluate_gex_standalone_bars,
)


def test_synthetic_gex_validation_all_gates():
    """Verify that all four synthetic validation gates pass:
    Gate A: Injected effect -> SUPPORTED
    Gate B: Known null -> Not SUPPORTED (FALSIFIED / null)
    Gate C: Sample floor binding (12 pairs: 9 vs 3) -> INCONCLUSIVE_INSUFFICIENT_DATA
    Gate D: Market drift confound (+15 bps short vs -5 bps long for both cohorts, zero interaction) -> Not SUPPORTED (FALSIFIED)
    """
    results = run_synthetic_gex_validation()
    assert results["allGatesPassed"] is True
    assert results["gateA_injectedEffect"]["passed"] is True
    assert results["gateA_injectedEffect"]["verdict"] == "SUPPORTED"
    assert results["gateB_knownNull"]["passed"] is True
    assert results["gateB_knownNull"]["verdict"] in ("FALSIFIED", "NULL_NO_EDGE")
    assert results["gateC_sampleFloorBinding"]["passed"] is True
    assert results["gateC_sampleFloorBinding"]["verdict"] == "INCONCLUSIVE_INSUFFICIENT_DATA"
    assert results["gateD_marketDriftConfound"]["passed"] is True
    assert results["gateD_marketDriftConfound"]["verdict"] in ("FALSIFIED", "NULL_NO_EDGE")


def test_gex_standalone_evaluator_catches_consecutive_overlap():
    """Verify standalone evaluator computes session bootstrap and flags overlapping windows."""
    import numpy as np

    # Synthetic bars over 10 sessions with 20 bars each
    bars = []
    rng = np.random.RandomState(42)
    for s in range(10):
        session_str = f"2026-10-{s+1:02d}"
        for b in range(20):
            gex = float(rng.normal(0, 1e9))
            ret = float(rng.normal(0, 3.0))
            bars.append({
                "sessionDate": session_str,
                "gex": gex,
                "netReturnBps": ret,
            })

    res = evaluate_gex_standalone_bars(bars, B=200, seed=42)
    assert res["status"] == "EVALUATED"
    assert "primaryDecisionBearingTest" in res
    assert "descriptiveConfoundedDiagnostics" in res
    assert "DESCRIPTIVE_ONLY_OVERLAPPING_WINDOW_CONFOUND" in res["descriptiveConfoundedDiagnostics"]["warning"]
