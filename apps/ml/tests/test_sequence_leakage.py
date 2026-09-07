"""Tests for sequence_leakage.py: label-shuffle and era-holdout on the TCN."""

from __future__ import annotations

import importlib.util
import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import LabeledExample
from ai_quant_lab_ml.sequence_leakage import SequenceLeakageAuditError, run_sequence_leakage_audit
from ai_quant_lab_ml.sequences import build_intrasession_sequences

TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None
START = datetime(2026, 3, 2, 3, 45, tzinfo=UTC)


def make_examples(sessions: int = 16, per_session: int = 15) -> list[LabeledExample]:
    examples: list[LabeledExample] = []
    index = 0
    for session in range(sessions):
        for minute in range(per_session):
            observed = START + timedelta(days=session, minutes=minute)
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
                    features={"a": float(score), "b": float(score) / 5.0, "c": float(index % 5)},
                )
            )
            index += 1
    return examples


@unittest.skipUnless(TORCH_AVAILABLE, "torch is not installed")
class SequenceLeakageAuditTests(unittest.TestCase):
    def test_runs_both_checks_and_returns_a_verdict(self) -> None:
        sequences = build_intrasession_sequences(
            make_examples(), lookback=6, feature_names=("a", "b", "c"), timeframe="1m",
        )
        audit = run_sequence_leakage_audit(
            sequences, lookback=6, channels=8, epochs=3, batch_size=32, random_state=0,
        )
        self.assertEqual(audit["method"], "SEQUENCE_LEAKAGE_AUDIT_V1")
        self.assertIn(audit["verdict"], {"PASS", "INVESTIGATE"})
        self.assertEqual({check["check"] for check in audit["checks"]}, {"LABEL_SHUFFLE", "ERA_HOLDOUT"})
        self.assertIn("baseMacroF1", audit["metrics"])

    def test_rejects_empty_input(self) -> None:
        with self.assertRaises(SequenceLeakageAuditError):
            run_sequence_leakage_audit([], lookback=6, channels=8, epochs=3, batch_size=32)

    def test_era_holdout_too_short_reports_failed_not_raised(self) -> None:
        sequences = build_intrasession_sequences(
            make_examples(sessions=2, per_session=15), lookback=6, feature_names=("a", "b", "c"), timeframe="1m",
        )
        audit = run_sequence_leakage_audit(
            sequences, lookback=6, channels=8, epochs=3, batch_size=32, random_state=0,
        )
        era_check = next(check for check in audit["checks"] if check["check"] == "ERA_HOLDOUT")
        self.assertEqual(era_check["status"], "FAILED")
        self.assertEqual(audit["verdict"], "INVESTIGATE")


if __name__ == "__main__":
    unittest.main()
