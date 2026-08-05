"""Register Stage 5/6 sequence research artifacts as shadow CANDIDATEs.

Does not enroll them in the EOD train loop. Rewrites artifact metadata with the
settlement/inference fields the shadow path requires, then inserts a
``model_versions`` CANDIDATE row so ``--shadow-scheme volatility-expansion-v1``
picks them up.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from ai_quant_lab_ml.artifacts import compute_artifact_checksum, load_model_artifact, write_model_artifact
from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION_SCALP,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
)
from ai_quant_lab_ml.features import feature_definition, feature_schema
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from ai_quant_lab_ml.sequence_inference import SEQUENCE_SHADOW_ALGORITHMS
from train import feature_schema_rows, json_output


ROOT = Path(__file__).resolve().parents[2]


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Register a TCN/stack artifact for volatility shadow scoring.")
    parser.add_argument("--artifact", type=Path, required=True, help="Path to an existing research .pkl artifact.")
    parser.add_argument("--database-url")
    parser.add_argument(
        "--rewrite-in-place",
        action="store_true",
        help="Overwrite the artifact with enriched metadata (default: write a sibling *-shadow.pkl).",
    )
    return parser


def _enrich_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    algorithm = metadata.get("algorithm")
    if algorithm not in SEQUENCE_SHADOW_ALGORITHMS:
        raise ValueError(f"Artifact algorithm {algorithm!r} is not a sequence shadow family.")

    schema_version = metadata.get("featureSchemaVersion") or FEATURE_SCHEMA_VERSION_SCALP
    schema = list(metadata.get("featureSchema") or feature_schema(schema_version))
    protocol = dict(metadata.get("validationProtocol") or {})
    dataset = dict(metadata.get("dataset") or {})
    hyperparameters = dict(metadata.get("hyperparameters") or {})

    lookback = metadata.get("lookback") or protocol.get("lookback") or hyperparameters.get("lookback")
    if lookback is None:
        raise ValueError("Artifact is missing lookback.")

    # Infer training windows from walk-forward / outer-fold summaries when present.
    folds = protocol.get("walkForward") or protocol.get("outerFolds") or []
    trained_at = metadata.get("trainedAt") or datetime.now(timezone.utc).isoformat()
    data_cutoff = protocol.get("dataCutoffAt")
    if not data_cutoff:
        # Research runs used 2026-08-04T05:00:00Z; prefer trainedAt if absent.
        data_cutoff = trained_at

    # Research runs used 2026-01-01 → 2026-07-31 with cutoff 2026-08-04T05:00Z.
    # Label availability must be strictly after the last training source bar
    # (horizon bars later); dataCutoffAt is the immutable experiment cutoff.
    if "trainingSourceWindow" not in protocol:
        protocol["trainingSourceWindow"] = {
            "start": protocol.get("dataWindowStart") or "2026-01-01T00:00:00+00:00",
            "end": protocol.get("dataWindowEnd") or "2026-07-31T10:00:00+00:00",
        }
    source_end = _parse_iso(protocol["trainingSourceWindow"]["end"])
    if "trainingLabelAvailableEnd" not in protocol:
        horizon = int(protocol.get("horizonBars") or 5)
        protocol["trainingLabelAvailableEnd"] = (
            source_end + __import__("datetime").timedelta(minutes=horizon)
        ).isoformat()
    label_end = _parse_iso(protocol["trainingLabelAvailableEnd"])
    if label_end <= source_end:
        horizon = int(protocol.get("horizonBars") or 5)
        protocol["trainingLabelAvailableEnd"] = (
            source_end + __import__("datetime").timedelta(minutes=horizon)
        ).isoformat()
    if "dataCutoffAt" not in protocol:
        protocol["dataCutoffAt"] = data_cutoff if data_cutoff != trained_at else "2026-08-04T05:00:00+00:00"
    if "dataWindowStart" not in protocol:
        protocol["dataWindowStart"] = protocol["trainingSourceWindow"]["start"]
    if "dataWindowEnd" not in protocol:
        protocol["dataWindowEnd"] = protocol["trainingSourceWindow"]["end"]

    protocol.setdefault("labelScheme", LABEL_SCHEME_VOLATILITY_EXPANSION)
    protocol.setdefault("horizonBars", 5)
    protocol.setdefault("expansionBand", 0.25)
    protocol.setdefault("neutralThresholdBps", 0.0)
    protocol.setdefault("lookback", int(lookback))
    protocol.setdefault("indicatorAlgorithmVersion", "ta-v1")
    protocol.setdefault("patternAlgorithmVersion", "candlestick-v1")
    protocol.setdefault("priceActionAlgorithmVersion", "price-action-v2")
    protocol.setdefault("shadowEnrollment", True)
    protocol.setdefault("eodTrainLoop", False)

    enriched = dict(metadata)
    enriched["featureSchemaVersion"] = schema_version
    enriched["featureSchema"] = schema
    enriched["featureDefinition"] = feature_definition(schema_version)
    enriched["lookback"] = int(lookback)
    enriched["validationProtocol"] = protocol
    enriched["dataset"] = dataset
    enriched["hyperparameters"] = hyperparameters
    if "validationMetrics" not in enriched:
        if "holdoutMetrics" in enriched:
            enriched["validationMetrics"] = enriched["holdoutMetrics"]
        elif folds:
            # Use the last fold's TCN metrics as a coarse validation block for TCN.
            last = folds[-1]
            if isinstance(last, dict) and "tcn" in last:
                enriched["validationMetrics"] = last["tcn"]
            elif isinstance(last, dict) and "tcnMacroF1" in last:
                enriched["validationMetrics"] = {"macroF1": last["tcnMacroF1"]}
            else:
                enriched["validationMetrics"] = {"macroF1": None}
        else:
            enriched["validationMetrics"] = {"macroF1": None}
    enriched["enrollment"] = {
        **dict(enriched.get("enrollment") or {}),
        "eod": False,
        "shadow": True,
        "reason": "Registered for volatility-expansion shadow scoring; not in EOD train loop.",
    }
    return enriched


def main(argv: list[str] | None = None) -> int:
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT / "apps" / "ml" / ".env", override=False)
    parser = build_parser()
    args = parser.parse_args(argv)

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required.")

    source = Path(args.artifact)
    if not source.is_file():
        parser.error(f"Artifact not found: {source}")

    loaded = load_model_artifact(source)
    try:
        enriched = _enrich_metadata(dict(loaded.metadata))
    except ValueError as error:
        json_output({"level": "error", "message": str(error)})
        return 1

    if args.rewrite_in_place:
        dest = source
    else:
        # Content-addressed, not a fixed "-shadow.pkl" suffix: two different
        # underlying artifacts registered from the same source stem must never
        # collide on one filename and silently overwrite each other's bytes
        # (observed previously: a later registration overwrote an earlier
        # version's shadow artifact while both model_versions rows kept
        # pointing at the same now-wrong path). Re-registering identical
        # content is still idempotent, since the same bytes hash to the same
        # name.
        predicted_checksum = compute_artifact_checksum(model=loaded.model, metadata=enriched)
        dest = source.with_name(f"{source.stem}-shadow-{predicted_checksum[:16]}.pkl")

    written = write_model_artifact(dest, model=loaded.model, metadata=enriched)
    schema_version = enriched["featureSchemaVersion"]
    protocol = enriched["validationProtocol"]
    training_start = datetime.fromisoformat(
        protocol["trainingSourceWindow"]["start"].replace("Z", "+00:00")
    )
    training_end = datetime.fromisoformat(
        protocol["trainingSourceWindow"]["end"].replace("Z", "+00:00")
    )
    trained_at = datetime.fromisoformat(str(enriched.get("trainedAt", datetime.now(timezone.utc).isoformat())).replace("Z", "+00:00"))

    try:
        import psycopg
    except ImportError:
        parser.error("psycopg is required.")
        return 1

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        candidate = repository.create_candidate_model(
            model_key=str(enriched["modelKey"]),
            algorithm=str(enriched["algorithm"]),
            artifact_uri=str(written.path.resolve()),
            artifact_checksum=written.checksum,
            feature_schema=feature_schema_rows(enriched["featureSchema"], schema_version),
            training_window_start=training_start,
            training_window_end=training_end,
            training_rows=int(
                (enriched.get("dataset") or {}).get("sequenceRows")
                or (enriched.get("dataset") or {}).get("labeledRows")
                or 1
            ),
            validation_metrics={
                **dict(enriched.get("validationMetrics") or {}),
                "validationProtocol": protocol,
                "enrollment": enriched.get("enrollment"),
            },
            trained_at=trained_at,
        )

        # Sticky, one-shot enrollment: only a research run that actually cleared
        # Stage 5/6 acceptance (beat trivial/lag-baseline or best-base, per fold)
        # is eligible, and a model key that already holds an enrollment keeps the
        # version it was first enrolled with -- a later qualifying re-registration
        # of the same key must not reset its evidence clock.
        research_advances = bool(protocol.get("researchAdvances"))
        volatility_shadow_enrolled = research_advances and repository.enroll_volatility_shadow(
            label_scheme=str(protocol["labelScheme"]),
            model_key=str(enriched["modelKey"]),
            model_version_id=candidate.id,
        )

    json_output({
        "level": "info",
        "message": "Sequence shadow candidate registered",
        "algorithm": enriched["algorithm"],
        "modelKey": enriched["modelKey"],
        "modelVersionId": candidate.id,
        "version": candidate.version,
        "stage": candidate.stage,
        "researchAdvances": research_advances,
        "volatilityShadowEnrolled": volatility_shadow_enrolled,
        "artifactPath": str(written.path),
        "artifactChecksum": written.checksum,
        "eodTrainLoop": False,
        "shadowScheme": LABEL_SCHEME_VOLATILITY_EXPANSION,
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
