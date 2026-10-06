"""Compact causal TCN for Stage 5 research (optional PyTorch).

The library is imported lazily so the default tree-training image stays free of
torch. Architecture constraints from Phase 25 Workstream F:

- causal dilated 1D convolutions with residual blocks;
- no attention layer in v1;
- parameter count reported and kept small relative to usable sequences.

Module-level ``nn.Module`` subclasses are required so research artifacts can be
pickled and unpickled via the shared ``write_model_artifact`` path.
"""

from __future__ import annotations

from typing import Any


TCN_ALGORITHM = "pytorch-causal-tcn-v1"
TEMPORAL_OCCLUSION_METHOD = "TEMPORAL_OCCLUSION_V1"

try:
    import torch
    from torch import nn
    import torch.nn.functional as F

    class CausalConv1d(nn.Module):
        def __init__(self, in_ch: int, out_ch: int, kernel_size: int, dilation: int) -> None:
            super().__init__()
            self.padding = (kernel_size - 1) * dilation
            self.conv = nn.Conv1d(in_ch, out_ch, kernel_size, dilation=dilation)

        def forward(self, x: Any) -> Any:
            x = F.pad(x, (self.padding, 0))
            return self.conv(x)

    class ResidualBlock(nn.Module):
        def __init__(self, channels: int, kernel_size: int, dilation: int, dropout: float) -> None:
            super().__init__()
            self.conv1 = CausalConv1d(channels, channels, kernel_size, dilation)
            self.conv2 = CausalConv1d(channels, channels, kernel_size, dilation)
            self.dropout = nn.Dropout(dropout)
            self.relu = nn.ReLU()

        def forward(self, x: Any) -> Any:
            residual = x
            out = self.relu(self.conv1(x))
            out = self.dropout(out)
            out = self.relu(self.conv2(out))
            out = self.dropout(out)
            return self.relu(out + residual)

    class CausalTcnClassifier(nn.Module):
        def __init__(
            self,
            *,
            n_features: int,
            n_classes: int,
            channels: int,
            kernel_size: int,
            dilations: tuple[int, ...],
            dropout: float,
        ) -> None:
            super().__init__()
            self.input = nn.Conv1d(n_features, channels, kernel_size=1)
            self.blocks = nn.ModuleList(
                [ResidualBlock(channels, kernel_size, dilation, dropout) for dilation in dilations]
            )
            self.head = nn.Linear(channels, n_classes)
            self.n_features = n_features
            self.n_classes = n_classes
            self.channels = channels
            self.kernel_size = kernel_size
            self.dilations = dilations
            self.dropout = dropout

        def forward(self, x: Any) -> Any:
            # x: (batch, lookback, features) → (batch, features, lookback)
            x = x.transpose(1, 2)
            x = self.input(x)
            for block in self.blocks:
                x = block(x)
            # Causal: the last timestep is the only admissible decision representation.
            x = x[:, :, -1]
            return self.head(x)

        def parameter_count(self) -> int:
            return sum(parameter.numel() for parameter in self.parameters())

except ImportError:  # pragma: no cover - optional dependency
    torch = None  # type: ignore[assignment]
    CausalConv1d = None  # type: ignore[misc, assignment]
    ResidualBlock = None  # type: ignore[misc, assignment]
    CausalTcnClassifier = None  # type: ignore[misc, assignment]


class TcnDependencyError(RuntimeError):
    """Raised when a TCN path is requested without the optional DL dependencies."""


def require_torch() -> Any:
    if torch is None:
        raise TcnDependencyError(
            "PyTorch is required for TCN research. Install apps/ml/requirements-dl.txt "
            "(kept out of the default ML image until a TCN candidate is enrolled)."
        )
    return torch


def build_causal_tcn(
    *,
    n_features: int,
    n_classes: int,
    channels: int = 16,
    kernel_size: int = 3,
    dilations: tuple[int, ...] = (1, 2, 4, 8),
    dropout: float = 0.1,
) -> Any:
    """Construct a small causal TCN classifier. Returns an ``nn.Module``."""

    require_torch()
    assert CausalTcnClassifier is not None
    return CausalTcnClassifier(
        n_features=n_features,
        n_classes=n_classes,
        channels=channels,
        kernel_size=kernel_size,
        dilations=dilations,
        dropout=dropout,
    )


__all__ = [
    "TCN_ALGORITHM",
    "TEMPORAL_OCCLUSION_METHOD",
    "CausalTcnClassifier",
    "TcnDependencyError",
    "build_causal_tcn",
    "require_torch",
]
