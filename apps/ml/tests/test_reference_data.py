from __future__ import annotations

import copy
import json
import math
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.features import feature_schema
from ai_quant_lab_ml.reference_data import (
    ReferenceDataError,
    build_reference_metadata,
    nearest_reference_label_agreement,
    parse_reference_metadata,
)


START = datetime(2024, 1, 2, tzinfo=UTC)
SCHEMA = feature_schema()

# Named positions in the fixed schema rather than hardcoded feature names, so a
# schema revision cannot leave these tests asserting against columns that no
# longer exist.
SIGNAL_FEATURE, SECOND_FEATURE, THIRD_FEATURE, FOURTH_FEATURE = SCHEMA[:4]


def feature_values(signal: float) -> dict[str, object]:
    values: dict[str, object] = {name: 0.0 for name in SCHEMA}
    values[SIGNAL_FEATURE] = signal
    return values


def example(index: int, label: str, signal: float | None = None, *, values: dict[str, object] | None = None) -> LabeledExample:
    observed_at = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=2),
        forward_return=0.01,
        label=label,  # type: ignore[arg-type]
        features=feature_values(float(index) if signal is None else signal) if values is None else values,  # type: ignore[arg-type]
    )


class FakeImputer:
    def __init__(self, width: int) -> None:
        self.n_features_in_ = width
        self.calls = 0

    def transform(self, rows: list[list[float]]) -> list[list[float]]:
        self.calls += 1
        return [[0.0 if math.isnan(value) else value for value in row] for row in rows]


class FakeScaler:
    def __init__(self, width: int) -> None:
        self.n_features_in_ = width
        self.calls = 0

    def transform(self, rows: list[list[float]]) -> list[list[float]]:
        self.calls += 1
        return [[value / 10.0 for value in row] for row in rows]


class FakePipeline:
    def __init__(self, width: int) -> None:
        self.imputer = FakeImputer(width)
        self.scaler = FakeScaler(width)
        self.named_steps = {"imputer": self.imputer, "scaler": self.scaler}


class ReferenceDataTests(unittest.TestCase):
    def test_builds_deterministic_stratified_chronological_json_safe_training_references(self) -> None:
        non_finite_values = feature_values(0.0)
        non_finite_values[SIGNAL_FEATURE] = math.nan
        non_finite_values[SECOND_FEATURE] = math.inf
        non_finite_values[THIRD_FEATURE] = "7.5"
        non_finite_values[FOURTH_FEATURE] = True
        training_examples = [
            example(0, "BEARISH", values=non_finite_values),
            example(1, "NEUTRAL"),
            example(2, "BULLISH"),
            example(3, "BEARISH"),
            example(4, "NEUTRAL"),
            example(5, "BULLISH"),
            example(6, "NEUTRAL"),
            example(7, "BULLISH"),
        ]

        first = build_reference_metadata(list(reversed(training_examples)), maximum_examples=6)
        second = build_reference_metadata(list(reversed(training_examples)), maximum_examples=6)
        parsed = parse_reference_metadata(first)

        self.assertEqual(first, second)
        json.dumps(first, allow_nan=False)
        self.assertEqual(parsed.training_rows, 8)
        self.assertEqual(len(parsed.examples), 6)
        self.assertEqual(first["sampling"]["referenceClassCounts"], {"BEARISH": 2, "NEUTRAL": 2, "BULLISH": 2})
        self.assertEqual(
            [item["observedAt"] for item in first["examples"]],
            sorted(item["observedAt"] for item in first["examples"]),
        )
        first_row = next(item for item in first["examples"] if item["candleId"] == "candle-0")
        self.assertIsNone(first_row["features"][SIGNAL_FEATURE])
        self.assertIsNone(first_row["features"][SECOND_FEATURE])
        self.assertEqual(first_row["features"][THIRD_FEATURE], 7.5)
        self.assertIsNone(first_row["features"][FOURTH_FEATURE])

    def test_parser_rejects_schema_drift_and_invalid_reference_rows(self) -> None:
        metadata = build_reference_metadata(
            [example(0, "BEARISH"), example(1, "NEUTRAL"), example(2, "BULLISH")],
            maximum_examples=3,
        )
        schema_drift = copy.deepcopy(metadata)
        schema_drift["featureSchema"] = list(reversed(schema_drift["featureSchema"]))
        with self.assertRaisesRegex(ReferenceDataError, "fixed feature schema"):
            parse_reference_metadata(schema_drift)

        non_finite = copy.deepcopy(metadata)
        non_finite["examples"][0]["features"][SIGNAL_FEATURE] = math.nan
        with self.assertRaisesRegex(ReferenceDataError, "finite number or null"):
            parse_reference_metadata(non_finite)

        validation_row = copy.deepcopy(metadata)
        validation_row["trainingOnly"] = False
        with self.assertRaisesRegex(ReferenceDataError, "trainingOnly"):
            parse_reference_metadata(validation_row)

    def test_calculates_label_agreement_from_duck_typed_fitted_preprocessing_steps(self) -> None:
        metadata = build_reference_metadata(
            [
                example(0, "BEARISH", signal=0.0),
                example(1, "NEUTRAL", signal=5.0),
                example(2, "BULLISH", signal=10.0),
            ],
            maximum_examples=3,
        )
        pipeline = FakePipeline(len(SCHEMA))
        agreement = nearest_reference_label_agreement(
            pipeline=pipeline,
            features=feature_values(9.0),
            predicted_label="BULLISH",
            reference_metadata=metadata,
            k=2,
        )

        self.assertEqual(pipeline.imputer.calls, 1)
        self.assertEqual(pipeline.scaler.calls, 1)
        self.assertEqual(agreement.neighbor_count, 2)
        self.assertEqual(agreement.matching_label_count, 1)
        self.assertAlmostEqual(agreement.label_agreement or 0.0, 0.5)
        self.assertEqual(agreement.neighbor_label_counts, {"BEARISH": 0, "NEUTRAL": 1, "BULLISH": 1})
        self.assertEqual([neighbor.candle_id for neighbor in agreement.neighbors], ["candle-2", "candle-1"])
        json.dumps(agreement.as_dict(), allow_nan=False)

    def test_breaks_equal_distances_chronologically_then_by_candle_id(self) -> None:
        metadata = build_reference_metadata(
            [example(0, "BULLISH", signal=4.0), example(1, "NEUTRAL", signal=6.0)],
            maximum_examples=2,
        )
        agreement = nearest_reference_label_agreement(
            pipeline=FakePipeline(len(SCHEMA)),
            features=feature_values(5.0),
            predicted_label="BULLISH",
            reference_metadata=metadata,
            k=1,
        )

        self.assertEqual(agreement.neighbors[0].candle_id, "candle-0")
        self.assertEqual(agreement.matching_label_count, 1)

    def test_requires_fitted_imputer_and_scaler_with_the_fixed_width(self) -> None:
        metadata = build_reference_metadata([example(0, "BULLISH")], maximum_examples=1)

        with self.assertRaisesRegex(ReferenceDataError, "imputer step"):
            nearest_reference_label_agreement(
                pipeline=object(),
                features=feature_values(0.0),
                predicted_label="BULLISH",
                reference_metadata=metadata,
                k=1,
            )

        pipeline = FakePipeline(len(SCHEMA) - 1)
        with self.assertRaisesRegex(ReferenceDataError, "does not match the fixed feature schema"):
            nearest_reference_label_agreement(
                pipeline=pipeline,
                features=feature_values(0.0),
                predicted_label="BULLISH",
                reference_metadata=metadata,
                k=1,
            )


if __name__ == "__main__":
    unittest.main()
