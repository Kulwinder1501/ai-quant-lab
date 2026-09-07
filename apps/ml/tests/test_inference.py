from __future__ import annotations

import copy
import dataclasses
import json
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION,
    FEATURE_SCHEMA_VERSION_V5,
    CandleEvidence,
    LabeledExample,
    PersistedModelVersion,
)
from ai_quant_lab_ml.features import feature_definition, feature_schema
from ai_quant_lab_ml.inference import (
    ExplainablePrediction,
    InferenceError,
    LOGISTIC_BASELINE_ALGORITHM,
    build_prediction_explanation,
    explain_logistic_prediction,
    validate_production_artifact,
)
from ai_quant_lab_ml.reference_data import build_reference_metadata
from predict import (
    parse_as_of,
    require_prediction_after_production_promotion,
    require_prediction_after_training_boundary,
)


START = datetime(2024, 1, 2, tzinfo=UTC)
FULL_SCHEMA = feature_schema()


class IdentityTransformer:
    def transform(self, rows: list[list[float]]) -> list[list[float]]:
        return rows


class BinaryClassifier:
    classes_ = ["BEARISH", "BULLISH"]
    coef_ = [[2.0, -3.0]]
    intercept_ = [0.5]

    def __init__(self, prediction: str, probabilities: list[float]) -> None:
        self.prediction = prediction
        self.probabilities = probabilities

    def predict(self, rows: list[list[float]]) -> list[str]:
        return [self.prediction]

    def predict_proba(self, rows: list[list[float]]) -> list[list[float]]:
        return [self.probabilities]


class FakePipeline:
    def __init__(self, classifier: BinaryClassifier) -> None:
        self.named_steps = {
            "imputer": IdentityTransformer(),
            "scaler": IdentityTransformer(),
            "classifier": classifier,
        }


def full_features(value: float = 0.0) -> dict[str, float]:
    return {name: value for name in FULL_SCHEMA}


def reference_example(index: int, label: str) -> LabeledExample:
    observed_at = START + timedelta(days=index)
    return LabeledExample(
        candle_id=f"training-candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=5),
        forward_return=0.01,
        label=label,  # type: ignore[arg-type]
        features=full_features(float(index)),
    )


def production_model(*, promoted_at: datetime | None = None) -> PersistedModelVersion:
    return PersistedModelVersion(
        id="model-version-1",
        model_key="market-direction-logistic--NIFTY50--1d--h5--neutral-50bps--ml-feature-v2",
        version=1,
        algorithm=LOGISTIC_BASELINE_ALGORITHM,
        stage="PRODUCTION",
        artifact_uri="C:/models/model.pkl",
        artifact_checksum="a" * 64,
        feature_schema=tuple({"name": name, "dtype": "float64", "schemaVersion": FEATURE_SCHEMA_VERSION} for name in FULL_SCHEMA),
        validation_metrics={},
        trained_at=datetime(2024, 3, 8, tzinfo=UTC),
        promoted_at=promoted_at,
    )


def compatible_metadata() -> dict[str, object]:
    return {
        "featureSchema": list(FULL_SCHEMA),
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "featureDefinition": feature_definition(),
        "algorithm": LOGISTIC_BASELINE_ALGORITHM,
        "modelKey": production_model().model_key,
        "dataset": {"instrument": "NIFTY50", "timeframe": "1d"},
        "validationProtocol": {
            "horizonBars": 5,
            "neutralThresholdBps": 50.0,
            "indicatorAlgorithmVersion": "ta-v1",
            "patternAlgorithmVersion": "candlestick-v1",
            "priceActionAlgorithmVersion": "price-action-v1",
            "trainingSourceWindow": {
                "start": "2024-01-02T00:00:00Z",
                "end": "2024-03-01T00:00:00Z",
            },
            "trainingLabelAvailableEnd": "2024-03-06T00:00:00Z",
            "dataCutoffAt": "2024-03-08T00:00:00Z",
        },
        "validationMetrics": {"macroF1": 0.52, "sampleCount": 20},
        "trainingReferenceSet": build_reference_metadata(
            [reference_example(0, "BEARISH"), reference_example(1, "BULLISH")],
            maximum_examples=2,
        ),
    }


def source_candle() -> CandleEvidence:
    from ai_quant_lab_ml.contracts import PatternEvidence, PriceActionEvidence

    return CandleEvidence(
        candle_id="source-candle-1",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        open_time=START,
        close_time=START + timedelta(hours=6),
        open=100.0,
        high=103.0,
        low=99.0,
        close=102.0,
        volume=1_000.0,
        indicators=(),
        patterns=(
            PatternEvidence("HAMMER", "candlestick-v1", "BULLISH", 0.8),
            PatternEvidence("DOJI", "candlestick-v2", "NEUTRAL", 0.9),
        ),
        price_action_events=(
            PriceActionEvidence("BREAKOUT", "price-action-v1", "BULLISH", 0.7, 101.0),
            PriceActionEvidence("SUPPORT", "price-action-v2", "BULLISH", 0.9, 99.0),
        ),
        future_close=None,
        future_close_time=None,
    )


class InferenceTests(unittest.TestCase):
    def test_binary_logistic_explanations_use_selected_class_coefficient_signs(self) -> None:
        schema = ("indicator.signal", "pattern.signal")
        features = {"indicator.signal": 2.0, "pattern.signal": 1.0}

        bearish = explain_logistic_prediction(
            FakePipeline(BinaryClassifier("BEARISH", [0.7, 0.3])),
            features,
            schema=schema,
            maximum_features=2,
        )
        bullish = explain_logistic_prediction(
            FakePipeline(BinaryClassifier("BULLISH", [0.3, 0.7])),
            features,
            schema=schema,
            maximum_features=2,
        )

        bearish_terms = {item["feature"]: item for item in bearish.feature_contributions}
        bullish_terms = {item["feature"]: item for item in bullish.feature_contributions}
        self.assertAlmostEqual(bearish.intercept, -0.5)
        self.assertAlmostEqual(bearish_terms["indicator.signal"]["coefficient"], -2.0)
        self.assertAlmostEqual(bearish_terms["indicator.signal"]["contribution"], -4.0)
        self.assertFalse(bearish_terms["indicator.signal"]["supportsPredictedClass"])
        self.assertAlmostEqual(bearish_terms["pattern.signal"]["coefficient"], 3.0)
        self.assertAlmostEqual(bearish_terms["pattern.signal"]["contribution"], 3.0)
        self.assertTrue(bearish_terms["pattern.signal"]["supportsPredictedClass"])

        self.assertAlmostEqual(bullish.intercept, 0.5)
        self.assertAlmostEqual(bullish_terms["indicator.signal"]["coefficient"], 2.0)
        self.assertAlmostEqual(bullish_terms["pattern.signal"]["coefficient"], -3.0)

    def test_artifact_contract_requires_valid_training_only_reference_metadata(self) -> None:
        metadata = compatible_metadata()
        contract = validate_production_artifact(
            production_model(),
            metadata,
            instrument_symbol="nifty50",
            timeframe="1d",
        )

        self.assertEqual(contract.instrument_symbol, "NIFTY50")
        self.assertEqual(contract.training_source_end, datetime(2024, 3, 1, tzinfo=UTC))
        self.assertEqual(contract.training_label_available_end, datetime(2024, 3, 6, tzinfo=UTC))
        self.assertEqual(contract.deployment_not_before, datetime(2024, 3, 8, tzinfo=UTC))
        self.assertEqual(len(contract.training_reference_data.examples), 2)

        missing_reference_set = copy.deepcopy(metadata)
        missing_reference_set.pop("trainingReferenceSet")
        with self.assertRaisesRegex(InferenceError, "training-only similar-setup reference data"):
            validate_production_artifact(
                production_model(),
                missing_reference_set,
                instrument_symbol="NIFTY50",
                timeframe="1d",
            )

        malformed_reference_set = copy.deepcopy(metadata)
        malformed_reference_set["trainingReferenceSet"]["examples"][0]["features"]["candle.open"] = float("nan")  # type: ignore[index]
        with self.assertRaisesRegex(InferenceError, "invalid training-only reference data"):
            validate_production_artifact(
                production_model(),
                malformed_reference_set,
                instrument_symbol="NIFTY50",
                timeframe="1d",
            )

        missing_label_boundary = copy.deepcopy(metadata)
        missing_label_boundary["validationProtocol"].pop("trainingLabelAvailableEnd")  # type: ignore[index]
        with self.assertRaisesRegex(InferenceError, "training-label availability end"):
            validate_production_artifact(
                production_model(),
                missing_label_boundary,
                instrument_symbol="NIFTY50",
                timeframe="1d",
            )

        early_cutoff = copy.deepcopy(metadata)
        early_cutoff["validationProtocol"]["dataCutoffAt"] = "2024-03-05T00:00:00Z"  # type: ignore[index]
        with self.assertRaisesRegex(InferenceError, "data cutoff precedes"):
            validate_production_artifact(
                production_model(),
                early_cutoff,
                instrument_symbol="NIFTY50",
                timeframe="1d",
            )

    def test_a_legacy_v5_artifact_remains_loadable_after_the_v6_bump(self) -> None:
        """The capacity bump must not orphan v5 models.

        The volatility shadow families were trained under ml-feature-v5 and keep
        building settled history after v6 becomes current, so an artifact is
        validated against the schema version recorded in its own metadata and the
        contract carries that version forward to feature construction.
        """

        v5_schema = feature_schema(FEATURE_SCHEMA_VERSION_V5)
        v5_examples = [
            dataclasses.replace(
                reference_example(index, label),
                features={name: float(index) for name in v5_schema},
            )
            for index, label in ((0, "BEARISH"), (1, "BULLISH"))
        ]
        model = dataclasses.replace(
            production_model(),
            feature_schema=tuple(
                {"name": name, "dtype": "float64", "schemaVersion": FEATURE_SCHEMA_VERSION_V5}
                for name in v5_schema
            ),
        )
        metadata = compatible_metadata()
        metadata["featureSchema"] = list(v5_schema)
        metadata["featureSchemaVersion"] = FEATURE_SCHEMA_VERSION_V5
        metadata["featureDefinition"] = feature_definition(FEATURE_SCHEMA_VERSION_V5)
        metadata["trainingReferenceSet"] = build_reference_metadata(
            v5_examples, schema=v5_schema, maximum_examples=2
        )

        contract = validate_production_artifact(
            model,
            metadata,
            instrument_symbol="NIFTY50",
            timeframe="1d",
        )

        self.assertEqual(contract.schema_version, FEATURE_SCHEMA_VERSION_V5)
        self.assertEqual(contract.feature_schema, v5_schema)

    def test_an_artifact_with_an_unknown_schema_version_is_rejected(self) -> None:
        metadata = compatible_metadata()
        metadata["featureSchemaVersion"] = "ml-feature-v99"

        with self.assertRaisesRegex(InferenceError, "unknown feature-schema version"):
            validate_production_artifact(
                production_model(),
                metadata,
                instrument_symbol="NIFTY50",
                timeframe="1d",
            )

    def test_explanation_is_explicitly_research_only_and_uses_matching_evidence_versions(self) -> None:
        contract = validate_production_artifact(
            production_model(),
            compatible_metadata(),
            instrument_symbol="NIFTY50",
            timeframe="1d",
        )
        explained = ExplainablePrediction(
            prediction="BULLISH",
            confidence=0.61,
            class_probabilities={"BEARISH": 0.13, "NEUTRAL": 0.26, "BULLISH": 0.61},
            intercept=0.2,
            feature_contributions=(
                {"feature": "indicator.RSI.value", "contribution": 0.8, "supportsPredictedClass": True},
                {"feature": "pattern.HAMMER.bullish_confidence", "contribution": -0.2, "supportsPredictedClass": False},
            ),
        )
        historical_reference = {"trainingOnlySimilarSetups": {"labelAgreement": 0.5, "neighborCount": 2}}
        explanation = build_prediction_explanation(
            candle=source_candle(),
            contract=contract,
            explained_prediction=explained,
            artifact_checksum="b" * 64,
            evidence_cutoff_at=START + timedelta(days=30),
            historical_reference=historical_reference,
        )
        entries = {entry["kind"]: entry for entry in explanation}

        self.assertEqual(entries["PATTERN_EVIDENCE"]["details"]["detections"], [{"code": "HAMMER", "direction": "BULLISH", "confidence": 0.8}])
        self.assertEqual(entries["PRICE_ACTION_EVIDENCE"]["details"]["events"], [{"eventType": "BREAKOUT", "direction": "BULLISH", "confidence": 0.7, "level": 101.0}])
        self.assertEqual(entries["HISTORICAL_SIMILAR_SETUPS"]["details"], historical_reference)
        self.assertIn("not realised trading profit", entries["HISTORICAL_SIMILAR_SETUPS"]["summary"])
        self.assertIn("not a trade idea, order", entries["LIMITATION"]["summary"])
        self.assertEqual(entries["LIMITATION"]["details"], {"automatedExecution": False, "paperTradeCreated": False})
        self.assertEqual(entries["MODEL_LINEAGE"]["details"]["trainingLabelAvailableEnd"], "2024-03-06T00:00:00+00:00")
        self.assertEqual(entries["MODEL_LINEAGE"]["details"]["trainingDataCutoffAt"], "2024-03-08T00:00:00+00:00")
        json.dumps(explanation, allow_nan=False)

    def test_rejects_non_mapping_feature_input_as_a_safe_inference_error(self) -> None:
        with self.assertRaises(InferenceError):
            explain_logistic_prediction(
                FakePipeline(BinaryClassifier("BULLISH", [0.3, 0.7])),
                [],  # type: ignore[arg-type]
                schema=("indicator.signal", "pattern.signal"),
            )

    def test_predict_cli_as_of_parser_normalizes_dates_and_offsets_to_utc(self) -> None:
        self.assertEqual(
            parse_as_of("2026-03-01"),
            datetime(2026, 3, 1, 23, 59, 59, 999999, tzinfo=UTC),
        )
        self.assertEqual(
            parse_as_of("2026-03-01T09:15:00+05:30"),
            datetime(2026, 3, 1, 3, 45, tzinfo=UTC),
        )

    def test_predict_cli_refuses_source_candles_before_training_information_boundary(self) -> None:
        contract = validate_production_artifact(
            production_model(),
            compatible_metadata(),
            instrument_symbol="NIFTY50",
            timeframe="1d",
        )

        with self.assertRaisesRegex(InferenceError, "training-information boundary"):
            require_prediction_after_training_boundary(datetime(2024, 3, 8, tzinfo=UTC), contract)
        require_prediction_after_training_boundary(datetime(2024, 3, 9, tzinfo=UTC), contract)

    def test_predict_cli_requires_a_persisted_production_time_before_scoring(self) -> None:
        promoted = production_model(promoted_at=datetime(2024, 3, 10, 9, 15, tzinfo=UTC))

        with self.assertRaisesRegex(InferenceError, "production promotion time"):
            require_prediction_after_production_promotion(datetime(2024, 3, 10, 9, 15, tzinfo=UTC), promoted)
        require_prediction_after_production_promotion(datetime(2024, 3, 10, 9, 16, tzinfo=UTC), promoted)

        with self.assertRaisesRegex(InferenceError, "must include a timezone"):
            require_prediction_after_production_promotion(datetime(2024, 3, 11), promoted)

        with self.assertRaisesRegex(InferenceError, "no persisted promotion timestamp"):
            require_prediction_after_production_promotion(datetime(2024, 3, 11, tzinfo=UTC), production_model())


if __name__ == "__main__":
    unittest.main()


class PooledArtifactInstrumentGuardTests(unittest.TestCase):
    """A pooled artifact may score its members and nothing else.

    `dataset.instrument` records only the primary member of a pooled run, so the
    single-instrument equality check would reject every other member -- which would make
    a pooled model unable to predict at all, and therefore unable to build the settled
    evidence promotion requires. Admitting the recorded pool is not a relaxation: an
    instrument absent from the pool is still refused.
    """

    POOL = ["ASIANPAINT", "SBIN", "INFY"]

    def test_a_pool_member_is_admitted(self) -> None:
        dataset = {"instrument": "ASIANPAINT", "timeframe": "1d", "pooledInstruments": self.POOL}
        for symbol in self.POOL:
            with self.subTest(symbol=symbol):
                self.assertTrue(self._admits(dataset, symbol, "1d"))

    def test_an_instrument_outside_the_pool_is_refused(self) -> None:
        dataset = {"instrument": "ASIANPAINT", "timeframe": "1d", "pooledInstruments": self.POOL}
        self.assertFalse(self._admits(dataset, "NIFTY50", "1d"))

    def test_a_single_instrument_artifact_still_requires_an_exact_match(self) -> None:
        dataset = {"instrument": "NIFTY50", "timeframe": "1d"}
        self.assertTrue(self._admits(dataset, "NIFTY50", "1d"))
        self.assertFalse(self._admits(dataset, "SBIN", "1d"))

    def test_the_timeframe_is_never_widened_by_pooling(self) -> None:
        dataset = {"instrument": "ASIANPAINT", "timeframe": "1d", "pooledInstruments": self.POOL}
        self.assertFalse(self._admits(dataset, "SBIN", "5m"))

    @staticmethod
    def _admits(dataset: dict[str, object], symbol: str, timeframe: str) -> bool:
        """Mirrors the guard in inference._validate_artifact_metadata."""

        if dataset.get("timeframe") != timeframe:
            return False
        pooled = dataset.get("pooledInstruments")
        if isinstance(pooled, (list, tuple)) and pooled:
            return symbol.upper() in {str(member).upper() for member in pooled}
        return dataset.get("instrument") == symbol.upper()
