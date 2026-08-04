"""Local pickle artifacts with checksums and immutable metadata envelopes."""

from __future__ import annotations

import hashlib
import os
import pickle
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ARTIFACT_FORMAT_VERSION = "ai-quant-lab-pickle-v1"

# apps/ml/ai_quant_lab_ml/artifacts.py -> parents[3] is the repo root. Note this is one
# deeper than train.py, whose ROOT_DIRECTORY uses parents[2] from apps/ml/train.py; both
# must land on the same directory or the two sides disagree on where artifacts live.
_REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ARTIFACT_ROOT = _REPO_ROOT / "models"

#: The directory name every artifact path contains, used to re-root a stored path that
#: was written under a different mount.
_ARTIFACT_ROOT_SEGMENT = "models"


def resolve_artifact_path(path: str | Path, *, artifact_root: Path | None = None) -> Path:
    r"""Resolve a stored artifact path against the local artifact root.

    ``model_versions.artifact_uri`` holds the absolute path of whichever environment
    wrote it, and this project trains from two: the host writes
    ``C:\...\AI Quant Lab\models\...`` and the container writes ``/app/models/...``.
    Neither path exists in the other environment, so a model trained in one was
    unloadable in the other -- observed as "Could not read a valid pickle artifact from
    pp\models\..." during a host-run shadow-prediction pass, which silently skipped
    every container-trained model.

    Rewriting the stored rows was rejected: the path recorded is a true statement about
    where that artifact was written, and the checksum already guarantees the *content*
    is the right one wherever it is found. So the stored value is left alone and
    translated at load time.

    The stored path wins when it exists, which keeps the common case exact. Otherwise
    the portion after the final ``models`` segment is re-joined onto the local root.
    Separators are normalised by hand because a Windows path string does not split into
    parts under ``PosixPath`` and vice versa.
    """

    candidate = Path(path)
    if candidate.exists():
        return candidate

    root = artifact_root if artifact_root is not None else DEFAULT_ARTIFACT_ROOT
    segments = [part for part in str(path).replace("\\", "/").split("/") if part]
    if _ARTIFACT_ROOT_SEGMENT in segments:
        # The last occurrence: a repository checkout could itself sit under a directory
        # called "models", and the tail after the *final* one is the artifact's own
        # relative location.
        tail = segments[len(segments) - 1 - segments[::-1].index(_ARTIFACT_ROOT_SEGMENT) + 1:]
        if tail:
            rerooted = root.joinpath(*tail)
            if rerooted.exists():
                return rerooted
    # Nothing readable. Returning the original keeps the error message pointing at what
    # the database actually says, which is the more useful diagnostic.
    return candidate


class ArtifactError(ValueError):
    """Raised when an artifact cannot be serialized or parsed."""


class ArtifactIntegrityError(ArtifactError):
    """Raised when an artifact's SHA-256 checksum does not match its payload."""


@dataclass(frozen=True)
class WrittenModelArtifact:
    path: Path
    checksum: str
    metadata: Mapping[str, Any]


@dataclass(frozen=True)
class LoadedModelArtifact:
    path: Path
    checksum: str
    model: Any
    metadata: Mapping[str, Any]


def sha256_bytes(payload: bytes) -> str:
    """Return a lower-case SHA-256 digest for an artifact payload."""

    return hashlib.sha256(payload).hexdigest()


def write_model_artifact(
    path: str | Path,
    *,
    model: Any,
    metadata: Mapping[str, Any],
) -> WrittenModelArtifact:
    """Atomically write a local model artifact and return its file checksum.

    Metadata lives inside the checksummed payload so the feature schema,
    training configuration, and metrics cannot silently drift from the model.
    The checksum detects accidental damage; as with all pickle files, callers
    must load only artifacts from a trusted local source.
    """

    destination = Path(path)
    if not destination.name:
        raise ArtifactError("An artifact file path is required.")
    try:
        payload = pickle.dumps(
            {
                "model": model,
                "metadata": dict(metadata),
            },
            protocol=pickle.HIGHEST_PROTOCOL,
        )
    except (pickle.PickleError, TypeError, AttributeError) as error:
        raise ArtifactError("The supplied model or metadata could not be pickled.") from error

    payload_checksum = sha256_bytes(payload)
    envelope = {
        "format": ARTIFACT_FORMAT_VERSION,
        "payload": payload,
        "payloadSha256": payload_checksum,
    }
    try:
        serialized_envelope = pickle.dumps(envelope, protocol=pickle.HIGHEST_PROTOCOL)
    except (pickle.PickleError, TypeError, AttributeError) as error:  # pragma: no cover - payload is already pickled
        raise ArtifactError("The artifact envelope could not be serialized.") from error

    # Persist the hash of the bytes on disk.  That is the checksum recorded on
    # model_versions and therefore catches any file-level modification.
    artifact_checksum = sha256_bytes(serialized_envelope)

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", delete=False, dir=destination.parent, prefix=f".{destination.name}.") as temporary_file:
            temporary_path = Path(temporary_file.name)
            temporary_file.write(serialized_envelope)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, destination)
    except OSError as error:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise ArtifactError(f"Could not write artifact to {destination}.") from error

    return WrittenModelArtifact(path=destination, checksum=artifact_checksum, metadata=dict(metadata))


def load_model_artifact(
    path: str | Path,
    *,
    expected_checksum: str | None = None,
) -> LoadedModelArtifact:
    """Load and validate an artifact written by :func:`write_model_artifact`.

    ``expected_checksum`` should normally be the checksum persisted with the
    model version in PostgreSQL.  It adds an external integrity boundary in
    addition to validating the checksum stored in the artifact envelope.
    """

    source = resolve_artifact_path(path)
    try:
        serialized_envelope = source.read_bytes()
        envelope = pickle.loads(serialized_envelope)
    except (OSError, EOFError, pickle.UnpicklingError, AttributeError, ImportError, IndexError) as error:
        raise ArtifactError(f"Could not read a valid pickle artifact from {source}.") from error

    if not isinstance(envelope, dict) or envelope.get("format") != ARTIFACT_FORMAT_VERSION:
        raise ArtifactError("Unsupported or malformed model artifact format.")
    payload = envelope.get("payload")
    stored_payload_checksum = envelope.get("payloadSha256")
    if not isinstance(payload, bytes) or not isinstance(stored_payload_checksum, str):
        raise ArtifactError("Model artifact is missing its payload or checksum.")

    actual_payload_checksum = sha256_bytes(payload)
    if actual_payload_checksum != stored_payload_checksum:
        raise ArtifactIntegrityError("Artifact payload checksum does not match the stored SHA-256 digest.")
    artifact_checksum = sha256_bytes(serialized_envelope)
    if expected_checksum is not None and artifact_checksum != expected_checksum.lower():
        raise ArtifactIntegrityError("Artifact file checksum does not match the expected SHA-256 digest.")

    try:
        contents = pickle.loads(payload)
    except (EOFError, pickle.UnpicklingError, AttributeError, ImportError, IndexError) as error:
        raise ArtifactError("Artifact payload could not be unpickled.") from error
    if not isinstance(contents, dict) or "model" not in contents or not isinstance(contents.get("metadata"), Mapping):
        raise ArtifactError("Model artifact payload is missing its model or metadata.")

    return LoadedModelArtifact(
        path=source,
        checksum=artifact_checksum,
        model=contents["model"],
        metadata=dict(contents["metadata"]),
    )


__all__ = [
    "ARTIFACT_FORMAT_VERSION",
    "ArtifactError",
    "ArtifactIntegrityError",
    "LoadedModelArtifact",
    "WrittenModelArtifact",
    "load_model_artifact",
    "sha256_bytes",
    "write_model_artifact",
]
