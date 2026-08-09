"""Deterministic, source-candle-only feature and label construction.

The feature mapping in this module is deliberately fixed.  A model trained with
``ml-feature-v2`` therefore receives the same ordered columns regardless of
which optional indicators or detections happen to exist for an individual
candle.  Absent numeric evidence is represented by ``math.nan`` and is left
for the training pipeline's imputer; this module never learns a replacement
value from future rows.

Every feature is scale-free â€” a return in basis points, a ratio, a bounded
oscillator, or a confidence.  No feature carries an absolute rupee price. On a
trending series an absolute level acts as a proxy for *time*, which lets a model
infer which era a chronological holdout belongs to and therefore its local label
distribution.  That is leakage wearing the costume of skill, and removing the
levels is the cheapest way to prevent it.
"""

from __future__ import annotations

import collections
import json
import math
import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .contracts import (
    FEATURE_SCHEMA_VERSION,
    FEATURE_SCHEMA_VERSION_SCALP,
    FEATURE_SCHEMA_VERSION_SCALP_V2,
    FEATURE_SCHEMA_VERSION_V5,
    FEATURE_SCHEMA_VERSION_V6,
    KNOWN_FEATURE_SCHEMA_VERSIONS,
    CandleEvidence,
    DatasetRequest,
    IndicatorEvidence,
    LabeledExample,
    MarketLabel,
    schema_version_for,
)
from .triple_barrier import TripleBarrierError, triple_barrier_label
from .volatility_expansion import (
    VolatilityExpansionError,
    trailing_range_of,
    volatility_expansion_label,
)


class FeatureConstructionError(ValueError):
    """Raised when evidence cannot safely become a training example."""


# Volume is normalised against its own recent median so the feature means the
# same thing in 2023 and 2026. The window is trailing and includes the scored
# bar, so it never reads a later one.
VOLUME_MEDIAN_WINDOW = 20


def trailing_feature_context(series: Sequence[tuple[float, float]]) -> tuple[float, float]:
    """Return ``(prior_close, median_volume)`` for the final bar of a series.

    ``series`` is chronological ``(close, volume)`` for consecutive completed
    candles ending with the bar being scored — the same walk
    :func:`build_labeled_examples` performs during training. Inference must use
    this helper rather than passing placeholders: a feature that is real during
    training and missing at prediction time is train/serve skew, and the imputer
    would hide it by filling in a training-fold median.
    """

    if not series:
        raise FeatureConstructionError("At least one trailing candle is required for feature context.")
    closes = [close for close, _ in series]
    volumes = [volume for _, volume in series if math.isfinite(volume)]
    prior_close = closes[-2] if len(closes) >= 2 else _nan()
    median_volume = statistics.median(volumes[-VOLUME_MEDIAN_WINDOW:]) if volumes else _nan()
    return prior_close, median_volume


_CANDLE_FEATURES: tuple[str, ...] = (
    "candle.close_return_bps",
    "candle.overnight_gap_bps",
    "candle.high_atr_ratio",
    "candle.low_atr_ratio",
    "candle.volume_median_ratio",
    "candle.body_return_bps",
    "candle.range_bps",
    "candle.upper_wick_bps",
    "candle.lower_wick_bps",
    "candle.gap_fill_bps",
    "candle.is_gap_defended",
)

# Institutional cash flow, normalised to be scale-free and era-robust. Both are
# populated by ``PostgresMlRepository._load_institutional_flow``, which enforces
# the point-in-time rule that matters here: flows for session D are published
# *after* D closes, so a bar may only read a print from a strictly earlier session.
#
# ``market.gift_nifty_implied_gap_bps`` used to sit alongside these. It is gone:
# nothing populated it, so it was a guaranteed-NaN column in both training and
# inference. Re-add it together with a loader once a real offshore feed exists --
# a declared column with no source is worse than an absent one, because it enters
# the versioned contract and forces a retrain while contributing nothing.
_LEGACY_MARKET_FEATURES: tuple[str, ...] = (
    "market.fii_net_flow_ratio",
    "market.dii_net_flow_ratio",
)

_MARKET_FEATURES: tuple[str, ...] = _LEGACY_MARKET_FEATURES + (
    "market.fii_futures_net_flow_ratio",
    "market.fii_options_net_flow_ratio",
)

# The three gap columns describe a session boundary, so inside a session they are
# not merely uninformative but actively misleading:
#
# * ``overnight_gap_bps`` compares the bar's open to the *previous bar's* close.
#   On a continuously quoted index that is ~0 on essentially every intraday bar.
# * ``is_gap_defended`` is gated on |gap| > 20bps, which minute-to-minute never
#   fires, making the column a constant 0.0 — zero information.
# * ``gap_fill_bps`` is the harmful one. It means open->low when the gap is
#   positive and open->high when it is negative, so at 1m, where the gap sign is
#   noise, a single column carries two opposite meanings selected at random. It
#   also duplicates upper_wick_bps / lower_wick_bps.
#
# ``volume_median_ratio`` is deliberately retained. It is the right normalisation
# for scalping the moment the feed carries real volume; note that Yahoo's ^NSEI
# 1m series reports zero volume on every bar, so against that source the column
# imputes to a constant and contributes nothing.
_SCALP_EXCLUDED_CANDLE_FEATURES: frozenset[str] = frozenset(
    {"candle.overnight_gap_bps", "candle.gap_fill_bps", "candle.is_gap_defended"}
)

_SCALP_CANDLE_FEATURES: tuple[str, ...] = tuple(
    name for name in _CANDLE_FEATURES if name not in _SCALP_EXCLUDED_CANDLE_FEATURES
)

_INDICATOR_VALUE_FIELDS: Mapping[str, tuple[str, ...]] = {
    "SMA": ("value_bps",),
    "EMA": ("value_bps",),
    "RSI": ("value",),
    "MACD": ("macd", "signal", "histogram"),
    "ATR": ("value_ratio",),
    "VWAP": ("value_bps",),
    # The band standard deviation is a rupee amount, so it is carried as a
    # fraction of close. As a raw level it would encode the price era exactly the
    # way an absolute close does.
    "BOLLINGER_BANDS": ("middle_bps", "upper_bps", "lower_bps", "standardDeviation_ratio"),
    "SUPERTREND": ("value_bps", "upperBand_bps", "lowerBand_bps"),
}

# These definitions are part of ml-feature-v1, not runtime knobs.  Changing a
# period, smoothing method, reset rule, or multiplier changes feature meaning
# and therefore requires a new feature schema version.
_INDICATOR_PARAMETERS: Mapping[str, Mapping[str, Any]] = {
    "SMA": {"period": 20},
    "EMA": {"period": 20},
    "RSI": {"period": 14, "smoothing": "WILDER"},
    "MACD": {"fastPeriod": 12, "slowPeriod": 26, "signalPeriod": 9},
    "ATR": {"period": 14, "smoothing": "WILDER"},
    "VWAP": {"reset": "NSE_SESSION"},
    "BOLLINGER_BANDS": {"period": 20, "standardDeviations": 2},
    "SUPERTREND": {"atrPeriod": 10, "multiplier": 3},
}

_PATTERN_CODES: tuple[str, ...] = (
    "DOJI",
    "HAMMER",
    "HANGING_MAN",
    "SHOOTING_STAR",
    "BULLISH_ENGULFING",
    "BEARISH_ENGULFING",
    "MORNING_STAR",
    "EVENING_STAR",
    "BULLISH_HARAMI",
    "BEARISH_HARAMI",
    "THREE_WHITE_SOLDIERS",
    "THREE_BLACK_CROWS",
    "INSIDE_BAR",
    "OUTSIDE_BAR",
)

_PRICE_ACTION_EVENT_TYPES: tuple[str, ...] = (
    "BREAKOUT",
    "BREAKDOWN",
    "SUPPORT",
    "RESISTANCE",
    "UPTREND",
    "DOWNTREND",
    "RANGE",
    "PULLBACK",
    "SWING_HIGH",
    "SWING_LOW",
)

_DIRECTIONS: tuple[str, ...] = ("BULLISH", "BEARISH", "NEUTRAL")


def _build_feature_schema_v5() -> tuple[str, ...]:
    indicator_features = tuple(
        f"indicator.{code}.{field}"
        for code, fields in _INDICATOR_VALUE_FIELDS.items()
        for field in fields
    )
    supertrend_features = ("indicator.SUPERTREND.trend_up", "indicator.SUPERTREND.trend_down")
    pattern_features = tuple(
        f"pattern.{code}.{direction.lower()}_confidence"
        for code in _PATTERN_CODES
        for direction in _DIRECTIONS
    )
    price_action_features = tuple(
        f"price_action.{event_type}.{direction.lower()}_confidence"
        for event_type in _PRICE_ACTION_EVENT_TYPES
        for direction in _DIRECTIONS
    ) + tuple(
        f"price_action.{event_type}.level_distance_bps" for event_type in _PRICE_ACTION_EVENT_TYPES
    )
    regime_features = ("regime.vix_sma20.value_ratio",)
    return _CANDLE_FEATURES + indicator_features + supertrend_features + pattern_features + price_action_features + regime_features + _LEGACY_MARKET_FEATURES

def _build_feature_schema_scalp(market_features: tuple[str, ...]) -> tuple[str, ...]:
    indicator_features = tuple(
        f"indicator.{code}.{field}"
        for code, fields in _INDICATOR_VALUE_FIELDS.items()
        for field in fields
    )
    supertrend_features = ("indicator.SUPERTREND.trend_up", "indicator.SUPERTREND.trend_down")
    return _SCALP_CANDLE_FEATURES + indicator_features + supertrend_features + market_features


# The v6 swing schema: 36 columns against v5's 113. Explicit rather than
# generated, because the whole point of the version is *which columns exist*;
# a builder that derives the list from shared tables invites an accidental
# contract change when a table gains an entry.
#
# What changed against v5, and why:
#
# * The 42 pattern and 30 price-action confidence one-hots collapse into four
#   aggregate scores. On daily NIFTY50 those blocks are zero on the vast
#   majority of rows, and 72 near-constant columns are variance for the
#   imputer and noise for the fold estimates while carrying at most "some
#   bullish/bearish detection fired, this strongly".
# * The two SUPPORT/RESISTANCE level distances survive as the only per-event
#   columns: they are the price-action block's dense structural content.
# * Bollinger middle/upper/lower are gone: middle *is* SMA20, and the bands
#   are middle +/- 2 standard deviations, so given `indicator.SMA.value_bps`
#   and the deviation ratio all three are exact linear combinations. The same
#   reasoning removes the SuperTrend band levels in favour of its line and
#   trend flags.
# * VWAP is gone from the swing schema: with one bar per session, a
#   session-reset VWAP is the bar's typical price restated, and on index
#   series the volume weighting is meaningless because index "volume" is
#   synthetic or zero.
# * `candle.gap_fill_bps` and `candle.is_gap_defended` are gone. The dual
#   meaning of gap_fill (open->low on up-gaps, open->high on down-gaps) makes
#   one column carry two opposite quantities on every timeframe, not just
#   intraday; the wick columns already carry the same evidence unambiguously.
# * Seven point-in-time breadth columns arrive from the twenty-equity research
#   panel and the two indices (Phase 25, Workstream B4). Their sources,
#   windows, and floors are part of the contract; see the BREADTH_* constants.
FEATURE_SCHEMA_V6: tuple[str, ...] = (
    "candle.close_return_bps",
    "candle.overnight_gap_bps",
    "candle.high_atr_ratio",
    "candle.low_atr_ratio",
    "candle.volume_median_ratio",
    "candle.body_return_bps",
    "candle.range_bps",
    "candle.upper_wick_bps",
    "candle.lower_wick_bps",
    "indicator.SMA.value_bps",
    "indicator.EMA.value_bps",
    "indicator.RSI.value",
    "indicator.MACD.macd",
    "indicator.MACD.signal",
    "indicator.MACD.histogram",
    "indicator.ATR.value_ratio",
    "indicator.BOLLINGER_BANDS.standardDeviation_ratio",
    "indicator.SUPERTREND.value_bps",
    "indicator.SUPERTREND.trend_up",
    "indicator.SUPERTREND.trend_down",
    "pattern.bullish_confidence",
    "pattern.bearish_confidence",
    "price_action.bullish_confidence",
    "price_action.bearish_confidence",
    "price_action.SUPPORT.level_distance_bps",
    "price_action.RESISTANCE.level_distance_bps",
    "regime.vix_sma20.value_ratio",
    "market.fii_net_flow_ratio",
    "market.dii_net_flow_ratio",
    "breadth.advance_decline_ratio",
    "breadth.median_return_bps",
    "breadth.return_dispersion_bps",
    "breadth.above_sma20_ratio",
    "breadth.median_volume_ratio",
    "breadth.bank_it_spread_bps",
    "cross.nifty_banknifty_return_gap_bps",
)

# Futures/options institutional flows change the ordered contract. They belong to
# v7 rather than silently changing every existing v6 artifact from 36 to 38 columns.
FEATURE_SCHEMA_V7: tuple[str, ...] = (
    FEATURE_SCHEMA_V6[:29]
    + ("market.fii_futures_net_flow_ratio", "market.fii_options_net_flow_ratio")
    + FEATURE_SCHEMA_V6[29:]
)

# A tuple, rather than a data-dependent list, is the versioned model contract.
# FEATURE_SCHEMA is always the *current* swing schema; the v5 tuple stays
# importable because v5 artifacts remain loadable and their feature vectors
# must be reconstructible bit-for-bit at inference.
FEATURE_SCHEMA_V5: tuple[str, ...] = _build_feature_schema_v5()
FEATURE_SCHEMA: tuple[str, ...] = FEATURE_SCHEMA_V7
FEATURE_SCHEMA_SCALP_V2: tuple[str, ...] = _build_feature_schema_scalp(_LEGACY_MARKET_FEATURES)
FEATURE_SCHEMA_SCALP: tuple[str, ...] = _build_feature_schema_scalp(_MARKET_FEATURES)

# The ordered contract for every schema version this codebase can construct.
# An unknown version is a hard error rather than a silent fallback: falling
# back to "the current swing schema" is exactly how a v5 artifact would end up
# scored against v6 columns.
_SCHEMA_BY_VERSION: Mapping[str, tuple[str, ...]] = {
    FEATURE_SCHEMA_VERSION: FEATURE_SCHEMA_V7,
    FEATURE_SCHEMA_VERSION_V6: FEATURE_SCHEMA_V6,
    FEATURE_SCHEMA_VERSION_V5: FEATURE_SCHEMA_V5,
    FEATURE_SCHEMA_VERSION_SCALP: FEATURE_SCHEMA_SCALP,
    FEATURE_SCHEMA_VERSION_SCALP_V2: FEATURE_SCHEMA_SCALP_V2,
}
assert set(_SCHEMA_BY_VERSION) == set(KNOWN_FEATURE_SCHEMA_VERSIONS)


def _definition_for(schema_version: str) -> dict[str, Any]:
    return {
        "schemaVersion": schema_version,
        "features": list(_SCHEMA_BY_VERSION[schema_version]),
        "indicatorAlgorithmVersion": "ta-v1",
        "indicatorParameters": {code: dict(parameters) for code, parameters in _INDICATOR_PARAMETERS.items()},
        "patternAlgorithmVersion": "candlestick-v1",
        "priceActionAlgorithmVersion": "price-action-v2",
    }


_FEATURE_DEFINITION_BY_VERSION: Mapping[str, dict[str, Any]] = {
    version: _definition_for(version) for version in _SCHEMA_BY_VERSION
}

# Kept as convenient JSON-safe public constants.  Runtime code should call
# feature_definition() so an accidental caller mutation cannot affect future
# artifact metadata.
FEATURE_DEFINITION: dict[str, Any] = json.loads(json.dumps(_FEATURE_DEFINITION_BY_VERSION[FEATURE_SCHEMA_VERSION], sort_keys=True))
FEATURE_DEFINITION_SCALP: dict[str, Any] = json.loads(json.dumps(_FEATURE_DEFINITION_BY_VERSION[FEATURE_SCHEMA_VERSION_SCALP], sort_keys=True))


def _require_known_version(schema_version: str) -> str:
    if schema_version not in _SCHEMA_BY_VERSION:
        raise FeatureConstructionError(
            f"Unknown feature-schema version {schema_version!r}; "
            f"known versions are {', '.join(KNOWN_FEATURE_SCHEMA_VERSIONS)}."
        )
    return schema_version


def feature_schema(schema_version: str = FEATURE_SCHEMA_VERSION) -> tuple[str, ...]:
    """Return the immutable ordered feature names for a given schema version."""

    return _SCHEMA_BY_VERSION[_require_known_version(schema_version)]


def feature_definition(schema_version: str = FEATURE_SCHEMA_VERSION) -> dict[str, Any]:
    """Return an independent JSON-safe description of the contract."""

    return json.loads(json.dumps(_FEATURE_DEFINITION_BY_VERSION[_require_known_version(schema_version)], sort_keys=True))


@dataclass(frozen=True)
class LabelResult:
    """The target derived from a later close; ``forward_return`` is fractional."""

    forward_return: float
    label: MarketLabel


def _nan() -> float:
    return float("nan")


def _numeric_or_nan(value: Any) -> float:
    """Return finite numeric evidence or a missing-value marker.

    Database adapters normally deserialize numeric JSON values as ``int`` or
    ``float``.  Numeric strings are also accepted defensively, while booleans
    and categorical values remain missing rather than being coerced to 0/1.
    """

    if value is None or isinstance(value, bool):
        return _nan()
    if isinstance(value, (int, float)):
        numeric = float(value)
    elif isinstance(value, str):
        try:
            numeric = float(value)
        except ValueError:
            return _nan()
    else:
        return _nan()
    return numeric if math.isfinite(numeric) else _nan()


def _source_number(value: Any, name: str) -> float:
    numeric = _numeric_or_nan(value)
    if math.isnan(numeric):
        raise FeatureConstructionError(f"Source candle field {name} must be a finite numeric value.")
    return numeric


def _ratio_bps(numerator: float, denominator: float) -> float:
    if not math.isfinite(numerator) or not math.isfinite(denominator) or denominator == 0:
        return _nan()
    # Subtract before dividing to avoid unnecessary cancellation for values
    # that are close together, such as an OHLC body return near zero.
    return ((numerator - denominator) / denominator) * 10_000.0


def _canonical_json(value: Mapping[str, Any]) -> str:
    """Stable ordering for duplicate evidence selection without data-order bias."""

    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _indicator_sort_key(evidence: IndicatorEvidence) -> tuple[str, str, str]:
    return (evidence.algorithm_version, _canonical_json(evidence.parameters), _canonical_json(evidence.values))


def _first_indicator_by_code(
    indicators: Sequence[IndicatorEvidence],
    code: str,
    algorithm_version: str,
) -> IndicatorEvidence | None:
    candidates = [
        candidate
        for candidate in indicators
        if (
            candidate.code.upper() == code
            and candidate.algorithm_version == algorithm_version
            and dict(candidate.parameters) == dict(_INDICATOR_PARAMETERS[code])
        )
    ]
    return min(candidates, key=_indicator_sort_key) if candidates else None


def _maximum_confidence(values: Iterable[float]) -> float:
    finite_values = [value for value in values if math.isfinite(value)]
    return max(finite_values, default=0.0)


def build_feature_vector(
    candle: CandleEvidence,
    *,
    prior_close: float,
    median_volume: float,
    schema_version: str = FEATURE_SCHEMA_VERSION,
    indicator_algorithm_version: str = "ta-v1",
    pattern_algorithm_version: str = "candlestick-v1",
    price_action_algorithm_version: str = "price-action-v2",
) -> dict[str, float]:
    """Build the full fixed feature mapping from one source candle's evidence.

    This function intentionally does not inspect ``future_close`` or
    ``future_close_time``.  Those fields are label-only and are handled by
    :func:`label_from_future_close`.
    """

    open_price = _source_number(candle.open, "open")
    high_price = _source_number(candle.high, "high")
    low_price = _source_number(candle.low, "low")
    close_price = _source_number(candle.close, "close")
    volume = _source_number(candle.volume, "volume")

    atr_indicator = _first_indicator_by_code(candle.indicators, "ATR", indicator_algorithm_version)
    atr_val = _numeric_or_nan(atr_indicator.values.get("value")) if atr_indicator else _nan()

    overnight_gap_bps = _ratio_bps(open_price, prior_close)

    # Calculate Gap Fill & Gap Defense
    gap_fill_bps = _nan()
    is_gap_defended = 0.0
    if math.isfinite(overnight_gap_bps):
        if overnight_gap_bps > 0:
            gap_fill_bps = _ratio_bps(low_price, open_price)
            if overnight_gap_bps > 20.0:
                gap_half_price = prior_close + (open_price - prior_close) * 0.5
                if low_price >= gap_half_price:
                    is_gap_defended = 1.0
        elif overnight_gap_bps < 0:
            gap_fill_bps = _ratio_bps(high_price, open_price)
            if overnight_gap_bps < -20.0:
                gap_half_price = prior_close + (open_price - prior_close) * 0.5
                if high_price <= gap_half_price:
                    is_gap_defended = 1.0

    schema_keys = feature_schema(schema_version)
    values: dict[str, float] = {name: _nan() for name in schema_keys}
    values.update(
        {
            "candle.close_return_bps": _ratio_bps(close_price, prior_close),
            "candle.overnight_gap_bps": overnight_gap_bps,
            "candle.high_atr_ratio": (high_price - close_price) / atr_val if atr_val > 0 else _nan(),
            "candle.low_atr_ratio": (close_price - low_price) / atr_val if atr_val > 0 else _nan(),
            "candle.volume_median_ratio": volume / median_volume if median_volume > 0 else _nan(),
            "candle.body_return_bps": _ratio_bps(close_price, open_price),
            "candle.range_bps": _ratio_bps(high_price, low_price),
            "candle.upper_wick_bps": _ratio_bps(high_price, max(open_price, close_price)),
            "candle.lower_wick_bps": _ratio_bps(min(open_price, close_price), low_price),
            "candle.gap_fill_bps": gap_fill_bps,
            "candle.is_gap_defended": is_gap_defended,
            "market.fii_net_flow_ratio": _numeric_or_nan(candle.fii_net_flow_ratio),
            "market.dii_net_flow_ratio": _numeric_or_nan(candle.dii_net_flow_ratio),
            "market.fii_futures_net_flow_ratio": _numeric_or_nan(candle.fii_futures_net_flow_ratio),
            "market.fii_options_net_flow_ratio": _numeric_or_nan(candle.fii_options_net_flow_ratio),
            "regime.vix_sma20.value_ratio": _numeric_or_nan(candle.vix_value_ratio),
        }
    )

    for code, output_fields in _INDICATOR_VALUE_FIELDS.items():
        indicator = _first_indicator_by_code(candle.indicators, code, indicator_algorithm_version)
        if indicator is None:
            continue
        for field in output_fields:
            raw_field = field.replace("_bps", "").replace("_ratio", "")
            raw_val = _numeric_or_nan(indicator.values.get(raw_field))
            
            if field.endswith("_bps"):
                # A level indicator becomes a signed distance from close in bps.
                final_val = _ratio_bps(raw_val, close_price)
            elif field.endswith("_ratio"):
                # A rupee magnitude (ATR, band width) becomes a fraction of close.
                final_val = raw_val / close_price if close_price > 0 else _nan()
            else:
                final_val = raw_val
                
            values[f"indicator.{code}.{field}"] = final_val

        if code == "SUPERTREND":
            trend = indicator.values.get("trend")
            if isinstance(trend, str) and trend.upper() == "UP":
                values["indicator.SUPERTREND.trend_up"] = 1.0
                values["indicator.SUPERTREND.trend_down"] = 0.0
            elif isinstance(trend, str) and trend.upper() == "DOWN":
                values["indicator.SUPERTREND.trend_up"] = 0.0
                values["indicator.SUPERTREND.trend_down"] = 1.0

    for pattern_code in _PATTERN_CODES:
        matching = [
            pattern
            for pattern in candle.patterns
            if pattern.code.upper() == pattern_code and pattern.algorithm_version == pattern_algorithm_version
        ]
        for direction in _DIRECTIONS:
            confidences = (
                _numeric_or_nan(pattern.confidence)
                for pattern in matching
                if pattern.direction.upper() == direction
            )
            values[f"pattern.{pattern_code}.{direction.lower()}_confidence"] = _maximum_confidence(confidences)

    for event_type in _PRICE_ACTION_EVENT_TYPES:
        matching = [
            event
            for event in candle.price_action_events
            if event.event_type.upper() == event_type and event.algorithm_version == price_action_algorithm_version
        ]
        for direction in _DIRECTIONS:
            confidences = (
                _numeric_or_nan(event.confidence)
                for event in matching
                if event.direction.upper() == direction
            )
            values[f"price_action.{event_type}.{direction.lower()}_confidence"] = _maximum_confidence(confidences)

        level_candidates = [
            event
            for event in matching
            if math.isfinite(_numeric_or_nan(event.level)) and math.isfinite(_numeric_or_nan(event.confidence))
        ]
        if level_candidates:
            # Ties are resolved by level, direction and version rather than input order.
            level_event = min(
                level_candidates,
                key=lambda event: (-_numeric_or_nan(event.confidence), _numeric_or_nan(event.level), event.direction, event.algorithm_version),
            )
            values[f"price_action.{event_type}.level_distance_bps"] = _ratio_bps(
                _numeric_or_nan(level_event.level), close_price
            )

    # v6 aggregates: the strongest bullish and bearish detection across the
    # whole block, replacing the per-code/per-type one-hots. The default 0.0
    # (not NaN) keeps the v5 convention that "nothing fired" is evidence of
    # absence, not a missing measurement. Computed unconditionally; the final
    # schema filter drops them for versions that do not declare them.
    values["pattern.bullish_confidence"] = _maximum_confidence(
        _numeric_or_nan(pattern.confidence)
        for pattern in candle.patterns
        if pattern.algorithm_version == pattern_algorithm_version and pattern.direction.upper() == "BULLISH"
    )
    values["pattern.bearish_confidence"] = _maximum_confidence(
        _numeric_or_nan(pattern.confidence)
        for pattern in candle.patterns
        if pattern.algorithm_version == pattern_algorithm_version and pattern.direction.upper() == "BEARISH"
    )
    values["price_action.bullish_confidence"] = _maximum_confidence(
        _numeric_or_nan(event.confidence)
        for event in candle.price_action_events
        if event.algorithm_version == price_action_algorithm_version and event.direction.upper() == "BULLISH"
    )
    values["price_action.bearish_confidence"] = _maximum_confidence(
        _numeric_or_nan(event.confidence)
        for event in candle.price_action_events
        if event.algorithm_version == price_action_algorithm_version and event.direction.upper() == "BEARISH"
    )

    # v6 breadth: attached by the repository as the latest settled panel
    # session at or before this bar's close. None -- either no context or an
    # unmeasurable member statistic -- stays NaN for the imputer, because "the
    # panel was not observable" is missing evidence, unlike a silent zero.
    breadth = candle.breadth
    values["breadth.advance_decline_ratio"] = _numeric_or_nan(None if breadth is None else breadth.advance_decline)
    values["breadth.median_return_bps"] = _numeric_or_nan(None if breadth is None else breadth.median_return_bps)
    values["breadth.return_dispersion_bps"] = _numeric_or_nan(None if breadth is None else breadth.return_dispersion_bps)
    values["breadth.above_sma20_ratio"] = _numeric_or_nan(None if breadth is None else breadth.above_sma20_share)
    values["breadth.median_volume_ratio"] = _numeric_or_nan(None if breadth is None else breadth.median_volume_ratio)
    values["breadth.bank_it_spread_bps"] = _numeric_or_nan(None if breadth is None else breadth.bank_it_spread_bps)
    values["cross.nifty_banknifty_return_gap_bps"] = _numeric_or_nan(None if breadth is None else breadth.index_return_gap_bps)

    return {k: v for k, v in values.items() if k in schema_keys}


def label_from_future_close(
    *, source_close: float, future_close: float | None, neutral_threshold_bps: float
) -> LabelResult | None:
    """Create a three-class target from a later close and a symmetric neutral band.

    ``forward_return`` is stored as a fractional return (for example ``0.01``
    for +1%), while classification uses basis points.  Values exactly on either
    threshold stay ``NEUTRAL`` so the neutral band is inclusive.
    """

    if neutral_threshold_bps < 0 or not math.isfinite(neutral_threshold_bps):
        raise FeatureConstructionError("neutral_threshold_bps must be a finite value greater than or equal to zero.")
    if future_close is None:
        return None
    source = _source_number(source_close, "close")
    future = _source_number(future_close, "future_close")
    if source <= 0 or future <= 0:
        raise FeatureConstructionError("close and future_close must both be greater than zero.")

    forward_return = future / source - 1.0
    threshold = neutral_threshold_bps / 10_000.0
    # A tolerance prevents binary floating-point representation from turning an
    # exact boundary such as 101 / 100 at a 100-bps threshold into BULLISH.
    boundary_tolerance = 1e-12
    if forward_return - threshold > boundary_tolerance:
        label: MarketLabel = "BULLISH"
    elif -threshold - forward_return > boundary_tolerance:
        label = "BEARISH"
    else:
        label = "NEUTRAL"
    return LabelResult(forward_return=forward_return, label=label)


def _validate_request(request: DatasetRequest) -> None:
    if not request.instrument_symbol.strip():
        raise FeatureConstructionError("instrument_symbol cannot be blank.")
    if not request.timeframe.strip():
        raise FeatureConstructionError("timeframe cannot be blank.")
    if request.data_window_end <= request.data_window_start:
        raise FeatureConstructionError("data_window_end must be after data_window_start.")
    if request.data_window_end > request.data_cutoff_at:
        raise FeatureConstructionError("data_window_end must not be later than data_cutoff_at.")
    if isinstance(request.horizon_bars, bool) or not isinstance(request.horizon_bars, int) or request.horizon_bars <= 0:
        raise FeatureConstructionError("horizon_bars must be a positive integer.")
    if (
        isinstance(request.neutral_threshold_bps, bool)
        or not isinstance(request.neutral_threshold_bps, (int, float))
        or request.neutral_threshold_bps < 0
        or not math.isfinite(request.neutral_threshold_bps)
    ):
        raise FeatureConstructionError("neutral_threshold_bps must be finite and greater than or equal to zero.")
    if not request.indicator_algorithm_version.strip():
        raise FeatureConstructionError("indicator_algorithm_version cannot be blank.")
    if not request.pattern_algorithm_version.strip():
        raise FeatureConstructionError("pattern_algorithm_version cannot be blank.")
    if not request.price_action_algorithm_version.strip():
        raise FeatureConstructionError("price_action_algorithm_version cannot be blank.")


def _validate_evidence_scope(candle: CandleEvidence, request: DatasetRequest) -> None:
    requested_symbol = request.instrument_symbol.strip().upper()
    if candle.symbol.strip().upper() != requested_symbol:
        raise FeatureConstructionError(
            f"Candle {candle.candle_id} belongs to {candle.symbol}, not requested symbol {request.instrument_symbol}."
        )
    if candle.timeframe != request.timeframe:
        raise FeatureConstructionError(
            f"Candle {candle.candle_id} has timeframe {candle.timeframe}, not requested timeframe {request.timeframe}."
        )
    if candle.open_time < request.data_window_start or candle.close_time > request.data_window_end:
        raise FeatureConstructionError(f"Candle {candle.candle_id} falls outside the requested data window.")
    if candle.close_time <= candle.open_time:
        raise FeatureConstructionError(f"Candle {candle.candle_id} must close after it opens.")


def build_labeled_examples(records: Sequence[CandleEvidence], request: DatasetRequest) -> list[LabeledExample]:
    """Turn adapter-provided evidence into chronologically ordered labeled examples.

    Records without a future close are intentionally omitted: they are valid
    latest observations but have no known target yet.  The adapter is expected
    to attach a future close exactly ``request.horizon_bars`` after each source
    candle and to enforce the immutable data cutoff before calling this pure
    function.
    """

    _validate_request(request)
    examples: list[LabeledExample] = []

    # The window advances one bar at a time, so a feature can only ever see bars
    # at or before the candle it describes.
    volume_window: collections.deque[float] = collections.deque(maxlen=VOLUME_MEDIAN_WINDOW)
    prior_close = _nan()
    
    # Process chronologically so relative metrics work correctly
    sorted_records = sorted(records, key=lambda c: c.close_time)

    for candle in sorted_records:
        current_volume = _source_number(candle.volume, "volume")
        if math.isfinite(current_volume):
            volume_window.append(current_volume)
        median_volume = statistics.median(volume_window) if volume_window else _nan()
        
        try:
            _validate_evidence_scope(candle, request)
        except FeatureConstructionError:
            prior_close = _source_number(candle.close, "close")
            continue
            
        label_result = label_from_future_close(
            source_close=candle.close,
            future_close=candle.future_close,
            neutral_threshold_bps=request.neutral_threshold_bps,
        )
        if label_result is None:
            prior_close = _source_number(candle.close, "close")
            continue
        if candle.future_close_time is None:
            raise FeatureConstructionError(
                f"Candle {candle.candle_id} has future_close but no future_close_time for label availability."
            )
        if candle.future_close_time <= candle.close_time:
            raise FeatureConstructionError(f"Candle {candle.candle_id} future_close_time must be after close_time.")
        if candle.future_close_time > request.data_window_end:
            raise FeatureConstructionError(f"Candle {candle.candle_id} label falls outside the requested data window.")

        schema_version = schema_version_for(request.timeframe)
        examples.append(
            LabeledExample(
                candle_id=candle.candle_id,
                instrument_id=candle.instrument_id,
                symbol=candle.symbol,
                timeframe=candle.timeframe,
                observed_at=candle.close_time,
                label_available_at=candle.future_close_time,
                forward_return=label_result.forward_return,
                label=label_result.label,
                features=build_feature_vector(
                    candle,
                    prior_close=prior_close,
                    median_volume=median_volume,
                    schema_version=schema_version,
                    indicator_algorithm_version=request.indicator_algorithm_version,
                    pattern_algorithm_version=request.pattern_algorithm_version,
                    price_action_algorithm_version=request.price_action_algorithm_version,
                ),
                vix_observed_at=candle.vix_observed_at,
            )
        )
        prior_close = _source_number(candle.close, "close")

    return sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))


def build_triple_barrier_examples(records: Sequence[CandleEvidence], request: DatasetRequest) -> list[LabeledExample]:
    """Turn evidence into labeled examples under the triple-barrier scheme.

    The parallel of :func:`build_labeled_examples`: the chronological walk, the
    feature construction, and the as-of discipline are identical, so this shares
    :func:`build_feature_vector` and the same validation. Only the *label* differs
    -- it comes from :func:`triple_barrier_label` over ``candle.forward_path``, with
    the profit/stop barriers scaled to the source bar's ATR.

    A candle is skipped (not an error) when it has no usable ATR, no forward path
    yet, or a same-bar double touch the OHLC cannot order -- the same "omit what
    cannot be labelled" rule the fixed-horizon builder applies to a missing future
    close. ``label_available_at`` is the barrier-touch time, which the split's
    purge gap must cover by setting ``horizon_bars`` to the vertical-barrier count.
    """

    _validate_request(request)
    if not (math.isfinite(request.barrier_upper_multiple) and request.barrier_upper_multiple > 0):
        raise FeatureConstructionError("barrier_upper_multiple must be finite and greater than zero.")
    if not (math.isfinite(request.barrier_lower_multiple) and request.barrier_lower_multiple > 0):
        raise FeatureConstructionError("barrier_lower_multiple must be finite and greater than zero.")

    examples: list[LabeledExample] = []
    volume_window: collections.deque[float] = collections.deque(maxlen=VOLUME_MEDIAN_WINDOW)
    prior_close = _nan()
    sorted_records = sorted(records, key=lambda candle: candle.close_time)

    for candle in sorted_records:
        current_volume = _source_number(candle.volume, "volume")
        if math.isfinite(current_volume):
            volume_window.append(current_volume)
        median_volume = statistics.median(volume_window) if volume_window else _nan()

        try:
            _validate_evidence_scope(candle, request)
        except FeatureConstructionError:
            prior_close = _source_number(candle.close, "close")
            continue

        source_close = _source_number(candle.close, "close")
        atr_indicator = _first_indicator_by_code(candle.indicators, "ATR", request.indicator_algorithm_version)
        atr_value = _numeric_or_nan(atr_indicator.values.get("value")) if atr_indicator else _nan()
        # A barrier cannot be placed without a volatility scale. Missing ATR is a
        # skip, not a failure -- the same treatment a missing label gets.
        if source_close <= 0 or not (math.isfinite(atr_value) and atr_value > 0):
            prior_close = source_close
            continue

        try:
            result = triple_barrier_label(
                source_close=source_close,
                atr=atr_value,
                upper_multiple=request.barrier_upper_multiple,
                lower_multiple=request.barrier_lower_multiple,
                forward_path=candle.forward_path,
            )
        except TripleBarrierError as error:
            raise FeatureConstructionError(f"Candle {candle.candle_id} has a malformed forward path: {error}") from error
        if result is None:
            # No forward path yet, or a same-bar double touch: unlabelable, omit.
            prior_close = source_close
            continue

        # Right-censoring guard. A NEUTRAL means "no barrier within the window",
        # but if the available path is shorter than the vertical barrier the run
        # simply ended early -- a later bar could still have touched a barrier, so
        # this is unknown, not a genuine time-out. A horizontal touch inside a
        # short path is still valid (the barrier was reached before data ran out).
        if result.touched == "VERTICAL" and len(candle.forward_path) < request.horizon_bars:
            prior_close = source_close
            continue

        if result.touch_close_time <= candle.close_time:
            raise FeatureConstructionError(f"Candle {candle.candle_id} barrier touch must be after its close time.")
        if result.touch_close_time > request.data_window_end:
            raise FeatureConstructionError(f"Candle {candle.candle_id} label falls outside the requested data window.")

        schema_version = schema_version_for(request.timeframe)
        examples.append(
            LabeledExample(
                candle_id=candle.candle_id,
                instrument_id=candle.instrument_id,
                symbol=candle.symbol,
                timeframe=candle.timeframe,
                observed_at=candle.close_time,
                label_available_at=result.touch_close_time,
                forward_return=result.forward_return,
                label=result.label,
                features=build_feature_vector(
                    candle,
                    prior_close=prior_close,
                    median_volume=median_volume,
                    schema_version=schema_version,
                    indicator_algorithm_version=request.indicator_algorithm_version,
                    pattern_algorithm_version=request.pattern_algorithm_version,
                    price_action_algorithm_version=request.price_action_algorithm_version,
                ),
                vix_observed_at=candle.vix_observed_at,
            )
        )
        prior_close = source_close

    return sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))


def build_volatility_expansion_examples(
    records: Sequence[CandleEvidence], request: DatasetRequest
) -> list[LabeledExample]:
    """Turn evidence into labeled examples under the volatility-expansion scheme.

    Shares the chronological walk, the feature vector, and the as-of validation with
    the other builders; only the label differs. ``request.horizon_bars`` is used for
    **both** windows -- the trailing range is the K bars ending at the source bar and
    the forward range is the K bars after it -- because equal windows make the ratio
    directly interpretable as "wider or narrower than the recent past".

    The trailing window is built from bars already walked, so it can never contain
    future information. A candle is skipped when the trailing window is not yet full
    (no scale to compare against) or the label is censored.

    The returned labels are CONTRACTION/STABLE/EXPANSION, **not** the directional
    alphabet, so callers must pass ``VOLATILITY_ALPHABET`` to training, evaluation,
    and persistence.
    """

    _validate_request(request)
    window = request.horizon_bars
    examples: list[LabeledExample] = []
    volume_window: collections.deque[float] = collections.deque(maxlen=VOLUME_MEDIAN_WINDOW)
    trailing_highs: collections.deque[float] = collections.deque(maxlen=window)
    trailing_lows: collections.deque[float] = collections.deque(maxlen=window)
    prior_close = _nan()
    sorted_records = sorted(records, key=lambda candle: candle.close_time)

    for candle in sorted_records:
        current_volume = _source_number(candle.volume, "volume")
        if math.isfinite(current_volume):
            volume_window.append(current_volume)
        median_volume = statistics.median(volume_window) if volume_window else _nan()

        source_close = _source_number(candle.close, "close")
        # The trailing window advances for every candle, including ones that fail
        # scope validation, so the envelope stays a true picture of recent range.
        trailing_highs.append(_source_number(candle.high, "high"))
        trailing_lows.append(_source_number(candle.low, "low"))

        try:
            _validate_evidence_scope(candle, request)
        except FeatureConstructionError:
            prior_close = source_close
            continue

        if len(trailing_highs) < window:
            prior_close = source_close
            continue

        try:
            result = volatility_expansion_label(
                trailing_range=trailing_range_of(list(trailing_highs), list(trailing_lows)),
                forward_path=candle.forward_path,
                expected_forward_bars=window,
                band=request.expansion_band,
            )
        except VolatilityExpansionError as error:
            raise FeatureConstructionError(
                f"Candle {candle.candle_id} has a malformed forward path: {error}"
            ) from error
        if result is None:
            prior_close = source_close
            continue

        label_available_at = result.label_available_at
        if label_available_at <= candle.close_time:
            raise FeatureConstructionError(
                f"Candle {candle.candle_id} label must become known after its close time."
            )
        if label_available_at > request.data_window_end:
            raise FeatureConstructionError(
                f"Candle {candle.candle_id} label falls outside the requested data window."
            )

        examples.append(
            LabeledExample(
                candle_id=candle.candle_id,
                instrument_id=candle.instrument_id,
                symbol=candle.symbol,
                timeframe=candle.timeframe,
                observed_at=candle.close_time,
                label_available_at=label_available_at,
                # The realised range ratio, kept where forward_return lives so the
                # continuous quantity behind the class is not thrown away.
                forward_return=result.range_ratio,
                label=result.label,
                features=build_feature_vector(
                    candle,
                    prior_close=prior_close,
                    median_volume=median_volume,
                    schema_version=schema_version_for(request.timeframe),
                    indicator_algorithm_version=request.indicator_algorithm_version,
                    pattern_algorithm_version=request.pattern_algorithm_version,
                    price_action_algorithm_version=request.price_action_algorithm_version,
                ),
                vix_observed_at=candle.vix_observed_at,
            )
        )
        prior_close = source_close

    return sorted(examples, key=lambda example: (example.observed_at, example.label_available_at, example.candle_id))


__all__ = [
    "FEATURE_SCHEMA",
    "FEATURE_SCHEMA_V5",
    "FEATURE_SCHEMA_V6",
    "FEATURE_SCHEMA_V7",
    "FEATURE_SCHEMA_SCALP",
    "FEATURE_SCHEMA_SCALP_V2",
    "FEATURE_DEFINITION",
    "FEATURE_DEFINITION_SCALP",
    "FEATURE_SCHEMA_VERSION",
    "FEATURE_SCHEMA_VERSION_V5",
    "FEATURE_SCHEMA_VERSION_V6",
    "FEATURE_SCHEMA_VERSION_SCALP",
    "FEATURE_SCHEMA_VERSION_SCALP_V2",
    "FeatureConstructionError",
    "LabelResult",
    "build_feature_vector",
    "build_labeled_examples",
    "build_triple_barrier_examples",
    "build_volatility_expansion_examples",
    "feature_schema",
    "feature_definition",
    "label_from_future_close",
]

