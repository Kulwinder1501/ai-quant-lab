from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from ai_quant_lab_ml.artifacts import ArtifactError, write_model_artifact
from ai_quant_lab_ml.contracts import (
    DIRECTIONAL_ALPHABET,
    FEATURE_SCHEMA_VERSION,
    DatasetRequest,
    EvaluationMetrics,
    LabeledExample,
    PersistedModelVersion,
    TemporalSplit,
)
from ai_quant_lab_ml.features import feature_definition, feature_schema
from ai_quant_lab_ml.training import BaselineTrainingResult
from train import (
    apply_audit_verdict,
    cpcv_summary,
    default_model_key,
    fold_summary,
    parse_timestamp,
    promotion_assessment,
    trivial_majority_metrics,
    validate_candidate_artifact,
)


def metrics(macro_f1: float) -> EvaluationMetrics:
    return EvaluationMetrics(
        accuracy=macro_f1,
        balanced_accuracy=macro_f1,
        macro_f1=macro_f1,
        sample_count=10,
        class_counts={"BEARISH": 3, "NEUTRAL": 4, "BULLISH": 3},
    )


def labeled(index: int, label: str) -> LabeledExample:
    observed_at = datetime(2024, 1, 1, tzinfo=UTC) + timedelta(days=index)
    return LabeledExample(
        candle_id=f"candle-{index}",
        instrument_id="instrument-1",
        symbol="NIFTY50",
        timeframe="1d",
        observed_at=observed_at,
        label_available_at=observed_at + timedelta(days=5),
        forward_return=0.0,
        label=label,
        features={"feature.one": float(index)},
    )


def candidate(macro_f1: float, *, training_macro_f1: float | None = None) -> BaselineTrainingResult:
    # A candidate normally fits its own history at least as well as the holdout;
    # tests that need the pathological case pass training_macro_f1 explicitly.
    return BaselineTrainingResult(
        algorithm="sklearn-logistic-regression-v1",
        model=None,
        feature_schema=("feature.one",),
        training_metrics=metrics(training_macro_f1 if training_macro_f1 is not None else macro_f1 + 0.05),
        validation_metrics=metrics(macro_f1),
        training_rows=20,
        validation_rows=10,
    )


def assess(
    macro_f1: float,
    **overrides: object,
) -> tuple[bool, dict[str, object]]:
    """Run the gate with sane defaults so each test states only what it varies."""

    arguments: dict[str, object] = {
        "candidate": candidate(macro_f1),
        "incumbent": None,
        "incumbent_metrics": None,
        "incumbent_error": None,
        "minimum_improvement": 0.0,
        "minimum_initial_macro_f1": 0.38,
        "maximum_plausible_macro_f1": 0.60,
        "override_suspicious": False,
        # The sample-size floors are neutralised here so each test exercises the one
        # rule it names. They have their own tests below.
        "minimum_validation_rows": 1,
        "minimum_directional_predictions": 1,
    }
    arguments.update(overrides)
    return promotion_assessment(**arguments)  # type: ignore[arg-type]


def incumbent() -> PersistedModelVersion:
    return PersistedModelVersion(
        id="model-production",
        model_key="market-direction-logistic",
        version=1,
        algorithm="sklearn-logistic-regression-v1",
        stage="PRODUCTION",
        artifact_uri="C:/models/production.pkl",
        artifact_checksum="a" * 64,
        feature_schema=({"name": "feature.one"},),
        validation_metrics={},
    )


class PromotionSampleSizeGateTests(unittest.TestCase):
    """A macro-F1 floor cannot discriminate on a holdout too small to resolve it."""

    def test_a_passing_score_on_too_few_rows_is_refused(self) -> None:
        # The real case this came from: a 15m candidate scored 0.4023 on 24 rows,
        # cleared the 0.38 floor, and was declared promotion-eligible.
        thin = BaselineTrainingResult(
            algorithm="sklearn-logistic-regression-v1",
            model=None,
            feature_schema=("feature.one",),
            training_metrics=metrics(0.50),
            validation_metrics=metrics(0.4023),
            training_rows=91,
            validation_rows=24,
        )
        qualifies, assessment = assess(
            0.4023,
            candidate=thin,
            minimum_validation_rows=60,
            minimum_directional_predictions=1,
        )
        self.assertFalse(qualifies)
        self.assertEqual(assessment["decision"], "INSUFFICIENT_VALIDATION_EVIDENCE")
        self.assertIn("24 validation rows", str(assessment["reason"]))

    def test_sample_size_is_checked_before_the_score_floor(self) -> None:
        """Insufficient evidence must not be reported as a quality failure.

        Reporting a too-small holdout as INITIAL_BASELINE_THRESHOLD_NOT_MET would
        send someone off to improve a model when the actual problem is the window.
        """

        _, assessment = assess(0.10, minimum_validation_rows=60, minimum_directional_predictions=1)
        self.assertEqual(assessment["decision"], "INSUFFICIENT_VALIDATION_EVIDENCE")

    def test_sample_size_is_checked_before_a_suspiciously_high_score(self) -> None:
        _, assessment = assess(0.95, minimum_validation_rows=60, minimum_directional_predictions=1)
        self.assertEqual(assessment["decision"], "INSUFFICIENT_VALIDATION_EVIDENCE")

    def test_a_model_that_almost_never_commits_has_no_readable_hit_rate(self) -> None:
        directional = EvaluationMetrics(
            accuracy=0.5,
            balanced_accuracy=0.5,
            macro_f1=0.45,
            sample_count=100,
            class_counts={"BEARISH": 30, "NEUTRAL": 40, "BULLISH": 30},
            directional_predictions=8,
            directional_hit_rate=0.25,
            coverage=0.08,
        )
        thin = BaselineTrainingResult(
            algorithm="sklearn-logistic-regression-v1",
            model=None,
            feature_schema=("feature.one",),
            training_metrics=metrics(0.50),
            validation_metrics=directional,
            training_rows=400,
            validation_rows=100,
        )
        qualifies, assessment = assess(
            0.45,
            candidate=thin,
            minimum_validation_rows=60,
            minimum_directional_predictions=30,
        )
        self.assertFalse(qualifies)
        self.assertEqual(assessment["decision"], "INSUFFICIENT_DIRECTIONAL_EVIDENCE")

    def test_sufficient_evidence_reaches_the_score_floor(self) -> None:
        """With enough rows and enough directional calls the gate judges quality again."""

        ample = EvaluationMetrics(
            accuracy=0.5,
            balanced_accuracy=0.5,
            macro_f1=0.45,
            sample_count=200,
            class_counts={"BEARISH": 60, "NEUTRAL": 80, "BULLISH": 60},
            directional_predictions=120,
            directional_hit_rate=0.52,
            coverage=0.6,
        )
        strong = BaselineTrainingResult(
            algorithm="sklearn-logistic-regression-v1",
            model=None,
            feature_schema=("feature.one",),
            training_metrics=metrics(0.50),
            validation_metrics=ample,
            training_rows=800,
            validation_rows=200,
        )
        qualifies, assessment = assess(
            0.45,
            candidate=strong,
            minimum_validation_rows=60,
            minimum_directional_predictions=30,
        )
        self.assertTrue(qualifies)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_MET")


class TrainCliPolicyTests(unittest.TestCase):
    def test_default_model_key_is_scoped_to_dataset_and_label_definition(self) -> None:
        common = {
            "instrument_symbol": "NIFTY50",
            "timeframe": "1d",
            "data_window_start": datetime(2024, 1, 1, tzinfo=UTC),
            "data_window_end": datetime(2024, 2, 1, tzinfo=UTC),
            "data_cutoff_at": datetime(2024, 2, 2, tzinfo=UTC),
        }
        five_bar = DatasetRequest(**common, horizon_bars=5, neutral_threshold_bps=50.0)
        ten_bar = DatasetRequest(**common, horizon_bars=10, neutral_threshold_bps=50.0)
        wider_band = DatasetRequest(**common, horizon_bars=5, neutral_threshold_bps=100.0)

        self.assertEqual(
            default_model_key(five_bar, "logistic"),
            f"market-direction-logistic--NIFTY50--1d--h5--neutral-50bps--{FEATURE_SCHEMA_VERSION}",
        )
        self.assertNotEqual(default_model_key(five_bar, "logistic"), default_model_key(ten_bar, "logistic"))
        self.assertNotEqual(default_model_key(five_bar, "logistic"), default_model_key(wider_band, "logistic"))

    def test_a_label_scheme_gets_its_own_lineage_and_only_its_own_parameters(self) -> None:
        """A scheme is a different question, so it must never share a PRODUCTION slot.

        The key also carries only the parameters that shape *that* scheme's target:
        stamping a neutral band or barrier multiples onto a volatility model would
        name a geometry it does not have, and would split one model's lineage in two
        whenever an unrelated flag moved.
        """

        from ai_quant_lab_ml.contracts import (
            LABEL_SCHEME_TRIPLE_BARRIER,
            LABEL_SCHEME_VOLATILITY_EXPANSION,
        )

        common = {
            "instrument_symbol": "NIFTY50",
            "timeframe": "1d",
            "data_window_start": datetime(2024, 1, 1, tzinfo=UTC),
            "data_window_end": datetime(2024, 2, 1, tzinfo=UTC),
            "data_cutoff_at": datetime(2024, 2, 2, tzinfo=UTC),
            "horizon_bars": 10,
            "neutral_threshold_bps": 50.0,
        }
        directional = DatasetRequest(**common)
        barrier = DatasetRequest(**common, label_scheme=LABEL_SCHEME_TRIPLE_BARRIER)
        volatility = DatasetRequest(**common, label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION)

        keys = {
            default_model_key(directional, "logistic"),
            default_model_key(barrier, "logistic"),
            default_model_key(volatility, "logistic"),
        }
        self.assertEqual(len(keys), 3, "each scheme must get a distinct lineage")

        volatility_key = default_model_key(volatility, "logistic")
        # Named for the target family, not "market-direction".
        self.assertTrue(volatility_key.startswith("volatility-expansion-logistic"))
        self.assertIn("band0.25", volatility_key)
        # The directional-only label parameters must not appear.
        self.assertNotIn("neutral-", volatility_key)
        self.assertNotIn("bu1", volatility_key)

        # A changed band is a changed target, so it is a different lineage...
        wider = DatasetRequest(
            **common, label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION, expansion_band=0.5
        )
        self.assertNotEqual(volatility_key, default_model_key(wider, "logistic"))
        # ...while an unused barrier flag must not move a volatility key at all.
        unused_barrier = DatasetRequest(
            **common, label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION, barrier_upper_multiple=3.0
        )
        self.assertEqual(volatility_key, default_model_key(unused_barrier, "logistic"))

    def test_each_algorithm_gets_its_own_default_promotion_lineage(self) -> None:
        request = DatasetRequest(
            instrument_symbol="NIFTY50",
            timeframe="1d",
            data_window_start=datetime(2024, 1, 1, tzinfo=UTC),
            data_window_end=datetime(2024, 2, 1, tzinfo=UTC),
            data_cutoff_at=datetime(2024, 2, 2, tzinfo=UTC),
            horizon_bars=5,
            neutral_threshold_bps=50.0,
        )

        keys = {choice: default_model_key(request, choice) for choice in ("logistic", "xgboost", "lightgbm")}

        self.assertEqual(len(set(keys.values())), 3)
        self.assertTrue(keys["xgboost"].startswith("market-direction-xgboost--"))
        self.assertTrue(keys["lightgbm"].startswith("market-direction-lightgbm--"))

    def test_candidate_artifact_is_reloaded_and_checked_before_lifecycle_changes(self) -> None:
        request = DatasetRequest(
            instrument_symbol="NIFTY50",
            timeframe="1d",
            data_window_start=datetime(2024, 1, 1, tzinfo=UTC),
            data_window_end=datetime(2024, 2, 1, tzinfo=UTC),
            data_cutoff_at=datetime(2024, 2, 2, tzinfo=UTC),
            horizon_bars=5,
            neutral_threshold_bps=50.0,
        )
        model_key = default_model_key(request, "logistic")
        metadata = {
            "featureSchema": list(feature_schema()),
            "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
            "featureDefinition": feature_definition(),
            "algorithm": "sklearn-logistic-regression-v1",
            "modelKey": model_key,
            "dataset": {"instrument": "NIFTY50", "timeframe": "1d"},
            "validationProtocol": {
                "horizonBars": 5,
                "neutralThresholdBps": 50.0,
                "indicatorAlgorithmVersion": request.indicator_algorithm_version,
                "patternAlgorithmVersion": request.pattern_algorithm_version,
                "priceActionAlgorithmVersion": request.price_action_algorithm_version,
            },
        }
        with TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "candidate.pkl"
            artifact = write_model_artifact(path, model=None, metadata=metadata)
            validate_candidate_artifact(
                path=path,
                expected_checksum=artifact.checksum,
                expected_schema=feature_schema(),
                model_key=model_key,
                algorithm="sklearn-logistic-regression-v1",
                request=request,
            )

            incompatible = dict(metadata)
            incompatible["featureDefinition"] = {"schemaVersion": "wrong"}
            corrupted_semantics = write_model_artifact(path, model=None, metadata=incompatible)
            with self.assertRaisesRegex(ArtifactError, "feature definition"):
                validate_candidate_artifact(
                    path=path,
                    expected_checksum=corrupted_semantics.checksum,
                    expected_schema=feature_schema(),
                    model_key=model_key,
                    algorithm="sklearn-logistic-regression-v1",
                    request=request,
                )

    def test_a_failed_leakage_audit_blocks_an_otherwise_passing_candidate(self) -> None:
        assessment: dict = {"decision": "INITIAL_BASELINE_THRESHOLD_MET"}
        audit = {"verdict": "INVESTIGATE", "summary": "1 of 3 leakage checks need investigation: FEATURE_LAG."}

        allowed = apply_audit_verdict(assessment, audit, override_suspicious=False)

        self.assertFalse(allowed)
        self.assertEqual(assessment["decision"], "LEAKAGE_AUDIT_REQUIRES_INVESTIGATION")
        self.assertIn("FEATURE_LAG", assessment["reason"])
        # The verdict is recorded either way, so the refusal keeps its evidence.
        self.assertEqual(assessment["leakageAudit"], audit)

    def test_a_passing_audit_leaves_the_decision_alone(self) -> None:
        assessment: dict = {"decision": "CANDIDATE_OUTPERFORMS_INCUMBENT"}

        allowed = apply_audit_verdict(assessment, {"verdict": "PASS", "summary": "ok"}, override_suspicious=False)

        self.assertTrue(allowed)
        self.assertEqual(assessment["decision"], "CANDIDATE_OUTPERFORMS_INCUMBENT")
        self.assertNotIn("overriddenLeakageAudit", assessment)

    def test_an_override_records_that_a_failed_audit_was_accepted(self) -> None:
        assessment: dict = {"decision": "INITIAL_BASELINE_THRESHOLD_MET"}

        allowed = apply_audit_verdict(assessment, {"verdict": "INVESTIGATE"}, override_suspicious=True)

        self.assertTrue(allowed)
        self.assertTrue(assessment["overriddenLeakageAudit"])

    def test_fold_summary_reports_the_spread_alongside_the_mean(self) -> None:
        summary = fold_summary([candidate(0.30), candidate(0.50), candidate(0.40)])

        self.assertEqual(summary["folds"], 3)
        self.assertAlmostEqual(summary["meanMacroF1"], 0.40, places=10)
        self.assertAlmostEqual(summary["spreadMacroF1"], 0.20, places=10)
        # The final fold is the one whose artifact is persisted and promoted.
        self.assertAlmostEqual(summary["finalFoldMacroF1"], 0.40, places=10)

    def test_cpcv_summary_separates_a_macro_f1_edge_from_an_accuracy_edge(self) -> None:
        # The real 2026-08-01 measurement on NIFTY50 daily, in miniature: the model
        # beat the constant predictor on macro-F1 in every split and lost to it on
        # accuracy in every split. Reporting only macro-F1 would have read as a
        # discovered edge when the model was getting fewer rows right.
        model = [
            EvaluationMetrics(accuracy=0.35, balanced_accuracy=0.33, macro_f1=0.29, sample_count=290, class_counts={}),
            EvaluationMetrics(accuracy=0.37, balanced_accuracy=0.35, macro_f1=0.32, sample_count=290, class_counts={}),
        ]
        trivial = [
            EvaluationMetrics(accuracy=0.49, balanced_accuracy=0.33, macro_f1=0.22, sample_count=290, class_counts={}),
            EvaluationMetrics(accuracy=0.52, balanced_accuracy=0.33, macro_f1=0.23, sample_count=290, class_counts={}),
        ]

        summary = cpcv_summary(model, trivial, groups=6, test_groups=2, embargo_fraction=0.01)

        self.assertEqual(summary["method"], "CPCV_V1")
        self.assertEqual(summary["splits"], 2)
        self.assertGreater(summary["macroF1MinusTrivial"]["mean"], 0)
        self.assertEqual(summary["macroF1WinRateVsTrivial"], 1.0)
        # The half that matters: fewer rows right than always guessing one class.
        self.assertLess(summary["accuracyMinusTrivial"]["mean"], 0)
        self.assertEqual(summary["accuracyWinRateVsTrivial"], 0.0)

    def test_trivial_baseline_predicts_the_training_majority_not_the_holdout_majority(self) -> None:
        # A deployed constant predictor only knows the training distribution, so
        # taking the majority from the holdout would give the baseline a peek at the
        # answers and understate the model's disadvantage.
        train = [labeled(index, "BULLISH") for index in range(7)] + [labeled(100 + index, "BEARISH") for index in range(3)]
        validation = [labeled(200 + index, "BEARISH") for index in range(8)] + [labeled(300, "BULLISH")]
        split = TemporalSplit(train=tuple(train), validation=tuple(validation), purge_count=0)

        baseline = trivial_majority_metrics(split, alphabet=DIRECTIONAL_ALPHABET)

        # Predicts BULLISH throughout (the training majority), so it is right on the
        # single BULLISH holdout row out of nine.
        self.assertAlmostEqual(baseline.accuracy, 1 / 9, places=10)

    def test_parses_dates_and_utc_timestamps_deterministically(self) -> None:
        self.assertEqual(
            parse_timestamp("2026-01-05"),
            datetime(2026, 1, 5, 0, 0, tzinfo=UTC),
        )
        self.assertEqual(
            parse_timestamp("2026-01-05T09:15:00Z"),
            datetime(2026, 1, 5, 9, 15, tzinfo=UTC),
        )

    def test_initial_promotion_requires_the_explicit_quality_floor(self) -> None:
        passes, assessment = assess(0.42)

        self.assertTrue(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_MET")

    def test_a_score_near_the_random_baseline_is_refused(self) -> None:
        passes, assessment = assess(0.35)

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_NOT_MET")

    def test_a_suspiciously_high_score_is_refused_before_any_comparison(self) -> None:
        """A leaking candidate that "beats" production is the failure this prevents."""

        passes, assessment = assess(0.71, incumbent=incumbent(), incumbent_metrics=metrics(0.50))

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "SUSPICIOUSLY_HIGH_REQUIRES_AUDIT")
        self.assertIn("plausible ceiling", str(assessment["reason"]))

    def test_a_suspiciously_high_score_can_be_promoted_only_by_explicit_override(self) -> None:
        passes, assessment = assess(0.71, override_suspicious=True)

        self.assertTrue(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_MET")
        self.assertTrue(assessment["overridden"])

    def test_a_holdout_score_above_training_is_refused(self) -> None:
        passes, assessment = assess(0.55, candidate=candidate(0.55, training_macro_f1=0.40))

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "HOLDOUT_EXCEEDS_TRAINING_REQUIRES_AUDIT")

    def test_a_weak_walk_forward_mean_cannot_be_rescued_by_one_lucky_final_fold(self) -> None:
        folds = {"folds": 4, "meanMacroF1": 0.31, "finalFoldMacroF1": 0.52}

        passes, assessment = assess(0.52, folds=folds)

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_NOT_MET")
        self.assertEqual(assessment["gateScores"], {"finalFold": 0.52, "mean": 0.31})

    def test_a_strong_mean_cannot_promote_a_failing_final_fold(self) -> None:
        folds = {"folds": 4, "meanMacroF1": 0.55, "finalFoldMacroF1": 0.30}

        passes, assessment = assess(0.30, folds=folds)

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_NOT_MET")

    def test_walk_forward_promotes_when_mean_and_final_fold_both_clear(self) -> None:
        folds = {"folds": 3, "meanMacroF1": 0.44, "finalFoldMacroF1": 0.41}

        passes, assessment = assess(0.41, folds=folds)

        self.assertTrue(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_MET")
        self.assertEqual(assessment["walkForward"], folds)

    def test_incumbent_requires_strict_macro_f1_improvement(self) -> None:
        passes, assessment = assess(
            0.55,
            incumbent=incumbent(),
            incumbent_metrics=metrics(0.55),
            minimum_improvement=0.01,
        )

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "CANDIDATE_DID_NOT_OUTPERFORM_INCUMBENT")

    def test_beating_the_incumbent_still_requires_the_absolute_floor(self) -> None:
        passes, assessment = assess(
            0.36,
            incumbent=incumbent(),
            incumbent_metrics=metrics(0.30),
        )

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "INITIAL_BASELINE_THRESHOLD_NOT_MET")

    def test_an_unevaluable_incumbent_cannot_be_replaced(self) -> None:
        passes, assessment = assess(
            0.55,
            incumbent=incumbent(),
            incumbent_metrics=None,
            incumbent_error="checksum mismatch",
        )

        self.assertFalse(passes)
        self.assertEqual(assessment["decision"], "INCUMBENT_NOT_EVALUABLE")


if __name__ == "__main__":
    unittest.main()
