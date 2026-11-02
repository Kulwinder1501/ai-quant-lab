"""Reference metadata must keep working when two feature-schema versions share their columns.

``ml-feature-v7-pa4`` is v7's 38 columns under a different definition. A reverse lookup from the
columns to a version returned the later of the two for every v7 artifact, so every model trained on
v7 failed inference with "incompatible feature-schema version" from the 2026-10-31 deploy until it
was found on 2026-11-02. The existing suite passed throughout, because nothing built or parsed
reference metadata for a schema whose columns another version also names.
"""

from __future__ import annotations

import unittest
from datetime import UTC, datetime, timedelta

from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4,
    FEATURE_SCHEMA_VERSION_V7_NO_PATTERN,
    KNOWN_FEATURE_SCHEMA_VERSIONS,
    LabeledExample,
)
from ai_quant_lab_ml.features import feature_schema
from ai_quant_lab_ml.reference_data import (
    ReferenceDataError,
    build_reference_metadata,
    parse_reference_metadata,
)

START = datetime(2024, 1, 2, tzinfo=UTC)
V7 = "ml-feature-v7"
V7_PA4 = FEATURE_SCHEMA_VERSION_V7_EVIDENCE_V4


def examples_for(version: str) -> list[LabeledExample]:
    names = feature_schema(version)
    labels = ("BULLISH", "BEARISH", "NEUTRAL")
    rows = []
    for index in range(12):
        observed_at = START + timedelta(days=index)
        rows.append(
            LabeledExample(
                candle_id=f"candle-{index}",
                instrument_id="instrument-1",
                symbol="NIFTY50",
                timeframe="1d",
                observed_at=observed_at,
                label_available_at=observed_at + timedelta(days=2),
                forward_return=0.01,
                label=labels[index % 3],  # type: ignore[arg-type]
                features={name: float(index) for name in names},  # type: ignore[arg-type]
            )
        )
    return rows


def versions_sharing_columns() -> list[tuple[str, ...]]:
    groups: dict[tuple[str, ...], list[str]] = {}
    for version in KNOWN_FEATURE_SCHEMA_VERSIONS:
        groups.setdefault(tuple(feature_schema(version)), []).append(version)
    return [tuple(group) for group in groups.values() if len(group) > 1]


class ReferenceSchemaVersionTests(unittest.TestCase):
    def test_the_collision_this_guards_against_exists(self) -> None:
        # If this stops being true the rest is still correct, but it is no longer exercising the case.
        self.assertEqual(tuple(feature_schema(V7)), tuple(feature_schema(V7_PA4)))
        self.assertIn((V7, V7_PA4), versions_sharing_columns())

    def test_every_known_version_round_trips_under_its_own_name(self) -> None:
        for version in KNOWN_FEATURE_SCHEMA_VERSIONS:
            with self.subTest(version=version):
                schema = feature_schema(version)
                metadata = build_reference_metadata(
                    examples_for(version), schema=schema, schema_version=version
                )
                self.assertEqual(metadata["featureSchemaVersion"], version)
                parsed = parse_reference_metadata(metadata, expected_schema=schema, schema_version=version)
                self.assertEqual(parsed.feature_schema, tuple(schema))
                # Without a version, any version naming these columns is accepted.
                parse_reference_metadata(metadata, expected_schema=schema)

    def test_a_v7_artifact_is_read_as_v7_although_pa4_has_the_same_columns(self) -> None:
        schema = feature_schema(V7)
        metadata = build_reference_metadata(examples_for(V7), schema=schema, schema_version=V7)
        self.assertEqual(metadata["featureSchemaVersion"], V7)

        parsed = parse_reference_metadata(metadata, expected_schema=schema, schema_version=V7)

        self.assertEqual(len(parsed.examples), 12)

    def test_a_pa4_artifact_is_read_as_pa4(self) -> None:
        schema = feature_schema(V7_PA4)
        metadata = build_reference_metadata(examples_for(V7_PA4), schema=schema, schema_version=V7_PA4)
        self.assertEqual(metadata["featureSchemaVersion"], V7_PA4)

        parse_reference_metadata(metadata, expected_schema=schema, schema_version=V7_PA4)

    def test_a_declared_version_that_differs_from_the_requested_one_is_rejected(self) -> None:
        schema = feature_schema(V7)
        v7_metadata = build_reference_metadata(examples_for(V7), schema=schema, schema_version=V7)
        pa4_metadata = build_reference_metadata(examples_for(V7_PA4), schema=schema, schema_version=V7_PA4)

        with self.assertRaisesRegex(ReferenceDataError, "incompatible feature-schema version"):
            parse_reference_metadata(v7_metadata, expected_schema=schema, schema_version=V7_PA4)
        with self.assertRaisesRegex(ReferenceDataError, "incompatible feature-schema version"):
            parse_reference_metadata(pa4_metadata, expected_schema=schema, schema_version=V7)

    def test_a_version_that_names_other_columns_is_rejected(self) -> None:
        schema = feature_schema(V7)

        with self.assertRaisesRegex(ReferenceDataError, "does not name the selected feature schema"):
            build_reference_metadata(
                examples_for(V7), schema=schema, schema_version=FEATURE_SCHEMA_VERSION_V7_NO_PATTERN
            )

    def test_without_a_version_the_first_registered_one_is_written(self) -> None:
        # What every artifact written before a second version existed carries.
        schema = feature_schema(V7)

        metadata = build_reference_metadata(examples_for(V7), schema=schema)

        self.assertEqual(metadata["featureSchemaVersion"], V7)

    def test_metadata_declaring_an_unknown_version_is_still_rejected(self) -> None:
        schema = feature_schema(V7)
        metadata = build_reference_metadata(examples_for(V7), schema=schema, schema_version=V7)
        metadata["featureSchemaVersion"] = "ml-feature-not-a-version"

        with self.assertRaisesRegex(ReferenceDataError, "incompatible feature-schema version"):
            parse_reference_metadata(metadata, expected_schema=schema)
        with self.assertRaisesRegex(ReferenceDataError, "incompatible feature-schema version"):
            parse_reference_metadata(metadata, expected_schema=schema, schema_version=V7)


if __name__ == "__main__":
    unittest.main()
