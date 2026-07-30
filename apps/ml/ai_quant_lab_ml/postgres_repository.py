"""Psycopg v3 persistence adapters for time-safe local ML research."""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass
import re
from datetime import date, datetime, timedelta
from typing import TYPE_CHECKING, Any, Mapping, Sequence

if TYPE_CHECKING:
    from psycopg import Connection

try:
    from psycopg.rows import dict_row
except ImportError:  # Allows pure fake-connection unit tests before optional runtime dependencies are installed.
    dict_row = None

from .contracts import (
    CandleEvidence,
    DatasetRequest,
    HistoricalPredictionReliability,
    AnyLabel,
    ForwardBar,
    IndicatorEvidence,
    InferenceRequest,
    LabelAlphabet,
    INSTITUTIONAL_FLOW_SCALE_SESSIONS,
    INSTITUTIONAL_FLOW_STALENESS_DAYS,
    LABEL_SCHEME_TRIPLE_BARRIER,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
    MarketLabel,
    PatternEvidence,
    PersistedModelPrediction,
    PersistedModelVersion,
    PriceActionEvidence,
    LABELS,
    REGIME_SOURCE_INDICATOR_ALGORITHM_VERSION,
    REGIME_SOURCE_INDICATOR_CODE,
    REGIME_SOURCE_INDICATOR_PERIOD,
    REGIME_SOURCE_SYMBOL,
    REGIME_STALENESS_BARS,
)
from .features import feature_definition

Row = Mapping[str, Any]


@dataclass(frozen=True)
class InstitutionalFlowEvidence:
    """The scale-free flow reading visible to one candle, and its source session."""

    fii_net_flow_ratio: float | None
    dii_net_flow_ratio: float | None
    flow_date: date | None


_FIND_NSE_INSTRUMENT_SQL = """
    SELECT id, symbol
    FROM instruments
    WHERE exchange = 'NSE' AND symbol = %s
"""

# An intraday forward label must not reach across the session close. NSE trades
# 09:15-15:30 IST, so a LEAD over an unpartitioned series hands the last
# horizon_bars candles of every session a label measured from the *next morning*,
# which means the label contains the overnight gap. Measured on Yahoo ^NSEI 1m
# (2026-07-23..29): the median |overnight gap| is 71bps while the 99th percentile
# 5-bar intraday move is 21bps, so those rows carry labels an order of magnitude
# larger than the distribution being fitted, and they land in the directional
# tails by construction. Partitioning by IST trading date nulls them instead.
#
# Daily and longer bars must stay UNPARTITIONED: one bar per session means a
# per-session partition would make every forward label NULL and silently empty
# the training set.
_INTRADAY_SESSION_PARTITION = "PARTITION BY (candles.close_time AT TIME ZONE 'Asia/Kolkata')::date"


def _is_intraday_timeframe(timeframe: str) -> bool:
    """Return whether a timeframe has more than one bar per trading session.

    Minute and hour codes ("1m", "15m", "1h") are intraday. Day, week, and month
    codes ("1d", "1wk", "1mo") are not, and none of them end in "m" or "h".
    """

    return timeframe.strip().lower().endswith(("m", "h"))


def _session_partition_clause(timeframe: str) -> str:
    return _INTRADAY_SESSION_PARTITION if _is_intraday_timeframe(timeframe) else ""


# The forward path triple-barrier labelling reads. For each source candle it takes
# the next up-to-`horizon_bars` completed bars, in time order, that were recorded by
# the cutoff and close within the data window. The strict `open_time`/`close_time`/
# `id` ordering after the source is the same total order used everywhere else, so a
# bar is never both a source and its own forward bar. For intraday the forward walk
# is confined to the source's own IST session (`{session_bound}`), the same reason
# the label LEAD is session-partitioned: a path crossing the overnight gap would
# measure the gap, not the intraday move.
_FORWARD_PATH_SQL = """
    SELECT
      src.id AS source_candle_id,
      fwd.high,
      fwd.low,
      fwd.close,
      fwd.close_time
    FROM candles AS src
    CROSS JOIN LATERAL (
      SELECT f.high, f.low, f.close, f.close_time, f.open_time, f.id
      FROM candles AS f
      WHERE f.instrument_id = src.instrument_id
        AND f.timeframe = src.timeframe
        AND f.is_complete = TRUE
        AND f.received_at <= %s
        AND f.close_time <= %s
        AND (
          f.open_time > src.open_time
          OR (f.open_time = src.open_time AND f.close_time > src.close_time)
          OR (f.open_time = src.open_time AND f.close_time = src.close_time AND f.id > src.id)
        )
        {session_bound}
      ORDER BY f.open_time ASC, f.close_time ASC, f.id ASC
      LIMIT %s
    ) AS fwd
    WHERE src.id = ANY(%s::uuid[])
    ORDER BY src.id ASC, fwd.open_time ASC, fwd.close_time ASC, fwd.id ASC
"""

_FORWARD_PATH_SESSION_BOUND = (
    "AND (f.close_time AT TIME ZONE 'Asia/Kolkata')::date "
    "= (src.close_time AT TIME ZONE 'Asia/Kolkata')::date"
)

#: Schemes whose label is decided by a *path* of later bars rather than a single
#: later close. Only these pay for the forward-path query.
_FORWARD_PATH_LABEL_SCHEMES: frozenset[str] = frozenset(
    {LABEL_SCHEME_TRIPLE_BARRIER, LABEL_SCHEME_VOLATILITY_EXPANSION}
)


# LEAD runs over the cutoff-bounded series before the outer source-window
# filter. Tail labels past the requested window are explicitly nulled, so a
# non-null label is exactly horizon_bars later and remains inside the immutable
# experiment window while only source-candle evidence is used as a feature.
_CANDLE_EVIDENCE_SQL = """
    WITH cutoff_candles AS (
      SELECT
        candles.id AS candle_id,
        candles.instrument_id,
        instruments.symbol,
        candles.timeframe,
        candles.open_time,
        candles.close_time,
        candles.open,
        candles.high,
        candles.low,
        candles.close,
        candles.volume,
        LEAD(candles.close, %s) OVER (
          {session_partition}
          ORDER BY candles.open_time ASC, candles.close_time ASC, candles.id ASC
        ) AS future_close,
        LEAD(candles.close_time, %s) OVER (
          {session_partition}
          ORDER BY candles.open_time ASC, candles.close_time ASC, candles.id ASC
        ) AS future_close_time
      FROM candles
      INNER JOIN instruments ON instruments.id = candles.instrument_id
      WHERE candles.instrument_id = %s
        AND candles.timeframe = %s
        AND candles.is_complete = TRUE
        AND candles.received_at <= %s
        AND candles.close_time <= %s
    )
    SELECT
      candle_id,
      instrument_id,
      symbol,
      timeframe,
      open_time,
      close_time,
      open,
      high,
      low,
      close,
      volume,
      CASE WHEN future_close_time <= %s THEN future_close ELSE NULL END AS future_close,
      CASE WHEN future_close_time <= %s THEN future_close_time ELSE NULL END AS future_close_time
    FROM cutoff_candles
    WHERE open_time >= %s
      AND close_time <= %s
    ORDER BY open_time ASC, close_time ASC, candle_id ASC
"""

_TRAILING_CLOSE_VOLUME_SQL = """
    SELECT
      candles.id AS candle_id,
      candles.close_time,
      candles.close,
      candles.volume
    FROM candles
    WHERE candles.instrument_id = %s
      AND candles.timeframe = %s
      AND candles.is_complete = TRUE
      AND candles.received_at <= %s
      AND candles.close_time <= %s
    ORDER BY candles.close_time DESC, candles.open_time DESC, candles.id DESC
    LIMIT %s
"""

_LATEST_CANDLE_EVIDENCE_SQL = """
    SELECT
      candles.id AS candle_id,
      candles.instrument_id,
      instruments.symbol,
      candles.timeframe,
      candles.open_time,
      candles.close_time,
      candles.open,
      candles.high,
      candles.low,
      candles.close,
      candles.volume
    FROM candles
    INNER JOIN instruments ON instruments.id = candles.instrument_id
    WHERE candles.instrument_id = %s
      AND candles.timeframe = %s
      AND candles.is_complete = TRUE
      AND candles.received_at <= %s
      AND candles.close_time <= %s
    ORDER BY candles.close_time DESC, candles.open_time DESC, candles.id DESC
    LIMIT 1
"""

_INDICATOR_EVIDENCE_SQL = """
    SELECT
      indicator_snapshots.candle_id,
      indicator_definitions.indicator_code,
      indicator_definitions.algorithm_version,
      indicator_definitions.parameters,
      indicator_snapshots.values
    FROM indicator_snapshots
    INNER JOIN indicator_definitions
      ON indicator_definitions.id = indicator_snapshots.indicator_definition_id
    WHERE indicator_snapshots.candle_id = ANY(%s::uuid[])
      AND indicator_snapshots.calculated_at <= %s
      AND indicator_definitions.algorithm_version = %s
      AND indicator_definitions.parameters = (%s::jsonb -> indicator_definitions.indicator_code)
    ORDER BY
      indicator_snapshots.candle_id ASC,
      indicator_definitions.indicator_code ASC,
      indicator_definitions.algorithm_version ASC,
      indicator_definitions.parameters_hash ASC
"""

_PATTERN_EVIDENCE_SQL = """
    SELECT
      pattern_detections.candle_id,
      pattern_definitions.pattern_code,
      pattern_definitions.algorithm_version,
      pattern_detections.direction,
      pattern_detections.confidence
    FROM pattern_detections
    INNER JOIN pattern_definitions
      ON pattern_definitions.id = pattern_detections.pattern_definition_id
    WHERE pattern_detections.candle_id = ANY(%s::uuid[])
      AND pattern_detections.detected_at <= %s
      AND pattern_definitions.algorithm_version = %s
    ORDER BY
      pattern_detections.candle_id ASC,
      pattern_definitions.pattern_code ASC,
      pattern_definitions.algorithm_version ASC
"""

_PRICE_ACTION_EVIDENCE_SQL = """
    SELECT
      candle_id,
      event_type,
      algorithm_version,
      direction,
      confidence,
      level
    FROM price_action_events
    WHERE candle_id = ANY(%s::uuid[])
      AND detected_at <= %s
      AND algorithm_version = %s
    ORDER BY candle_id ASC, event_type ASC, algorithm_version ASC
"""

# The regime reads a second instrument, so the as-of discipline has to be restated
# here: the VIX bar must have closed no later than the target bar, and both it and its
# average must have been recorded by the cutoff. The lower close_time bound stops a gap
# in the VIX series from carrying an old reading forward as though it were current.
_VIX_REGIME_SQL = """
    SELECT
      target.id AS candle_id,
      vix.close_time AS vix_close_time,
      vix.close AS vix_close,
      vix_snapshot.values AS vix_average
    FROM candles AS target
    CROSS JOIN LATERAL (
      SELECT vix_candles.id, vix_candles.close, vix_candles.close_time
      FROM candles AS vix_candles
      INNER JOIN instruments ON instruments.id = vix_candles.instrument_id
      WHERE instruments.symbol = %s
        AND vix_candles.timeframe = target.timeframe
        AND vix_candles.is_complete = TRUE
        AND vix_candles.received_at <= %s
        AND vix_candles.close_time <= target.close_time
        AND vix_candles.close_time >= target.close_time - %s
      ORDER BY vix_candles.close_time DESC
      LIMIT 1
    ) AS vix
    INNER JOIN indicator_snapshots AS vix_snapshot ON vix_snapshot.candle_id = vix.id
    INNER JOIN indicator_definitions
      ON indicator_definitions.id = vix_snapshot.indicator_definition_id
    WHERE target.id = ANY(%s::uuid[])
      AND vix_snapshot.calculated_at <= %s
      AND indicator_definitions.indicator_code = %s
      AND indicator_definitions.algorithm_version = %s
      AND indicator_definitions.parameters ->> 'period' = %s
    ORDER BY target.id ASC, indicator_definitions.parameters_hash ASC
"""

# Institutional flows are a second source, so the as-of discipline is restated here
# the same way it is for the VIX regime -- and it is stricter, because these figures
# are not a market quote but a report published hours after the session they
# describe.
#
# Three separate bounds, each guarding a different way this leaks:
#
# 1. ``published_at <= data_cutoff_at`` -- the experiment's immutable evidence
#    boundary, identical to every other loader here.
# 2. ``published_at <= target.close_time`` -- the bar may only read what was known
#    when it closed. Without this, a 15:30 IST bar reads figures published at 18:30
#    the same day, which is a three-hour lookahead into its own label window. This
#    is the bound that makes the feature legitimate at all.
# 3. ``flow.date < target``'s own IST session -- belt and braces on (2). Even if a
#    backfill wrote an early ``published_at``, a bar can never read the report for
#    its own session.
#
# The scale window is ``ROWS BETWEEN n PRECEDING AND 1 PRECEDING``: strictly prior
# sessions, so an outlier does not normalise itself away. NULLIF guards the case
# where every prior session was flat, which would otherwise divide by zero.
_INSTITUTIONAL_FLOW_SQL = """
    WITH visible_flows AS (
      SELECT
        date,
        published_at,
        fii_cash_net_cr,
        dii_cash_net_cr,
        AVG(ABS(fii_cash_net_cr)) OVER scale_window AS fii_scale,
        AVG(ABS(dii_cash_net_cr)) OVER scale_window AS dii_scale
      FROM institutional_flows
      WHERE published_at <= %s
      WINDOW scale_window AS (
        ORDER BY date ASC
        ROWS BETWEEN %s PRECEDING AND 1 PRECEDING
      )
    )
    SELECT
      target.id AS candle_id,
      flow.date AS flow_date,
      flow.fii_cash_net_cr,
      flow.dii_cash_net_cr,
      flow.fii_scale,
      flow.dii_scale
    FROM candles AS target
    CROSS JOIN LATERAL (
      SELECT
        visible_flows.date,
        visible_flows.fii_cash_net_cr,
        visible_flows.dii_cash_net_cr,
        visible_flows.fii_scale,
        visible_flows.dii_scale
      FROM visible_flows
      WHERE visible_flows.published_at <= target.close_time
        AND visible_flows.date < (target.close_time AT TIME ZONE 'Asia/Kolkata')::date
        AND visible_flows.date >= (target.close_time AT TIME ZONE 'Asia/Kolkata')::date - %s
      ORDER BY visible_flows.date DESC
      LIMIT 1
    ) AS flow
    WHERE target.id = ANY(%s::uuid[])
"""

_TIMEFRAME_PATTERN = re.compile(r"^(\d+)(m|h|d)$")
_TIMEFRAME_UNIT_SECONDS: Mapping[str, int] = {"m": 60, "h": 3600, "d": 86400}


def _regime_staleness_interval(timeframe: str) -> timedelta | None:
    """The staleness window, or None when the timeframe is not one this rule models.

    Returning None keeps an unrecognised timeframe from borrowing another one's
    window; the regime is reported as unmeasurable instead of silently approximated.
    """

    match = _TIMEFRAME_PATTERN.match(timeframe.strip())
    if match is None:
        return None
    seconds = int(match.group(1)) * _TIMEFRAME_UNIT_SECONDS[match.group(2)]
    return timedelta(seconds=seconds * REGIME_STALENESS_BARS)


_MODEL_VERSION_RETURNING_COLUMNS = """
    id,
    model_key,
    version,
    algorithm,
    stage,
    artifact_uri,
    artifact_checksum,
    feature_schema,
    validation_metrics,
    trained_at,
    promoted_at
"""

_MODEL_PREDICTION_RETURNING_COLUMNS = """
    id,
    model_version_id,
    instrument_id,
    source_candle_id,
    prediction,
    confidence,
    created_at
"""

_HISTORICAL_PREDICTION_RELIABILITY_SQL = """
    WITH cutoff_candles AS (
      SELECT
        candles.id,
        candles.close,
        candles.close_time,
        LEAD(candles.close, %s) OVER (
          {session_partition}
          ORDER BY candles.open_time ASC, candles.close_time ASC, candles.id ASC
        ) AS future_close,
        LEAD(candles.close_time, %s) OVER (
          {session_partition}
          ORDER BY candles.open_time ASC, candles.close_time ASC, candles.id ASC
        ) AS future_close_time
      FROM candles
      WHERE candles.instrument_id = %s
        AND candles.timeframe = %s
        AND candles.is_complete = TRUE
        AND candles.received_at <= %s
        AND candles.close_time <= %s
    ), evaluated_predictions AS (
      SELECT
        predictions.prediction,
        CASE
          WHEN ((cutoff_candles.future_close - cutoff_candles.close) / cutoff_candles.close) * 10000 > %s THEN 'BULLISH'
          WHEN ((cutoff_candles.future_close - cutoff_candles.close) / cutoff_candles.close) * 10000 < -%s THEN 'BEARISH'
          ELSE 'NEUTRAL'
        END AS realised_label
      FROM model_predictions AS predictions
      INNER JOIN cutoff_candles ON cutoff_candles.id = predictions.source_candle_id
      WHERE predictions.model_version_id = %s
        AND predictions.instrument_id = %s
        AND predictions.prediction = %s
        AND predictions.created_at <= %s
        AND predictions.evidence_cutoff_at <= %s
        AND cutoff_candles.close_time < %s
        AND cutoff_candles.future_close_time <= %s
    )
    SELECT
      COUNT(*)::integer AS evaluated_predictions,
      COUNT(*) FILTER (WHERE prediction = realised_label)::integer AS correct_predictions
    FROM evaluated_predictions
"""


def _require_non_blank(value: str, field: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise ValueError(f"{field} must not be blank.")
    return normalized


def _require_valid_datetime(value: datetime, field: str) -> datetime:
    if not isinstance(value, datetime):
        raise ValueError(f"{field} must be a datetime.")
    return value


def _to_optional_datetime(value: Any, field: str) -> datetime | None:
    return None if value is None else _require_valid_datetime(value, field)


def _to_float(value: Any, field: str) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Database returned an invalid numeric {field}.") from error
    if not math.isfinite(parsed):
        raise ValueError(f"Database returned an invalid numeric {field}.")
    return parsed


def _to_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Database returned an invalid integer {field}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Database returned an invalid integer {field}.") from error
    if parsed <= 0:
        raise ValueError(f"Database returned an invalid integer {field}.")
    return parsed


def _to_non_negative_int(value: Any, field: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Database returned an invalid integer {field}.")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Database returned an invalid integer {field}.") from error
    if parsed < 0:
        raise ValueError(f"Database returned an invalid integer {field}.")
    return parsed


def _json_value(value: Any, field: str) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError(f"Database returned invalid JSON for {field}.") from error
    return value


def _to_mapping(value: Any, field: str) -> Mapping[str, Any]:
    parsed = _json_value(value, field)
    if not isinstance(parsed, Mapping):
        raise ValueError(f"Database returned a non-object JSON value for {field}.")
    return dict(parsed)


def _normalize_feature_schema_entry(value: Any, field: str) -> Mapping[str, Any]:
    if isinstance(value, str):
        return {"name": _require_non_blank(value, f"{field} feature name")}
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} entries must be JSON objects or feature-name strings.")
    return dict(value)


def _to_feature_schema(value: Any, field: str) -> Sequence[Mapping[str, Any]]:
    parsed = _json_value(value, field)
    if not isinstance(parsed, Sequence) or isinstance(parsed, (str, bytes, bytearray)):
        raise ValueError(f"Database returned a non-array JSON value for {field}.")
    schema: list[Mapping[str, Any]] = []
    for item in parsed:
        schema.append(_normalize_feature_schema_entry(item, field))
    return tuple(schema)


def _serialize_json_object(value: Mapping[str, Any], field: str) -> str:
    if not isinstance(value, Mapping):
        raise ValueError(f"{field} must be a JSON object.")
    try:
        return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be JSON serializable.") from error


def _serialize_json_array(value: Sequence[Any], field: str) -> str:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError(f"{field} must be a JSON array.")
    try:
        return json.dumps(list(value), sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be JSON serializable with finite numeric values.") from error


def _serialize_feature_schema(value: Sequence[str | Mapping[str, Any]]) -> str:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise ValueError("Feature schema must be a sequence of JSON objects.")
    schema: list[Mapping[str, Any]] = []
    for item in value:
        schema.append(_normalize_feature_schema_entry(item, "Feature schema"))
    try:
        return json.dumps(schema, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError) as error:
        raise ValueError("Feature schema must be JSON serializable.") from error


def _indicator_parameter_contract_json() -> str:
    definition = feature_definition()
    parameters = definition.get("indicatorParameters")
    if not isinstance(parameters, Mapping):
        raise RuntimeError("The ML feature definition has no indicator-parameter contract.")
    return _serialize_json_object(parameters, "ML indicator parameter contract")


def _to_model_version(row: Row) -> PersistedModelVersion:
    checksum = row["artifact_checksum"]
    return PersistedModelVersion(
        id=str(row["id"]),
        model_key=_require_non_blank(str(row["model_key"]), "Model key"),
        version=_to_int(row["version"], "model version"),
        algorithm=_require_non_blank(str(row["algorithm"]), "Algorithm"),
        stage=_require_non_blank(str(row["stage"]), "Model stage"),
        artifact_uri=_require_non_blank(str(row["artifact_uri"]), "Artifact URI"),
        artifact_checksum=None if checksum is None else str(checksum),
        feature_schema=_to_feature_schema(row["feature_schema"], "feature schema"),
        validation_metrics=_to_mapping(row["validation_metrics"], "validation metrics"),
        trained_at=_to_optional_datetime(row.get("trained_at"), "trained at"),
        promoted_at=_to_optional_datetime(row.get("promoted_at"), "promoted at"),
    )


def _to_model_prediction(row: Row) -> PersistedModelPrediction:
    prediction = _require_non_blank(str(row["prediction"]), "Prediction")
    if prediction not in LABELS:
        raise ValueError("Database returned an unsupported prediction label.")
    confidence = _to_float(row["confidence"], "prediction confidence")
    if confidence < 0 or confidence > 1:
        raise ValueError("Database returned a prediction confidence outside [0, 1].")
    source_candle_id = row["source_candle_id"]
    if source_candle_id is None:
        raise ValueError("Phase 11 predictions must retain a completed source candle.")
    return PersistedModelPrediction(
        id=str(row["id"]),
        model_version_id=str(row["model_version_id"]),
        instrument_id=str(row["instrument_id"]),
        source_candle_id=str(source_candle_id),
        prediction=prediction,  # type: ignore[arg-type]
        confidence=confidence,
        created_at=_require_valid_datetime(row["created_at"], "Prediction created at"),
    )


def _validate_dataset_request(request: DatasetRequest) -> None:
    _require_non_blank(request.instrument_symbol, "Instrument symbol")
    _require_non_blank(request.timeframe, "Timeframe")
    _require_non_blank(request.indicator_algorithm_version, "Indicator algorithm version")
    _require_non_blank(request.pattern_algorithm_version, "Pattern algorithm version")
    _require_non_blank(request.price_action_algorithm_version, "Price-action algorithm version")
    _require_valid_datetime(request.data_window_start, "Data-window start")
    _require_valid_datetime(request.data_window_end, "Data-window end")
    _require_valid_datetime(request.data_cutoff_at, "Data cutoff")
    if request.data_window_end <= request.data_window_start:
        raise ValueError("Data-window end must be after data-window start.")
    if request.data_window_end > request.data_cutoff_at:
        raise ValueError("Data-window end must not be later than the data cutoff.")
    if not isinstance(request.horizon_bars, int) or isinstance(request.horizon_bars, bool) or request.horizon_bars <= 0:
        raise ValueError("Horizon bars must be a positive integer.")
    if (
        isinstance(request.neutral_threshold_bps, bool)
        or not isinstance(request.neutral_threshold_bps, (int, float))
        or not math.isfinite(request.neutral_threshold_bps)
        or request.neutral_threshold_bps < 0
    ):
        raise ValueError("Neutral threshold basis points must be a non-negative finite number.")


def _validate_inference_request(request: InferenceRequest) -> None:
    _require_non_blank(request.instrument_symbol, "Instrument symbol")
    _require_non_blank(request.timeframe, "Timeframe")
    _require_non_blank(request.indicator_algorithm_version, "Indicator algorithm version")
    _require_non_blank(request.pattern_algorithm_version, "Pattern algorithm version")
    _require_non_blank(request.price_action_algorithm_version, "Price-action algorithm version")
    _require_valid_datetime(request.data_cutoff_at, "Data cutoff")


class PostgresMlRepository:
    """Reads cutoff-bounded research evidence and persists local model lifecycle state."""

    def __init__(self, connection: Connection[Any]) -> None:
        self._connection = connection

    def load_candle_evidence(self, request: DatasetRequest) -> Sequence[CandleEvidence]:
        """Return ordered source-candle evidence with later labels kept separate from features."""

        _validate_dataset_request(request)
        symbol = _require_non_blank(request.instrument_symbol, "Instrument symbol").upper()
        timeframe = _require_non_blank(request.timeframe, "Timeframe")

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(_FIND_NSE_INSTRUMENT_SQL, (symbol,))
            instrument = cursor.fetchone()
        if instrument is None:
            raise ValueError(f'NSE instrument "{symbol}" is not registered.')

        instrument_id = str(instrument["id"])
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _CANDLE_EVIDENCE_SQL.format(session_partition=_session_partition_clause(timeframe)),
                (
                    request.horizon_bars,
                    request.horizon_bars,
                    instrument_id,
                    timeframe,
                    request.data_cutoff_at,
                    request.data_cutoff_at,
                    request.data_window_end,
                    request.data_window_end,
                    request.data_window_start,
                    request.data_window_end,
                ),
            )
            candle_rows = list(cursor.fetchall())
        if not candle_rows:
            return ()

        candle_ids = [str(row["candle_id"]) for row in candle_rows]
        indicator_parameter_contract = _indicator_parameter_contract_json()
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _INDICATOR_EVIDENCE_SQL,
                (
                    candle_ids,
                    request.data_cutoff_at,
                    request.indicator_algorithm_version,
                    indicator_parameter_contract,
                ),
            )
            indicator_rows = list(cursor.fetchall())
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _PATTERN_EVIDENCE_SQL,
                (candle_ids, request.data_cutoff_at, request.pattern_algorithm_version),
            )
            pattern_rows = list(cursor.fetchall())
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _PRICE_ACTION_EVIDENCE_SQL,
                (candle_ids, request.data_cutoff_at, request.price_action_algorithm_version),
            )
            price_action_rows = list(cursor.fetchall())

        indicators_by_candle: dict[str, list[IndicatorEvidence]] = defaultdict(list)
        for row in indicator_rows:
            indicators_by_candle[str(row["candle_id"])].append(
                IndicatorEvidence(
                    code=_require_non_blank(str(row["indicator_code"]), "Indicator code"),
                    algorithm_version=_require_non_blank(str(row["algorithm_version"]), "Indicator algorithm version"),
                    parameters=_to_mapping(row["parameters"], "indicator parameters"),
                    values=_to_mapping(row["values"], "indicator values"),
                )
            )

        patterns_by_candle: dict[str, list[PatternEvidence]] = defaultdict(list)
        for row in pattern_rows:
            patterns_by_candle[str(row["candle_id"])].append(
                PatternEvidence(
                    code=_require_non_blank(str(row["pattern_code"]), "Pattern code"),
                    algorithm_version=_require_non_blank(str(row["algorithm_version"]), "Pattern algorithm version"),
                    direction=_require_non_blank(str(row["direction"]), "Pattern direction"),
                    confidence=_to_float(row["confidence"], "pattern confidence"),
                )
            )

        price_actions_by_candle: dict[str, list[PriceActionEvidence]] = defaultdict(list)
        for row in price_action_rows:
            level = row["level"]
            price_actions_by_candle[str(row["candle_id"])].append(
                PriceActionEvidence(
                    event_type=_require_non_blank(str(row["event_type"]), "Price-action event type"),
                    algorithm_version=_require_non_blank(str(row["algorithm_version"]), "Price-action algorithm version"),
                    direction=_require_non_blank(str(row["direction"]), "Price-action direction"),
                    confidence=_to_float(row["confidence"], "price-action confidence"),
                    level=None if level is None else _to_float(level, "price-action level"),
                )
            )

        regime_by_candle = self._load_vix_regime(candle_ids, timeframe, request.data_cutoff_at)
        flow_by_candle = self._load_institutional_flow(candle_ids, request.data_cutoff_at)
        # Only path-based schemes read a forward path, so the fixed-horizon scheme
        # issues no extra query and its behaviour is bit-for-bit unchanged.
        forward_paths = (
            self._load_forward_paths(
                candle_ids,
                timeframe,
                request.horizon_bars,
                request.data_cutoff_at,
                request.data_window_end,
            )
            if request.label_scheme in _FORWARD_PATH_LABEL_SCHEMES
            else {}
        )

        evidence: list[CandleEvidence] = []
        for row in candle_rows:
            close_time = _require_valid_datetime(row["close_time"], "Candle close time")
            future_close = row["future_close"]
            future_close_time = row["future_close_time"]
            if (future_close is None) != (future_close_time is None):
                raise ValueError("Database returned an incomplete future-label pair.")
            resolved_future_close = None if future_close is None else _to_float(future_close, "future candle close")
            resolved_future_close_time = (
                None if future_close_time is None else _require_valid_datetime(future_close_time, "Future candle close time")
            )
            if resolved_future_close_time is not None and resolved_future_close_time <= close_time:
                raise ValueError("Future label must close after its source candle.")

            candle_id = str(row["candle_id"])
            regime = regime_by_candle.get(candle_id)
            flow = flow_by_candle.get(candle_id)
            evidence.append(
                CandleEvidence(
                    candle_id=candle_id,
                    instrument_id=str(row["instrument_id"]),
                    symbol=_require_non_blank(str(row["symbol"]), "Instrument symbol"),
                    timeframe=_require_non_blank(str(row["timeframe"]), "Timeframe"),
                    open_time=_require_valid_datetime(row["open_time"], "Candle open time"),
                    close_time=close_time,
                    open=_to_float(row["open"], "candle open"),
                    high=_to_float(row["high"], "candle high"),
                    low=_to_float(row["low"], "candle low"),
                    close=_to_float(row["close"], "candle close"),
                    volume=_to_float(row["volume"], "candle volume"),
                    indicators=tuple(indicators_by_candle[candle_id]),
                    patterns=tuple(patterns_by_candle[candle_id]),
                    price_action_events=tuple(price_actions_by_candle[candle_id]),
                    future_close=resolved_future_close,
                    future_close_time=resolved_future_close_time,
                    vix_value_ratio=None if regime is None else regime[0],
                    vix_observed_at=None if regime is None else regime[1],
                    fii_net_flow_ratio=None if flow is None else flow.fii_net_flow_ratio,
                    dii_net_flow_ratio=None if flow is None else flow.dii_net_flow_ratio,
                    institutional_flow_date=None if flow is None else flow.flow_date,
                    forward_path=forward_paths.get(candle_id, ()),
                )
            )
        return tuple(evidence)

    def _load_forward_paths(
        self,
        candle_ids: Sequence[str],
        timeframe: str,
        horizon_bars: int,
        data_cutoff_at: datetime,
        data_window_end: datetime,
    ) -> dict[str, tuple[ForwardBar, ...]]:
        """Map each source candle to its forward path for triple-barrier labelling.

        A candle missing from the result, or present with fewer than ``horizon_bars``
        bars, is right-censored at the end of the data: the builder treats a short
        no-touch path as unknown rather than a genuine time-out.
        """

        if not candle_ids:
            return {}

        session_bound = _FORWARD_PATH_SESSION_BOUND if _is_intraday_timeframe(timeframe) else ""
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _FORWARD_PATH_SQL.format(session_bound=session_bound),
                (data_cutoff_at, data_window_end, horizon_bars, list(candle_ids)),
            )
            rows = list(cursor.fetchall())

        paths: dict[str, list[ForwardBar]] = defaultdict(list)
        for row in rows:
            paths[str(row["source_candle_id"])].append(
                ForwardBar(
                    high=_to_float(row["high"], "forward bar high"),
                    low=_to_float(row["low"], "forward bar low"),
                    close=_to_float(row["close"], "forward bar close"),
                    close_time=_require_valid_datetime(row["close_time"], "forward bar close time"),
                )
            )
        return {candle_id: tuple(bars) for candle_id, bars in paths.items()}

    def _load_institutional_flow(
        self,
        candle_ids: Sequence[str],
        data_cutoff_at: datetime,
    ) -> dict[str, InstitutionalFlowEvidence]:
        """Map candle id to the scale-free institutional flow visible when it closed.

        A candle is simply absent from the result when the flow is unmeasurable --
        no collected print, a gap wider than the staleness window, or fewer than
        one prior session to scale against. Callers leave the feature missing in
        that case rather than substituting 0, because a zero net flow is a real
        and different observation from an unobserved one, and imputing it would
        teach the model that "collector was down" looks like "balanced session".
        """

        if not candle_ids:
            return {}

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _INSTITUTIONAL_FLOW_SQL,
                (
                    data_cutoff_at,
                    INSTITUTIONAL_FLOW_SCALE_SESSIONS,
                    INSTITUTIONAL_FLOW_STALENESS_DAYS,
                    list(candle_ids),
                ),
            )
            rows = list(cursor.fetchall())

        flow_by_candle: dict[str, InstitutionalFlowEvidence] = {}
        for row in rows:
            candle_id = str(row["candle_id"])
            if candle_id in flow_by_candle:
                continue

            def ratio(net_key: str, scale_key: str) -> float | None:
                net = row[net_key]
                scale = row[scale_key]
                if net is None or scale is None:
                    return None
                scale_value = _to_float(scale, "institutional flow scale")
                if scale_value <= 0:
                    return None
                return _to_float(net, "institutional net flow") / scale_value

            fii_ratio = ratio("fii_cash_net_cr", "fii_scale")
            dii_ratio = ratio("dii_cash_net_cr", "dii_scale")
            if fii_ratio is None and dii_ratio is None:
                continue

            flow_by_candle[candle_id] = InstitutionalFlowEvidence(
                fii_net_flow_ratio=fii_ratio,
                dii_net_flow_ratio=dii_ratio,
                flow_date=row["flow_date"],
            )
        return flow_by_candle

    def _load_vix_regime(
        self,
        candle_ids: Sequence[str],
        timeframe: str,
        data_cutoff_at: datetime,
    ) -> dict[str, tuple[float, datetime]]:
        """Map candle id to its volatility ratio and the VIX close time behind it.

        A candle is simply absent from the result when the regime cannot be measured
        — no registered VIX instrument, a gap wider than the staleness window, or a
        missing average. Callers leave the feature missing in that case rather than
        substituting a value, so the imputer cannot disguise absent evidence as calm.
        """

        staleness = _regime_staleness_interval(timeframe)
        if not candle_ids or staleness is None:
            return {}

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _VIX_REGIME_SQL,
                (
                    REGIME_SOURCE_SYMBOL,
                    data_cutoff_at,
                    staleness,
                    list(candle_ids),
                    data_cutoff_at,
                    REGIME_SOURCE_INDICATOR_CODE,
                    REGIME_SOURCE_INDICATOR_ALGORITHM_VERSION,
                    str(REGIME_SOURCE_INDICATOR_PERIOD),
                ),
            )
            rows = list(cursor.fetchall())

        regime_by_candle: dict[str, tuple[float, datetime]] = {}
        for row in rows:
            candle_id = str(row["candle_id"])
            if candle_id in regime_by_candle:
                continue
            average = _to_mapping(row["vix_average"], "VIX average values").get("value")
            if average is None:
                continue
            vix_average = _to_float(average, "VIX average")
            vix_close = _to_float(row["vix_close"], "VIX close")
            if vix_average <= 0 or vix_close <= 0:
                continue
            regime_by_candle[candle_id] = (
                vix_close / vix_average,
                _require_valid_datetime(row["vix_close_time"], "VIX close time"),
            )
        return regime_by_candle

    def load_trailing_close_volume_series(
        self,
        request: InferenceRequest,
        *,
        bars: int,
    ) -> list[tuple[float, float]]:
        """Load the last ``bars`` completed candles as chronological (close, volume).

        The stationary feature schema needs the previous close and a rolling median
        volume, which a single-candle inference read cannot supply. This walks
        backwards from the same as-of cutoff as
        :meth:`load_latest_completed_candle_evidence`, so it can only ever see bars
        that were already complete and received at that instant — never a later one.
        """

        _validate_inference_request(request)
        if isinstance(bars, bool) or not isinstance(bars, int) or bars <= 0:
            raise ValueError("bars must be a positive integer.")
        symbol = _require_non_blank(request.instrument_symbol, "Instrument symbol").upper()
        timeframe = _require_non_blank(request.timeframe, "Timeframe")

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(_FIND_NSE_INSTRUMENT_SQL, (symbol,))
            instrument = cursor.fetchone()
        if instrument is None:
            raise ValueError(f'NSE instrument "{symbol}" is not registered.')

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _TRAILING_CLOSE_VOLUME_SQL,
                (
                    str(instrument["id"]),
                    timeframe,
                    request.data_cutoff_at,
                    request.data_cutoff_at,
                    bars,
                ),
            )
            rows = list(cursor.fetchall())

        # The query returns newest first so the LIMIT keeps the most recent window;
        # reverse it to hand back the chronological order features expect.
        return [
            (_to_float(row["close"], "candle close"), _to_float(row["volume"], "candle volume"))
            for row in reversed(rows)
        ]

    def load_latest_completed_candle_evidence(self, request: InferenceRequest) -> CandleEvidence | None:
        """Load one as-of completed candle and only its compatible persisted evidence.

        This inference reader deliberately has no future-close window function.
        A prediction can therefore never use a later candle merely because a
        label would be available for training.
        """

        _validate_inference_request(request)
        symbol = _require_non_blank(request.instrument_symbol, "Instrument symbol").upper()
        timeframe = _require_non_blank(request.timeframe, "Timeframe")

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(_FIND_NSE_INSTRUMENT_SQL, (symbol,))
            instrument = cursor.fetchone()
        if instrument is None:
            raise ValueError(f'NSE instrument "{symbol}" is not registered.')

        instrument_id = str(instrument["id"])
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _LATEST_CANDLE_EVIDENCE_SQL,
                (instrument_id, timeframe, request.data_cutoff_at, request.data_cutoff_at),
            )
            candle_row = cursor.fetchone()
        if candle_row is None:
            return None

        candle_id = str(candle_row["candle_id"])
        indicator_parameter_contract = _indicator_parameter_contract_json()
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _INDICATOR_EVIDENCE_SQL,
                (
                    [candle_id],
                    request.data_cutoff_at,
                    request.indicator_algorithm_version,
                    indicator_parameter_contract,
                ),
            )
            indicator_rows = list(cursor.fetchall())
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _PATTERN_EVIDENCE_SQL,
                ([candle_id], request.data_cutoff_at, request.pattern_algorithm_version),
            )
            pattern_rows = list(cursor.fetchall())
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _PRICE_ACTION_EVIDENCE_SQL,
                ([candle_id], request.data_cutoff_at, request.price_action_algorithm_version),
            )
            price_action_rows = list(cursor.fetchall())

        indicators = tuple(
            IndicatorEvidence(
                code=_require_non_blank(str(row["indicator_code"]), "Indicator code"),
                algorithm_version=_require_non_blank(str(row["algorithm_version"]), "Indicator algorithm version"),
                parameters=_to_mapping(row["parameters"], "indicator parameters"),
                values=_to_mapping(row["values"], "indicator values"),
            )
            for row in indicator_rows
        )
        patterns = tuple(
            PatternEvidence(
                code=_require_non_blank(str(row["pattern_code"]), "Pattern code"),
                algorithm_version=_require_non_blank(str(row["algorithm_version"]), "Pattern algorithm version"),
                direction=_require_non_blank(str(row["direction"]), "Pattern direction"),
                confidence=_to_float(row["confidence"], "pattern confidence"),
            )
            for row in pattern_rows
        )
        price_action_events = tuple(
            PriceActionEvidence(
                event_type=_require_non_blank(str(row["event_type"]), "Price-action event type"),
                algorithm_version=_require_non_blank(str(row["algorithm_version"]), "Price-action algorithm version"),
                direction=_require_non_blank(str(row["direction"]), "Price-action direction"),
                confidence=_to_float(row["confidence"], "price-action confidence"),
                level=None if row["level"] is None else _to_float(row["level"], "price-action level"),
            )
            for row in price_action_rows
        )
        close_time = _require_valid_datetime(candle_row["close_time"], "Candle close time")
        open_time = _require_valid_datetime(candle_row["open_time"], "Candle open time")
        if close_time <= open_time:
            raise ValueError("Database returned a candle that does not close after it opens.")
        # Both resolved through the same loaders training uses. Substituting a
        # placeholder here instead would be train/serve skew, and the imputer would
        # hide it. This is precisely what went wrong with the institutional-flow
        # columns when they were introduced: they were declared in the schema but
        # never loaded on either path, so the model was fitted on and served a
        # constant.
        regime = self._load_vix_regime([candle_id], timeframe, request.data_cutoff_at).get(candle_id)
        flow = self._load_institutional_flow([candle_id], request.data_cutoff_at).get(candle_id)
        return CandleEvidence(
            candle_id=candle_id,
            instrument_id=str(candle_row["instrument_id"]),
            symbol=_require_non_blank(str(candle_row["symbol"]), "Instrument symbol"),
            timeframe=_require_non_blank(str(candle_row["timeframe"]), "Timeframe"),
            open_time=open_time,
            close_time=close_time,
            open=_to_float(candle_row["open"], "candle open"),
            high=_to_float(candle_row["high"], "candle high"),
            low=_to_float(candle_row["low"], "candle low"),
            close=_to_float(candle_row["close"], "candle close"),
            volume=_to_float(candle_row["volume"], "candle volume"),
            indicators=indicators,
            patterns=patterns,
            price_action_events=price_action_events,
            future_close=None,
            future_close_time=None,
            vix_value_ratio=None if regime is None else regime[0],
            vix_observed_at=None if regime is None else regime[1],
            fii_net_flow_ratio=None if flow is None else flow.fii_net_flow_ratio,
            dii_net_flow_ratio=None if flow is None else flow.dii_net_flow_ratio,
            institutional_flow_date=None if flow is None else flow.flow_date,
        )

    def create_candidate_model(
        self,
        *,
        model_key: str,
        algorithm: str,
        artifact_uri: str,
        artifact_checksum: str | None,
        feature_schema: Sequence[str | Mapping[str, Any]],
        training_window_start: datetime,
        training_window_end: datetime,
        training_rows: int,
        validation_metrics: Mapping[str, Any],
        trained_at: datetime,
    ) -> PersistedModelVersion:
        """Create the next immutable candidate version under a per-model transaction lock."""

        normalized_model_key = _require_non_blank(model_key, "Model key")
        normalized_algorithm = _require_non_blank(algorithm, "Algorithm")
        normalized_artifact_uri = _require_non_blank(artifact_uri, "Artifact URI")
        _require_valid_datetime(training_window_start, "Training-window start")
        _require_valid_datetime(training_window_end, "Training-window end")
        _require_valid_datetime(trained_at, "Trained at")
        if training_window_end <= training_window_start:
            raise ValueError("Training-window end must be after training-window start.")
        if isinstance(training_rows, bool) or not isinstance(training_rows, int) or training_rows <= 0:
            raise ValueError("Training rows must be a positive integer.")

        serialized_schema = _serialize_feature_schema(feature_schema)
        serialized_metrics = _serialize_json_object(validation_metrics, "Validation metrics")
        normalized_checksum = None if artifact_checksum is None else _require_non_blank(artifact_checksum, "Artifact checksum")

        with self._connection.transaction():
            with self._connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (normalized_model_key,))
                cursor.execute(
                    """
                    SELECT COALESCE(MAX(version), 0) + 1 AS next_version
                    FROM model_versions
                    WHERE model_key = %s
                    """,
                    (normalized_model_key,),
                )
                version_row = cursor.fetchone()
                if version_row is None:
                    raise RuntimeError("Unable to allocate a model version.")
                next_version = _to_int(version_row["next_version"], "next model version")
                cursor.execute(
                    f"""
                    INSERT INTO model_versions (
                      model_key,
                      version,
                      algorithm,
                      stage,
                      artifact_uri,
                      artifact_checksum,
                      feature_schema,
                      training_window_start,
                      training_window_end,
                      training_rows,
                      validation_metrics,
                      trained_at
                    ) VALUES (%s, %s, %s, 'CANDIDATE', %s, %s, %s::jsonb, %s, %s, %s, %s::jsonb, %s)
                    RETURNING {_MODEL_VERSION_RETURNING_COLUMNS}
                    """,
                    (
                        normalized_model_key,
                        next_version,
                        normalized_algorithm,
                        normalized_artifact_uri,
                        normalized_checksum,
                        serialized_schema,
                        training_window_start,
                        training_window_end,
                        training_rows,
                        serialized_metrics,
                        trained_at,
                    ),
                )
                inserted = cursor.fetchone()
                if inserted is None:
                    raise RuntimeError("Creating the candidate model did not return a row.")
                return _to_model_version(inserted)

    def get_production_model(self, model_key: str) -> PersistedModelVersion | None:
        """Resolve the sole production version for a model key, if one is promoted."""

        normalized_model_key = _require_non_blank(model_key, "Model key")
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                f"""
                SELECT {_MODEL_VERSION_RETURNING_COLUMNS}
                FROM model_versions
                WHERE model_key = %s AND stage = 'PRODUCTION'
                ORDER BY version DESC
                LIMIT 1
                """,
                (normalized_model_key,),
            )
            row = cursor.fetchone()
        return None if row is None else _to_model_version(row)

    def historical_prediction_reliability(
        self,
        *,
        model_version_id: str,
        instrument_id: str,
        timeframe: str,
        prediction: MarketLabel,
        reference_close_time: datetime,
        data_cutoff_at: datetime,
        horizon_bars: int,
        neutral_threshold_bps: float,
    ) -> HistoricalPredictionReliability:
        """Measure earlier same-label predictions whose outcomes were knowable by this candle close.

        The query deliberately excludes records created after the source candle
        and outcomes that closed after it. This keeps the explanation from
        turning later observed outcomes into apparent contemporaneous evidence.
        """

        normalized_model_version_id = _require_non_blank(model_version_id, "Model version ID")
        normalized_instrument_id = _require_non_blank(instrument_id, "Instrument ID")
        normalized_timeframe = _require_non_blank(timeframe, "Timeframe")
        if prediction not in LABELS:
            raise ValueError("Prediction must be one of BEARISH, NEUTRAL, or BULLISH.")
        _require_valid_datetime(reference_close_time, "Reference candle close time")
        _require_valid_datetime(data_cutoff_at, "Data cutoff")
        if reference_close_time > data_cutoff_at:
            raise ValueError("Reference candle close time must not be later than the data cutoff.")
        if isinstance(horizon_bars, bool) or not isinstance(horizon_bars, int) or horizon_bars <= 0:
            raise ValueError("Horizon bars must be a positive integer.")
        if (
            isinstance(neutral_threshold_bps, bool)
            or not isinstance(neutral_threshold_bps, (int, float))
            or not math.isfinite(neutral_threshold_bps)
            or neutral_threshold_bps < 0
        ):
            raise ValueError("Neutral threshold basis points must be a non-negative finite number.")

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                _HISTORICAL_PREDICTION_RELIABILITY_SQL.format(
                    session_partition=_session_partition_clause(normalized_timeframe)
                ),
                (
                    horizon_bars,
                    horizon_bars,
                    normalized_instrument_id,
                    normalized_timeframe,
                    data_cutoff_at,
                    reference_close_time,
                    neutral_threshold_bps,
                    neutral_threshold_bps,
                    normalized_model_version_id,
                    normalized_instrument_id,
                    prediction,
                    reference_close_time,
                    reference_close_time,
                    reference_close_time,
                    reference_close_time,
                ),
            )
            row = cursor.fetchone()
        if row is None:
            raise RuntimeError("Historical prediction reliability query did not return a row.")
        evaluated_predictions = _to_non_negative_int(row["evaluated_predictions"], "evaluated prediction count")
        correct_predictions = _to_non_negative_int(row["correct_predictions"], "correct prediction count")
        if correct_predictions > evaluated_predictions:
            raise ValueError("Database returned more correct predictions than evaluated predictions.")
        return HistoricalPredictionReliability(
            evaluated_predictions=evaluated_predictions,
            correct_predictions=correct_predictions,
            accuracy=None if evaluated_predictions == 0 else correct_predictions / evaluated_predictions,
        )

    def save_model_prediction(
        self,
        *,
        model_version_id: str,
        instrument_id: str,
        source_candle_id: str,
        prediction: MarketLabel,
        confidence: float,
        feature_contributions: Sequence[Mapping[str, Any]],
        explanation: Sequence[Mapping[str, Any]],
        evidence_cutoff_at: datetime,
    ) -> PersistedModelPrediction:
        """Upsert one explainable research prediction for one model/source-candle pair."""

        normalized_model_version_id = _require_non_blank(model_version_id, "Model version ID")
        normalized_instrument_id = _require_non_blank(instrument_id, "Instrument ID")
        normalized_source_candle_id = _require_non_blank(source_candle_id, "Source candle ID")
        if prediction not in LABELS:
            raise ValueError("Prediction must be one of BEARISH, NEUTRAL, or BULLISH.")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Prediction confidence must be a finite value in [0, 1].")
        _require_valid_datetime(evidence_cutoff_at, "Evidence cutoff")
        serialized_contributions = _serialize_json_array(feature_contributions, "Feature contributions")
        serialized_explanation = _serialize_json_array(explanation, "Explanation")

        with self._connection.transaction():
            with self._connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    f"""
                    INSERT INTO model_predictions (
                      model_version_id,
                      instrument_id,
                      source_candle_id,
                      trade_idea_id,
                      prediction,
                      confidence,
                      feature_contributions,
                      explanation,
                      evidence_cutoff_at
                    ) VALUES (%s, %s, %s, NULL, %s, %s, %s::jsonb, %s::jsonb, %s)
                    ON CONFLICT (model_version_id, source_candle_id)
                      WHERE source_candle_id IS NOT NULL
                    DO UPDATE SET
                      prediction = EXCLUDED.prediction,
                      confidence = EXCLUDED.confidence,
                      feature_contributions = EXCLUDED.feature_contributions,
                      explanation = EXCLUDED.explanation,
                      evidence_cutoff_at = EXCLUDED.evidence_cutoff_at
                    RETURNING {_MODEL_PREDICTION_RETURNING_COLUMNS}
                    """,
                    (
                        normalized_model_version_id,
                        normalized_instrument_id,
                        normalized_source_candle_id,
                        prediction,
                        float(confidence),
                        serialized_contributions,
                        serialized_explanation,
                        evidence_cutoff_at,
                    ),
                )
                row = cursor.fetchone()
        if row is None:
            raise RuntimeError("Saving the model prediction did not return a row.")
        return _to_model_prediction(row)

    def save_auxiliary_prediction(
        self,
        *,
        model_version_id: str,
        instrument_id: str,
        source_candle_id: str,
        label_scheme: str,
        prediction: AnyLabel,
        confidence: float,
        feature_contributions: Sequence[Mapping[str, Any]],
        explanation: Sequence[Mapping[str, Any]],
        evidence_cutoff_at: datetime,
        alphabet: LabelAlphabet,
    ) -> dict[str, Any]:
        """Upsert one prediction from a model whose target is not a trade direction.

        Deliberately a separate method writing a separate table, not a branch inside
        :meth:`save_model_prediction`. ``model_predictions`` is read as a directional
        signal by the strategy engine, the agent, the scanner, and the dashboards; a
        CONTRACTION/STABLE/EXPANSION value reaching that table would be interpreted
        as a call on price direction.

        ``alphabet`` is required rather than defaulted: the database intentionally
        does not constrain ``prediction`` to a value list (the table serves every
        non-directional scheme), so this is the boundary that enforces the label set,
        and making it explicit stops a caller from silently getting the directional
        one.
        """

        normalized_model_version_id = _require_non_blank(model_version_id, "Model version ID")
        normalized_instrument_id = _require_non_blank(instrument_id, "Instrument ID")
        normalized_source_candle_id = _require_non_blank(source_candle_id, "Source candle ID")
        normalized_scheme = _require_non_blank(label_scheme, "Label scheme")
        if prediction not in set(alphabet.labels):
            raise ValueError(
                f"Prediction must be one of {', '.join(alphabet.labels)} for the {alphabet.name} alphabet."
            )
        # A directional label in this table would mean a directional model wrote to
        # the auxiliary path, which is as much a mistake as the reverse.
        if prediction in set(LABELS):
            raise ValueError(
                "Directional labels belong in model_predictions, not auxiliary_model_predictions."
            )
        if (
            isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(confidence)
            or not 0 <= confidence <= 1
        ):
            raise ValueError("Prediction confidence must be a finite value in [0, 1].")
        _require_valid_datetime(evidence_cutoff_at, "Evidence cutoff")
        serialized_contributions = _serialize_json_array(feature_contributions, "Feature contributions")
        serialized_explanation = _serialize_json_array(explanation, "Explanation")

        with self._connection.transaction():
            with self._connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    """
                    INSERT INTO auxiliary_model_predictions (
                      model_version_id,
                      instrument_id,
                      source_candle_id,
                      label_scheme,
                      prediction,
                      confidence,
                      feature_contributions,
                      explanation,
                      evidence_cutoff_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s)
                    ON CONFLICT (model_version_id, source_candle_id)
                      WHERE source_candle_id IS NOT NULL
                    DO UPDATE SET
                      label_scheme = EXCLUDED.label_scheme,
                      prediction = EXCLUDED.prediction,
                      confidence = EXCLUDED.confidence,
                      feature_contributions = EXCLUDED.feature_contributions,
                      explanation = EXCLUDED.explanation,
                      evidence_cutoff_at = EXCLUDED.evidence_cutoff_at
                    RETURNING id, model_version_id, instrument_id, source_candle_id,
                              label_scheme, prediction, confidence, created_at
                    """,
                    (
                        normalized_model_version_id,
                        normalized_instrument_id,
                        normalized_source_candle_id,
                        normalized_scheme,
                        prediction,
                        float(confidence),
                        serialized_contributions,
                        serialized_explanation,
                        evidence_cutoff_at,
                    ),
                )
                row = cursor.fetchone()
        if row is None:
            raise RuntimeError("Saving the auxiliary prediction did not return a row.")
        return {
            "id": str(row["id"]),
            "modelVersionId": str(row["model_version_id"]),
            "instrumentId": str(row["instrument_id"]),
            "sourceCandleId": None if row["source_candle_id"] is None else str(row["source_candle_id"]),
            "labelScheme": str(row["label_scheme"]),
            "prediction": str(row["prediction"]),
            "confidence": _to_float(row["confidence"], "prediction confidence"),
            "createdAt": _require_valid_datetime(row["created_at"], "Prediction created-at"),
        }

    def list_auxiliary_predictions(
        self,
        *,
        instrument_id: str,
        label_scheme: str,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        """Most recent non-directional predictions for one instrument and scheme."""

        normalized_instrument_id = _require_non_blank(instrument_id, "Instrument ID")
        normalized_scheme = _require_non_blank(label_scheme, "Label scheme")
        bounded_limit = max(1, min(500, int(limit)))
        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(
                """
                SELECT id, model_version_id, instrument_id, source_candle_id,
                       label_scheme, prediction, confidence, created_at
                FROM auxiliary_model_predictions
                WHERE instrument_id = %s AND label_scheme = %s
                ORDER BY created_at DESC, id DESC
                LIMIT %s
                """,
                (normalized_instrument_id, normalized_scheme, bounded_limit),
            )
            rows = list(cursor.fetchall())
        return [
            {
                "id": str(row["id"]),
                "modelVersionId": str(row["model_version_id"]),
                "instrumentId": str(row["instrument_id"]),
                "sourceCandleId": None if row["source_candle_id"] is None else str(row["source_candle_id"]),
                "labelScheme": str(row["label_scheme"]),
                "prediction": str(row["prediction"]),
                "confidence": _to_float(row["confidence"], "prediction confidence"),
                "createdAt": _require_valid_datetime(row["created_at"], "Prediction created-at"),
            }
            for row in rows
        ]

    def promote_candidate(
        self,
        *,
        model_version_id: str,
        expected_previous_model_id: str | None,
        comparison: Mapping[str, Any],
    ) -> PersistedModelVersion:
        """Promote a compared candidate only if the incumbent has not changed."""

        normalized_model_version_id = _require_non_blank(model_version_id, "Model version ID")
        if expected_previous_model_id is not None:
            expected_previous_model_id = _require_non_blank(expected_previous_model_id, "Expected previous model ID")
        serialized_comparison = _serialize_json_object(comparison, "Promotion comparison")

        with self._connection.transaction():
            with self._connection.cursor(row_factory=dict_row) as cursor:
                cursor.execute(
                    f"""
                    SELECT {_MODEL_VERSION_RETURNING_COLUMNS}
                    FROM model_versions
                    WHERE id = %s
                    FOR UPDATE
                    """,
                    (normalized_model_version_id,),
                )
                candidate_row = cursor.fetchone()
                if candidate_row is None:
                    raise ValueError("Candidate model version was not found.")
                candidate = _to_model_version(candidate_row)
                if candidate.stage != "CANDIDATE":
                    raise ValueError(f"Only CANDIDATE models can be promoted; found {candidate.stage}.")

                cursor.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (candidate.model_key,))
                cursor.execute(
                    """
                    SELECT id
                    FROM model_versions
                    WHERE model_key = %s AND stage = 'PRODUCTION'
                    FOR UPDATE
                    """,
                    (candidate.model_key,),
                )
                current_production = cursor.fetchone()
                current_production_id = None if current_production is None else str(current_production["id"])
                if current_production_id != expected_previous_model_id:
                    raise ValueError("Current production model changed since the candidate comparison.")

                if current_production_id is not None:
                    cursor.execute(
                        """
                        UPDATE model_versions
                        SET stage = 'ARCHIVED'
                        WHERE id = %s AND stage = 'PRODUCTION'
                        """,
                        (current_production_id,),
                    )

                cursor.execute(
                    f"""
                    UPDATE model_versions
                    SET stage = 'PRODUCTION', promoted_at = CURRENT_TIMESTAMP
                    WHERE id = %s AND stage = 'CANDIDATE'
                    RETURNING {_MODEL_VERSION_RETURNING_COLUMNS}
                    """,
                    (candidate.id,),
                )
                promoted_row = cursor.fetchone()
                if promoted_row is None:
                    raise RuntimeError("Candidate model could not be marked as production.")

                cursor.execute(
                    """
                    INSERT INTO model_promotions (
                      model_version_id,
                      previous_model_version_id,
                      comparison
                    ) VALUES (%s, %s, %s::jsonb)
                    """,
                    (candidate.id, current_production_id, serialized_comparison),
                )
                return _to_model_version(promoted_row)
