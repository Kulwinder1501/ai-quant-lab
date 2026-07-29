"""Stable contracts shared by local training, inference, and persistence adapters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Mapping, Sequence

MarketLabel = Literal["BULLISH", "BEARISH", "NEUTRAL"]
LABELS: tuple[MarketLabel, ...] = ("BEARISH", "NEUTRAL", "BULLISH")

# v4 rather than v3 because ``candle.gap_fill_bps`` and ``candle.is_gap_defended``
# were added to the swing schema while the version string still said v3. Two
# different ordered column sets under one version name is the exact failure the
# version exists to prevent: the champion/challenger gate compares an incumbent's
# stored schema against the candidate's, and a mismatch makes it skip the
# incumbent instead of failing, so a candidate would promote uncontested.
# Artifacts under models/*--ml-feature-v3 were trained on the 9-feature candle
# block and must be retrained before they can be promoted again.
FEATURE_SCHEMA_VERSION = "ml-feature-v4"
FEATURE_SCHEMA_VERSION_SCALP = "ml-feature-scalp-v1"

# Scalping timeframes share one schema. The swing schema's pattern, price-action,
# and daily-gap columns are either absent or degenerate inside a single session,
# so an intraday model gets a deliberately narrower, denser feature block.
SCALP_TIMEFRAMES: tuple[str, ...] = ("1m", "3m", "5m")


def schema_version_for(timeframe: str) -> str:
    """Return the feature-schema version a timeframe trains and predicts under.

    Training, inference, artifact metadata, and the model key must all agree on
    this. It is a single function rather than an inline conditional in each of
    those places because four copies of the same mapping drift, and the symptom
    is a model whose metadata claims one schema while its columns are another.
    """

    return FEATURE_SCHEMA_VERSION_SCALP if timeframe in SCALP_TIMEFRAMES else FEATURE_SCHEMA_VERSION


# Empirically calibrated on Yahoo ^NSEI closes (2026-07): a constant band cannot
# serve every timeframe, because the neutral share at +/-50bps is 20% on 1d, 88%
# on 15m, and 99.2% on 1m. A 1m model trained at 50bps sees one class and learns
# to answer NEUTRAL always. Each intraday value below is roughly the 33rd
# percentile of |forward return| over 5 bars, which puts the three classes near
# balance. These assume horizon_bars=5; re-measure if the horizon changes.
#
# 1d deliberately stays at 50bps even though the balanced value is ~72bps. At
# 50bps the daily split is already a workable 20/40/40, and the threshold is part
# of the default model key, so moving it would orphan the existing daily
# promotion lineage for no measured gain.
DEFAULT_NEUTRAL_THRESHOLD_BPS: Mapping[str, float] = {
    "1m": 2.0,
    "3m": 4.0,
    "5m": 5.0,
    "10m": 7.0,
    "15m": 9.0,
    "30m": 13.0,
    "60m": 20.0,
    "1d": 50.0,
}


def default_neutral_threshold_bps(timeframe: str) -> float:
    """Return the calibrated neutral band for a timeframe.

    An unrecognised timeframe falls back to the daily band, which is also the
    historical constant, so no existing command changes behaviour.
    """

    return DEFAULT_NEUTRAL_THRESHOLD_BPS.get(timeframe, DEFAULT_NEUTRAL_THRESHOLD_BPS["1d"])

# The volatility-regime feature reads a second instrument, so its source is part of
# the schema contract: changing the symbol, indicator, period, algorithm version, or
# staleness window changes what a stored feature value meant.
REGIME_SOURCE_SYMBOL = "INDIAVIX"
REGIME_SOURCE_INDICATOR_CODE = "SMA"
REGIME_SOURCE_INDICATOR_PERIOD = 20
REGIME_SOURCE_INDICATOR_ALGORITHM_VERSION = "ta-v1"
REGIME_STALENESS_BARS = 5

# Persisted algorithm identifiers. They are written to model_versions.algorithm
# and into the artifact metadata envelope, so an existing identifier must never
# change meaning; a new model family gets a new identifier instead.
LOGISTIC_BASELINE_ALGORITHM = "sklearn-logistic-regression-v1"
XGBOOST_ALGORITHM = "xgboost-gradient-boosting-v1"
LIGHTGBM_ALGORITHM = "lightgbm-gradient-boosting-v1"

# Gradient-boosted forests cannot be explained with linear-coefficient language,
# so the inference layer routes them to an exact TreeSHAP explainer instead.
TREE_ENSEMBLE_ALGORITHMS: tuple[str, ...] = (XGBOOST_ALGORITHM, LIGHTGBM_ALGORITHM)
SUPPORTED_ALGORITHMS: tuple[str, ...] = (LOGISTIC_BASELINE_ALGORITHM, *TREE_ENSEMBLE_ALGORITHMS)

# The CLI-facing short name for each trainable algorithm.
ALGORITHM_BY_CHOICE: Mapping[str, str] = {
    "logistic": LOGISTIC_BASELINE_ALGORITHM,
    "xgboost": XGBOOST_ALGORITHM,
    "lightgbm": LIGHTGBM_ALGORITHM,
}
ALGORITHM_CHOICES: tuple[str, ...] = tuple(ALGORITHM_BY_CHOICE)


@dataclass(frozen=True)
class DatasetRequest:
    """One instrument/timeframe experiment and its immutable source-data boundary."""

    instrument_symbol: str
    timeframe: str
    data_window_start: datetime
    data_window_end: datetime
    data_cutoff_at: datetime
    horizon_bars: int
    neutral_threshold_bps: float
    indicator_algorithm_version: str = "ta-v1"
    pattern_algorithm_version: str = "candlestick-v1"
    price_action_algorithm_version: str = "price-action-v2"


@dataclass(frozen=True)
class InferenceRequest:
    """One as-of, completed-candle prediction request for a promoted local model."""

    instrument_symbol: str
    timeframe: str
    data_cutoff_at: datetime
    indicator_algorithm_version: str = "ta-v1"
    pattern_algorithm_version: str = "candlestick-v1"
    price_action_algorithm_version: str = "price-action-v2"


@dataclass(frozen=True)
class IndicatorEvidence:
    code: str
    algorithm_version: str
    parameters: Mapping[str, Any]
    values: Mapping[str, Any]


@dataclass(frozen=True)
class PatternEvidence:
    code: str
    algorithm_version: str
    direction: str
    confidence: float


@dataclass(frozen=True)
class PriceActionEvidence:
    event_type: str
    algorithm_version: str
    direction: str
    confidence: float
    level: float | None


@dataclass(frozen=True)
class CandleEvidence:
    """Data visible at a source candle close plus a later close used only as its label."""

    candle_id: str
    instrument_id: str
    symbol: str
    timeframe: str
    open_time: datetime
    close_time: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float
    indicators: Sequence[IndicatorEvidence]
    patterns: Sequence[PatternEvidence]
    price_action_events: Sequence[PriceActionEvidence]
    future_close: float | None
    future_close_time: datetime | None
    vix_value_ratio: float | None = None
    vix_observed_at: datetime | None = None
    fii_net_flow_ratio: float | None = None
    dii_net_flow_ratio: float | None = None
    gift_nifty_implied_gap_bps: float | None = None

@dataclass(frozen=True)
class LabeledExample:
    candle_id: str
    instrument_id: str
    symbol: str
    timeframe: str
    observed_at: datetime
    label_available_at: datetime
    forward_return: float
    label: MarketLabel
    features: Mapping[str, float]
    vix_observed_at: datetime | None = None


@dataclass(frozen=True)
class TemporalSplit:
    train: Sequence[LabeledExample]
    validation: Sequence[LabeledExample]
    purge_count: int


@dataclass(frozen=True)
class EvaluationMetrics:
    accuracy: float
    balanced_accuracy: float
    macro_f1: float
    sample_count: int
    class_counts: Mapping[MarketLabel, int]
    # Directional evidence, kept optional so a metrics block written before these
    # existed still deserialises. `directional_hit_rate` is the figure comparable
    # to a binary "right N% of the time" claim: accuracy over only the rows the
    # model actually committed to a direction on. It stays None at zero coverage,
    # because a model that never commits has no hit rate rather than a zero one.
    directional_predictions: int | None = None
    directional_hit_rate: float | None = None
    coverage: float | None = None


@dataclass(frozen=True)
class PersistedModelVersion:
    id: str
    model_key: str
    version: int
    algorithm: str
    stage: str
    artifact_uri: str
    artifact_checksum: str | None
    feature_schema: Sequence[Mapping[str, Any]]
    validation_metrics: Mapping[str, Any]
    trained_at: datetime | None = None
    promoted_at: datetime | None = None


@dataclass(frozen=True)
class HistoricalPredictionReliability:
    """Observed outcome rate for earlier, time-safe predictions in one comparable cohort."""

    evaluated_predictions: int
    correct_predictions: int
    accuracy: float | None


@dataclass(frozen=True)
class PersistedModelPrediction:
    """The idempotent research record returned after a prediction save."""

    id: str
    model_version_id: str
    instrument_id: str
    source_candle_id: str
    prediction: MarketLabel
    confidence: float
    created_at: datetime

