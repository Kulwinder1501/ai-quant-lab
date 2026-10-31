from __future__ import annotations

import os
import re
import sys
import unittest
from pathlib import Path

from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION,
    FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4,
    KNOWN_FEATURE_SCHEMA_VERSIONS,
    LEGACY_EVIDENCE_ALGORITHM_VERSIONS,
    evidence_versions_for,
)
from ai_quant_lab_ml.features import feature_definition, feature_schema

# abspath, not resolve(): resolve() expands a short or aliased path to its long form, which on Windows can pass the 260-character limit
REPOSITORY_ROOT = Path(os.path.abspath(__file__)).parents[3]
DETECTOR_CONSTANTS = REPOSITORY_ROOT / "apps/api/src/modules/pattern-recognition/domain/market-pattern.ts"


def versions_detection_writes_today() -> tuple[str, str]:
    """Read the two constants from the TypeScript detector, so the pins here cannot drift from it unnoticed."""

    text = DETECTOR_CONSTANTS.read_text(encoding="utf-8")
    pattern = re.search(r'export const candlestickAlgorithmVersion = "([^"]+)"', text)
    price_action = re.search(r'export const priceActionAlgorithmVersion = "([^"]+)"', text)
    assert pattern and price_action, f"could not read the current versions from {DETECTOR_CONSTANTS}"
    return pattern.group(1), price_action.group(1)


class EvidenceV4SchemaTest(unittest.TestCase):
    def test_every_existing_schema_keeps_the_pins_its_stored_artifacts_recorded(self) -> None:
        # Inference rejects an artifact whose stored feature definition differs from the one built here, so changing what
        # an existing schema pins would make every model already registered under it unusable.
        for version in KNOWN_FEATURE_SCHEMA_VERSIONS:
            if version == FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4:
                continue
            definition = feature_definition(version)
            self.assertEqual(
                (definition["patternAlgorithmVersion"], definition["priceActionAlgorithmVersion"]),
                ("candlestick-v1", "price-action-v2"),
                msg=f"{version} no longer records the legacy evidence versions",
            )
        self.assertEqual(LEGACY_EVIDENCE_ALGORITHM_VERSIONS, ("candlestick-v1", "price-action-v2"))

    def test_new_schema_reads_the_same_columns_as_v7(self) -> None:
        self.assertEqual(feature_schema(FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4), feature_schema(FEATURE_SCHEMA_VERSION))

    def test_new_schema_differs_from_v7_only_in_the_two_pins_and_its_own_name(self) -> None:
        old = feature_definition(FEATURE_SCHEMA_VERSION)
        new = feature_definition(FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4)

        differing = {key for key in old if old[key] != new[key]}

        self.assertEqual(differing, {"schemaVersion", "patternAlgorithmVersion", "priceActionAlgorithmVersion"})

    def test_new_schema_pins_what_detection_writes_today(self) -> None:
        # Fails when the detector moves to a newer version: the answer is another schema version beside this one, never an edit
        # to this one (see contracts.py), so a model trained under it keeps meaning what it was trained on.
        self.assertEqual(evidence_versions_for(FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4), versions_detection_writes_today())
        definition = feature_definition(FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4)
        self.assertEqual(
            (definition["patternAlgorithmVersion"], definition["priceActionAlgorithmVersion"]),
            versions_detection_writes_today(),
        )

    def test_an_unlisted_schema_falls_back_to_the_legacy_pins(self) -> None:
        self.assertEqual(evidence_versions_for("ml-feature-unlisted"), LEGACY_EVIDENCE_ALGORITHM_VERSIONS)


class TrainParserTest(unittest.TestCase):
    def parse(self, *extra: str):
        sys.path.insert(0, str(REPOSITORY_ROOT / "apps/ml"))
        try:
            import train
        finally:
            sys.path.pop(0)
        return train.build_parser().parse_args(
            ["--instrument", "NIFTY50", "--timeframe", "1d", "--from", "2023-01-01", "--to", "2026-01-01", *extra]
        )

    def test_accepts_the_new_schema_and_research_only(self) -> None:
        arguments = self.parse("--feature-schema", FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4, "--research-only")

        self.assertEqual(arguments.feature_schema, FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4)
        self.assertTrue(arguments.research_only)

    def test_research_only_is_off_by_default(self) -> None:
        self.assertFalse(self.parse().research_only)


if __name__ == "__main__":
    unittest.main()
