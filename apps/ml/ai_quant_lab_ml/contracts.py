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
#
# v6 rather than v5 is the Phase 25 Stage 2 capacity bump, and it is the first
# version change made for statistical rather than plumbing reasons. v5 carried
# 113 columns, 82 of which were the pattern and price-action one-hot blocks that
# are zero on almost every row; v6 collapses those into four aggregate scores,
# drops columns that are linear combinations of others (Bollinger middle/upper/
# lower given SMA20 and the band deviation, SuperTrend bands given its level),
# drops VWAP (degenerate on a daily bar: one bar per session means it is the
# typical price restated), and drops the two gap-derivative columns whose
# documented pathologies (dual meaning, near-constant gate) apply on every
# timeframe. In their place it adds seven point-in-time market-breadth columns
# computed from the twenty-equity research panel and the two indices. Unlike
# earlier bumps, v5 artifacts remain loadable and scorable: inference validates
# an artifact against the schema version *recorded in its own metadata*, so the
# volatility shadow families trained under v5 keep building settled history
# while v6 lineages start fresh.
FEATURE_SCHEMA_VERSION = "ml-feature-v7"
FEATURE_SCHEMA_VERSION_V9 = "ml-feature-v9"
FEATURE_SCHEMA_VERSION_V8 = "ml-feature-v8"
FEATURE_SCHEMA_VERSION_V8_GEOMETRY = "ml-feature-v8-geometry"
FEATURE_SCHEMA_VERSION_V6 = "ml-feature-v6"
FEATURE_SCHEMA_VERSION_V5 = "ml-feature-v5"
FEATURE_SCHEMA_VERSION_SCALP = "ml-feature-scalp-v3"
FEATURE_SCHEMA_VERSION_SCALP_V2 = "ml-feature-scalp-v2"

#: v7 with the two candlestick-pattern aggregates removed, and nothing else changed.
#:
#: An ablation contract, not a production one. Measured 2026-08-17: bars firing a pattern reached
#: EXPANSION 5.7-7.1 points more often than bars that did not, on both indices at 15m (z = +8.9
#: and +11.0). That is a real separation, and the opposite of what the same patterns do on the
#: directional target. But patterns are *derived from* `candle.range_bps`, the wick columns, the
#: body, and `indicator.ATR.value_ratio` — all of which v7 already carries — so a univariate gap
#: says nothing about whether these two columns add anything a tree cannot already reconstruct.
#:
#: Answering that needs the same fit twice, differing only in these columns. It is registered as a
#: real version rather than patched in at runtime because the schema version is part of the model
#: key, and an ablated artifact must be impossible to confuse with a production one.
FEATURE_SCHEMA_VERSION_V7_NO_PATTERN = "ml-feature-v7-nopattern"

#: Every schema version this codebase can still construct feature vectors for.
#: An artifact recorded under any other version is rejected at load time.
KNOWN_FEATURE_SCHEMA_VERSIONS: tuple[str, ...] = (
    FEATURE_SCHEMA_VERSION,
    FEATURE_SCHEMA_VERSION_V9,
    FEATURE_SCHEMA_VERSION_V8,
    FEATURE_SCHEMA_VERSION_V8_GEOMETRY,
    FEATURE_SCHEMA_VERSION_V6,
    FEATURE_SCHEMA_VERSION_V5,
    FEATURE_SCHEMA_VERSION_SCALP,
    FEATURE_SCHEMA_VERSION_SCALP_V2,
    FEATURE_SCHEMA_VERSION_V7_NO_PATTERN,
)

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

# Market breadth reads a *panel* of other instruments, so its sources are part of
# the v6 schema contract exactly the way the VIX regime's source is: changing the
# roster, the windows, or the participation floor changes what a stored feature
# value meant and therefore requires a new schema version.
#
# The roster is the twenty research equities from API migration 027. They are the
# instruments whose daily history this project actually collects and audits; a
# free-floating "Nifty 50 constituents" list would drift from the data that
# exists. Breadth is always computed from *daily* completed bars regardless of
# the timeframe being trained: an intraday bar reads the latest fully settled
# session, never a same-day partial print, which keeps the columns point-in-time
# by construction.
BREADTH_UNIVERSE: tuple[str, ...] = (
    "ASIANPAINT", "AXISBANK", "BAJFINANCE", "BHARTIARTL", "HDFCBANK",
    "HINDUNILVR", "ICICIBANK", "INFY", "ITC", "KOTAKBANK",
    "LT", "MARUTI", "NESTLEIND", "RELIANCE", "SBIN",
    "SUNPHARMA", "TCS", "TITAN", "ULTRACEMCO", "WIPRO",
)

# The banking-versus-IT relative-strength spread needs sector membership. Only
# roster members appear here; both sides must clear BREADTH_SECTOR_MINIMUM
# members on a session or the spread is unmeasurable rather than a two-name
# accident.
BREADTH_BANK_SYMBOLS: tuple[str, ...] = ("AXISBANK", "HDFCBANK", "ICICIBANK", "KOTAKBANK", "SBIN")
BREADTH_IT_SYMBOLS: tuple[str, ...] = ("INFY", "TCS", "WIPRO")
BREADTH_SECTOR_MINIMUM = 2

# Trailing windows, in sessions, for the share-above-SMA and volume-ratio
# members. Both include the session being scored and never a later one.
BREADTH_SMA_SESSIONS = 20
BREADTH_VOLUME_MEDIAN_SESSIONS = 20

# A session must have this many members with a measurable return before any
# breadth statistic is published for it. Three names say nothing about breadth;
# an unmeasured session stays NaN rather than masquerading as a quiet one.
BREADTH_MINIMUM_PARTICIPANTS = 10

# How stale a breadth print may be and still describe the bar being scored,
# mirroring INSTITUTIONAL_FLOW_STALENESS_DAYS: NSE trades every weekday, so a
# wider gap means collection was down and the feature is unmeasurable.
BREADTH_STALENESS_DAYS = 5

# The cross-index relative-return column compares these two symbols' daily
# closes. Part of the contract for the same reason the VIX source symbol is.
BREADTH_INDEX_PRIMARY = "NIFTY50"
BREADTH_INDEX_SECONDARY = "BANKNIFTY"


@dataclass(frozen=True)
class BreadthContext:
    """One settled session's cross-sectional breadth, attachable to any later bar.

    ``observed_at`` is the panel session's close time; the attach rule is the
    same as the VIX regime's -- the latest context whose ``observed_at`` is at or
    before the bar's own close, within the staleness budget. ``None`` members
    mean that statistic was unmeasurable for the session (too few participants,
    incomplete trailing windows) and become NaN in the feature vector rather
    than a learned fill value.
    """

    observed_at: datetime
    advance_decline: float | None
    median_return_bps: float | None
    return_dispersion_bps: float | None
    above_sma20_share: float | None
    median_volume_ratio: float | None
    bank_it_spread_bps: float | None
    index_return_gap_bps: float | None


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
# Phase 25, Workstream C. CatBoost's ordered boosting fits each tree on
# permutation-prefix targets, a genuinely different variance-control bias from
# XGBoost's level-wise and LightGBM's leaf-wise growth. It enters as a normal
# challenger family on the same numeric schema — native categorical handling
# would be a separate, explicitly versioned schema experiment.
CATBOOST_ALGORITHM = "catboost-gradient-boosting-v1"

# Gradient-boosted forests cannot be explained with linear-coefficient language,
# so the inference layer routes them to an exact TreeSHAP explainer instead.
TREE_ENSEMBLE_ALGORITHMS: tuple[str, ...] = (XGBOOST_ALGORITHM, LIGHTGBM_ALGORITHM, CATBOOST_ALGORITHM)
# Sequence research families (Stage 5/6). Shadow-scorable once registered as
# CANDIDATE; not part of the EOD train loop. Identifiers are owned by
# tcn_model / stacking modules and duplicated here so contracts stay import-light.
TCN_ALGORITHM = "pytorch-causal-tcn-v1"
STACK_ALGORITHM = "oof-logistic-stack-v1"
SEQUENCE_SHADOW_ALGORITHMS: tuple[str, ...] = (TCN_ALGORITHM, STACK_ALGORITHM)
SUPPORTED_ALGORITHMS: tuple[str, ...] = (
    LOGISTIC_BASELINE_ALGORITHM,
    *TREE_ENSEMBLE_ALGORITHMS,
    *SEQUENCE_SHADOW_ALGORITHMS,
)

# The CLI-facing short name for each trainable algorithm.
ALGORITHM_BY_CHOICE: Mapping[str, str] = {
    "logistic": LOGISTIC_BASELINE_ALGORITHM,
    "xgboost": XGBOOST_ALGORITHM,
    "lightgbm": LIGHTGBM_ALGORITHM,
    "catboost": CATBOOST_ALGORITHM,
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
    fii_futures_net_flow_ratio: float | None = None
    fii_options_net_flow_ratio: float | None = None
    # The trading session whose published flows the ratios above came from.
    # Carried so a leakage audit can assert it precedes this bar's own session.
    institutional_flow_date: date | None = None
    # The latest settled panel session's breadth at or before this bar's close
    # (v6 schema only; None for scalp evidence and when no fresh panel session
    # exists). Populated by the repository, never computed inside features.py,
    # so training and inference share one loader and cannot skew.
    breadth: BreadthContext | None = None
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
    # Per-class breakdown, optional for the same reason the fields above are: a metrics
    # block written before it existed still deserialises. Keyed by label.
    per_class: Mapping[str, ClassMetrics] | None = None


@dataclass(frozen=True)
class ClassMetrics:
    """Per-class precision, recall and F1 for one label.

    Added because macro-F1 cannot answer a trading question. A straddle is only taken on
    a predicted EXPANSION, so what decides whether the strategy pays is the precision of
    that one class -- measured 2026-08-03 as needing to reach 44.3% against a 27.6% base
    rate before fees. Macro-F1 averages exactly that away, and the promotion gate scored
    macro-F1 alone.

    ``precision`` is None when the model never predicted the class, rather than 0.0.
    sklearn's ``zero_division=0`` reports 0.0 there, which reads as "always wrong" when
    the truth is "never attempted" -- the difference between a model that is bad at
    EXPANSION and one that abstains from it entirely, which are opposite situations for a
    strategy that only acts on that class. ``recall`` is None by the same rule when the
    class never occurred.
    """

    precision: float | None
    recall: float | None
    f1: float
    #: How often the model predicted this class. The denominator behind ``precision``.
    predicted_count: int
    #: How often the class actually occurred. The denominator behind ``recall``.
    actual_count: int


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

