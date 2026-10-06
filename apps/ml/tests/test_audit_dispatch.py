from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

import audit
from ai_quant_lab_ml.contracts import (
    LABEL_SCHEME_FIXED_HORIZON,
    LABEL_SCHEME_TRIPLE_BARRIER,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
)


class AuditLabelDispatchTests(unittest.TestCase):
    def test_uses_triple_barrier_builder_for_triple_barrier_request(self) -> None:
        request = SimpleNamespace(label_scheme=LABEL_SCHEME_TRIPLE_BARRIER)
        with patch.object(audit, "build_triple_barrier_examples", return_value=["triple"]) as builder:
            result = audit.build_audit_examples([], request)  # type: ignore[arg-type]

        self.assertEqual(result, ["triple"])
        builder.assert_called_once_with([], request)

    def test_keeps_each_other_scheme_on_its_own_builder(self) -> None:
        volatility = SimpleNamespace(label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION)
        directional = SimpleNamespace(label_scheme=LABEL_SCHEME_FIXED_HORIZON)
        with (
            patch.object(audit, "build_volatility_expansion_examples", return_value=["volatility"]),
            patch.object(audit, "build_labeled_examples", return_value=["directional"]),
        ):
            self.assertEqual(
                audit.build_audit_examples([], volatility),  # type: ignore[arg-type]
                ["volatility"],
            )
            self.assertEqual(
                audit.build_audit_examples([], directional),  # type: ignore[arg-type]
                ["directional"],
            )


if __name__ == "__main__":
    unittest.main()
