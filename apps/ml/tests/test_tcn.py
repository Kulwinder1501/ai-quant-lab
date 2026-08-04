"""Tests for the optional causal TCN path."""

from __future__ import annotations

import importlib.util
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.sequences import build_intrasession_sequences, sequence_purged_walk_forward
from ai_quant_lab_ml.tcn_model import TCN_ALGORITHM, build_causal_tcn
from ai_quant_lab_ml.tcn_explain import temporal_occlusion_contributions
from ai_quant_lab_ml.tcn_training import predict_tcn_labels, train_tcn_classifier
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET

TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None
START = datetime(2026, 3, 2, 3, 45, tzinfo=UTC)


def make_examples(rows: int = 120) -> list[LabeledExample]:
    examples: list[LabeledExample] = []
    for index in range(rows):
        observed = START + timedelta(minutes=index)
        score = (index % 17) - 8
        label = "EXPANSION" if score > 3 else ("CONTRACTION" if score < -3 else "STABLE")
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
                    "c": float(index % 5),
                },
            )
        )
    return examples


@unittest.skipUnless(TORCH_AVAILABLE, "torch is not installed")
class CausalTcnTests(unittest.TestCase):
    def test_trains_and_scores_within_label_space(self) -> None:
        sequences = build_intrasession_sequences(
            make_examples(), lookback=8, feature_names=("a", "b", "c"), timeframe="1m",
        )
        split = sequence_purged_walk_forward(sequences, folds=1, validation_fraction=0.25)[0]
        result = train_tcn_classifier(
            split,
            lookback=8,
            channels=8,
            dilations=(1, 2),
            epochs=8,
            batch_size=32,
            patience=4,
            random_state=0,
        )
        self.assertEqual(result.algorithm, TCN_ALGORITHM)
        self.assertGreater(result.parameter_count, 0)
        predictions = predict_tcn_labels(
            result.model,
            split.validation,
            medians=result.hyperparameters["featureMedians"],
            alphabet=VOLATILITY_ALPHABET,
        )
        self.assertEqual(len(predictions), len(split.validation))
        self.assertTrue(set(predictions) <= set(VOLATILITY_ALPHABET.labels))

    def test_temporal_occlusion_returns_blocks(self) -> None:
        sequences = build_intrasession_sequences(
            make_examples(80), lookback=8, feature_names=("a", "b", "c"), timeframe="1m",
        )
        split = sequence_purged_walk_forward(sequences, folds=1, validation_fraction=0.3)[0]
        result = train_tcn_classifier(
            split, lookback=8, channels=8, dilations=(1, 2), epochs=5, batch_size=32, patience=3,
        )
        explained = temporal_occlusion_contributions(
            result.model,
            split.validation[0],
            medians=result.hyperparameters["featureMedians"],
            alphabet=VOLATILITY_ALPHABET,
            window=2,
        )
        self.assertEqual(explained["contributionMethod"], "TEMPORAL_OCCLUSION_V1")
        self.assertTrue(explained["blocks"])

    def test_parameter_count_is_reported(self) -> None:
        model = build_causal_tcn(n_features=3, n_classes=3, channels=8, dilations=(1, 2))
        self.assertGreater(model.parameter_count(), 0)

    def test_artifact_pickle_roundtrip(self) -> None:
        import tempfile
        from pathlib import Path

        from ai_quant_lab_ml.artifacts import load_model_artifact, write_model_artifact

        model = build_causal_tcn(n_features=3, n_classes=3, channels=8, dilations=(1, 2))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tcn.pkl"
            write_model_artifact(path, model=model, metadata={"algorithm": TCN_ALGORITHM})
            loaded = load_model_artifact(path)
            self.assertEqual(loaded.model.parameter_count(), model.parameter_count())


class SequenceReadinessGateTests(unittest.TestCase):
    def test_missing_report_refuses(self) -> None:
        from datetime import timezone

        from ai_quant_lab_ml.sequence_readiness import SequenceReadinessError, require_sequence_candidate_pass

        with self.assertRaises(SequenceReadinessError):
            require_sequence_candidate_pass(
                None,
                symbol="NIFTYBEES",
                timeframe="1m",
                candidate="tcn-1m",
                as_of=datetime.now(timezone.utc),
            )

    def test_pass_verdict_returns_provenance(self) -> None:
        from datetime import timezone

        from ai_quant_lab_ml.sequence_readiness import require_sequence_candidate_pass

        created = datetime.now(timezone.utc)
        report = {
            "id": "r1",
            "reportHash": "a" * 64,
            "createdAt": created,
            "report": {
                "candidates": [
                    {
                        "verdict": "PASS",
                        "measurements": {
                            "symbol": "NIFTYBEES",
                            "timeframe": "1m",
                            "candidate": "tcn-1m",
                        },
                    }
                ]
            },
        }
        provenance = require_sequence_candidate_pass(
            report,
            symbol="NIFTYBEES",
            timeframe="1m",
            candidate="tcn-1m",
            as_of=created,
        )
        self.assertEqual(provenance["verdict"], "PASS")
        self.assertEqual(provenance["reportId"], "r1")


if __name__ == "__main__":
    unittest.main()
