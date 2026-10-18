"""Gate R4: Parity Unit Tests in Python.
Verifies Python levels engine produces identical levels, counts, and states
on 14 golden fixtures (5 synthetic + 3 real stocks at 3 dates each).
"""

import json
import math
from pathlib import Path
import pytest

from apps.ml.equity_stance_r0.levels import Bar, compute_levels

FIXTURES_FILE = Path(__file__).resolve().parent / "fixtures" / "r0_parity_fixtures.json"


@pytest.fixture(scope="module")
def parity_fixtures():
    with open(FIXTURES_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["fixtures"]


def test_parity_all_14_fixtures(parity_fixtures):
    assert len(parity_fixtures) == 14

    for fixture in parity_fixtures:
        name = fixture["name"]
        bars = [Bar(**b) for b in fixture["bars"]]
        expected = fixture["expected"]

        res = compute_levels(bars)

        # 1. State match
        assert res.state == expected["state"], f"[{name}] state mismatch"

        # 2. As of date match
        assert res.as_of_date == expected["as_of_date"], f"[{name}] as_of_date mismatch"

        # 3. ATR14 match to 1e-9
        if expected["atr14"] is not None:
            assert res.atr14 is not None, f"[{name}] expected atr14 not None"
            assert math.isclose(res.atr14, expected["atr14"], rel_tol=1e-9, abs_tol=1e-9), f"[{name}] atr14 mismatch"
        else:
            assert res.atr14 is None, f"[{name}] expected atr14 to be None"

        # 4. Nearest support match
        if expected["nearest_support"] is not None:
            assert res.nearest_support is not None, f"[{name}] expected nearest_support not None"
            assert math.isclose(res.nearest_support.price, expected["nearest_support"]["price"], rel_tol=1e-9, abs_tol=1e-9)
            assert res.nearest_support.touches == expected["nearest_support"]["touches"]
            assert math.isclose(res.nearest_support.strength, expected["nearest_support"]["strength"], rel_tol=1e-9, abs_tol=1e-9)
            assert res.nearest_support.state == expected["nearest_support"]["state"]
        else:
            assert res.nearest_support is None, f"[{name}] expected nearest_support to be None"

        # 5. Nearest resistance match
        if expected["nearest_resistance"] is not None:
            assert res.nearest_resistance is not None, f"[{name}] expected nearest_resistance not None"
            assert math.isclose(res.nearest_resistance.price, expected["nearest_resistance"]["price"], rel_tol=1e-9, abs_tol=1e-9)
            assert res.nearest_resistance.touches == expected["nearest_resistance"]["touches"]
            assert math.isclose(res.nearest_resistance.strength, expected["nearest_resistance"]["strength"], rel_tol=1e-9, abs_tol=1e-9)
            assert res.nearest_resistance.state == expected["nearest_resistance"]["state"]
        else:
            assert res.nearest_resistance is None, f"[{name}] expected nearest_resistance to be None"

        # 6. Risk distance ATR match to 1e-9
        if expected["risk_distance_atr"] is not None:
            assert res.risk_distance_atr is not None, f"[{name}] expected risk_distance_atr not None"
            assert math.isclose(res.risk_distance_atr, expected["risk_distance_atr"], rel_tol=1e-9, abs_tol=1e-9)
        else:
            assert res.risk_distance_atr is None, f"[{name}] expected risk_distance_atr to be None"

        # 7. Total levels count match
        assert len(res.levels) == expected["levels_count"], f"[{name}] levels count mismatch"

        # 8. Individual levels match
        for idx, exp_lvl in enumerate(expected["levels"]):
            act_lvl = res.levels[idx]
            assert act_lvl.kind == exp_lvl["kind"], f"[{name}] level {idx} kind mismatch"
            assert act_lvl.source == exp_lvl["source"], f"[{name}] level {idx} source mismatch"
            assert act_lvl.side == exp_lvl["side"], f"[{name}] level {idx} side mismatch"
            assert act_lvl.touches == exp_lvl["touches"], f"[{name}] level {idx} touches mismatch"
            assert act_lvl.state == exp_lvl["state"], f"[{name}] level {idx} state mismatch"
            assert math.isclose(act_lvl.price, exp_lvl["price"], rel_tol=1e-9, abs_tol=1e-9), f"[{name}] level {idx} price mismatch"
            assert math.isclose(act_lvl.strength, exp_lvl["strength"], rel_tol=1e-9, abs_tol=1e-9), f"[{name}] level {idx} strength mismatch"
