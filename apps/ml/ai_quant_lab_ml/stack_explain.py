"""Two-layer explanation for the OOF logistic stack.

Layer 1 attributes the meta-learner's decision to base-probability inputs.
Layer 2 links to each base model's native explainer for the same observation.
Never present meta coefficients as original market-feature effects.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from .contracts import LabelAlphabet
from .sequences import SequenceExample
from .stacking import (
    BASE_LAG_LGBM,
    BASE_TCN,
    STACK_CONTRIBUTION_METHOD,
    build_meta_features,
    meta_feature_names,
)
from .tcn_explain import temporal_occlusion_contributions
from .volatility_expansion import VOLATILITY_ALPHABET


def explain_stack_prediction(
    meta_model: Any,
    *,
    sequence: SequenceExample,
    tcn_model: Any,
    tcn_medians: Sequence[float],
    tcn_proba: Mapping[str, float],
    lag_lgbm_proba: Mapping[str, float],
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET,
) -> dict[str, Any]:
    """Return meta-level contributions plus base-layer explanation hooks."""

    feature_names = meta_feature_names(alphabet)
    features = build_meta_features(tcn_proba, lag_lgbm_proba, alphabet=alphabet)
    classes = [str(c) for c in meta_model.classes_]
    proba_raw = meta_model.predict_proba([features])[0]
    stack_proba = {label: 0.0 for label in alphabet.labels}
    for index, label in enumerate(classes):
        stack_proba[label] = float(proba_raw[index])
    prediction = max(stack_proba, key=stack_proba.get)
    class_index = classes.index(prediction)

    intercept = float(meta_model.intercept_[class_index])
    weights = meta_model.coef_[class_index]
    contributions = []
    for name, value, weight in zip(feature_names, features, weights):
        contributions.append({
            "metaFeature": name,
            "value": float(value),
            "coefficient": float(weight),
            "contribution": float(weight) * float(value),
            "source": (
                "tcn_probability" if name.startswith(f"{BASE_TCN}.")
                else "lag_lightgbm_probability" if name.startswith(f"{BASE_LAG_LGBM}.")
                else "disagreement"
            ),
        })
    contributions.sort(key=lambda row: abs(row["contribution"]), reverse=True)

    base_layer = {
        BASE_TCN: temporal_occlusion_contributions(
            tcn_model,
            sequence,
            medians=tcn_medians,
            alphabet=alphabet,
            predicted_label=max(tcn_proba, key=tcn_proba.get),
        ),
        BASE_LAG_LGBM: {
            "contributionMethod": "TREE_SHAP_V1",
            "note": (
                "Lag-LightGBM TreeSHAP is available via the shared inference explainer "
                "on flattened lag features; omitted here to keep the research CLI free of "
                "a second SHAP pass on every sample."
            ),
            "probabilities": dict(lag_lgbm_proba),
            "prediction": max(lag_lgbm_proba, key=lag_lgbm_proba.get),
        },
    }

    return {
        "contributionMethod": STACK_CONTRIBUTION_METHOD,
        "prediction": prediction,
        "probabilities": stack_proba,
        "meta": {
            "intercept": intercept,
            "topContributions": contributions[:8],
            "note": "Meta coefficients weight base probabilities/uncertainty, not raw market features.",
        },
        "baseExplanations": base_layer,
    }


__all__ = ["explain_stack_prediction"]
