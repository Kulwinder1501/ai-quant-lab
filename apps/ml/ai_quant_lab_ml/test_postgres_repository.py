"""Focused fake-connection tests for the psycopg ML persistence adapter."""

from __future__ import annotations

import json
import unittest
from collections import deque
from datetime import date, datetime, timedelta, timezone
from typing import Any, Mapping

from ai_quant_lab_ml.contracts import DatasetRequest, InferenceRequest
from ai_quant_lab_ml.features import feature_definition
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository


Row = Mapping[str, Any]


class FakeCursor:
    def __init__(self, connection: "FakeConnection") -> None:
        self._connection = connection
        self._rows: list[Row] = []

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        return False

    def execute(self, query: str, params: tuple[Any, ...] | None = None) -> None:
        self._connection.calls.append((" ".join(query.split()), params))
        outcome = self._connection.outcomes.popleft()
        if isinstance(outcome, Exception):
            raise outcome
        self._rows = outcome

    def fetchone(self) -> Row | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[Row]:
        return list(self._rows)


class FakeTransaction:
    def __init__(self, connection: "FakeConnection") -> None:
        self._connection = connection

    def __enter__(self) -> "FakeTransaction":
        self._connection.transaction_events.append("begin")
        return self

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        self._connection.transaction_events.append("rollback" if exc_type else "commit")
        return False


class FakeConnection:
    def __init__(self, outcomes: list[list[Row] | Exception]) -> None:
        self.outcomes: deque[list[Row] | Exception] = deque(outcomes)
        self.calls: list[tuple[str, tuple[Any, ...] | None]] = []
        self.transaction_events: list[str] = []
        self.row_factories: list[object] = []

    def cursor(self, *, row_factory: object = None) -> FakeCursor:
        self.row_factories.append(row_factory)
        return FakeCursor(self)

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)


def at(day: int, hour: int = 0) -> datetime:
    return datetime(2026, 1, day, hour, tzinfo=timezone.utc)


def request() -> DatasetRequest:
    return DatasetRequest(
        instrument_symbol="nifty50",
        timeframe="1d",
        data_window_start=at(1),
        data_window_end=at(31, 23),
        data_cutoff_at=at(31, 23),
        horizon_bars=2,
        neutral_threshold_bps=10.0,
    )


def inference_request() -> InferenceRequest:
    return InferenceRequest(
        instrument_symbol="nifty50",
        timeframe="1d",
        data_cutoff_at=at(31, 23),
    )


def model_row(**overrides: Any) -> Row:
    row: dict[str, Any] = {
        "id": "model-3",
        "model_key": "trend-label-v1",
        "version": 3,
        "algorithm": "logistic-regression",
        "stage": "CANDIDATE",
        "artifact_uri": "file:///models/model-3.joblib",
        "artifact_checksum": "sha256:abc",
        "feature_schema": [{"name": "close", "version": "ml-feature-v1"}],
        "validation_metrics": {"balanced_accuracy": 0.7},
        "trained_at": at(20),
        "promoted_at": None,
    }
    row.update(overrides)
    return row


class PostgresMlRepositoryTests(unittest.TestCase):
    def test_shadow_pool_reads_only_explicitly_enrolled_versions(self) -> None:
        enrolled_at = at(22)
        connection = FakeConnection([[
            model_row(
                model_key="volatility-expansion-xgboost--NIFTY50--60m--h2",
                validation_metrics={
                    "validationProtocol": {"labelScheme": "volatility-expansion-v1"},
                    "promotionAssessment": {"decision": "INITIAL_BASELINE_THRESHOLD_MET"},
                },
                shadow_enrolled_at=enrolled_at,
            )
        ]])

        members = PostgresMlRepository(connection).list_shadow_pool("volatility-expansion-v1")

        self.assertEqual(len(members), 1)
        self.assertEqual(members[0]["enrolled_at"], enrolled_at)
        query, parameters = connection.calls[0]
        self.assertIn("FROM volatility_shadow_enrollments", query)
        self.assertIn("model_versions.id = volatility_shadow_enrollments.model_version_id", query)
        self.assertEqual(parameters, ("volatility-expansion-v1", "volatility-expansion-v1"))

    def test_directional_scheme_cannot_query_the_auxiliary_shadow_pool(self) -> None:
        connection = FakeConnection([])

        with self.assertRaisesRegex(ValueError, "directional"):
            PostgresMlRepository(connection).list_shadow_pool("fixed-horizon-v1")

        self.assertEqual(connection.calls, [])

    def test_loads_cutoff_bounded_source_evidence_and_later_labels(self) -> None:
        connection = FakeConnection([
            [{"id": "instrument-1", "symbol": "NIFTY50"}],
            [
                {
                    "candle_id": "candle-1",
                    "instrument_id": "instrument-1",
                    "symbol": "NIFTY50",
                    "timeframe": "1d",
                    "open_time": at(1),
                    "close_time": at(1, 6),
                    "open": "100",
                    "high": "103",
                    "low": "99",
                    "close": "102",
                    "volume": "1000",
                    "future_close": "108",
                    "future_close_time": at(3, 6),
                },
                {
                    "candle_id": "candle-2",
                    "instrument_id": "instrument-1",
                    "symbol": "NIFTY50",
                    "timeframe": "1d",
                    "open_time": at(2),
                    "close_time": at(2, 6),
                    "open": "102",
                    "high": "104",
                    "low": "101",
                    "close": "103",
                    "volume": "1100",
                    "future_close": None,
                    "future_close_time": None,
                },
            ],
            [
                {
                    "candle_id": "candle-1",
                    "indicator_code": "RSI",
                    "algorithm_version": "ta-v1",
                    "parameters": {"period": 14},
                    "values": '{"value":55.0}',
                },
            ],
            [
                {
                    "candle_id": "candle-2",
                    "pattern_code": "HAMMER",
                    "algorithm_version": "candlestick-v1",
                    "direction": "BULLISH",
                    "confidence": "0.82",
                },
            ],
            [
                {
                    "candle_id": "candle-1",
                    "event_type": "BREAKOUT",
                    "algorithm_version": "price-action-v2",
                    "direction": "BULLISH",
                    "confidence": "0.9",
                    "level": "101.5",
                },
            ],
            [
                {
                    "candle_id": "candle-1",
                    "vix_close_time": at(1, 6),
                    "vix_close": "15",
                    "vix_average": {"value": 12.0},
                },
            ],
            [
                {
                    "candle_id": "candle-1",
                    "flow_date": date(2025, 12, 31),
                    "fii_cash_net_cr": "-2400",
                    "dii_cash_net_cr": "1800",
                    "fii_scale": "1200",
                    "dii_scale": "900",
                    "fii_index_futures_net_cr": None,
                    "fii_index_options_net_cr": None,
                    "fii_futures_scale": None,
                    "fii_options_scale": None,
                },
            ],
            # Breadth panel: empty here — a panel below the participation floor
            # publishes no context, and the evidence carries breadth=None.
            [],
        ])

        records = PostgresMlRepository(connection).load_candle_evidence(request())  # type: ignore[arg-type]

        self.assertEqual([record.candle_id for record in records], ["candle-1", "candle-2"])
        self.assertEqual(records[0].future_close, 108.0)
        self.assertEqual(records[0].future_close_time, at(3, 6))
        self.assertEqual(records[1].future_close, None)
        self.assertEqual(records[0].indicators[0].values["value"], 55.0)
        self.assertEqual(records[1].patterns[0].code, "HAMMER")
        self.assertEqual(records[0].price_action_events[0].event_type, "BREAKOUT")

        candle_sql, candle_params = connection.calls[1]
        self.assertIn("LEAD(candles.close, %s)", candle_sql)
        self.assertIn("candles.received_at <= %s", candle_sql)
        self.assertIn("CASE WHEN future_close_time <= %s THEN future_close ELSE NULL END", candle_sql)
        self.assertIn("candles.close_time <= %s", candle_sql)
        self.assertEqual(candle_params, (2, 2, "instrument-1", "1d", at(31, 23), at(31, 23), at(31, 23), at(31, 23), at(1), at(31, 23)))
        self.assertIn("indicator_definitions.algorithm_version = %s", connection.calls[2][0])
        self.assertIn("pattern_definitions.algorithm_version = %s", connection.calls[3][0])
        self.assertIn("AND algorithm_version = %s", connection.calls[4][0])
        indicator_params = connection.calls[2][1]
        self.assertIsNotNone(indicator_params)
        self.assertEqual(indicator_params[0:3], (["candle-1", "candle-2"], at(31, 23), "ta-v1"))
        self.assertEqual(json.loads(indicator_params[3]), feature_definition()["indicatorParameters"])
        self.assertEqual(connection.calls[3][1], (["candle-1", "candle-2"], at(31, 23), "candlestick-v1"))
        self.assertEqual(connection.calls[4][1], (["candle-1", "candle-2"], at(31, 23), "price-action-v2"))

        # The regime feature must actually carry a value, and must stay absent rather
        # than defaulting when the VIX series has no bar for that candle.
        self.assertAlmostEqual(records[0].vix_value_ratio or 0.0, 15.0 / 12.0, places=10)
        self.assertEqual(records[0].vix_observed_at, at(1, 6))
        self.assertIsNone(records[1].vix_value_ratio)
        self.assertIsNone(records[1].vix_observed_at)

        regime_sql, regime_params = connection.calls[5]
        self.assertIn("vix_candles.close_time <= target.close_time", regime_sql)
        self.assertIn("vix_candles.received_at <= %s", regime_sql)
        self.assertIn("vix_snapshot.calculated_at <= %s", regime_sql)
        self.assertEqual(
            regime_params,
            (
                "INDIAVIX",
                at(31, 23),
                timedelta(days=5),
                ["candle-1", "candle-2"],
                at(31, 23),
                "SMA",
                "ta-v1",
                "20",
            ),
        )

        # The institutional-flow columns were previously declared in the feature
        # schema but populated by nothing, so they were a constant NaN on both the
        # training and the inference path. This asserts the loader actually reaches
        # the evidence, and that the raw crore figure is normalised by its trailing
        # scale rather than passed through.
        self.assertAlmostEqual(records[0].fii_net_flow_ratio or 0.0, -2400.0 / 1200.0, places=10)
        self.assertAlmostEqual(records[0].dii_net_flow_ratio or 0.0, 1800.0 / 900.0, places=10)
        self.assertEqual(records[0].institutional_flow_date, date(2025, 12, 31))
        # Absent, not imputed: a candle with no visible print must not read as flat.
        self.assertIsNone(records[1].fii_net_flow_ratio)
        self.assertIsNone(records[1].dii_net_flow_ratio)
        self.assertIsNone(records[1].institutional_flow_date)

        flow_sql, flow_params = connection.calls[6]
        # The three bounds that keep this feature from leaking. Flows for session D
        # are published after D closes, so a bar may only read a strictly earlier
        # session's print, and only one already visible at the cutoff.
        self.assertIn("WHERE published_at <= %s", flow_sql)
        self.assertIn("visible_flows.published_at <= target.close_time", flow_sql)
        self.assertIn(
            "visible_flows.date < (target.close_time AT TIME ZONE 'Asia/Kolkata')::date", flow_sql
        )
        # Strictly prior sessions, so an outlier cannot normalise itself away.
        self.assertIn("ROWS BETWEEN %s PRECEDING AND 1 PRECEDING", flow_sql)
        self.assertEqual(flow_params, (at(31, 23), 20, 5, ["candle-1", "candle-2"]))

        # The breadth panel is loaded under the same as-of discipline: completed
        # daily bars received by the cutoff, warmed up before the window start.
        breadth_sql, breadth_params = connection.calls[7]
        self.assertIn("candles.timeframe = '1d'", breadth_sql)
        self.assertIn("candles.is_complete = TRUE", breadth_sql)
        self.assertIn("candles.received_at <= %s", breadth_sql)
        self.assertIsNotNone(breadth_params)
        self.assertIn("HDFCBANK", breadth_params[0])
        self.assertIn("NIFTY50", breadth_params[0])
        self.assertIn("BANKNIFTY", breadth_params[0])
        self.assertEqual(breadth_params[1], at(31, 23))
        self.assertEqual(breadth_params[3], at(1) - timedelta(days=60))
        # An empty panel publishes no context; evidence stays None, never zero.
        self.assertIsNone(records[0].breadth)
        self.assertIsNone(records[1].breadth)

    def test_skips_evidence_queries_when_window_has_no_completed_candles(self) -> None:
        connection = FakeConnection([
            [{"id": "instrument-1", "symbol": "NIFTY50"}],
            [],
        ])

        records = PostgresMlRepository(connection).load_candle_evidence(request())  # type: ignore[arg-type]

        self.assertEqual(records, ())
        self.assertEqual(len(connection.calls), 2)

    def test_rejects_a_non_integer_horizon_before_querying(self) -> None:
        invalid_request = DatasetRequest(
            instrument_symbol="NIFTY50",
            timeframe="1d",
            data_window_start=at(1),
            data_window_end=at(31, 23),
            data_cutoff_at=at(31, 23),
            horizon_bars=1.5,  # type: ignore[arg-type]
            neutral_threshold_bps=10.0,
        )
        connection = FakeConnection([])

        with self.assertRaisesRegex(ValueError, "positive integer"):
            PostgresMlRepository(connection).load_candle_evidence(invalid_request)  # type: ignore[arg-type]

        self.assertEqual(connection.calls, [])

    def test_rejects_a_window_that_extends_beyond_the_as_of_cutoff(self) -> None:
        invalid_request = DatasetRequest(
            instrument_symbol="NIFTY50",
            timeframe="1d",
            data_window_start=at(1),
            data_window_end=at(31, 23),
            data_cutoff_at=at(30, 23),
            horizon_bars=2,
            neutral_threshold_bps=10.0,
        )
        connection = FakeConnection([])

        with self.assertRaisesRegex(ValueError, "must not be later"):
            PostgresMlRepository(connection).load_candle_evidence(invalid_request)  # type: ignore[arg-type]

        self.assertEqual(connection.calls, [])

    def test_creates_next_candidate_version_in_one_transaction(self) -> None:
        connection = FakeConnection([
            [],
            [{"next_version": 3}],
            [model_row(trained_at=at(21))],
        ])

        created = PostgresMlRepository(connection).create_candidate_model(  # type: ignore[arg-type]
            model_key="trend-label-v1",
            algorithm="logistic-regression",
            artifact_uri="file:///models/model-3.joblib",
            artifact_checksum="sha256:abc",
            feature_schema=("close",),
            training_window_start=at(1),
            training_window_end=at(20),
            training_rows=50,
            validation_metrics={"balanced_accuracy": 0.7},
            trained_at=at(21),
        )

        self.assertEqual(created.version, 3)
        self.assertEqual(created.algorithm, "logistic-regression")
        self.assertEqual(created.trained_at, at(21))
        self.assertIsNone(created.promoted_at)
        self.assertEqual(connection.transaction_events, ["begin", "commit"])
        self.assertIn("pg_advisory_xact_lock", connection.calls[0][0])
        self.assertIn("COALESCE(MAX(version), 0) + 1", connection.calls[1][0])
        self.assertIn("'CANDIDATE'", connection.calls[2][0])
        insert_params = connection.calls[2][1]
        self.assertIsNotNone(insert_params)
        self.assertEqual(insert_params[0:6], ("trend-label-v1", 3, "logistic-regression", "file:///models/model-3.joblib", "sha256:abc", '[{"name":"close"}]'))
        self.assertEqual(json.loads(insert_params[9]), {"balanced_accuracy": 0.7})

    def test_rolls_back_candidate_creation_when_insert_fails(self) -> None:
        connection = FakeConnection([
            [],
            [{"next_version": 1}],
            RuntimeError("insert failed"),
        ])

        with self.assertRaisesRegex(RuntimeError, "insert failed"):
            PostgresMlRepository(connection).create_candidate_model(  # type: ignore[arg-type]
                model_key="trend-label-v1",
                algorithm="logistic-regression",
                artifact_uri="file:///models/model-1.joblib",
                artifact_checksum=None,
                feature_schema=[],
                training_window_start=at(1),
                training_window_end=at(20),
                training_rows=50,
                validation_metrics={},
                trained_at=at(21),
            )

        self.assertEqual(connection.transaction_events, ["begin", "rollback"])

    def test_reads_current_production_model(self) -> None:
        connection = FakeConnection([
            [model_row(id="model-production", version=2, stage="PRODUCTION", trained_at=at(20), promoted_at=at(22))],
        ])

        current = PostgresMlRepository(connection).get_production_model("trend-label-v1")  # type: ignore[arg-type]

        self.assertIsNotNone(current)
        assert current is not None
        self.assertEqual(current.id, "model-production")
        self.assertEqual(current.stage, "PRODUCTION")
        self.assertEqual(current.trained_at, at(20))
        self.assertEqual(current.promoted_at, at(22))
        self.assertIn("stage = 'PRODUCTION'", connection.calls[0][0])
        self.assertIn("promoted_at", connection.calls[0][0])

    def test_keeps_an_unavailable_production_timestamp_explicitly_null(self) -> None:
        connection = FakeConnection([
            [model_row(id="legacy-production", stage="PRODUCTION", promoted_at=None)],
        ])

        current = PostgresMlRepository(connection).get_production_model("trend-label-v1")  # type: ignore[arg-type]

        self.assertIsNotNone(current)
        assert current is not None
        self.assertIsNone(current.promoted_at)

    def test_promotes_only_when_the_evaluated_incumbent_is_current(self) -> None:
        connection = FakeConnection([
            [model_row(id="candidate-3")],
            [],
            [{"id": "production-2"}],
            [],
            [model_row(id="candidate-3", stage="PRODUCTION", promoted_at=at(30))],
            [],
        ])

        promoted = PostgresMlRepository(connection).promote_candidate(  # type: ignore[arg-type]
            model_version_id="candidate-3",
            expected_previous_model_id="production-2",
            comparison={"candidate_balanced_accuracy": 0.7, "production_balanced_accuracy": 0.6},
        )

        self.assertEqual(promoted.stage, "PRODUCTION")
        self.assertEqual(promoted.promoted_at, at(30))
        self.assertEqual(connection.transaction_events, ["begin", "commit"])
        self.assertIn("FOR UPDATE", connection.calls[0][0])
        self.assertIn("pg_advisory_xact_lock", connection.calls[1][0])
        self.assertIn("'ARCHIVED'", connection.calls[3][0])
        self.assertIn("'PRODUCTION'", connection.calls[4][0])
        promotion_params = connection.calls[5][1]
        self.assertIsNotNone(promotion_params)
        self.assertEqual(promotion_params[0:2], ("candidate-3", "production-2"))
        self.assertEqual(json.loads(promotion_params[2]), {
            "candidate_balanced_accuracy": 0.7,
            "production_balanced_accuracy": 0.6,
        })

    def test_rejects_a_stale_promotion_and_rolls_back(self) -> None:
        connection = FakeConnection([
            [model_row(id="candidate-3")],
            [],
            [{"id": "newer-production"}],
        ])

        with self.assertRaisesRegex(ValueError, "changed since the candidate comparison"):
            PostgresMlRepository(connection).promote_candidate(  # type: ignore[arg-type]
                model_version_id="candidate-3",
                expected_previous_model_id="production-2",
                comparison={},
            )

        self.assertEqual(connection.transaction_events, ["begin", "rollback"])
        self.assertFalse(any("ARCHIVED" in sql for sql, _ in connection.calls))

    def test_loads_latest_cutoff_bounded_completed_evidence_without_a_future_label(self) -> None:
        connection = FakeConnection([
            [{"id": "instrument-1", "symbol": "NIFTY50"}],
            [{
                "candle_id": "candle-31",
                "instrument_id": "instrument-1",
                "symbol": "NIFTY50",
                "timeframe": "1d",
                "open_time": at(31),
                "close_time": at(31, 6),
                "open": "201",
                "high": "205",
                "low": "200",
                "close": "204",
                "volume": "2500",
            }],
            [{
                "candle_id": "candle-31",
                "indicator_code": "RSI",
                "algorithm_version": "ta-v1",
                "parameters": {"period": 14, "smoothing": "WILDER"},
                "values": {"value": 61.0},
            }],
            [{
                "candle_id": "candle-31",
                "pattern_code": "BULLISH_ENGULFING",
                "algorithm_version": "candlestick-v1",
                "direction": "BULLISH",
                "confidence": "0.87",
            }],
            [{
                "candle_id": "candle-31",
                "event_type": "BREAKOUT",
                "algorithm_version": "price-action-v2",
                "direction": "BULLISH",
                "confidence": "0.91",
                "level": "202",
            }],
            [{
                "candle_id": "candle-31",
                "vix_close_time": at(31, 6),
                "vix_close": "11",
                "vix_average": {"value": 13.75},
            }],
            [{
                "candle_id": "candle-31",
                "flow_date": date(2026, 1, 30),
                "fii_cash_net_cr": "3000",
                "dii_cash_net_cr": None,
                "fii_scale": "1500",
                "dii_scale": None,
                "fii_index_futures_net_cr": None,
                "fii_index_options_net_cr": None,
                "fii_futures_scale": None,
                "fii_options_scale": None,
            }],
            # Breadth panel (empty: below the participation floor, no context).
            [],
        ])

        evidence = PostgresMlRepository(connection).load_latest_completed_candle_evidence(  # type: ignore[arg-type]
            inference_request()
        )

        self.assertIsNotNone(evidence)
        assert evidence is not None
        self.assertEqual(evidence.candle_id, "candle-31")
        self.assertEqual(evidence.future_close, None)
        self.assertEqual(evidence.future_close_time, None)
        self.assertEqual(evidence.indicators[0].code, "RSI")
        self.assertEqual(evidence.patterns[0].code, "BULLISH_ENGULFING")
        self.assertEqual(evidence.price_action_events[0].event_type, "BREAKOUT")

        latest_sql, latest_params = connection.calls[1]
        self.assertNotIn("LEAD(", latest_sql)
        self.assertIn("candles.is_complete = TRUE", latest_sql)
        self.assertIn("candles.received_at <= %s", latest_sql)
        self.assertIn("candles.close_time <= %s", latest_sql)
        self.assertIn("ORDER BY candles.close_time DESC", latest_sql)
        self.assertEqual(latest_params, ("instrument-1", "1d", at(31, 23), at(31, 23)))
        latest_indicator_params = connection.calls[2][1]
        self.assertIsNotNone(latest_indicator_params)
        self.assertEqual(latest_indicator_params[0:3], (["candle-31"], at(31, 23), "ta-v1"))
        self.assertEqual(json.loads(latest_indicator_params[3]), feature_definition()["indicatorParameters"])
        self.assertEqual(connection.calls[3][1], (["candle-31"], at(31, 23), "candlestick-v1"))
        self.assertEqual(connection.calls[4][1], (["candle-31"], at(31, 23), "price-action-v2"))

        # Inference resolves the regime the same way training does, so a served
        # prediction cannot silently see a different feature than the model trained on.
        self.assertAlmostEqual(evidence.vix_value_ratio or 0.0, 11.0 / 13.75, places=10)
        self.assertEqual(evidence.vix_observed_at, at(31, 6))
        self.assertEqual(connection.calls[5][1][0], "INDIAVIX")
        self.assertEqual(connection.calls[5][1][3], ["candle-31"])

        # Same argument for institutional flow: inference must go through the same
        # loader, or the served vector carries a NaN where training carried a value.
        self.assertAlmostEqual(evidence.fii_net_flow_ratio or 0.0, 3000.0 / 1500.0, places=10)
        self.assertEqual(evidence.institutional_flow_date, date(2026, 1, 30))
        # One side missing must not drag the other down with it.
        self.assertIsNone(evidence.dii_net_flow_ratio)
        self.assertEqual(connection.calls[6][1], (at(31, 23), 20, 5, ["candle-31"]))

        # Breadth is resolved through the shared loader on the inference path
        # too; an unmeasurable panel is absent evidence, never a default.
        breadth_sql, breadth_params = connection.calls[7]
        self.assertIn("candles.timeframe = '1d'", breadth_sql)
        self.assertEqual(breadth_params[1], at(31, 23))
        self.assertIsNone(evidence.breadth)

    def test_upserts_one_prediction_per_model_and_source_candle(self) -> None:
        connection = FakeConnection([
            [{
                "id": "prediction-1",
                "model_version_id": "model-1",
                "instrument_id": "instrument-1",
                "source_candle_id": "candle-31",
                "prediction": "BULLISH",
                "confidence": "0.82",
                "created_at": at(31, 7),
            }],
        ])

        persisted = PostgresMlRepository(connection).save_model_prediction(  # type: ignore[arg-type]
            model_version_id="model-1",
            instrument_id="instrument-1",
            source_candle_id="candle-31",
            prediction="BULLISH",
            confidence=0.82,
            feature_contributions=[{"feature": "indicator.RSI.value", "contribution": 0.25}],
            explanation=[{"kind": "MODEL_OUTPUT", "details": {"prediction": "BULLISH"}}],
            evidence_cutoff_at=at(31, 23),
        )

        self.assertEqual(persisted.id, "prediction-1")
        self.assertEqual(persisted.prediction, "BULLISH")
        self.assertEqual(connection.transaction_events, ["begin", "commit"])
        prediction_sql, prediction_params = connection.calls[0]
        self.assertIn("INSERT INTO model_predictions", prediction_sql)
        self.assertIn("ON CONFLICT (model_version_id, source_candle_id)", prediction_sql)
        self.assertIn("WHERE source_candle_id IS NOT NULL", prediction_sql)
        self.assertIn("DO UPDATE SET", prediction_sql)
        self.assertIn("evidence_cutoff_at = EXCLUDED.evidence_cutoff_at", prediction_sql)
        self.assertNotIn("created_at = CURRENT_TIMESTAMP", prediction_sql)
        self.assertNotIn("created_at = EXCLUDED.created_at", prediction_sql)
        self.assertEqual(prediction_params[0:5], ("model-1", "instrument-1", "candle-31", "BULLISH", 0.82))
        self.assertEqual(json.loads(prediction_params[5]), [{"contribution": 0.25, "feature": "indicator.RSI.value"}])
        self.assertEqual(json.loads(prediction_params[6]), [{"details": {"prediction": "BULLISH"}, "kind": "MODEL_OUTPUT"}])
        self.assertEqual(prediction_params[7], at(31, 23))

    def test_auxiliary_predictions_are_written_to_their_own_table(self) -> None:
        """A non-directional prediction must never reach model_predictions.

        That table's value is read as a trade direction by the strategy engine, the
        autonomous agent, the market scanner, and the predictions dashboard, so a
        volatility label landing there would be acted on as a directional signal.
        """

        from ai_quant_lab_ml.volatility_expansion import (
            LABEL_SCHEME_VOLATILITY_EXPANSION,
            VOLATILITY_ALPHABET,
        )

        connection = FakeConnection([
            [{
                "id": "aux-1",
                "model_version_id": "model-1",
                "instrument_id": "instrument-1",
                "source_candle_id": "candle-31",
                "label_scheme": LABEL_SCHEME_VOLATILITY_EXPANSION,
                "prediction": "EXPANSION",
                "confidence": "0.71",
                "created_at": at(31, 7),
            }],
        ])

        saved = PostgresMlRepository(connection).save_auxiliary_prediction(  # type: ignore[arg-type]
            model_version_id="model-1",
            instrument_id="instrument-1",
            source_candle_id="candle-31",
            label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION,
            prediction="EXPANSION",
            confidence=0.71,
            feature_contributions=[{"feature": "candle.range_bps", "value": 0.4}],
            explanation=[{"reason": "range widening"}],
            evidence_cutoff_at=at(31, 23),
            alphabet=VOLATILITY_ALPHABET,
        )

        self.assertEqual(saved["prediction"], "EXPANSION")
        self.assertEqual(saved["labelScheme"], LABEL_SCHEME_VOLATILITY_EXPANSION)
        self.assertAlmostEqual(saved["confidence"], 0.71, places=10)

        sql, params = connection.calls[0]
        self.assertIn("INSERT INTO auxiliary_model_predictions", sql)
        self.assertNotIn("INSERT INTO model_predictions", sql)
        # Idempotent per (model, source candle), like the directional table.
        self.assertIn("ON CONFLICT (model_version_id, source_candle_id)", sql)
        self.assertEqual(params[4], "EXPANSION")
        self.assertEqual(params[8], at(31, 23))
        self.assertEqual(connection.transaction_events, ["begin", "commit"])

    def test_auxiliary_predictions_refuse_labels_from_the_wrong_alphabet(self) -> None:
        from ai_quant_lab_ml.volatility_expansion import (
            LABEL_SCHEME_VOLATILITY_EXPANSION,
            VOLATILITY_ALPHABET,
        )

        repository = PostgresMlRepository(FakeConnection([]))  # type: ignore[arg-type]

        def save(prediction: str) -> None:
            repository.save_auxiliary_prediction(
                model_version_id="model-1",
                instrument_id="instrument-1",
                source_candle_id="candle-31",
                label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION,
                prediction=prediction,
                confidence=0.5,
                feature_contributions=[],
                explanation=[],
                evidence_cutoff_at=at(31, 23),
                alphabet=VOLATILITY_ALPHABET,
            )

        # Not in the declared alphabet at all.
        with self.assertRaises(ValueError):
            save("SIDEWAYS")
        # A directional label is refused with its own message: it means a directional
        # model wrote to the auxiliary path, which is as wrong as the reverse.
        for directional in ("BULLISH", "BEARISH", "NEUTRAL"):
            with self.assertRaises(ValueError):
                save(directional)

    def test_auxiliary_predictions_are_listed_by_instrument_and_scheme(self) -> None:
        connection = FakeConnection([
            [{
                "id": "aux-1",
                "model_version_id": "model-1",
                "instrument_id": "instrument-1",
                "source_candle_id": None,
                "label_scheme": "volatility-expansion-v1",
                "prediction": "CONTRACTION",
                "confidence": "0.62",
                "created_at": at(31, 7),
            }],
        ])

        rows = PostgresMlRepository(connection).list_auxiliary_predictions(  # type: ignore[arg-type]
            instrument_id="instrument-1", label_scheme="volatility-expansion-v1", limit=10,
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["prediction"], "CONTRACTION")
        self.assertIsNone(rows[0]["sourceCandleId"])
        sql, params = connection.calls[0]
        self.assertIn("FROM auxiliary_model_predictions", sql)
        self.assertIn("WHERE instrument_id = %s AND label_scheme = %s", sql)
        self.assertEqual(params, ("instrument-1", "volatility-expansion-v1", 10))

    def test_historical_reliability_uses_only_as_of_prediction_evidence_and_known_outcomes(self) -> None:
        connection = FakeConnection([
            [{"evaluated_predictions": 4, "correct_predictions": 3}],
        ])

        reliability = PostgresMlRepository(connection).historical_prediction_reliability(  # type: ignore[arg-type]
            model_version_id="model-1",
            instrument_id="instrument-1",
            timeframe="1d",
            prediction="BULLISH",
            reference_close_time=at(20, 6),
            data_cutoff_at=at(31, 23),
            horizon_bars=2,
            neutral_threshold_bps=10.0,
        )

        self.assertEqual(reliability.evaluated_predictions, 4)
        self.assertEqual(reliability.correct_predictions, 3)
        self.assertEqual(reliability.accuracy, 0.75)
        reliability_sql, reliability_params = connection.calls[0]
        self.assertIn("LEAD(candles.close, %s)", reliability_sql)
        self.assertIn("candles.received_at <= %s", reliability_sql)
        self.assertIn("predictions.created_at <= %s", reliability_sql)
        self.assertIn("predictions.evidence_cutoff_at <= %s", reliability_sql)
        self.assertIn("cutoff_candles.future_close_time <= %s", reliability_sql)
        self.assertEqual(
            reliability_params,
            (
                2,
                2,
                "instrument-1",
                "1d",
                at(31, 23),
                at(20, 6),
                10.0,
                10.0,
                "model-1",
                "instrument-1",
                "BULLISH",
                at(20, 6),
                at(20, 6),
                at(20, 6),
                at(20, 6),
            ),
        )


if __name__ == "__main__":
    unittest.main()
