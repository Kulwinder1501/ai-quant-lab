import json
from pathlib import Path
import unittest

from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V8, CandleEvidence, PatternEvidence
from ai_quant_lab_ml.features import build_feature_vector
from datetime import UTC, datetime, timedelta


class CandlestickFixtureParityTests(unittest.TestCase):
    def test_all_fixtures_map_to_v8_binary_flags(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "candlestick_fixtures.json"
        with open(fixture_path, "r", encoding="utf-8") as f:
            fixtures = json.load(f)

        for fixture in fixtures:
            with self.subTest(fixture=fixture["name"]):
                target_candle = next(c for c in fixture["candles"] if c["id"] == fixture["targetCandleId"])
                
                # Mock detection matching the canonical fixture
                pattern_evidence = PatternEvidence(
                    code=fixture["expectedPattern"],
                    algorithm_version="candlestick-v1",
                    direction=fixture["expectedDirection"],
                    confidence=0.9,
                )
                
                open_time = datetime(2026, 7, 24, 9, 15, tzinfo=UTC)
                candle = CandleEvidence(
                    candle_id=target_candle["id"],
                    instrument_id="inst-1",
                    symbol="NIFTY50",
                    timeframe="5m",
                    open_time=open_time,
                    close_time=open_time + timedelta(minutes=5),
                    open=float(target_candle["open"]),
                    high=float(target_candle["high"]),
                    low=float(target_candle["low"]),
                    close=float(target_candle["close"]),
                    volume=1000.0,
                    indicators=(),
                    patterns=(pattern_evidence,),
                    price_action_events=(),
                    future_close=None,
                    future_close_time=None,
                )
                
                vec = build_feature_vector(
                    candle,
                    prior_close=100.0,
                    median_volume=1000.0,
                    schema_version=FEATURE_SCHEMA_VERSION_V8,
                )
                
                expected_flag_key = f"pattern.is_{fixture['expectedPattern'].lower()}"
                self.assertIn(expected_flag_key, vec)
                self.assertEqual(vec[expected_flag_key], 1.0)


if __name__ == "__main__":
    unittest.main()
