from __future__ import annotations

import pickle
import tempfile
import unittest
from pathlib import Path

from ai_quant_lab_ml.artifacts import (
    ArtifactIntegrityError,
    compute_artifact_checksum,
    load_model_artifact,
    resolve_artifact_path,
    write_model_artifact,
)


class ModelArtifactTests(unittest.TestCase):
    def test_round_trip_preserves_model_metadata_and_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "baseline.pkl"
            written = write_model_artifact(path, model={"weights": [1, 2]}, metadata={"featureSchema": ["x"], "run": 7})

            loaded = load_model_artifact(path, expected_checksum=written.checksum.upper())

            self.assertEqual(loaded.checksum, written.checksum)
            self.assertEqual(loaded.model, {"weights": [1, 2]})
            self.assertEqual(dict(loaded.metadata), {"featureSchema": ["x"], "run": 7})

    def test_predicted_checksum_matches_the_written_artifact(self) -> None:
        # A content-addressed destination filename (e.g. register_sequence_shadow.py's
        # shadow path) must be derivable before writing, and must agree with what
        # write_model_artifact actually records -- otherwise two different artifacts
        # could still collide on the same predicted name.
        model = {"weights": [3, 4]}
        metadata = {"featureSchema": ["x", "y"], "run": 9}
        predicted = compute_artifact_checksum(model=model, metadata=metadata)

        with tempfile.TemporaryDirectory() as directory:
            written = write_model_artifact(Path(directory) / "artifact.pkl", model=model, metadata=metadata)

        self.assertEqual(predicted, written.checksum)

    def test_predicted_checksum_differs_for_different_metadata(self) -> None:
        model = {"weights": [1]}
        first = compute_artifact_checksum(model=model, metadata={"run": 1})
        second = compute_artifact_checksum(model=model, metadata={"run": 2})

        self.assertNotEqual(first, second)

    def test_detects_payload_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "baseline.pkl"
            write_model_artifact(path, model={"weights": [1]}, metadata={})
            envelope = pickle.loads(path.read_bytes())
            envelope["payload"] = b"tampered"
            path.write_bytes(pickle.dumps(envelope, protocol=pickle.HIGHEST_PROTOCOL))

            with self.assertRaises(ArtifactIntegrityError):
                load_model_artifact(path)


if __name__ == "__main__":
    unittest.main()


class ResolveArtifactPathTests(unittest.TestCase):
    r"""Translating a stored artifact path into the local environment's path.

    ``model_versions.artifact_uri`` holds the absolute path of whichever environment wrote
    it, and this project trains from two: the host writes
    ``C:\...\AI Quant Lab\models\...`` and the container writes ``/app/models/...``.
    Neither exists in the other, so a container-trained model was unloadable on the host --
    seen as "Could not read a valid pickle artifact from \app\models\..." during a host-run
    shadow-prediction pass, which silently skipped every container-trained model.

    The stored row is deliberately not rewritten: it is a true statement about where that
    artifact was written, and the checksum already guarantees the content is right wherever
    it is found. Translation happens at load time instead.
    """

    def test_an_existing_path_is_returned_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            target = root / "some-key" / "artifact.pkl"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x")

            self.assertEqual(resolve_artifact_path(target, artifact_root=root), target)

    def test_a_foreign_absolute_path_is_rerooted_onto_the_local_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            target = root / "some-key" / "artifact.pkl"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x")

            # What a container-trained row looks like on the host.
            self.assertEqual(
                resolve_artifact_path("/app/models/some-key/artifact.pkl", artifact_root=root),
                target,
            )

    def test_a_windows_stored_path_reroots_under_posix_semantics(self) -> None:
        # A Windows path string does not split into parts under PosixPath, so separators
        # are normalised by hand. Without that, a host-written row is unloadable in the
        # container -- the same bug in the opposite direction.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            target = root / "some-key" / "artifact.pkl"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x")

            stored = r"C:\Users\someone\AI Quant Lab\models\some-key\artifact.pkl"
            self.assertEqual(resolve_artifact_path(stored, artifact_root=root), target)

    def test_the_final_models_segment_wins(self) -> None:
        # A checkout could itself live under a directory called "models"; the artifact's
        # own location is the tail after the *last* such segment.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            target = root / "key" / "a.pkl"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"x")

            stored = "/srv/models/checkout/models/key/a.pkl"
            self.assertEqual(resolve_artifact_path(stored, artifact_root=root), target)

    def test_an_unresolvable_path_comes_back_unchanged(self) -> None:
        # So the failure message names what the database actually said, which is the more
        # useful diagnostic than a rewritten path nobody recorded.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            root.mkdir(parents=True)
            stored = "/app/models/absent/nope.pkl"

            self.assertEqual(str(resolve_artifact_path(stored, artifact_root=root)), str(Path(stored)))

    def test_loading_uses_the_resolver(self) -> None:
        # The single load point, so every caller inherits the translation.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "models"
            target = root / "key" / "written.pkl"
            target.parent.mkdir(parents=True)
            written = write_model_artifact(target, model={"a": 1}, metadata={"modelKey": "key"})

            loaded = load_model_artifact(
                resolve_artifact_path("/app/models/key/written.pkl", artifact_root=root),
                expected_checksum=written.checksum,
            )
            self.assertEqual(loaded.metadata["modelKey"], "key")
