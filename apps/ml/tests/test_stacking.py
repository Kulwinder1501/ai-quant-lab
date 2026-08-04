"""Tests for Stage 6 OOF logistic stacking."""

from __future__ import annotations

import importlib.util
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.sequences import build_intrasession_sequences, sequence_purged_walk_forward
from ai_quant_lab_ml.stack_explain import explain_stack_prediction
from ai_quant_lab_ml.stacking import (
    STACK_ALGORITHM,
    STACK_CONTRIBUTION_METHOD,
    build_meta_features,
    measure_error_diversity,
    meta_feature_names,
    train_meta_learner,
    train_oof_stack,
    OofRow,
)
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET

TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None
START = datetime(2026, 3, 2, 3, 45, tzinfo=UTC)


def make_examples(rows: int = 180) -> list[LabeledExample]:
    examples: list[LabeledExample] = []
    for index in range(rows):
        observed = START + timedelta(minutes=index)
        score = (index % 19) - 9
        label = "EXPANSION" if score > 4 else ("CONTRACTION" if score < -4 else "STABLE")
        examples.append(
            LabeledExample(
                candle_id=f"c-{index}",
                instrument_id="inst-1",
                symbol="NIFTYBEES",
                timeframe="1m",
                observed_at=observed,
                label_available_at=observed + timedelta(minutes=5),
                forward_return=0.0,
                label=label,  # type: ignore[arg-type]
                features={
                    "a": float(score),
                    "b": float(score) / 5.0,
                    "c": float(index % 7),
                },
            )
        )
    return examples


class MetaFeatureTests(unittest.TestCase):
    def test_meta_feature_width_matches_names(self) -> None:
        names = meta_feature_names(VOLATILITY_ALPHABET)
        tcn = {label: 1.0 / 3 for label in VOLATILITY_ALPHABET.labels}
        lag = dict(tcn)
        lag["EXPANSION"] = 0.5
        lag["STABLE"] = 0.3
        lag["CONTRACTION"] = 0.2
        features = build_meta_features(tcn, lag, alphabet=VOLATILITY_ALPHABET)
        self.assertEqual(len(features), len(names))
        self.assertGreater(features[-2], 0.0)  # L1 disagreement
        self.assertEqual(features[-1], 1.0)  # pred disagreement


class DiversityTests(unittest.TestCase):
    def test_identical_errors_fail_gate(self) -> None:
        rows = [
            OofRow(
                candle_id=f"c-{i}",
                fold=1,
                label="STABLE",
                observed_at=START,
                tcn_proba={"CONTRACTION": 0.1, "STABLE": 0.8, "EXPANSION": 0.1},
                lag_lgbm_proba={"CONTRACTION": 0.1, "STABLE": 0.8, "EXPANSION": 0.1},
                tcn_pred="STABLE",
                lag_lgbm_pred="STABLE",
            )
            for i in range(20)
        ]
        report = measure_error_diversity(rows)
        self.assertFalse(report.passes)
        self.assertEqual(report.disagreement_rate, 0.0)

    def test_diverse_errors_pass_gate(self) -> None:
        rows = []
        for i in range(40):
            tcn_ok = i % 2 == 0
            lag_ok = i % 3 == 0
            rows.append(
                OofRow(
                    candle_id=f"c-{i}",
                    fold=1,
                    label="STABLE",
                    observed_at=START,
                    tcn_proba={"CONTRACTION": 0.2, "STABLE": 0.6, "EXPANSION": 0.2},
                    lag_lgbm_proba={"CONTRACTION": 0.3, "STABLE": 0.4, "EXPANSION": 0.3},
                    tcn_pred="STABLE" if tcn_ok else "EXPANSION",
                    lag_lgbm_pred="STABLE" if lag_ok else "CONTRACTION",
                )
            )
        report = measure_error_diversity(rows)
        self.assertTrue(report.passes)
        self.assertGreater(report.disagreement_rate, 0.05)


class MetaLearnerTests(unittest.TestCase):
    def test_trains_on_synthetic_oof(self) -> None:
        train_rows = []
        holdout_rows = []
        for i in range(60):
            label = "EXPANSION" if i % 3 == 0 else ("CONTRACTION" if i % 3 == 1 else "STABLE")
            # Make TCN slightly informative.
            tcn = {"CONTRACTION": 0.2, "STABLE": 0.2, "EXPANSION": 0.6}
            if label == "CONTRACTION":
                tcn = {"CONTRACTION": 0.6, "STABLE": 0.2, "EXPANSION": 0.2}
            elif label == "STABLE":
                tcn = {"CONTRACTION": 0.2, "STABLE": 0.6, "EXPANSION": 0.2}
            lag = {"CONTRACTION": 0.33, "STABLE": 0.34, "EXPANSION": 0.33}
            row = OofRow(
                candle_id=f"c-{i}",
                fold=1 if i < 40 else 2,
                label=label,  # type: ignore[arg-type]
                observed_at=START,
                tcn_proba=tcn,
                lag_lgbm_proba=lag,
                tcn_pred=max(tcn, key=tcn.get),  # type: ignore[arg-type]
                lag_lgbm_pred=max(lag, key=lag.get),  # type: ignore[arg-type]
            )
            if i < 40:
                train_rows.append(row)
            else:
                holdout_rows.append(row)
        model, metrics, _, _ = train_meta_learner(train_rows, holdout_rows)
        self.assertGreater(metrics.macro_f1, 0.3)
        self.assertEqual(len(model.classes_), 3)


@unittest.skipUnless(TORCH_AVAILABLE, "torch is not installed")
class EndToEndStackTests(unittest.TestCase):
    def test_stack_pipeline_runs(self) -> None:
        sequences = build_intrasession_sequences(
            make_examples(), lookback=8, feature_names=("a", "b", "c"), timeframe="1m",
        )
        splits = sequence_purged_walk_forward(sequences, folds=2, validation_fraction=0.35)
        result, fits, oof_rows = train_oof_stack(
            splits,
            lookback=8,
            channels=8,
            epochs=4,
            batch_size=32,
            random_state=0,
        )
        self.assertEqual(result.algorithm, STACK_ALGORITHM)
        self.assertEqual(len(fits), 2)
        self.assertGreater(len(oof_rows), 0)
        holdout = [row for row in oof_rows if row.fold == result.holdout_fold]
        explanation = explain_stack_prediction(
            result.model,
            sequence=splits[-1].validation[0],
            tcn_model=fits[-1].tcn_model,
            tcn_medians=fits[-1].tcn_medians,
            tcn_proba=holdout[0].tcn_proba,
            lag_lgbm_proba=holdout[0].lag_lgbm_proba,
        )
        self.assertEqual(explanation["contributionMethod"], STACK_CONTRIBUTION_METHOD)
        self.assertIn("baseExplanations", explanation)


if __name__ == "__main__":
    unittest.main()
