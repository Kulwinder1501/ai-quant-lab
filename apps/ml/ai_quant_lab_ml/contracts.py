"""Stable contracts shared by local training, inference, and persistence adapters."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any, Literal, Mapping, Sequence

MarketLabel = Literal["BULLISH", "BEARISH", "NEUTRAL"]
LABELS: tuple[MarketLabel, ...] = ("BEARISH", "NEUTRAL", "BULLISH")

# A label is only meaningful together with the alphabet it was drawn from, and this
# project now has more than one: the directional target predicts BEARISH/NEUTRAL/
# BULLISH, while the volatility-expansion target predicts CONTRACTION/STABLE/
# EXPANSION. Those two must never be conflated -- emitting "BULLISH" to mean "the
# range widened" would be read as a signal to go long by the strategy engine, the
# autonomous agent, and the dashboards.
#
# Rather than widen one global tuple (which would make the random baseline 1/6 and
# render the decisive-prediction metric meaningless for both targets), the alphabet
# is an explicit value that training, evaluation, and the leakage audit accept.
# Every such parameter defaults to DIRECTIONAL_ALPHABET, so existing callers and
# their persisted metrics are bit-for-bit unchanged.
AnyLabel = str


@dataclass(frozen=True)
class LabelAlphabet:
    """An ordered label set plus the class that means "no commitment"."""

    name: str
    labels: tuple[AnyLabel, ...]
    #: The class a model predicts when it declines to commit -- NEUTRAL for
    #: direction, STABLE for volatility. Metrics that measure how often a model
    #: actually committed, and how often it was right when it did, are computed
    #: against this rather than against a hardcoded pair of directional labels.
    abstain_label: AnyLabel

    def __post_init__(self) -> None:
        if len(self.labels) < 2:
            raise ValueError("A label alphabet needs at least two labels.")
        if len(set(self.labels)) != len(self.labels):
            raise ValueError("A label alphabet cannot repeat a label.")
        if self.abstain_label not in self.labels:
            raise ValueError("The abstain label must be one of the alphabet's labels.")

    @property
    def random_baseline_macro_f1(self) -> float:
        """Macro-F1 a uniformly random predictor scores over this alphabet."""

        return 1.0 / len(self.labels)

    @property
    def decisive_labels(self) -> tuple[AnyLabel, ...]:
        return tuple(label for label in self.labels if label != self.abstain_label)


DIRECTIONAL_ALPHABET = LabelAlphabet(name="direction", labels=LABELS, abstain_label="NEUTRAL")

# v4 rather than v3 because ``candle.gap_fill_bps`` and ``candle.is_gap_defended``
# were added to the swing schema while the version string still said v3. Two
# different ordered column sets under one version name is the exact failure the
# version exists to prevent: the champion/challenger gate compares an incumbent's
# stored schema against the candidate's, and a mismatch makes it skip the
# incumbent instead of failing, so a candidate would promote uncontested.
# Artifacts under models/*--ml-feature-v3 were trained on the 9-feature candle
# block and must be retrained before they can be promoted again.
#
# v5 rather than v4 because ``market.gift_nifty_implied_gap_bps`` was removed. It
# was declared in v4 but nothing ever populated it -- no loader read
# ``offshore_derivatives`` -- so it was a guaranteed-NaN column in both training
# and inference, and the only free "GIFT Nifty" source turned out to be a
# hardcoded zero. A constant column cannot inform a split, but it does enlarge the
# versioned contract and force a retrain, so it is gone until a real offshore feed
# exists. Both v4 and scalp-v1 artifacts were built against the old column set and
# must be retrained; redefining either name in place is the mismatch the paragraph
# above describes.
FEATURE_SCHEMA_VERSION = "ml-feature-v5"
FEATURE_SCHEMA_VERSION_SCALP = "ml-feature-scalp-v2"

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

# Labelling schemes. Distinct from FEATURE_SCHEMA_VERSION on purpose: the feature
# *columns* are identical across schemes, only the *target* differs, so a scheme
# is tracked separately. A model's provenance records both, and the
# champion/challenger gate must only ever compare models that share a scheme --
# a fixed-horizon model and a triple-barrier model are answering different
# questions and their scores are not comparable.
#
# fixed-horizon: the incumbent 3-class target -- sign of the close-to-close return
#   at exactly horizon_bars, against a symmetric neutral band.
# triple-barrier: label by which of {profit barrier, stop barrier, time barrier}
#   the forward path reaches first, with the price barriers scaled to ATR.
# volatility-expansion: not a direction at all -- whether the next K bars' range
#   widens or narrows against the trailing K bars. It draws from its own label
#   alphabet (CONTRACTION/STABLE/EXPANSION) and persists to its own table, because
#   a non-directional label in the directional path would be read as a trade signal.
LABEL_SCHEME_FIXED_HORIZON = "fixed-horizon-v1"
LABEL_SCHEME_TRIPLE_BARRIER = "triple-barrier-v1"
LABEL_SCHEME_VOLATILITY_EXPANSION = "volatility-expansion-v1"
LABEL_SCHEMES: tuple[str, ...] = (
    LABEL_SCHEME_FIXED_HORIZON,
    LABEL_SCHEME_TRIPLE_BARRIER,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
)

#: Schemes whose target is a price direction. Everything outside this set uses a
#: non-directional alphabet and must not be written to ``model_predictions``.
DIRECTIONAL_LABEL_SCHEMES: tuple[str, ...] = (
    LABEL_SCHEME_FIXED_HORIZON,
    LABEL_SCHEME_TRIPLE_BARRIER,
)

# The institutional-flow feature reads a second table, so the same reasoning
# applies: this normalisation is part of the schema contract, and changing either
# constant changes what a stored feature value meant.
#
# The raw figure is net crore, which is not usable as a feature across eras -- FII
# cash turnover has grown by roughly an order of magnitude over the history this
# project trains on, so a fixed crore value means something different in 2015 than
# in 2026 and the model would be fitting the era, not the flow. Dividing by the
# trailing mean absolute net flow of the *prior* published sessions gives a
# dimensionless "how unusual is today's flow" reading centred near +/-1.
#
# The window excludes the session being scaled. Including it would let an extreme
# day inflate its own denominator and compress exactly the signal the feature is
# meant to carry.
INSTITUTIONAL_FLOW_SCALE_SESSIONS = 20

# How stale a published print may be and still describe the bar being scored. NSE
# publishes every trading day, so a gap wider than this means the collector was
# down; the feature is reported unmeasurable rather than carrying a fortnight-old
# reading forward as though it were current.
INSTITUTIONAL_FLOW_STALENESS_DAYS = 5

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
    # Labelling scheme and its parameters. Defaults reproduce the incumbent
    # fixed-horizon target exactly, so an unchanged caller is unaffected. For the
    # triple-barrier scheme, ``horizon_bars`` is the vertical-barrier bar count
    # (the max bars a label can take), which is what the purge gap must cover; the
    # two multiples set the ATR-scaled profit and stop distances.
    label_scheme: str = LABEL_SCHEME_FIXED_HORIZON
    barrier_upper_multiple: float = 1.0
    barrier_lower_multiple: float = 1.0
    # volatility-expansion only: the band around an unchanged range. EXPANSION at a
    # ratio >= 1 + band, CONTRACTION at <= 1 / (1 + band). 0.25 measured as the
    # best-balanced value on daily NIFTY50/BANKNIFTY.
    expansion_band: float = 0.25


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
class ForwardBar:
    """One completed bar on the forward path after a source candle, in time order.

    Label-only evidence for triple-barrier labelling: ``high``/``low`` decide a
    barrier touch, ``close`` gives the realised return at the touch, and
    ``close_time`` is when that label became known (feeding the purge discipline).
    It is the multi-bar analogue of ``CandleEvidence.future_close`` and, like it,
    must never be read as a feature.
    """

    high: float
    low: float
    close: float
    close_time: datetime


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
    # Scale-free institutional cash flow: net crore over the trailing mean
    # absolute net crore of prior published sessions. See
    # ``INSTITUTIONAL_FLOW_SCALE_SESSIONS`` for why it is a ratio and not the raw
    # figure. None means the flow was unmeasurable as of this bar, which is left
    # missing rather than imputed to 0 -- a flat session and an unobserved one are
    # not the same evidence.
    fii_net_flow_ratio: float | None = None
    dii_net_flow_ratio: float | None = None
    # The trading session whose published flows the two ratios above came from.
    # Carried so a leakage audit can assert it precedes this bar's own session.
    institutional_flow_date: date | None = None
    # Label-only: the forward bars used by triple-barrier labelling, bounded to the
    # vertical barrier and obeying the same as-of cutoff as ``future_close``. Empty
    # for the fixed-horizon scheme, which never reads it. Never a feature.
    forward_path: Sequence["ForwardBar"] = ()

@dataclass(frozen=True)
class LabeledExample:
    candle_id: str
    instrument_id: str
    symbol: str
    timeframe: str
    observed_at: datetime
    label_available_at: datetime
    forward_return: float
    # Drawn from whichever LabelAlphabet the dataset's label scheme declares, so it
    # is not narrowed to MarketLabel. The alphabet is validated at the training and
    # evaluation boundaries rather than here, because a frozen dataclass cannot
    # know which scheme produced it.
    label: AnyLabel
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

