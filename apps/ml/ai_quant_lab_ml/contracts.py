"""Stable contracts shared by local training, inference, and persistence adapters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal, Mapping, Sequence

MarketLabel = Literal["BULLISH", "BEARISH", "NEUTRAL"]
LABELS: tuple[MarketLabel, ...] = ("BEARISH", "NEUTRAL", "BULLISH")
FEATURE_SCHEMA_VERSION = "ml-feature-v3"

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

