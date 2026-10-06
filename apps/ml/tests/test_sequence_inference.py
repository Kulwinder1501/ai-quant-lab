"""Tests for sequence shadow validation helpers."""

from __future__ import annotations

import unittest
from datetime import UTC, datetime

from ai_quant_lab_ml.contracts import PersistedModelVersion
from ai_quant_lab_ml.inference import InferenceError
from ai_quant_lab_ml.sequence_inference import (
    is_sequence_shadow_algorithm,
    validate_sequence_shadow_artifact,
)
from ai_quant_lab_ml.tcn_model import TCN_ALGORITHM


def _model_version(**overrides):
    base = dict(
        id="mv-1",
        model_key="volatility-expansion-tcn--NIFTYBEES--1m",
        version=1,
        algorithm=TCN_ALGORITHM,
        stage="CANDIDATE",
        artifact_uri="/tmp/x.pkl",
        artifact_checksum="a" * 64,
        feature_schema=[{"name": "a", "version": "ml-feature-scalp-v2"}],
        validation_metrics={},
        trained_at=datetime(2026, 8, 4, tzinfo=UTC),
        promoted_at=None,
    )
    base.update(overrides)
    return PersistedModelVersion(**base)


class SequenceShadowValidationTests(unittest.TestCase):
    def test_algorithm_gate(self) -> None:
        self.assertTrue(is_sequence_shadow_algorithm(TCN_ALGORITHM))
        self.assertFalse(is_sequence_shadow_algorithm("lightgbm-gradient-boosting-v1"))

    def test_rejects_wrong_scheme(self) -> None:
        metadata = {
            "algorithm": TCN_ALGORITHM,
            "modelKey": "volatility-expansion-tcn--NIFTYBEES--1m",
            "featureSchemaVersion": "ml-feature-scalp-v2",
            "featureSchema": ["a"],
            "lookback": 64,
            "dataset": {"instrument": "NIFTYBEES", "timeframe": "1m"},
            "validationProtocol": {
                "labelScheme": "fixed-horizon-v1",
                "horizonBars": 5,
                "expansionBand": 0.25,
                "lookback": 64,
                "trainingSourceWindow": {
                    "start": "2026-01-01T00:00:00+00:00",
                    "end": "2026-07-01T00:00:00+00:00",
                },
                "trainingLabelAvailableEnd": "2026-07-01T00:05:00+00:00",
                "dataCutoffAt": "2026-08-04T05:00:00+00:00",
            },
            "validationMetrics": {"macroF1": 0.5},
        }
        with self.assertRaises(InferenceError):
            validate_sequence_shadow_artifact(
                _model_version(),
                metadata,
                instrument_symbol="NIFTYBEES",
                timeframe="1m",
                allow_candidate_pool_member=True,
            )

    def test_an_archived_shadow_member_is_rejected_without_the_flag(self) -> None:
        """A sticky-enrolled model must not silently score once it is archived.

        The stage check runs before any other validation, so an empty metadata
        payload is enough to isolate it: the failure must be about stage, not
        about a missing field.
        """

        with self.assertRaisesRegex(InferenceError, "PRODUCTION or enrolled"):
            validate_sequence_shadow_artifact(
                _model_version(stage="ARCHIVED"),
                {},
                instrument_symbol="NIFTYBEES",
                timeframe="1m",
            )

    def test_an_archived_shadow_member_passes_the_stage_gate_with_the_flag(self) -> None:
        """Once ``allow_archived_shadow_member`` is set, ARCHIVED is admitted.

        Empty metadata still fails a later check (the artifact/model-version
        algorithm match), but that failure must no longer be about stage.
        """

        with self.assertRaises(InferenceError) as raised:
            validate_sequence_shadow_artifact(
                _model_version(stage="ARCHIVED"),
                {},
                instrument_symbol="NIFTYBEES",
                timeframe="1m",
                allow_archived_shadow_member=True,
            )
        self.assertNotIn("PRODUCTION or enrolled", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
