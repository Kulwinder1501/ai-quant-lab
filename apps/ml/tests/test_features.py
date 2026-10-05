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

    def test_v8_geometry_and_v8_full_schema_contracts(self) -> None:
        from ai_quant_lab_ml.contracts import (
            FEATURE_SCHEMA_VERSION_V8,
            FEATURE_SCHEMA_VERSION_V8_GEOMETRY,
            FEATURE_SCHEMA_VERSION_V9,
        )
        from ai_quant_lab_ml.features import (
            FEATURE_SCHEMA_V8,
            FEATURE_SCHEMA_V8_GEOMETRY,
            FEATURE_SCHEMA_V9,
            _CANDLE_GEOMETRY_FEATURES,
            _PATTERN_BINARY_FEATURES,
            _PATTERN_BINARY_FEATURES_V8,
        )

        self.assertEqual(len(_CANDLE_GEOMETRY_FEATURES), 11)
        self.assertEqual(len(_PATTERN_BINARY_FEATURES_V8), 24)
        self.assertEqual(len(_PATTERN_BINARY_FEATURES), 26)
        self.assertEqual(len(FEATURE_SCHEMA_V8_GEOMETRY), len(FEATURE_SCHEMA) + 11)
        self.assertEqual(len(FEATURE_SCHEMA_V8), len(FEATURE_SCHEMA_V8_GEOMETRY) + 24)
        self.assertEqual(len(FEATURE_SCHEMA_V9), len(FEATURE_SCHEMA_V8) + 2)

        schema_v8_geom = feature_schema(FEATURE_SCHEMA_VERSION_V8_GEOMETRY)
        self.assertEqual(schema_v8_geom, FEATURE_SCHEMA_V8_GEOMETRY)

        schema_v8 = feature_schema(FEATURE_SCHEMA_VERSION_V8)
        self.assertEqual(schema_v8, FEATURE_SCHEMA_V8)

        schema_v9 = feature_schema(FEATURE_SCHEMA_VERSION_V9)
        self.assertEqual(schema_v9, FEATURE_SCHEMA_V9)

    def test_build_labeled_examples_defaults_to_the_production_schema(self) -> None:
        """Without an override, the schema is `schema_version_for(request.timeframe)`, unchanged."""
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT

        source = evidence(future_close=103.0)
        examples = build_labeled_examples([source], request())
        self.assertEqual(len(examples), 1)
        self.assertNotIn("ict.htf_bias_bullish", examples[0].features)

        # An explicit override changes which columns get built, on the identical candle.
        overridden = build_labeled_examples([source], request(), schema_version=FEATURE_SCHEMA_VERSION_V_ICT)
        self.assertIn("ict.htf_bias_bullish", overridden[0].features)

    def test_v_ict_schema_is_v9_plus_eleven_ict_columns(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V9, FEATURE_SCHEMA_VERSION_V_ICT
        from ai_quant_lab_ml.features import FEATURE_SCHEMA_V9, FEATURE_SCHEMA_V_ICT

        self.assertEqual(len(FEATURE_SCHEMA_V_ICT), len(FEATURE_SCHEMA_V9) + 11)
        self.assertEqual(FEATURE_SCHEMA_V_ICT[: len(FEATURE_SCHEMA_V9)], FEATURE_SCHEMA_V9)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V_ICT), FEATURE_SCHEMA_V_ICT)
        # v9 itself must not have gained the ICT columns as a side effect of this change.
        self.assertNotIn("ict.htf_bias_bullish", FEATURE_SCHEMA_V9)

    def test_v_ict_features_default_to_absence_when_no_ict_evidence_is_attached(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT

        observed = features_of(evidence(), schema_version=FEATURE_SCHEMA_VERSION_V_ICT)
        # One-hots default to 0.0 (evidence of absence), matching pattern.is_* / SUPERTREND's own
        # convention -- never left out of the vector just because nothing was attached.
        for column in (
            "ict.htf_bias_bullish",
            "ict.htf_bias_bearish",
            "ict.premium_discount_is_premium",
            "ict.premium_discount_is_discount",
            "ict.nearest_order_block_is_bullish",
            "ict.nearest_order_block_is_bearish",
            "ict.has_bos_level",
            "ict.has_choch_level",
        ):
            self.assertEqual(observed[column], 0.0, column)
        # The ATR-normalised distances are a genuinely missing measurement, so NaN, not 0.
        for column in (
            "ict.distance_to_nearest_order_block_atr",
            "ict.distance_to_bos_level_atr",
            "ict.distance_to_choch_level_atr",
        ):
            self.assertTrue(math.isnan(observed[column]), column)

    def test_v_ict_features_populate_from_attached_ict_evidence(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT, IctEvidence

        atr_indicator = IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 4.0})
        source = dataclasses.replace(
            evidence(indicators=(atr_indicator,)),
            ict=IctEvidence(
                htf_bias="BEARISH",
                premium_discount_zone="PREMIUM",
                distance_to_nearest_order_block=8.0,
                nearest_order_block_side="BEARISH",
                has_bos_level=True,
                has_choch_level=True,
                distance_to_bos_level=-12.0,
                distance_to_choch_level=6.0,
            ),
        )

        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT)
        self.assertEqual(observed["ict.htf_bias_bullish"], 0.0)
        self.assertEqual(observed["ict.htf_bias_bearish"], 1.0)
        self.assertEqual(observed["ict.premium_discount_is_premium"], 1.0)
        self.assertEqual(observed["ict.premium_discount_is_discount"], 0.0)
        self.assertEqual(observed["ict.nearest_order_block_is_bullish"], 0.0)
        self.assertEqual(observed["ict.nearest_order_block_is_bearish"], 1.0)
        self.assertEqual(observed["ict.has_bos_level"], 1.0)
        self.assertEqual(observed["ict.has_choch_level"], 1.0)
        # Raw distances (8.0, -12.0, 6.0) divided by ATR (4.0) -- scale-free, per this module's own
        # anti-leakage rule against absolute price levels.
        self.assertAlmostEqual(observed["ict.distance_to_nearest_order_block_atr"], 2.0, places=10)
        self.assertAlmostEqual(observed["ict.distance_to_bos_level_atr"], -3.0, places=10)
        self.assertAlmostEqual(observed["ict.distance_to_choch_level_atr"], 1.5, places=10)

    def test_v_ict_columns_are_absent_from_every_other_schema(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V9, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="DISCOUNT",
                distance_to_nearest_order_block=10.0,
                nearest_order_block_side="BULLISH",
                has_bos_level=True,
                has_choch_level=False,
                distance_to_bos_level=5.0,
                distance_to_choch_level=None,
            ),
        )
        # ict evidence attached, but built under v9: no ict.* key should leak into a production
        # schema's vector just because the evidence happened to be present on the candle.
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V9)
        self.assertFalse(any(key.startswith("ict.") for key in observed))

    def test_v_ict_refined_schema_is_v_ict_plus_six_refined_columns(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_REFINED
        from ai_quant_lab_ml.features import FEATURE_SCHEMA_V_ICT, FEATURE_SCHEMA_V_ICT_REFINED

        self.assertEqual(len(FEATURE_SCHEMA_V_ICT_REFINED), len(FEATURE_SCHEMA_V_ICT) + 6)
        self.assertEqual(FEATURE_SCHEMA_V_ICT_REFINED[: len(FEATURE_SCHEMA_V_ICT)], FEATURE_SCHEMA_V_ICT)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V_ICT_REFINED), FEATURE_SCHEMA_V_ICT_REFINED)
        self.assertNotIn("ict.stop_compression_ratio", FEATURE_SCHEMA_V_ICT)

    def test_v_ict_refined_defaults_to_absence_without_a_refinement(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_REFINED, IctEvidence

        # HTF order block present, but no nested refinement found on this bar.
        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="DISCOUNT",
                distance_to_nearest_order_block=10.0,
                nearest_order_block_side="BULLISH",
                has_bos_level=True,
                has_choch_level=False,
                distance_to_bos_level=5.0,
                distance_to_choch_level=None,
                htf_order_block_side="BULLISH",
                htf_order_block_distance=40.0,
                refined_order_block_distance=None,
                stop_compression_ratio=None,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_REFINED)
        self.assertEqual(observed["ict.htf_order_block_is_bullish"], 1.0)
        self.assertEqual(observed["ict.htf_order_block_is_bearish"], 0.0)
        self.assertEqual(observed["ict.has_refined_order_block"], 0.0)
        self.assertTrue(math.isnan(observed["ict.refined_order_block_distance_atr"]))
        self.assertTrue(math.isnan(observed["ict.stop_compression_ratio"]))

    def test_v_ict_refined_populates_from_a_real_refinement(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_REFINED, IctEvidence

        atr_indicator = IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 4.0})
        source = dataclasses.replace(
            evidence(indicators=(atr_indicator,)),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="DISCOUNT",
                distance_to_nearest_order_block=10.0,
                nearest_order_block_side="BULLISH",
                has_bos_level=True,
                has_choch_level=False,
                distance_to_bos_level=5.0,
                distance_to_choch_level=None,
                htf_order_block_side="BEARISH",
                htf_order_block_distance=40.0,
                refined_order_block_distance=8.0,
                stop_compression_ratio=0.375,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_REFINED)
        self.assertEqual(observed["ict.htf_order_block_is_bearish"], 1.0)
        self.assertAlmostEqual(observed["ict.htf_order_block_distance_atr"], 10.0, places=10)  # 40.0 / 4.0
        self.assertEqual(observed["ict.has_refined_order_block"], 1.0)
        self.assertAlmostEqual(observed["ict.refined_order_block_distance_atr"], 2.0, places=10)  # 8.0 / 4.0
        self.assertAlmostEqual(observed["ict.stop_compression_ratio"], 0.375, places=10)

    def test_v_ict_ote_schema_is_v_ict_refined_plus_four_ote_columns(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_OTE
        from ai_quant_lab_ml.features import FEATURE_SCHEMA_V_ICT_OTE, FEATURE_SCHEMA_V_ICT_REFINED

        self.assertEqual(len(FEATURE_SCHEMA_V_ICT_OTE), len(FEATURE_SCHEMA_V_ICT_REFINED) + 4)
        self.assertEqual(FEATURE_SCHEMA_V_ICT_OTE[: len(FEATURE_SCHEMA_V_ICT_REFINED)], FEATURE_SCHEMA_V_ICT_REFINED)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V_ICT_OTE), FEATURE_SCHEMA_V_ICT_OTE)
        self.assertNotIn("ict.ote_distance_to_band_atr", FEATURE_SCHEMA_V_ICT_REFINED)

    def test_v_ict_ote_defaults_to_absence_without_a_dealing_range(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_OTE, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="UNKNOWN",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                ote_side=None,
                ote_is_within=None,
                ote_distance_to_band=None,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_OTE)
        self.assertEqual(observed["ict.ote_side_is_bullish"], 0.0)
        self.assertEqual(observed["ict.ote_side_is_bearish"], 0.0)
        self.assertEqual(observed["ict.ote_is_within"], 0.0)
        self.assertTrue(math.isnan(observed["ict.ote_distance_to_band_atr"]))

    def test_v_ict_ote_populates_from_a_real_band(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_OTE, IctEvidence

        atr_indicator = IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 4.0})
        source = dataclasses.replace(
            evidence(indicators=(atr_indicator,)),
            ict=IctEvidence(
                htf_bias="BEARISH",
                premium_discount_zone="PREMIUM",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                ote_side="BEARISH",
                ote_is_within=False,
                ote_distance_to_band=10.0,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_OTE)
        self.assertEqual(observed["ict.ote_side_is_bullish"], 0.0)
        self.assertEqual(observed["ict.ote_side_is_bearish"], 1.0)
        self.assertEqual(observed["ict.ote_is_within"], 0.0)
        self.assertAlmostEqual(observed["ict.ote_distance_to_band_atr"], 2.5, places=10)  # 10.0 / 4.0

    def test_v_ict_ote_columns_are_absent_from_v_ict_refined(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_REFINED, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="DISCOUNT",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                ote_side="BULLISH",
                ote_is_within=True,
                ote_distance_to_band=0.0,
            ),
        )
        # ict.ote evidence attached, but built under v-ict-refined: no ict.ote.* key should leak in.
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_REFINED)
        self.assertFalse(any(key.startswith("ict.ote_") for key in observed))

    def test_v_ict_swing_schema_is_v_ict_ote_plus_seven_swing_columns(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING
        from ai_quant_lab_ml.features import FEATURE_SCHEMA_V_ICT_OTE, FEATURE_SCHEMA_V_ICT_SWING

        self.assertEqual(len(FEATURE_SCHEMA_V_ICT_SWING), len(FEATURE_SCHEMA_V_ICT_OTE) + 7)
        self.assertEqual(FEATURE_SCHEMA_V_ICT_SWING[: len(FEATURE_SCHEMA_V_ICT_OTE)], FEATURE_SCHEMA_V_ICT_OTE)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V_ICT_SWING), FEATURE_SCHEMA_V_ICT_SWING)
        self.assertNotIn("ict.distance_to_ith_atr", FEATURE_SCHEMA_V_ICT_OTE)

    def test_v_ict_swing_defaults_to_absence_without_a_hierarchy(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="UNKNOWN",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                swing_distance_to_ith=None,
                swing_distance_to_itl=None,
                swing_distance_to_sth=None,
                swing_distance_to_stl=None,
                swing_protected_side=None,
                swing_protected_breached=None,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING)
        self.assertEqual(observed["ict.swing_protected_side_is_ith"], 0.0)
        self.assertEqual(observed["ict.swing_protected_side_is_itl"], 0.0)
        self.assertEqual(observed["ict.swing_protected_breached"], 0.0)
        for column in (
            "ict.distance_to_ith_atr",
            "ict.distance_to_itl_atr",
            "ict.distance_to_sth_atr",
            "ict.distance_to_stl_atr",
        ):
            self.assertTrue(math.isnan(observed[column]), column)

    def test_v_ict_swing_populates_from_a_real_hierarchy(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING, IctEvidence

        atr_indicator = IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 4.0})
        source = dataclasses.replace(
            evidence(indicators=(atr_indicator,)),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="DISCOUNT",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                swing_distance_to_ith=None,
                swing_distance_to_itl=8.0,
                swing_distance_to_sth=None,
                swing_distance_to_stl=20.0,
                swing_protected_side="INTERMEDIATE_TERM_LOW",
                swing_protected_breached=True,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING)
        self.assertEqual(observed["ict.swing_protected_side_is_ith"], 0.0)
        self.assertEqual(observed["ict.swing_protected_side_is_itl"], 1.0)
        self.assertEqual(observed["ict.swing_protected_breached"], 1.0)
        self.assertAlmostEqual(observed["ict.distance_to_itl_atr"], 2.0, places=10)  # 8.0 / 4.0
        self.assertAlmostEqual(observed["ict.distance_to_stl_atr"], 5.0, places=10)  # 20.0 / 4.0
        self.assertTrue(math.isnan(observed["ict.distance_to_ith_atr"]))
        self.assertTrue(math.isnan(observed["ict.distance_to_sth_atr"]))

    def test_v_ict_swing_columns_are_absent_from_v_ict_ote(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_OTE, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="DISCOUNT",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                swing_protected_side="INTERMEDIATE_TERM_HIGH",
                swing_protected_breached=False,
            ),
        )
        # ict.swing evidence attached, but built under v-ict-ote: no swing-hierarchy key should leak in.
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_OTE)
        self.assertFalse(any(key.startswith("ict.swing_") or "_to_ith" in key or "_to_itl" in key for key in observed))

    # ------------------------------------------------------------------------------------------
    # v-ict-swing-vol: OTE presence flag, cyclical time-of-day, RVOL bucket, Parkinson volatility.
    # ------------------------------------------------------------------------------------------

    def test_v_ict_swing_vol_schema_is_v_ict_swing_plus_five_columns(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL
        from ai_quant_lab_ml.features import FEATURE_SCHEMA_V_ICT_SWING, FEATURE_SCHEMA_V_ICT_SWING_VOL

        self.assertEqual(len(FEATURE_SCHEMA_V_ICT_SWING_VOL), len(FEATURE_SCHEMA_V_ICT_SWING) + 5)
        self.assertEqual(FEATURE_SCHEMA_V_ICT_SWING_VOL[: len(FEATURE_SCHEMA_V_ICT_SWING)], FEATURE_SCHEMA_V_ICT_SWING)
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL), FEATURE_SCHEMA_V_ICT_SWING_VOL)
        for column in (
            "ict.ote_is_active",
            "time.tod_sin",
            "time.tod_cos",
            "volume.rvol_bucket",
            "volatility.parkinson_ratio",
        ):
            self.assertIn(column, FEATURE_SCHEMA_V_ICT_SWING_VOL)
            # None of these five are part of the ICT ablation chain itself -- v-ict-swing must not
            # have gained them as a side effect of this change.
            self.assertNotIn(column, FEATURE_SCHEMA_V_ICT_SWING)

    def test_v_ict_swing_vol_columns_are_absent_from_v_ict_swing(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="PREMIUM",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                ote_side="BULLISH",
                ote_is_within=True,
                ote_distance_to_band=0.0,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING)
        for column in (
            "ict.ote_is_active",
            "time.tod_sin",
            "time.tod_cos",
            "volume.rvol_bucket",
            "volatility.parkinson_ratio",
        ):
            self.assertNotIn(column, observed)

    def test_ote_is_active_flag_is_false_without_a_band(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL, IctEvidence

        source = dataclasses.replace(
            evidence(),
            ict=IctEvidence(
                htf_bias="BULLISH",
                premium_discount_zone="UNKNOWN",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                ote_side=None,
                ote_is_within=None,
                ote_distance_to_band=None,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL)
        self.assertEqual(observed["ict.ote_is_active"], 0.0)
        # The imputer-skew case this flag exists to fix: no band, no ATR either, so the distance
        # column is NaN -- the flag must still read 0.0 (absence), never NaN itself.
        self.assertTrue(math.isnan(observed["ict.ote_distance_to_band_atr"]))

    def test_ote_is_active_flag_is_true_with_an_active_band(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL, IctEvidence

        atr_indicator = IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 4.0})
        source = dataclasses.replace(
            evidence(indicators=(atr_indicator,)),
            ict=IctEvidence(
                htf_bias="BEARISH",
                premium_discount_zone="PREMIUM",
                distance_to_nearest_order_block=None,
                nearest_order_block_side=None,
                has_bos_level=False,
                has_choch_level=False,
                distance_to_bos_level=None,
                distance_to_choch_level=None,
                ote_side="BEARISH",
                # Within the band (distance 0.0) is still an *active* band -- the presence flag reads
                # "was a band computed", not "is price currently inside it" (that is `ote_is_within`).
                ote_is_within=True,
                ote_distance_to_band=0.0,
            ),
        )
        observed = features_of(source, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL)
        self.assertEqual(observed["ict.ote_is_active"], 1.0)
        self.assertEqual(observed["ict.ote_distance_to_band_atr"], 0.0)

    def test_time_of_day_known_bucket_boundaries(self) -> None:
        """Market open and the last 5-minute bucket before close land in buckets 1 and 75."""
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL
        from ai_quant_lab_ml.volume_intelligence import INDIA_TZ, get_tod_bucket_index

        open_tick = datetime(2024, 1, 2, 9, 15, tzinfo=INDIA_TZ)
        last_bucket_tick = datetime(2024, 1, 2, 15, 25, tzinfo=INDIA_TZ)
        midday_tick = datetime(2024, 1, 2, 12, 30, tzinfo=INDIA_TZ)

        self.assertEqual(get_tod_bucket_index(open_tick), 1)
        self.assertEqual(get_tod_bucket_index(last_bucket_tick), 75)

        def observed_at(tick: datetime) -> dict[str, float]:
            candle = dataclasses.replace(evidence(), close_time=tick)
            return features_of(candle, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL)

        open_observed = observed_at(open_tick)
        last_observed = observed_at(last_bucket_tick)
        midday_observed = observed_at(midday_tick)

        # Market open: minute-of-day 555/1440 -> a specific, hand-computable angle.
        open_angle = 2.0 * math.pi * (9 * 60 + 15) / 1440.0
        self.assertAlmostEqual(open_observed["time.tod_sin"], math.sin(open_angle), places=10)
        self.assertAlmostEqual(open_observed["time.tod_cos"], math.cos(open_angle), places=10)

        # Midday is neither of the two endpoints -- just a sanity check it is a distinct, finite point.
        self.assertTrue(math.isfinite(midday_observed["time.tod_sin"]))
        self.assertTrue(math.isfinite(midday_observed["time.tod_cos"]))
        self.assertNotAlmostEqual(midday_observed["time.tod_sin"], open_observed["time.tod_sin"], places=3)

        # The cyclical property this feature must get right: 09:15 and the last pre-15:30 bucket are
        # ~17h45m apart across the overnight gap, not neighbours. A naive angle = 2*pi*(bucket-1)/75
        # would place them about one 75th of the circle apart (Euclidean distance ~0.084 on the unit
        # circle) -- wrongly implying the session wraps continuously into the next day's open. Encoding
        # over the true 24-hour clock instead keeps them far apart.
        distance = math.hypot(
            open_observed["time.tod_sin"] - last_observed["time.tod_sin"],
            open_observed["time.tod_cos"] - last_observed["time.tod_cos"],
        )
        self.assertGreater(distance, 1.0, f"09:15 and 15:25 should be far apart on the unit circle, got {distance}")

    def test_time_of_day_outside_the_session_is_missing_not_zero(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL
        from ai_quant_lab_ml.volume_intelligence import INDIA_TZ

        # 16:00 IST: after the 15:30 close, outside the session `get_tod_bucket_index` defines.
        after_close = dataclasses.replace(
            evidence(), close_time=datetime(2024, 1, 2, 16, 0, tzinfo=INDIA_TZ)
        )
        observed = features_of(after_close, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL)
        self.assertTrue(math.isnan(observed["time.tod_sin"]))
        self.assertTrue(math.isnan(observed["time.tod_cos"]))

    def test_rvol_bucket_reuses_the_existing_volume_ratio_not_a_new_computation(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL
        from ai_quant_lab_ml.volume_intelligence import assign_rvol_bin

        # volume_median_ratio = 1_000.0 / 800.0 = 1.25 -> bin 4 under volume_intelligence's own edges
        # (1.25 <= RVOL < 1.50). Computed directly from the same evidence() fixture everything else in
        # this file uses (volume=1_000.0, MEDIAN_VOLUME=800.0), not a bespoke scenario.
        observed = features_of(evidence(), schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL)
        ratio = observed["candle.volume_median_ratio"]
        self.assertAlmostEqual(ratio, 1.25, places=10)
        self.assertEqual(observed["volume.rvol_bucket"], float(assign_rvol_bin(ratio)))
        self.assertEqual(observed["volume.rvol_bucket"], 4.0)

    def test_rvol_bucket_is_missing_when_the_ratio_is_missing(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL

        # median_volume=0.0 makes candle.volume_median_ratio NaN (see build_feature_vector's own
        # zero-division guard) -- the bucket must follow it to NaN, not silently default to a bin.
        observed = features_of(
            evidence(), median_volume=0.0, schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL
        )
        self.assertTrue(math.isnan(observed["candle.volume_median_ratio"]))
        self.assertTrue(math.isnan(observed["volume.rvol_bucket"]))

    def test_parkinson_ratio_matches_a_hand_computed_value(self) -> None:
        """Ten bars of a constant (high, low) range have a closed-form Parkinson estimate."""
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL

        high, low = 101.0, 99.0
        window = tuple((high, low) for _ in range(10))
        expected = math.sqrt(math.log(high / low) ** 2 / (4.0 * math.log(2.0)))

        observed = features_of(
            evidence(), schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL, trailing_high_low=window
        )
        self.assertAlmostEqual(observed["volatility.parkinson_ratio"], expected, places=12)
        # Sanity bound: a +/-1% range around 100 should read a small-single-digit-percent vol, not a
        # value in the wrong units (e.g. an absolute price level, or 100x off from a ratio).
        self.assertGreater(observed["volatility.parkinson_ratio"], 0.0)
        self.assertLess(observed["volatility.parkinson_ratio"], 0.05)

    def test_parkinson_ratio_is_missing_below_the_window_size(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL
        from ai_quant_lab_ml.features import PARKINSON_WINDOW

        short_window = tuple((101.0, 99.0) for _ in range(PARKINSON_WINDOW - 1))
        observed = features_of(
            evidence(), schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL, trailing_high_low=short_window
        )
        self.assertTrue(math.isnan(observed["volatility.parkinson_ratio"]))

    def test_parkinson_ratio_reacts_to_a_regime_change_faster_than_atr(self) -> None:
        """The demonstrable improvement this feature exists for.

        Both columns are read off the identical synthetic bar via the same `build_feature_vector`
        call, so this is a true apples-to-apples comparison on one series, not two separate claims.

        Calm phase: every bar has high=100.1/low=99.9 (true range 0.2, no gaps since open=close=100
        every bar). ATR is Wilder-seeded with that same 0.2 true range, so it starts already converged
        and constant at 0.2 through the whole calm phase -- the cleanest possible baseline for "how far
        has it moved" after the shock, with no residual drift to account for.

        Shock: a single storm bar (high=104.0/low=96.0, true range 8.0) lands with 9 calm bars still in
        the Parkinson window and 13 calm periods of smoothing already behind the ATR. Each series is
        then compared against its own fully-converged, hand-computable steady-state value for a
        permanently sustained storm -- the ATR fixed point (period-weighted average that converges to
        the constant input) and the Parkinson value for a fully-storm window -- to get a
        regime-independent "fraction of the way there" figure for each.
        """
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL

        atr_period = 14
        calm_high, calm_low = 100.1, 99.9
        storm_high, storm_low = 104.0, 96.0
        calm_true_range = calm_high - calm_low  # 0.2
        storm_true_range = storm_high - storm_low  # 8.0

        # Wilder ATR seeded at the calm true range: atr[i] = atr[i-1] + (TR[i] - atr[i-1]) / period.
        # With atr[0] == calm_true_range and every subsequent TR == calm_true_range, atr stays exactly
        # calm_true_range for the whole calm phase (a fixed point of its own recursion) -- not an
        # approximation, the exact Wilder value for a perfectly calm history.
        atr_before_shock = calm_true_range
        atr_after_one_storm_bar = atr_before_shock + (storm_true_range - atr_before_shock) / atr_period
        # Hand-computable: 0.2 + (8.0 - 0.2) / 14
        self.assertAlmostEqual(atr_after_one_storm_bar, 0.2 + 7.8 / 14, places=12)

        atr_indicator_before = IndicatorEvidence(
            "ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": atr_before_shock}
        )
        atr_indicator_after = IndicatorEvidence(
            "ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": atr_after_one_storm_bar}
        )

        calm_window = tuple((calm_high, calm_low) for _ in range(10))
        one_storm_window = calm_window[1:] + ((storm_high, storm_low),)

        before = features_of(
            dataclasses.replace(evidence(indicators=(atr_indicator_before,))),
            schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL,
            trailing_high_low=calm_window,
        )
        after_one_storm_bar = features_of(
            dataclasses.replace(evidence(indicators=(atr_indicator_after,))),
            schema_version=FEATURE_SCHEMA_VERSION_V_ICT_SWING_VOL,
            trailing_high_low=one_storm_window,
        )

        # Fully-converged steady state for a permanently sustained storm, computed independently of
        # the implementation under test:
        atr_steady_state = storm_true_range  # Wilder's fixed point under a constant input.
        parkinson_steady_state = math.sqrt(math.log(storm_high / storm_low) ** 2 / (4.0 * math.log(2.0)))

        atr_ratio_before = before["indicator.ATR.value_ratio"]
        atr_ratio_after = after_one_storm_bar["indicator.ATR.value_ratio"]
        parkinson_before = before["volatility.parkinson_ratio"]
        parkinson_after = after_one_storm_bar["volatility.parkinson_ratio"]

        # `indicator.*_ratio` columns divide by the candle's own close (101.0 on the `evidence()`
        # fixture), not by an assumed round number -- see `_INDICATOR_VALUE_FIELDS`'s "_ratio" handling.
        close_price = evidence().close
        self.assertAlmostEqual(atr_ratio_before, calm_true_range / close_price, places=10)
        self.assertAlmostEqual(atr_ratio_after, atr_after_one_storm_bar / close_price, places=10)

        atr_steady_ratio = atr_steady_state / close_price
        atr_recovery_fraction = (atr_ratio_after - atr_ratio_before) / (atr_steady_ratio - atr_ratio_before)
        parkinson_recovery_fraction = (parkinson_after - parkinson_before) / (
            parkinson_steady_state - parkinson_before
        )

        # Both move toward their new regime after one storm bar, but Parkinson -- an unweighted mean
        # over a 10-bar window -- gets a 1/10 share of the new regime immediately, while Wilder's
        # recursive smoothing only takes a 1/14 step every bar no matter how extreme the new reading
        # is. The real, demonstrable improvement: Parkinson covers clearly more of the distance to the
        # new regime than ATR does, on the identical synthetic shock.
        self.assertGreater(parkinson_recovery_fraction, atr_recovery_fraction * 2.0)
        self.assertGreater(parkinson_recovery_fraction, 0.25)

    def test_candlestick_geometry_scale_free_and_zero_division_protection(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V8_GEOMETRY

        # Standard candle with ATR = 2.0
        # Open 100, High 103, Low 99, Close 101 (body = 1, range = 4, upper_wick = 2, lower_wick = 1)
        # Prior close 100, prior high 102, prior low 98
        candle_with_atr = evidence(
            indicators=(
                IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 2.0}),
            )
        )
        vec = build_feature_vector(
            candle_with_atr,
            prior_close=100.0,
            median_volume=800.0,
            prior_high=102.0,
            prior_low=98.0,
            schema_version=FEATURE_SCHEMA_VERSION_V8_GEOMETRY,
        )

        self.assertAlmostEqual(vec["candle.body_atr_ratio"], 1.0 / 2.0, places=6)
        self.assertAlmostEqual(vec["candle.upper_wick_atr_ratio"], 2.0 / 2.0, places=6)
        self.assertAlmostEqual(vec["candle.lower_wick_atr_ratio"], 1.0 / 2.0, places=6)
        self.assertAlmostEqual(vec["candle.range_atr_ratio"], 4.0 / 2.0, places=6)
        self.assertAlmostEqual(vec["candle.close_position_within_range"], (101.0 - 99.0) / 4.0, places=6)
        self.assertAlmostEqual(vec["candle.body_to_range_ratio"], 1.0 / 4.0, places=6)
        self.assertAlmostEqual(vec["candle.upper_wick_to_range_ratio"], 2.0 / 4.0, places=6)
        self.assertAlmostEqual(vec["candle.lower_wick_to_range_ratio"], 1.0 / 4.0, places=6)
        self.assertAlmostEqual(vec["candle.gap_from_previous_close_atr"], (100.0 - 100.0) / 2.0, places=6)
        self.assertAlmostEqual(vec["candle.close_vs_previous_high_atr"], (101.0 - 102.0) / 2.0, places=6)
        self.assertAlmostEqual(vec["candle.close_vs_previous_low_atr"], (101.0 - 98.0) / 2.0, places=6)

        # Zero ATR / Zero Range protection: should safely return NaN without ZeroDivisionError
        flat_candle = CandleEvidence(
            candle_id="flat-1",
            instrument_id="inst-1",
            symbol="NIFTY50",
            timeframe="1d",
            open_time=START,
            close_time=START + timedelta(hours=6),
            open=100.0,
            high=100.0,
            low=100.0,
            close=100.0,
            volume=100.0,
            indicators=(
                IndicatorEvidence("ATR", "ta-v1", {"period": 14, "smoothing": "WILDER"}, {"value": 0.0}),
            ),
            patterns=(),
            price_action_events=(),
            future_close=100.0,
            future_close_time=START + timedelta(days=1),
        )
        flat_vec = build_feature_vector(
            flat_candle,
            prior_close=100.0,
            median_volume=100.0,
            schema_version=FEATURE_SCHEMA_VERSION_V8_GEOMETRY,
        )
        self.assertTrue(math.isnan(flat_vec["candle.body_atr_ratio"]))
        self.assertTrue(math.isnan(flat_vec["candle.close_position_within_range"]))
        self.assertTrue(math.isnan(flat_vec["candle.body_to_range_ratio"]))

    def test_v8_multi_hot_pattern_flags(self) -> None:
        from ai_quant_lab_ml.contracts import FEATURE_SCHEMA_VERSION_V8

        candle_with_patterns = evidence(
            patterns=(
                PatternEvidence("HAMMER", "candlestick-v1", "BULLISH", 0.85),
                PatternEvidence("PIERCING_LINE", "candlestick-v1", "BULLISH", 0.90),
            )
        )
        vec = build_feature_vector(
            candle_with_patterns,
            prior_close=100.0,
            median_volume=800.0,
            schema_version=FEATURE_SCHEMA_VERSION_V8,
        )

        self.assertEqual(vec["pattern.is_hammer"], 1.0)
        self.assertEqual(vec["pattern.is_piercing_line"], 1.0)
        self.assertEqual(vec["pattern.is_shooting_star"], 0.0)
        self.assertEqual(vec["pattern.is_tweezer_bottom"], 0.0)


if __name__ == "__main__":
    unittest.main()
