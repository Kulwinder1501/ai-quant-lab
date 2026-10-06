"""Temporal occlusion explanations for the causal TCN.

Workstream F forbids calling convolution weights "feature importance." Occlusion
attributes both feature channels and time regions by measuring the drop in the
selected-class logit when a contiguous lag window is zeroed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .contracts import LabelAlphabet
from .sequences import SequenceExample
from .tcn_model import TEMPORAL_OCCLUSION_METHOD, require_torch
from .tcn_training import predict_tcn_proba


def temporal_occlusion_contributions(
    model: Any,
    sequence: SequenceExample,
    *,
    medians: Sequence[float],
    alphabet: LabelAlphabet,
    window: int = 4,
    predicted_label: str | None = None,
) -> dict[str, Any]:
    """Explain one sequence by occluding contiguous lag blocks.

    Returns the predicted label, class probabilities, and per-block logit drops
    sorted by absolute impact. Sanity: randomizing the model weights should
    collapse these drops toward zero — callers assert that in tests.
    """

    torch = require_torch()
    probs = predict_tcn_proba(model, [sequence], medians=medians, alphabet=alphabet)[0]
    label = predicted_label or max(probs, key=probs.get)
    class_index = list(alphabet.labels).index(label)

    def logit_for(features: list[list[float]]) -> float:
        x = torch.tensor([features], dtype=torch.float32)
        model.eval()
        with torch.no_grad():
            logits = model(x)[0]
        return float(logits[class_index].item())

    baseline_features: list[list[float]] = []
    for row in sequence.features:
        baseline_features.append([
            float(medians[i]) if not _finite(value) else float(value)
            for i, value in enumerate(row)
        ])
    baseline = logit_for(baseline_features)

    lookback = sequence.lookback
    blocks: list[dict[str, Any]] = []
    for start in range(0, lookback, window):
        end = min(lookback, start + window)
        occluded = [list(row) for row in baseline_features]
        for index in range(start, end):
            occluded[index] = [0.0] * len(sequence.feature_names)
        drop = baseline - logit_for(occluded)
        # lag-from-decision: 0 is the decision bar.
        lag_start = lookback - end
        lag_end = lookback - start - 1
        blocks.append({
            "lagStart": lag_start,
            "lagEnd": lag_end,
            "logitDrop": drop,
            "supportsPredictedClass": drop > 0,
        })

    blocks.sort(key=lambda item: (-abs(float(item["logitDrop"])), int(item["lagStart"])))
    return {
        "contributionMethod": TEMPORAL_OCCLUSION_METHOD,
        "prediction": label,
        "classProbabilities": probs,
        "baselineLogit": baseline,
        "occlusionWindow": window,
        "blocks": blocks,
    }


def _finite(value: Any) -> bool:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return False
    return parsed == parsed and abs(parsed) != float("inf")


__all__ = ["temporal_occlusion_contributions"]
