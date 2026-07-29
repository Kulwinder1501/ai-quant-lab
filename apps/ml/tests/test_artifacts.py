from __future__ import annotations

import pickle
import tempfile
import unittest
from pathlib import Path

from ai_quant_lab_ml.artifacts import ArtifactIntegrityError, load_model_artifact, write_model_artifact


class ModelArtifactTests(unittest.TestCase):
    def test_round_trip_preserves_model_metadata_and_checksum(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "baseline.pkl"
            written = write_model_artifact(path, model={"weights": [1, 2]}, metadata={"featureSchema": ["x"], "run": 7})

            loaded = load_model_artifact(path, expected_checksum=written.checksum.upper())

            self.assertEqual(loaded.checksum, written.checksum)
            self.assertEqual(loaded.model, {"weights": [1, 2]})
            self.assertEqual(dict(loaded.metadata), {"featureSchema": ["x"], "run": 7})

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
