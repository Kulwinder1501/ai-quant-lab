"""Tests for the gradient-boosted model families and their TreeSHAP explainer.

The libraries are optional, so every test that needs one skips cleanly when it
is absent. The additivity assertions are the important ones: they prove the
reported contributions really do decompose the selected class's margin rather
than being a plausible-looking number.
"""

from __future__ import annotations

import importlib.util
import math
import random
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from ai_quant_lab_ml.artifacts import load_model_artifact, write_model_artifact
from ai_quant_lab_ml.contracts import (
    LIGHTGBM_ALGORITHM,
    LOGISTIC_BASELINE_ALGORITHM,
    XGBOOST_ALGORITHM,
    LabeledExample,
    PersistedModelVersion,
    TemporalSplit,
)
from ai_quant_lab_ml.estimators import LabelEncodedClassifier, LabelEncodingError
from ai_quant_lab_ml.inference import (
    TREE_CONTRIBUTION_METHOD,
    InferenceError,
    explain_prediction,
)
from ai_quant_lab_ml.training import (
    TrainingError,
    algorithm_identifier,
    predict_labels,
    train_model,
    training_metadata,
)


SKLEARN_AVAILABLE = importlib.util.find_spec("sklearn") is not None
XGBOOST_AVAILABLE = SKLEARN_AVAILABLE and importlib.util.find_spec("xgboost") is not None
LIGHTGBM_AVAILABLE = SKLEARN_AVAILABLE and importlib.util.find_spec("lightgbm") is not None

START = datetime(2023, 1, 2, tzinfo=UTC)
SCHEMA = ("signal", "momentum", "always_missing")

# Small, shallow forests keep the suite fast and, more importantly, force the
# trees to actually split on this little synthetic history.
XGBOOST_HYPERPARAMETERS = {"n_estimators": 30, "max_depth": 2}
LIGHTGBM_HYPERPARAMETERS = {"n_estimators": 30, "num_leaves": 4, "min_child_samples": 5}


def build_split(*, three_class: bool = True, seed: int = 11, rows: int = 360) -> TemporalSplit:
    """Build a separable synthetic split so a fitted forest is not degenerate."""

    generator = random.Random(seed)
    examples: list[LabeledExample] = []
    for index in range(rows):
        signal = generator.uniform(-1.0, 1.0)
        momentum = generator.uniform(-1.0, 1.0)
        score = signal + momentum
        if three_class:
            label = "BULLISH" if score > 0.4 else ("BEARISH" if score < -0.4 else "NEUTRAL")
        else:
            label = "BULLISH" if score > 0 else "BEARISH"
        observed_at = START + timedelta(days=index)
        examples.append(
            LabeledExample(
                candle_id=f"candle-{index}",
                instrument_id="instrument-1",
                symbol="NIFTY50",
                timeframe="1d",
                observed_at=observed_at,
                label_available_at=observed_at + timedelta(days=5),
                forward_return=score / 100.0,
                label=label,  # type: ignore[arg-type]
                features={"signal": signal, "momentum": momentum, "always_missing": math.nan},
            )
        )
    return TemporalSplit(train=tuple(examples[:280]), validation=tuple(examples[300:]), purge_count=20)


def selected_class_margin(pipeline: object, features: dict[str, float], predicted_label: str, algorithm: str) -> float:
    """Recompute the raw margin of the selected class straight from the booster."""

    steps = pipeline.named_steps  # type: ignore[attr-defined]
    row = [features.get(name, float("nan")) for name in SCHEMA]
    standardized = steps["scaler"].transform(steps["imputer"].transform([row]))
    classifier = steps["classifier"]
    classes = list(classifier.classes_)
    class_index = classes.index(predicted_label)

    if algorithm == XGBOOST_ALGORITHM:
        import xgboost

        margins = classifier.estimator.get_booster().predict(
            xgboost.DMatrix(standardized), output_margin=True, validate_features=False,
        )
    else:
        margins = classifier.estimator.predict(standardized, raw_score=True)

    values = [float(value) for value in list(margins)[0]] if hasattr(margins[0], "__len__") else [float(margins[0])]
    if len(values) == 1:
        # A binary booster reports only the classes_[1] margin.
        return values[0] if class_index == 1 else -values[0]
    return values[class_index]


class LabelEncodedClassifierTests(unittest.TestCase):
    class RecordingEstimator:
        def __init__(self) -> None:
            self.fitted_targets: list[int] = []

        def fit(self, X: object, y: list[int]) -> None:
            self.fitted_targets = list(y)

        def predict(self, X: object) -> list[int]:
            return [0, 1]

        def predict_proba(self, X: object) -> list[list[float]]:
            return [[0.7, 0.3], [0.2, 0.8]]

    def test_encodes_only_observed_labels_in_canonical_order(self) -> None:
        estimator = self.RecordingEstimator()
        classifier = LabelEncodedClassifier(estimator)

        classifier.fit([[0.0], [1.0], [2.0]], ["BULLISH", "BEARISH", "BULLISH"])

        # BEARISH precedes BULLISH in the canonical label order, and NEUTRAL is
        # absent, so the codes stay contiguous from zero as XGBoost requires.
        self.assertEqual(classifier.classes_, ("BEARISH", "BULLISH"))
        self.assertEqual(estimator.fitted_targets, [1, 0, 1])
        self.assertEqual(classifier.predict([[0.0], [1.0]]), ["BEARISH", "BULLISH"])

    def test_rejects_labels_outside_the_fixed_space(self) -> None:
        classifier = LabelEncodedClassifier(self.RecordingEstimator())

        with self.assertRaisesRegex(LabelEncodingError, "outside the fixed market-label space"):
            classifier.fit([[0.0], [1.0]], ["BULLISH", "SIDEWAYS"])

    def test_requires_two_classes_and_a_fitted_state(self) -> None:
        classifier = LabelEncodedClassifier(self.RecordingEstimator())

        with self.assertRaisesRegex(LabelEncodingError, "At least two distinct labels"):
            classifier.fit([[0.0], [1.0]], ["BULLISH", "BULLISH"])
        with self.assertRaisesRegex(LabelEncodingError, "not been fitted"):
            classifier.predict([[0.0]])


class AlgorithmRegistryTests(unittest.TestCase):
    def test_maps_each_choice_to_its_persisted_identifier(self) -> None:
        self.assertEqual(algorithm_identifier("logistic"), LOGISTIC_BASELINE_ALGORITHM)
        self.assertEqual(algorithm_identifier("xgboost"), XGBOOST_ALGORITHM)
        self.assertEqual(algorithm_identifier("lightgbm"), LIGHTGBM_ALGORITHM)

    def test_rejects_an_unknown_algorithm(self) -> None:
        with self.assertRaisesRegex(TrainingError, "Unknown algorithm"):
            algorithm_identifier("catboost")
        with self.assertRaisesRegex(TrainingError, "Unknown algorithm"):
            train_model("catboost", build_split(), schema=SCHEMA)

    @unittest.skipUnless(XGBOOST_AVAILABLE, "xgboost is not installed")
    def test_an_unknown_hyperparameter_fails_loudly(self) -> None:
        with self.assertRaisesRegex(TrainingError, "Invalid hyperparameters for xgboost"):
            train_model("xgboost", build_split(), schema=SCHEMA, hyperparameters={"nnum_leaves": 7})


@unittest.skipUnless(XGBOOST_AVAILABLE, "xgboost is not installed")
class XgboostTrainingTests(unittest.TestCase):
    def test_trains_a_recorded_deterministic_forest(self) -> None:
        split = build_split()

        result = train_model("xgboost", split, schema=SCHEMA, hyperparameters=XGBOOST_HYPERPARAMETERS)
        metadata = training_metadata(result)

        self.assertEqual(result.algorithm, XGBOOST_ALGORITHM)
        self.assertEqual(tuple(result.model.named_steps), ("imputer", "scaler", "classifier"))
        self.assertEqual(metadata["hyperparameters"]["nEstimators"], 30)
        self.assertEqual(metadata["hyperparameters"]["maxDepth"], 2)
        self.assertEqual(metadata["featureSchema"], list(SCHEMA))
        self.assertGreater(result.validation_metrics.macro_f1, 0.5)
        self.assertEqual(result.validation_rows, len(split.validation))

    def test_predicted_labels_stay_inside_the_fixed_label_space(self) -> None:
        split = build_split()

        result = train_model("xgboost", split, schema=SCHEMA, hyperparameters=XGBOOST_HYPERPARAMETERS)
        predictions = predict_labels(result.model, split.validation, schema=SCHEMA)

        self.assertEqual(len(predictions), len(split.validation))
        self.assertLessEqual(set(predictions), {"BEARISH", "NEUTRAL", "BULLISH"})

    def test_a_boosted_pipeline_survives_the_checksummed_artifact_round_trip(self) -> None:
        split = build_split()
        result = train_model("xgboost", split, schema=SCHEMA, hyperparameters=XGBOOST_HYPERPARAMETERS)
        expected = predict_labels(result.model, split.validation, schema=SCHEMA)

        with TemporaryDirectory() as directory:
            path = Path(directory) / "xgboost-candidate.pkl"
            written = write_model_artifact(path, model=result.model, metadata=training_metadata(result))
            reloaded = load_model_artifact(path, expected_checksum=written.checksum)

        self.assertEqual(predict_labels(reloaded.model, split.validation, schema=SCHEMA), expected)


@unittest.skipUnless(LIGHTGBM_AVAILABLE, "lightgbm is not installed")
class LightgbmTrainingTests(unittest.TestCase):
    def test_trains_a_recorded_deterministic_forest(self) -> None:
        split = build_split()

        result = train_model("lightgbm", split, schema=SCHEMA, hyperparameters=LIGHTGBM_HYPERPARAMETERS)
        metadata = training_metadata(result)

        self.assertEqual(result.algorithm, LIGHTGBM_ALGORITHM)
        self.assertEqual(tuple(result.model.named_steps), ("imputer", "scaler", "classifier"))
        self.assertEqual(metadata["hyperparameters"]["numLeaves"], 4)
        self.assertGreater(result.validation_metrics.macro_f1, 0.5)

    def test_repeated_runs_on_one_split_agree(self) -> None:
        split = build_split()

        first = train_model("lightgbm", split, schema=SCHEMA, hyperparameters=LIGHTGBM_HYPERPARAMETERS)
        second = train_model("lightgbm", split, schema=SCHEMA, hyperparameters=LIGHTGBM_HYPERPARAMETERS)

        self.assertEqual(
            predict_labels(first.model, split.validation, schema=SCHEMA),
            predict_labels(second.model, split.validation, schema=SCHEMA),
        )

    def test_a_boosted_pipeline_survives_the_checksummed_artifact_round_trip(self) -> None:
        split = build_split()
        result = train_model("lightgbm", split, schema=SCHEMA, hyperparameters=LIGHTGBM_HYPERPARAMETERS)
        expected = predict_labels(result.model, split.validation, schema=SCHEMA)

        with TemporaryDirectory() as directory:
            path = Path(directory) / "lightgbm-candidate.pkl"
            written = write_model_artifact(path, model=result.model, metadata=training_metadata(result))
            reloaded = load_model_artifact(path, expected_checksum=written.checksum)

        self.assertEqual(predict_labels(reloaded.model, split.validation, schema=SCHEMA), expected)


class TreeShapExplanationTests(unittest.TestCase):
    def assert_contributions_reconstruct_the_margin(self, choice: str, algorithm: str, *, three_class: bool) -> None:
        split = build_split(three_class=three_class)
        hyperparameters = XGBOOST_HYPERPARAMETERS if choice == "xgboost" else LIGHTGBM_HYPERPARAMETERS
        result = train_model(choice, split, schema=SCHEMA, hyperparameters=hyperparameters)
        features = dict(split.validation[0].features)

        explained = explain_prediction(
            result.model,
            features,
            algorithm=algorithm,
            schema=SCHEMA,
            # Retain every feature so the additivity check sees the whole sum.
            maximum_features=len(SCHEMA),
        )

        self.assertEqual(explained.contribution_method, TREE_CONTRIBUTION_METHOD)
        self.assertEqual(explained.algorithm, algorithm)
        self.assertEqual(len(explained.feature_contributions), len(SCHEMA))
        # A forest has no coefficients, and reporting one would be misleading.
        self.assertTrue(all(item["coefficient"] is None for item in explained.feature_contributions))
        self.assertAlmostEqual(sum(explained.class_probabilities.values()), 1.0, places=6)

        reconstructed = explained.intercept + sum(float(item["contribution"]) for item in explained.feature_contributions)
        self.assertAlmostEqual(
            reconstructed,
            selected_class_margin(result.model, features, explained.prediction, algorithm),
            places=4,
        )

    @unittest.skipUnless(XGBOOST_AVAILABLE, "xgboost is not installed")
    def test_xgboost_multiclass_contributions_are_additive(self) -> None:
        self.assert_contributions_reconstruct_the_margin("xgboost", XGBOOST_ALGORITHM, three_class=True)

    @unittest.skipUnless(XGBOOST_AVAILABLE, "xgboost is not installed")
    def test_xgboost_binary_contributions_are_additive(self) -> None:
        self.assert_contributions_reconstruct_the_margin("xgboost", XGBOOST_ALGORITHM, three_class=False)

    @unittest.skipUnless(LIGHTGBM_AVAILABLE, "lightgbm is not installed")
    def test_lightgbm_multiclass_contributions_are_additive(self) -> None:
        self.assert_contributions_reconstruct_the_margin("lightgbm", LIGHTGBM_ALGORITHM, three_class=True)

    @unittest.skipUnless(LIGHTGBM_AVAILABLE, "lightgbm is not installed")
    def test_lightgbm_binary_contributions_are_additive(self) -> None:
        self.assert_contributions_reconstruct_the_margin("lightgbm", LIGHTGBM_ALGORITHM, three_class=False)

    @unittest.skipUnless(XGBOOST_AVAILABLE, "xgboost is not installed")
    def test_a_forest_is_refused_by_the_linear_explainer(self) -> None:
        result = train_model("xgboost", build_split(), schema=SCHEMA, hyperparameters=XGBOOST_HYPERPARAMETERS)

        with self.assertRaisesRegex(InferenceError, "does not expose linear coefficients"):
            explain_prediction(
                result.model,
                dict(build_split().validation[0].features),
                algorithm=LOGISTIC_BASELINE_ALGORITHM,
                schema=SCHEMA,
            )

    @unittest.skipUnless(XGBOOST_AVAILABLE, "xgboost is not installed")
    def test_an_unexplainable_algorithm_is_refused(self) -> None:
        result = train_model("xgboost", build_split(), schema=SCHEMA, hyperparameters=XGBOOST_HYPERPARAMETERS)

        with self.assertRaisesRegex(InferenceError, "No local explainer exists"):
            explain_prediction(
                result.model,
                dict(build_split().validation[0].features),
                algorithm="pytorch-transformer-v9",
                schema=SCHEMA,
            )


class ProductionGateTests(unittest.TestCase):
    """The artifact gate must admit the boosted families and nothing beyond them."""

    def model_version(self, algorithm: str) -> PersistedModelVersion:
        return PersistedModelVersion(
            id="model-version-1",
            model_key="market-direction-xgboost--NIFTY50--1d--h5--neutral-50bps--ml-feature-v1",
            version=1,
            algorithm=algorithm,
            stage="PRODUCTION",
            artifact_uri="C:/models/model.pkl",
            artifact_checksum="a" * 64,
            feature_schema=({"name": "signal"},),
            validation_metrics={},
        )

    def test_an_unsupported_algorithm_cannot_reach_inference(self) -> None:
        from ai_quant_lab_ml.inference import validate_production_artifact

        with self.assertRaisesRegex(InferenceError, "No local explainer exists"):
            validate_production_artifact(
                self.model_version("pytorch-transformer-v9"),
                {},
                instrument_symbol="NIFTY50",
                timeframe="1d",
            )

    def test_a_boosted_algorithm_passes_the_algorithm_check(self) -> None:
        from ai_quant_lab_ml.inference import validate_production_artifact

        # The schema check is the next gate, which proves the algorithm gate let
        # the boosted family through rather than rejecting it outright.
        for algorithm in (XGBOOST_ALGORITHM, LIGHTGBM_ALGORITHM):
            with self.subTest(algorithm=algorithm):
                with self.assertRaisesRegex(InferenceError, "incompatible persisted feature schema"):
                    validate_production_artifact(
                        self.model_version(algorithm),
                        {},
                        instrument_symbol="NIFTY50",
                        timeframe="1d",
                    )


if __name__ == "__main__":
    unittest.main()
