"""A picklable label-encoding classifier wrapper for gradient-boosting models.

XGBoost refuses a non-numeric target: ``XGBClassifier.fit`` requires classes
encoded as contiguous integers starting at zero.  The rest of this workspace —
``predict_labels``, the promotion gate, and the Phase 11 explainers — reads and
writes the fixed ``BEARISH``/``NEUTRAL``/``BULLISH`` strings instead.

This wrapper keeps both contracts true at once.  It encodes the target only for
the wrapped estimator and decodes every prediction back to a label string, so a
boosted artifact is a drop-in replacement for the logistic baseline everywhere
a pipeline is loaded.  It is defined at module level, and holds no library
import of its own, so a pickled artifact unpickles from this package alone.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .contracts import LABELS, MarketLabel


class LabelEncodingError(ValueError):
    """Raised when a target cannot be encoded into the fixed label space."""


class LabelEncodedClassifier:
    """Wrap a numeric-target classifier behind the fixed market-label space.

    ``classes_`` follows the sklearn convention: it is the ordered list of label
    strings whose position matches the column order of :meth:`predict_proba`.
    Only labels actually present in the training partition are encoded, and they
    keep the canonical :data:`LABELS` order so a two-class training fold still
    produces the contiguous ``0..k-1`` codes XGBoost requires.
    """

    # scikit-learn reads this marker instead of isinstance checks when a
    # duck-typed estimator is the final step of a pipeline.
    _estimator_type = "classifier"

    def __init__(self, estimator: Any, *, labels: Sequence[MarketLabel] = LABELS) -> None:
        self.estimator = estimator
        self.labels = tuple(labels)
        self.classes_: tuple[MarketLabel, ...] = ()

    def get_params(self, deep: bool = True) -> dict[str, Any]:
        """Support ``repr`` and any caller that inspects pipeline parameters."""

        parameters: dict[str, Any] = {"estimator": self.estimator, "labels": self.labels}
        if deep and hasattr(self.estimator, "get_params"):
            for name, value in self.estimator.get_params(deep=True).items():
                parameters[f"estimator__{name}"] = value
        return parameters

    def set_params(self, **parameters: Any) -> LabelEncodedClassifier:
        nested: dict[str, Any] = {}
        for name, value in parameters.items():
            if name == "estimator":
                self.estimator = value
            elif name == "labels":
                self.labels = tuple(value)
            elif name.startswith("estimator__"):
                nested[name.removeprefix("estimator__")] = value
            else:
                raise LabelEncodingError(f"Unknown parameter {name!r}.")
        if nested:
            self.estimator.set_params(**nested)
        return self

    def __sklearn_tags__(self) -> Any:
        """Expose the wrapped estimator's capability tags (scikit-learn >= 1.6).

        Pipeline dispatch reads these tags before delegating ``predict``. The
        wrapped model is the one doing the actual estimating, so its own tags are
        the truthful answer; the fallback only covers an estimator that predates
        the tag protocol.
        """

        delegated = getattr(self.estimator, "__sklearn_tags__", None)
        if callable(delegated):
            return delegated()
        from sklearn.base import BaseEstimator, ClassifierMixin

        class _DefaultClassifier(ClassifierMixin, BaseEstimator):
            pass

        return _DefaultClassifier().__sklearn_tags__()

    def _encode(self, y: Sequence[Any], classes: Sequence[MarketLabel]) -> list[int]:
        index_by_label = {label: index for index, label in enumerate(classes)}
        codes: list[int] = []
        for value in y:
            label = str(value)
            if label not in index_by_label:
                raise LabelEncodingError(f"Label {label!r} is outside the fitted label space.")
            codes.append(index_by_label[label])
        return codes

    def fit(self, X: Any, y: Sequence[Any], **fit_parameters: Any) -> LabelEncodedClassifier:
        observed = {str(value) for value in y}
        unknown = observed.difference(self.labels)
        if unknown:
            raise LabelEncodingError(f"Labels {sorted(unknown)!r} are outside the fixed market-label space.")
        classes = tuple(label for label in self.labels if label in observed)
        if len(classes) < 2:
            raise LabelEncodingError("At least two distinct labels are required to fit a classifier.")
        self.classes_ = classes
        self.estimator.fit(X, self._encode(y, classes), **fit_parameters)
        return self

    def _require_fitted(self) -> tuple[MarketLabel, ...]:
        if not self.classes_:
            raise LabelEncodingError("This classifier has not been fitted yet.")
        return self.classes_

    def predict(self, X: Any) -> list[MarketLabel]:
        classes = self._require_fitted()
        decoded: list[MarketLabel] = []
        for code in self.estimator.predict(X):
            index = int(round(float(code)))
            if index < 0 or index >= len(classes):
                raise LabelEncodingError("The wrapped estimator returned a code outside the fitted label space.")
            decoded.append(classes[index])
        return decoded

    def predict_proba(self, X: Any) -> Any:
        self._require_fitted()
        return self.estimator.predict_proba(X)

    def __repr__(self) -> str:  # pragma: no cover - diagnostic convenience only
        return f"LabelEncodedClassifier(estimator={self.estimator!r}, classes_={list(self.classes_)!r})"


__all__ = ["LabelEncodedClassifier", "LabelEncodingError"]
