from __future__ import annotations

import dataclasses
import math
import re
import unittest
from datetime import UTC, datetime, timedelta
from typing import Any

from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION,
    FEATURE_SCHEMA_VERSION_SCALP,
    FEATURE_SCHEMA_VERSION_SCALP_V2,
    FEATURE_SCHEMA_VERSION_V5,
    FEATURE_SCHEMA_VERSION_V6,
    BreadthContext,
    CandleEvidence,
    DatasetRequest,
    IndicatorEvidence,
    PatternEvidence,
    PriceActionEvidence,
)
from ai_quant_lab_ml.features import (
    FEATURE_SCHEMA,
    FEATURE_SCHEMA_V5,
    FEATURE_SCHEMA_V6,
    FEATURE_SCHEMA_SCALP,
    FEATURE_SCHEMA_SCALP_V2,
    VOLUME_MEDIAN_WINDOW,
    FeatureConstructionError,
    build_feature_vector,
    build_labeled_examples,
    feature_definition,
    feature_schema,
    label_from_future_close,
    trailing_feature_context,
)


START = datetime(2024, 1, 2, 9, 15, tzinfo=UTC)

# The trailing context every direct build_feature_vector call needs. Training
# derives these by walking history; a test states them explicitly.
PRIOR_CLOSE = 100.0
MEDIAN_VOLUME = 800.0


def features_of(candle: CandleEvidence, **overrides: Any) -> dict[str, float]:
    """Build one feature vector with an explicit, stated trailing context."""

    return build_feature_vector(
        candle,
        prior_close=overrides.pop("prior_close", PRIOR_CLOSE),
        median_volume=overrides.pop("median_volume", MEDIAN_VOLUME),
        **overrides,
    )


def evidence(
    index: int = 0,
    *,
    future_close: float | None = 102.0,
    indicators: tuple[IndicatorEvidence, ...] | None = None,
    patterns: tuple[PatternEvidence, ...] | None = None,
    events: tuple[PriceActionEvidence, ...] | None = None,
    fii_net_flow_ratio: float | None = None,
    dii_net_flow_ratio: float | None = None,
    fii_futures_net_flow_ratio: float | None = None,
    fii_options_net_flow_ratio: float | None = None,
) -> CandleEvidence:
    open_time = START + timedelta(days=index)
    return CandleEvidence(
        candle_id=f"candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        open_time=open_time,
        close_time=open_time + timedelta(hours=6),
        open=100.0,
        high=103.0,
        low=99.0,
        close=101.0,
        volume=1_000.0,
        indicators=indicators
        if indicators is not None
        else (
            IndicatorEvidence("RSI", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 54.5}),
            IndicatorEvidence(
                "MACD",
                "ta-v1",
                {"fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9},
                {"macd": 1.2, "signal": None, "histogram": None},
            ),
            IndicatorEvidence(
                "SUPERTREND",
                "ta-v1",
                {"atrPeriod": 10, "multiplier": 3},
                {"value": 98.0, "upperBand": 99.0, "lowerBand": 96.0, "trend": "UP"},
            ),
        ),
        patterns=patterns
        if patterns is not None
        else (PatternEvidence("HAMMER", "candlestick-v1", "BULLISH", 0.8),),
        price_action_events=events
        if events is not None
        else (PriceActionEvidence("BREAKOUT", "price-action-v2", "BULLISH", 0.7, 100.0),),
        future_close=future_close,
        future_close_time=open_time + timedelta(days=2, hours=6) if future_close is not None else None,
        fii_net_flow_ratio=fii_net_flow_ratio,
        dii_net_flow_ratio=dii_net_flow_ratio,
        fii_futures_net_flow_ratio=fii_futures_net_flow_ratio,
        fii_options_net_flow_ratio=fii_options_net_flow_ratio,
    )


def request() -> DatasetRequest:
    return DatasetRequest(
        instrument_symbol="NIFTY50",
        timeframe="1d",
        data_window_start=START - timedelta(days=1),
        data_window_end=START + timedelta(days=30),
        data_cutoff_at=START + timedelta(days=31),
        horizon_bars=2,
        neutral_threshold_bps=100.0,
    )


class FeatureConstructionTests(unittest.TestCase):
    def assert_feature_mappings_equal(self, left: dict[str, float], right: dict[str, float]) -> None:
        self.assertEqual(tuple(left), tuple(right))
        for name in left:
            if math.isnan(left[name]):
                self.assertTrue(math.isnan(right[name]), name)
            else:
                self.assertEqual(left[name], right[name], name)

    def test_every_feature_is_scale_free(self) -> None:
        """No feature may be denominated in rupees.

        An absolute price level is a proxy for time on a trending series, which is
        how a chronological holdout leaks its label distribution to the model.
        """

        allowed_suffixes = ("_bps", "_ratio", "_confidence", "_up", "_down")
        for name in FEATURE_SCHEMA:
            with self.subTest(feature=name):
                is_bounded_oscillator = bool(re.match(r"^indicator\.(RSI|MACD)\.", name))
                # A 0/1 indicator flag carries no unit, so it cannot encode a price
                # era the way an absolute level does. SUPERTREND's trend_up /
                # trend_down flags already pass via the "_up"/"_down" suffixes; an
                # "is_" prefixed flag is the same kind of column.
                is_binary_flag = bool(re.search(r"\.is_[a-z0-9_]+$", name))
                self.assertTrue(
                    name.endswith(allowed_suffixes) or is_bounded_oscillator or is_binary_flag,
                    f"{name} is not a ratio, bps distance, bounded oscillator, flag, or confidence.",
                )
        for level_feature in ("candle.open", "candle.high", "candle.low", "candle.close", "candle.volume"):
            self.assertNotIn(level_feature, FEATURE_SCHEMA)

    def test_institutional_flow_evidence_reaches_the_feature_vector(self) -> None:
        """A declared column must be fed by something.

        These two were added to the schema with no loader on either the training or
        the inference path, so every vector carried NaN for them and the imputer
        filled it in silently. The model was fitted on a constant, which is
        indistinguishable from the column not existing except that it enlarged the
        versioned contract and forced a retrain.
        """

        for name in ("market.fii_net_flow_ratio", "market.dii_net_flow_ratio"):
            self.assertIn(name, FEATURE_SCHEMA)

        observed = features_of(evidence(fii_net_flow_ratio=-2.0, dii_net_flow_ratio=1.5))
        self.assertAlmostEqual(observed["market.fii_net_flow_ratio"], -2.0, places=10)
        self.assertAlmostEqual(observed["market.dii_net_flow_ratio"], 1.5, places=10)

    def test_unobserved_institutional_flow_stays_missing_rather_than_zero(self) -> None:
        """A flat session and an uncollected one are different evidence.

        Imputing 0 would teach the model that a collector outage looks like balanced
        institutional buying and selling.
        """

        observed = features_of(evidence())
        self.assertTrue(math.isnan(observed["market.fii_net_flow_ratio"]))
        self.assertTrue(math.isnan(observed["market.dii_net_flow_ratio"]))

    def test_no_declared_feature_is_sourced_by_nothing(self) -> None:
        """Guards the class of bug above for every ``market.*`` column at once.

        A column that stays NaN when its evidence is fully populated has no loader
        behind it. ``market.gift_nifty_implied_gap_bps`` was exactly that and has
        been removed until a real offshore feed exists.
        """

        populated = features_of(evidence(
            fii_net_flow_ratio=-2.0,
            dii_net_flow_ratio=1.5,
            fii_futures_net_flow_ratio=-1.0,
            fii_options_net_flow_ratio=0.5,
        ))
        unsourced = [
            name
            for name in FEATURE_SCHEMA
            if name.startswith("market.") and math.isnan(populated[name])
        ]
        self.assertEqual(unsourced, [], f"declared but never populated: {unsourced}")
        self.assertNotIn("market.gift_nifty_implied_gap_bps", FEATURE_SCHEMA)

    def test_feature_schema_is_fixed_and_future_label_cannot_change_features(self) -> None:
        source = evidence()
        changed_label = evidence(future_close=1_000.0)

        first = features_of(source)
        second = features_of(changed_label)

        self.assertEqual(tuple(first), FEATURE_SCHEMA)
        self.assert_feature_mappings_equal(first, second)
        # Close 101 against a prior close of 100 is exactly 100 bps.
        self.assertAlmostEqual(first["candle.close_return_bps"], 100.0, places=10)
        # Open 100 against the same prior close is a flat open.
        self.assertAlmostEqual(first["candle.overnight_gap_bps"], 0.0, places=10)
        # Volume 1000 against a median of 800.
        self.assertAlmostEqual(first["candle.volume_median_ratio"], 1.25, places=10)
        self.assertAlmostEqual(first["candle.body_return_bps"], 100.0, places=10)
        self.assertEqual(first["indicator.RSI.value"], 54.5)
        self.assertTrue(math.isnan(first["indicator.MACD.signal"]))
        self.assertEqual(first["indicator.SUPERTREND.trend_up"], 1.0)
        self.assertEqual(first["pattern.bullish_confidence"], 0.8)
        self.assertEqual(first["price_action.bullish_confidence"], 0.7)
        self.assertTrue(math.isnan(first["price_action.SUPPORT.level_distance_bps"]))

    def test_v5_schema_still_constructs_per_code_columns(self) -> None:
        """The legacy swing schema must stay reconstructible bit-for-bit.

        v5 artifacts remain loadable after the v6 bump -- the volatility shadow
        families keep scoring -- so the per-code pattern and price-action
        columns those models trained on must keep meaning exactly what they
        meant, per-event level distances included.
        """

        first = features_of(evidence(), schema_version=FEATURE_SCHEMA_VERSION_V5)

        self.assertEqual(tuple(first), FEATURE_SCHEMA_V5)
        self.assertEqual(first["pattern.HAMMER.bullish_confidence"], 0.8)
        self.assertEqual(first["price_action.BREAKOUT.bullish_confidence"], 0.7)
        self.assertAlmostEqual(first["price_action.BREAKOUT.level_distance_bps"], -99.0099009901, places=6)
        self.assertTrue(math.isnan(first["price_action.SUPPORT.level_distance_bps"]))
        # The v6 aggregates and breadth columns must not bleed into a v5 vector.
        self.assertNotIn("pattern.bullish_confidence", first)
        self.assertNotIn("breadth.advance_decline_ratio", first)

    def test_published_schema_versions_keep_their_original_widths(self) -> None:
        """A new feature must get a new version rather than orphan deployed artifacts."""

        self.assertEqual(len(FEATURE_SCHEMA_V5), 113)
        self.assertEqual(len(FEATURE_SCHEMA_V6), 36)
        self.assertEqual(len(FEATURE_SCHEMA_SCALP_V2), 27)
        self.assertEqual(len(FEATURE_SCHEMA), 38)
        self.assertEqual(len(FEATURE_SCHEMA_SCALP), 29)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V5), FEATURE_SCHEMA_V5)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V6), FEATURE_SCHEMA_V6)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_SCALP_V2), FEATURE_SCHEMA_SCALP_V2)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION), FEATURE_SCHEMA)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_SCALP), FEATURE_SCHEMA_SCALP)
        for legacy_version in (
            FEATURE_SCHEMA_VERSION_V5,
            FEATURE_SCHEMA_VERSION_V6,
            FEATURE_SCHEMA_VERSION_SCALP_V2,
        ):
            self.assertNotIn("market.fii_futures_net_flow_ratio", feature_schema(legacy_version))
            self.assertNotIn("market.fii_options_net_flow_ratio", feature_schema(legacy_version))

    def test_unknown_schema_version_is_rejected(self) -> None:
        with self.assertRaises(FeatureConstructionError):
            feature_schema("ml-feature-v99")
        with self.assertRaises(FeatureConstructionError):
            features_of(evidence(), schema_version="ml-feature-v99")

    def test_breadth_context_reaches_the_v6_feature_vector(self) -> None:
        """The seven breadth columns must be fed by the attached context.

        A declared column with no loader is the institutional-flow bug again: a
        guaranteed-NaN feature silently imputed to a training-fold constant.
        """

        source = evidence()
        with_breadth = dataclasses.replace(
            source,
            breadth=BreadthContext(
                observed_at=source.close_time,
                advance_decline=0.4,
                median_return_bps=35.0,
                return_dispersion_bps=120.0,
                above_sma20_share=0.65,
                median_volume_ratio=1.1,
                bank_it_spread_bps=-42.0,
                index_return_gap_bps=18.0,
            ),
        )

        observed = features_of(with_breadth)
        self.assertAlmostEqual(observed["breadth.advance_decline_ratio"], 0.4, places=10)
        self.assertAlmostEqual(observed["breadth.median_return_bps"], 35.0, places=10)
        self.assertAlmostEqual(observed["breadth.return_dispersion_bps"], 120.0, places=10)
        self.assertAlmostEqual(observed["breadth.above_sma20_ratio"], 0.65, places=10)
        self.assertAlmostEqual(observed["breadth.median_volume_ratio"], 1.1, places=10)
        self.assertAlmostEqual(observed["breadth.bank_it_spread_bps"], -42.0, places=10)
        self.assertAlmostEqual(observed["cross.nifty_banknifty_return_gap_bps"], 18.0, places=10)

        # No context is missing evidence, never a silent zero.
        absent = features_of(source)
        for name in (
            "breadth.advance_decline_ratio",
            "breadth.median_return_bps",
            "breadth.return_dispersion_bps",
            "breadth.above_sma20_ratio",
            "breadth.median_volume_ratio",
            "breadth.bank_it_spread_bps",
            "cross.nifty_banknifty_return_gap_bps",
        ):
            self.assertTrue(math.isnan(absent[name]), name)

    def test_duplicate_evidence_order_does_not_change_feature_values(self) -> None:
        first = evidence(
            indicators=(
                IndicatorEvidence("RSI", "ta-v2", {"period": 14, "smoothing": "WILDER"}, {"value": 60}),
                IndicatorEvidence("RSI", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 50}),
            ),
            patterns=(
                PatternEvidence("DOJI", "candlestick-v1", "NEUTRAL", 0.3),
                PatternEvidence("DOJI", "candlestick-v1", "NEUTRAL", 0.6),
            ),
        )
        reordered = evidence(
            indicators=tuple(reversed(first.indicators)),
            patterns=tuple(reversed(first.patterns)),
        )

        self.assert_feature_mappings_equal(features_of(first), features_of(reordered))
        self.assertEqual(features_of(first)["indicator.RSI.value"], 50.0)
        # The per-code neutral column exists only in the v5 contract.
        v5_features = features_of(first, schema_version=FEATURE_SCHEMA_VERSION_V5)
        self.assertEqual(v5_features["pattern.DOJI.neutral_confidence"], 0.6)

    def test_uses_only_the_explicit_algorithm_versions(self) -> None:
        mixed_versions = evidence(
            indicators=(IndicatorEvidence("RSI", "ta-v2", {"period": 14, "smoothing": "WILDER"}, {"value": 99.0}),),
            patterns=(PatternEvidence("HAMMER", "candlestick-v2", "BULLISH", 0.99),),
            events=(PriceActionEvidence("BREAKOUT", "price-action-v3", "BULLISH", 0.99, 101.0),),
        )

        default_features = features_of(mixed_versions)
        selected_features = features_of(
            mixed_versions,
            indicator_algorithm_version="ta-v2",
            pattern_algorithm_version="candlestick-v2",
            price_action_algorithm_version="price-action-v3",
        )

        self.assertTrue(math.isnan(default_features["indicator.RSI.value"]))
        self.assertEqual(default_features["pattern.bullish_confidence"], 0.0)
        self.assertEqual(default_features["price_action.bullish_confidence"], 0.0)
        self.assertEqual(selected_features["indicator.RSI.value"], 99.0)
        self.assertEqual(selected_features["pattern.bullish_confidence"], 0.99)
        self.assertEqual(selected_features["price_action.bullish_confidence"], 0.99)

    def test_same_version_with_non_default_indicator_parameters_is_not_a_v1_feature(self) -> None:
        non_default = evidence(indicators=(IndicatorEvidence("RSI", "ta-v1", {"period": 21, "smoothing": "WILDER"}, {"value": 61.0}),))

        self.assertTrue(math.isnan(features_of(non_default)["indicator.RSI.value"]))

    def test_feature_definition_is_json_safe_and_declares_fixed_parameters(self) -> None:
        definition = feature_definition()

        self.assertEqual(definition["schemaVersion"], FEATURE_SCHEMA_VERSION)
        self.assertEqual(definition["indicatorParameters"]["RSI"], {"period": 14, "smoothing": "WILDER"})
        self.assertEqual(definition["indicatorParameters"]["SUPERTREND"], {"atrPeriod": 10, "multiplier": 3})
        definition["features"].append("mutated")
        self.assertNotIn("mutated", feature_definition()["features"])

    def test_label_threshold_is_symmetric_and_inclusive(self) -> None:
        self.assertEqual(label_from_future_close(source_close=100, future_close=101, neutral_threshold_bps=100).label, "NEUTRAL")
        self.assertEqual(label_from_future_close(source_close=100, future_close=101.01, neutral_threshold_bps=100).label, "BULLISH")
        self.assertEqual(label_from_future_close(source_close=100, future_close=98.99, neutral_threshold_bps=100).label, "BEARISH")
        self.assertIsNone(label_from_future_close(source_close=100, future_close=None, neutral_threshold_bps=100))

    def test_build_examples_sorts_and_omits_unlabeled_latest_candle(self) -> None:
        later = evidence(2, future_close=None)
        early = evidence(0, future_close=103.0)
        middle = evidence(1, future_close=99.0)

        examples = build_labeled_examples([later, middle, early], request())

        self.assertEqual([example.candle_id for example in examples], ["candle-0", "candle-1"])
        self.assertEqual([example.label for example in examples], ["BULLISH", "BEARISH"])
        self.assertAlmostEqual(examples[0].forward_return, 103 / 101 - 1)


if __name__ == "__main__":
    unittest.main()
