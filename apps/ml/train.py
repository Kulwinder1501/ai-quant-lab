"""Train and optionally promote a local, time-aware market-direction model.

This script is intentionally a research workflow. It only reads local
PostgreSQL data, writes a local artifact, and updates local model metadata;
it contains no market connectivity or trading execution.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import dataclasses
import sys
from datetime import datetime, timezone
from pathlib import Path
from hashlib import sha256
from typing import Any, Mapping, Sequence
from uuid import uuid4

from ai_quant_lab_ml.artifacts import ArtifactError, load_model_artifact, write_model_artifact
from ai_quant_lab_ml.contracts import (
    ALGORITHM_CHOICES,
    FEATURE_SCHEMA_VERSION,
    FEATURE_SCHEMA_VERSION_V5,
    SCALP_TIMEFRAMES,
    DIRECTIONAL_ALPHABET,
    LABEL_SCHEME_FIXED_HORIZON,
    LABEL_SCHEME_TRIPLE_BARRIER,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
    LABEL_SCHEMES,
    AnyLabel,
    LabelAlphabet,
    DatasetRequest,
    EvaluationMetrics,
    LabeledExample,
    PersistedModelVersion,
    TemporalSplit,
    default_neutral_threshold_bps,
    schema_version_for,
)
from ai_quant_lab_ml.features import (
    build_labeled_examples,
    build_triple_barrier_examples,
    build_volatility_expansion_examples,
    feature_definition,
    feature_schema,
)
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from ai_quant_lab_ml.reference_data import build_reference_metadata
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET
from ai_quant_lab_ml.training import (
    BaselineTrainingResult,
    evaluate_predictions,
    predict_labels,
    train_model,
    training_metadata,
)
from ai_quant_lab_ml.data_readiness import (
    DataReadinessError,
    load_latest_report,
    require_series_ready,
)
from ai_quant_lab_ml.leakage import run_leakage_audit
from ai_quant_lab_ml.validation import (
    CPCV_METHOD_NAME,
    POOLED_WALK_FORWARD_METHOD_NAME,
    combinatorial_purged_splits,
    pooled_walk_forward_splits,
    walk_forward_splits,
)


ROOT_DIRECTORY = Path(__file__).resolve().parents[2]
DEFAULT_ARTIFACT_DIRECTORY = ROOT_DIRECTORY / "models"

# A macro-F1 floor cannot discriminate on a holdout that is too small to resolve
# it. Observed on 2026-07-29: a 15m candidate scoring 0.4023 on 24 validation rows
# with 8 directional predictions at a 25% hit rate was declared promotion-eligible
# purely because 0.4023 > the 0.38 floor. The standard error of macro-F1 at n=24 is
# roughly 0.10, so that "pass" and a 0.34 "fail" are the same measurement.
#
# 60 rows brings the standard error to about 0.06, which is the point at which the
# 0.38 floor starts to mean something against the ~0.33 random baseline. The
# directional floor is separate because coverage can be low enough that a model
# committed to a direction only a handful of times, and a hit rate over 8 calls is
# not evidence regardless of how many rows the macro-F1 was computed on.
MINIMUM_VALIDATION_ROWS = 60
MINIMUM_DIRECTIONAL_PREDICTIONS = 30

# Each optional hyperparameter flag names the trainer keyword it fills and the
# algorithms that accept it. A flag left unset is never forwarded, so the
# trainer's own documented default applies and is what gets recorded in the
# artifact metadata. Supplying a flag the selected algorithm cannot use is an
# error rather than a silent no-op.
HYPERPARAMETER_APPLICABILITY: Mapping[str, tuple[str, ...]] = {
    "max_iter": ("logistic",),
    "n_estimators": ("xgboost", "lightgbm", "catboost"),
    "learning_rate": ("xgboost", "lightgbm", "catboost"),
    "max_depth": ("xgboost", "lightgbm", "catboost"),
    "subsample": ("xgboost", "lightgbm", "catboost"),
    "colsample_bytree": ("xgboost", "lightgbm", "catboost"),
    "reg_lambda": ("xgboost", "lightgbm", "catboost"),
    "min_child_weight": ("xgboost",),
    "num_leaves": ("lightgbm",),
    "min_child_samples": ("lightgbm",),
}


def parse_timestamp(value: str, *, end_of_day: bool = False) -> datetime:
    """Parse a date or ISO-8601 timestamp as a timezone-aware UTC instant."""

    normalized = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        normalized = f"{normalized}T{'23:59:59.999999' if end_of_day else '00:00:00.000000'}+00:00"
    elif normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD or an ISO-8601 timestamp.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def non_negative_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not math.isfinite(parsed) or parsed < 0:
        raise argparse.ArgumentTypeError("must be a non-negative finite number")
    return parsed


def positive_float(value: str) -> float:
    parsed = non_negative_float(value)
    if parsed == 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def unit_interval(value: str) -> float:
    parsed = non_negative_float(value)
    if parsed > 1:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return parsed


def fraction(value: str) -> float:
    """A sampling fraction: greater than zero and at most one."""

    parsed = unit_interval(value)
    if parsed == 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def strict_unit_interval(value: str) -> float:
    parsed = unit_interval(value)
    if parsed == 0 or parsed == 1:
        raise argparse.ArgumentTypeError("must be strictly between 0 and 1")
    return parsed


def non_blank(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise argparse.ArgumentTypeError("must not be blank")
    return normalized


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Train a cutoff-bound, chronologically validated local market-direction model.",
    )
    instruments = parser.add_mutually_exclusive_group(required=True)
    instruments.add_argument("--instrument", type=non_blank, help="Registered NSE symbol, for example NIFTY50.")
    # Pooled cross-sectional training. The swing schema's features are all scale-free
    # (basis points and ratios), which is what makes one model over many instruments
    # coherent at all -- a raw-price feature would just learn which symbol it is
    # looking at. Rows multiply by the instrument count: twenty research equities on
    # `1d` is ~17,700 labelled rows against ~880 for NIFTY50 alone, and that is the
    # only route to a fold count above two while the 60-row validation floor holds.
    instruments.add_argument(
        "--instruments",
        type=non_blank,
        help=(
            "Comma-separated symbols to pool into one cross-sectional dataset, for example "
            "SBIN,INFY,TCS. Assumes shared dynamics across the pool; use --instrument for a "
            "single-instrument model."
        ),
    )
    parser.add_argument("--timeframe", required=True, type=non_blank, help="Completed candle timeframe, for example 1d.")
    parser.add_argument("--from", dest="data_window_start", required=True, help="Inclusive data-window start (YYYY-MM-DD or ISO-8601).")
    parser.add_argument("--to", dest="data_window_end", required=True, help="Inclusive data-window end (YYYY-MM-DD or ISO-8601).")
    parser.add_argument("--data-cutoff-at", help="Stored-data revision cutoff (defaults to the current UTC time).")
    parser.add_argument("--horizon-bars", type=positive_int, default=5, help="Later completed bars used for each label (default: 5).")
    parser.add_argument(
        "--neutral-threshold-bps",
        type=non_negative_float,
        default=None,
        help=(
            "Inclusive forward-return neutral band in bps. Defaults to a band calibrated "
            "for the timeframe (1m: 2, 5m: 5, 15m: 9, 1d: 50), because a single constant "
            "leaves a 1m target 99% NEUTRAL."
        ),
    )
    parser.add_argument(
        "--label-scheme",
        choices=LABEL_SCHEMES,
        default=LABEL_SCHEME_FIXED_HORIZON,
        help=(
            "Target definition. fixed-horizon-v1: sign of the close-to-close return at "
            "--horizon-bars against the neutral band. triple-barrier-v1: which of the "
            "ATR-scaled profit/stop barriers the forward path hits first, with "
            "--horizon-bars as the time barrier (default: fixed-horizon-v1)."
        ),
    )
    parser.add_argument("--barrier-upper-multiple", type=positive_float, default=1.0, help="triple-barrier: profit barrier in ATR units (default: 1.0).")
    parser.add_argument("--barrier-lower-multiple", type=positive_float, default=1.0, help="triple-barrier: stop barrier in ATR units (default: 1.0).")
    parser.add_argument(
        "--expansion-band",
        type=positive_float,
        default=0.25,
        help=(
            "volatility-expansion: band around an unchanged range. EXPANSION at a ratio "
            ">= 1 + band, CONTRACTION at <= 1 / (1 + band) (default: 0.25)."
        ),
    )
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2, help="Final chronological validation fraction, exclusive of purge (default: 0.2).")
    parser.add_argument(
        "--algorithm",
        choices=ALGORITHM_CHOICES,
        default="logistic",
        help="Model family to fit: the linear baseline or a gradient-boosted forest (default: logistic).",
    )
    parser.add_argument(
        "--model-key",
        type=non_blank,
        help=(
            "Optional local model family key. By default it is scoped to the algorithm, instrument, timeframe, "
            "label definition, and feature schema, so each algorithm keeps its own promotion lineage. Pass one "
            "shared key to make two algorithms compete for the same PRODUCTION slot on identical unseen data."
        ),
    )
    parser.add_argument("--database-url", help="PostgreSQL URL; defaults to DATABASE_URL in the root .env/environment.")
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIRECTORY, help="Local directory for immutable pickle artifacts.")
    parser.add_argument("--random-state", type=int, default=42, help="Deterministic library random state (default: 42).")
    parser.add_argument("--max-iter", type=positive_int, help="logistic: maximum solver iterations (default: 1000).")
    parser.add_argument("--n-estimators", type=positive_int, help="boosted families: boosting rounds (default: 300).")
    parser.add_argument("--learning-rate", type=positive_float, help="boosted families: shrinkage per round (default: 0.05).")
    parser.add_argument("--max-depth", type=positive_int, help="boosted families: maximum tree depth (default: xgboost 3, lightgbm/catboost 4).")
    parser.add_argument("--subsample", type=fraction, help="boosted families: row sampling fraction per round (default: 0.8).")
    parser.add_argument("--colsample-bytree", type=fraction, help="boosted families: feature sampling fraction (default: 0.8; catboost applies it per split as rsm).")
    parser.add_argument("--reg-lambda", type=non_negative_float, help="boosted families: L2 leaf penalty (default: 1.0; catboost 3.0 as l2_leaf_reg).")
    parser.add_argument("--min-child-weight", type=non_negative_float, help="xgboost: minimum child hessian weight (default: 5).")
    parser.add_argument("--num-leaves", type=positive_int, help="lightgbm: maximum leaves per tree (default: 15).")
    parser.add_argument("--min-child-samples", type=positive_int, help="lightgbm: minimum observations per leaf (default: 20).")
    parser.add_argument("--promote", action="store_true", help="Promote only if the explicit unseen-data gate passes.")
    parser.add_argument("--minimum-improvement", type=non_negative_float, default=0.0, help="Required candidate macro-F1 advantage over production (default: 0).")
    parser.add_argument(
        "--minimum-initial-macro-f1",
        type=unit_interval,
        default=None,
        help=(
            "Required macro-F1 for an initial production model. Defaults per label scheme "
            "(direction: 0.38, volatility-expansion: 0.40); ~0.33 is the 3-class random baseline."
        ),
    )
    parser.add_argument("--maximum-plausible-macro-f1", type=unit_interval, default=0.60, help="Candidate scoring above this must not auto-promote without override (default: 0.60).")
    parser.add_argument("--override-suspicious", action="store_true", help="Force promotion despite suspiciously high score or negative gap.")
    parser.add_argument(
        "--minimum-validation-rows",
        type=positive_int,
        default=MINIMUM_VALIDATION_ROWS,
        help=f"Holdout rows required before a macro-F1 floor is meaningful (default: {MINIMUM_VALIDATION_ROWS}).",
    )
    parser.add_argument(
        "--minimum-directional-predictions",
        type=positive_int,
        default=MINIMUM_DIRECTIONAL_PREDICTIONS,
        help=f"Directional calls required before a hit rate is readable (default: {MINIMUM_DIRECTIONAL_PREDICTIONS}).",
    )
    parser.add_argument("--folds", type=positive_int, default=1, help="Number of walk-forward validation folds (default: 1).")
    # CPCV is a research measurement, off by default. It fits one model per
    # combination, so 6 groups choosing 2 is 15 extra fits; the walk-forward path
    # and the promotion gate are untouched whether it runs or not.
    parser.add_argument(
        "--cpcv-groups",
        type=positive_int,
        default=None,
        help="Run Combinatorial Purged CV over this many blocks as a research metric (default: off).",
    )
    parser.add_argument("--cpcv-test-groups", type=positive_int, default=2, help="Blocks held out per CPCV combination (default: 2).")
    parser.add_argument(
        "--cpcv-embargo-fraction",
        type=fraction,
        default=0.01,
        help="Share of the series embargoed after each CPCV test block (default: 0.01).",
    )
    # The escape hatch exists for scratch databases and deliberate local
    # experiments, not for routine runs: an artifact trained this way carries
    # `dataReadiness.enforced = false` in its protocol, permanently.
    parser.add_argument(
        "--allow-unaudited-data",
        action="store_true",
        help=(
            "Skip the data-readiness gate. Every gated run must otherwise be cleared by a fresh "
            "`npm run data:audit` report with every trained series READY."
        ),
    )
    # Research-only override so a capacity experiment can train the previous
    # swing schema and the current one on identical rows and folds. Scalp
    # timeframes are excluded: their schema is not versioned by this pair.
    parser.add_argument(
        "--feature-schema",
        choices=(FEATURE_SCHEMA_VERSION, FEATURE_SCHEMA_VERSION_V5),
        default=None,
        help=(
            "Override the swing feature-schema version for an A/B capacity comparison "
            f"(default: the timeframe's current mapping, {FEATURE_SCHEMA_VERSION} for swing)."
        ),
    )
    return parser


def metrics_to_mapping(metrics: EvaluationMetrics) -> dict[str, Any]:
    return {
        "accuracy": metrics.accuracy,
        "balancedAccuracy": metrics.balanced_accuracy,
        "macroF1": metrics.macro_f1,
        # The directional hit rate is the figure comparable to a binary "right N%
        # of the time" claim; coverage says how often the model committed at all.
        "directionalPredictions": metrics.directional_predictions,
        "directionalHitRate": metrics.directional_hit_rate,
        "coverage": metrics.coverage,
        "sampleCount": metrics.sample_count,
        "classCounts": dict(metrics.class_counts),
        # Per-class breakdown. macro-F1 cannot answer whether a strategy acting on one
        # class pays: a straddle is taken only on a predicted EXPANSION, so that class's
        # precision is the number that decides it. Nulls are meaningful -- a null
        # precision means the class was never predicted, which is a different fact from a
        # precision of zero.
        "perClass": (
            {
                label: {
                    "precision": entry.precision,
                    "recall": entry.recall,
                    "f1": entry.f1,
                    "predictedCount": entry.predicted_count,
                    "actualCount": entry.actual_count,
                }
                for label, entry in metrics.per_class.items()
            }
            if metrics.per_class is not None
            else None
        ),
    }


def fold_summary(fold_results: Sequence[BaselineTrainingResult]) -> dict[str, Any]:
    """Summarise walk-forward folds so a score can be read with its uncertainty.

    The spread matters as much as the mean: two candidates whose macro-F1 differs
    by less than the spread across folds are not distinguishable, and reporting
    only the mean invites reading noise as a ranking.
    """

    scores = [result.validation_metrics.macro_f1 for result in fold_results]
    mean_macro_f1 = sum(scores) / len(scores)
    return {
        "folds": len(scores),
        "foldMacroF1": scores,
        "meanMacroF1": mean_macro_f1,
        "minMacroF1": min(scores),
        "maxMacroF1": max(scores),
        "spreadMacroF1": max(scores) - min(scores),
        # The most recent fold is the one whose artifact is persisted and promoted.
        "finalFoldMacroF1": scores[-1],
    }


def trivial_majority_metrics(
    split: TemporalSplit,
    *,
    alphabet: LabelAlphabet,
) -> EvaluationMetrics:
    """Score the always-predict-the-training-majority strategy on a split's holdout.

    This is the baseline that matters, and it is not the random one. Macro-F1
    rises mechanically as a label distribution becomes less degenerate, so a
    model can post a higher macro-F1 than a previous attempt purely because its
    classes are better balanced while still being beaten by a constant predictor.
    Every real result in this project came from making this comparison; the
    triple-barrier track looked like an improvement until it was made.

    The majority class is taken from the *training* partition, because that is
    the only thing a deployed constant predictor could have known.
    """

    counts: dict[AnyLabel, int] = {}
    for item in split.train:
        counts[item.label] = counts.get(item.label, 0) + 1
    majority = max(counts.items(), key=lambda entry: (entry[1], entry[0]))[0]
    actual = [item.label for item in split.validation]
    return evaluate_predictions(actual, [majority] * len(actual), alphabet=alphabet)


def _percentile(values: Sequence[float], fraction: float) -> float:
    ranked = sorted(values)
    size = len(ranked)
    if size == 1:
        return ranked[0]
    position = fraction * (size - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ranked[lower]
    return ranked[lower] + (ranked[upper] - ranked[lower]) * (position - lower)


def _distribution(values: Sequence[float]) -> dict[str, float]:
    count = len(values)
    mean = sum(values) / count
    variance = sum((value - mean) ** 2 for value in values) / count
    return {
        "mean": mean,
        "std": math.sqrt(variance),
        "min": min(values),
        "p05": _percentile(values, 0.05),
        "median": _percentile(values, 0.5),
        "p95": _percentile(values, 0.95),
        "max": max(values),
    }


def cpcv_summary(
    model_metrics: Sequence[EvaluationMetrics],
    trivial_metrics: Sequence[EvaluationMetrics],
    *,
    groups: int,
    test_groups: int,
    embargo_fraction: float,
) -> dict[str, Any]:
    """Summarise a CPCV score distribution against its per-split trivial baseline.

    Reported as a distribution rather than a headline number on purpose. The
    walk-forward score answers "how did this model do on the most recent block";
    this answers "how much does that answer move when the evaluation window
    moves", which is the question a single number cannot address.

    The spread is not a standard error over independent samples -- CPCV training
    sets overlap heavily, so the scores are correlated and the true uncertainty is
    wider than a naive sqrt(n) reading of this std would suggest. It is a lower
    bound on how unstable the score is, and that is still far more than one number
    conveys.

    **Both metrics are reported against the trivial majority-class predictor on the
    same holdout, and accuracy is the one to read first.** Macro-F1 flatters any
    model that spreads its predictions: a constant predictor scores an F1 of zero
    on two of three classes by construction, so merely guessing in all three
    classes lifts macro-F1 above it without a single extra correct call. Accuracy
    has no such loophole -- beating a constant predictor on accuracy means genuinely
    getting more rows right. A macro-F1 edge with a flat or negative accuracy edge
    is the signature of a redistributed guess, not a discovered signal, and is
    precisely what made the triple-barrier track look like progress.
    """

    macro_f1 = [metrics.macro_f1 for metrics in model_metrics]
    accuracy = [metrics.accuracy for metrics in model_metrics]
    trivial_macro_f1 = [metrics.macro_f1 for metrics in trivial_metrics]
    trivial_accuracy = [metrics.accuracy for metrics in trivial_metrics]
    macro_f1_deltas = [model - trivial for model, trivial in zip(macro_f1, trivial_macro_f1)]
    accuracy_deltas = [model - trivial for model, trivial in zip(accuracy, trivial_accuracy)]

    return {
        # Carried so nothing ever ranks a CPCV score against a walk-forward score:
        # they average over different test distributions and are not comparable.
        "method": CPCV_METHOD_NAME,
        "groups": groups,
        "testGroups": test_groups,
        "embargoFraction": embargo_fraction,
        "splits": len(model_metrics),
        "macroF1": _distribution(macro_f1),
        "accuracy": _distribution(accuracy),
        "trivialMacroF1": _distribution(trivial_macro_f1),
        "trivialAccuracy": _distribution(trivial_accuracy),
        "macroF1MinusTrivial": _distribution(macro_f1_deltas),
        "accuracyMinusTrivial": _distribution(accuracy_deltas),
        # The share of splits actually won, because a mean edge carried by three
        # lucky splits out of fifteen is not an edge.
        "macroF1WinRateVsTrivial": sum(1 for delta in macro_f1_deltas if delta > 0) / len(macro_f1_deltas),
        "accuracyWinRateVsTrivial": sum(1 for delta in accuracy_deltas if delta > 0) / len(accuracy_deltas),
    }


def feature_schema_rows(schema: Sequence[str], schema_version: str) -> list[dict[str, str]]:
    return [
        {
            "name": name,
            "dtype": "float64",
            "schemaVersion": schema_version,
        }
        for name in schema
    ]


def schema_names(schema: Sequence[Mapping[str, Any]]) -> tuple[str, ...]:
    names: list[str] = []
    for field in schema:
        name = field.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError("Persisted feature schema contains an invalid field name.")
        names.append(name)
    return tuple(names)


def artifact_path(artifact_directory: Path, model_key: str, trained_at: datetime) -> Path:
    safe_key = re.sub(r"[^A-Za-z0-9._-]+", "-", model_key).strip(".-") or "model"
    unique = uuid4().hex[:12]
    return artifact_directory / safe_key / f"{trained_at.strftime('%Y%m%dT%H%M%S%fZ')}-{unique}.pkl"


def default_model_key(
    request: DatasetRequest,
    algorithm_choice: str,
    schema_version: str = FEATURE_SCHEMA_VERSION,
    pooled_instruments: Sequence[str] = (),
) -> str:
    """Return a model family key that cannot accidentally span incompatible experiments.

    The algorithm is part of the key so a boosted candidate does not silently
    take over the linear baseline's promotion lineage. Two algorithms only
    compete for one PRODUCTION slot when the operator passes an explicit shared
    ``--model-key``, which is a deliberate championship, not an accident.
    """

    def component(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-") or "value"

    is_volatility = request.label_scheme == LABEL_SCHEME_VOLATILITY_EXPANSION
    # The prefix names the target family, so a volatility model must not be called
    # "market-direction": the key is the model's identity and appears in the
    # artifact path, the promotion lineage, and every log line.
    family = "volatility-expansion" if is_volatility else "market-direction"
    # A pooled model answers a different question from a single-instrument one and
    # its score is an average over a different distribution, so it must not inherit
    # NIFTY50's promotion lineage. The member list is hashed rather than spelled out:
    # twenty symbols would make the key unreadable and the artifact path unusable,
    # while the full roster is recorded in validationProtocol.pooledInstruments.
    if pooled_instruments:
        roster = ",".join(sorted(symbol.upper() for symbol in pooled_instruments))
        digest = sha256(roster.encode("utf-8")).hexdigest()[:8]
        instrument_component = f"pool{len(pooled_instruments)}-{digest}"
    else:
        instrument_component = component(request.instrument_symbol.upper())
    parts = [
        f"{family}-{component(algorithm_choice)}",
        instrument_component,
        component(request.timeframe),
        f"h{request.horizon_bars}",
    ]
    # The neutral band defines the *directional* label boundary and has no meaning
    # for a range-ratio target, so it is omitted rather than recorded misleadingly.
    if not is_volatility:
        parts.append(f"neutral-{component(format(request.neutral_threshold_bps, '.12g'))}bps")
    parts.append(schema_version)
    # A different labelling scheme is a different question, so it must not share a
    # promotion lineage: a triple-barrier candidate scored against a fixed-horizon
    # incumbent is a meaningless comparison. The component is appended only for
    # non-default schemes so every existing fixed-horizon key stays byte-identical
    # and its promotion history is preserved.
    if request.label_scheme != LABEL_SCHEME_FIXED_HORIZON:
        parts.append(component(request.label_scheme))
        # Only the parameters that actually shape *this* scheme's target belong in
        # the key. Stamping barrier multiples onto a volatility model would imply a
        # geometry it does not have, and would make two otherwise-identical vol
        # models look different if an unused barrier flag changed.
        if request.label_scheme == LABEL_SCHEME_VOLATILITY_EXPANSION:
            parts.append(f"band{format(request.expansion_band, '.12g')}")
        else:
            parts.append(
                f"bu{format(request.barrier_upper_multiple, '.12g')}"
                f"-bl{format(request.barrier_lower_multiple, '.12g')}"
            )
    return "--".join(parts)

def selected_hyperparameters(args: argparse.Namespace, parser: argparse.ArgumentParser) -> dict[str, Any]:
    """Collect only the explicitly supplied flags that the chosen algorithm accepts."""

    supplied: dict[str, Any] = {}
    for name, algorithms in HYPERPARAMETER_APPLICABILITY.items():
        value = getattr(args, name, None)
        if value is None:
            continue
        if args.algorithm not in algorithms:
            flag = f"--{name.replace('_', '-')}"
            parser.error(f"{flag} does not apply to --algorithm {args.algorithm} (it applies to: {', '.join(algorithms)}).")
        supplied[name] = value
    return supplied


def validate_candidate_artifact(
    *,
    path: Path,
    expected_checksum: str,
    expected_schema: Sequence[str],
    schema_version: str = FEATURE_SCHEMA_VERSION,
    model_key: str,
    algorithm: str,
    request: DatasetRequest,
) -> None:
    """Re-read the just-written candidate before metadata persistence or promotion."""

    loaded = load_model_artifact(path, expected_checksum=expected_checksum)
    metadata = loaded.metadata
    if tuple(metadata.get("featureSchema", ())) != tuple(expected_schema):
        raise ArtifactError("Candidate artifact does not match the fixed feature schema.")
    if metadata.get("featureSchemaVersion") != schema_version:
        raise ArtifactError("Candidate artifact has an incompatible feature-schema version.")
    if metadata.get("featureDefinition") != feature_definition(schema_version):
        raise ArtifactError("Candidate artifact has an incompatible feature definition.")
    if metadata.get("algorithm") != algorithm:
        raise ArtifactError("Candidate artifact algorithm does not match the persisted candidate.")
    if metadata.get("modelKey") != model_key:
        raise ArtifactError("Candidate artifact model key does not match the persisted candidate.")
    dataset = metadata.get("dataset")
    if not isinstance(dataset, Mapping) or dataset.get("instrument") != request.instrument_symbol or dataset.get("timeframe") != request.timeframe:
        raise ArtifactError("Candidate artifact was written for a different instrument or timeframe.")
    protocol = metadata.get("validationProtocol")
    if not isinstance(protocol, Mapping) or (
        protocol.get("horizonBars") != request.horizon_bars
        or protocol.get("neutralThresholdBps") != request.neutral_threshold_bps
        # Absent means an artifact written before schemes existed, which was
        # necessarily fixed-horizon.
        or protocol.get("labelScheme", LABEL_SCHEME_FIXED_HORIZON) != request.label_scheme
        # Band drift must fail loudly for the scheme it governs. Absent is tolerated
        # only for artifacts written before the field existed, which are necessarily
        # not volatility models, since those could not settle at all back then.
        or (
            request.label_scheme == LABEL_SCHEME_VOLATILITY_EXPANSION
            and protocol.get("expansionBand") != request.expansion_band
        )
        or protocol.get("indicatorAlgorithmVersion") != request.indicator_algorithm_version
        or protocol.get("patternAlgorithmVersion") != request.pattern_algorithm_version
        or protocol.get("priceActionAlgorithmVersion") != request.price_action_algorithm_version
    ):
        raise ArtifactError("Candidate artifact uses a different label or analytical-evidence definition.")


def validation_protocol(
    request: DatasetRequest,
    *,
    validation_fraction: float,
    purge_count: int,
    split_train: Sequence[LabeledExample],
    split_validation: Sequence[LabeledExample],
) -> dict[str, Any]:
    return {
        "method": "PURGED_CHRONOLOGICAL_V1",
        "validationFraction": validation_fraction,
        "purgeBars": purge_count,
        "horizonBars": request.horizon_bars,
        "neutralThresholdBps": request.neutral_threshold_bps,
        # Part of the label definition, so it is recorded and cross-checked like
        # every other label parameter. For the fixed-horizon scheme the barrier
        # multiples are unused, but recording them keeps the block one shape.
        "labelScheme": request.label_scheme,
        "barrierUpperMultiple": request.barrier_upper_multiple,
        "barrierLowerMultiple": request.barrier_lower_multiple,
        # The band *is* the volatility label rule: EXPANSION at ratio >= 1 + band,
        # CONTRACTION at <= 1 / (1 + band). Settlement has to grade a live prediction
        # against the same rule the model was trained on, and until this was recorded
        # the only trace of it was the model key. `neutralThresholdBps` above is
        # recorded for shape but means nothing for this target.
        "expansionBand": request.expansion_band,
        "indicatorAlgorithmVersion": request.indicator_algorithm_version,
        "patternAlgorithmVersion": request.pattern_algorithm_version,
        "priceActionAlgorithmVersion": request.price_action_algorithm_version,
        "dataWindowStart": request.data_window_start.isoformat(),
        "dataWindowEnd": request.data_window_end.isoformat(),
        "dataCutoffAt": request.data_cutoff_at.isoformat(),
        "trainingSourceWindow": {
            "start": split_train[0].observed_at.isoformat(),
            "end": split_train[-1].observed_at.isoformat(),
        },
        # The final training target is only known once its future label candle
        # closes. Historical inference must not deploy this model before that
        # information boundary, even if the source candle itself is earlier.
        "trainingLabelAvailableEnd": max(example.label_available_at for example in split_train).isoformat(),
        "validationSourceWindow": {
            "start": split_validation[0].observed_at.isoformat(),
            "end": split_validation[-1].observed_at.isoformat(),
        },
    }


def evaluate_incumbent(
    incumbent: PersistedModelVersion,
    validation: Sequence[LabeledExample],
    expected_schema: Sequence[str],
    schema_version: str,
    request: DatasetRequest,
    alphabet: LabelAlphabet = DIRECTIONAL_ALPHABET,
) -> tuple[EvaluationMetrics | None, str | None]:
    """Evaluate a trusted, checksum-matched production artifact on this exact holdout."""

    if not incumbent.artifact_checksum:
        return None, "The production model has no persisted artifact checksum."
    try:
        if schema_names(incumbent.feature_schema) != tuple(expected_schema):
            return None, "The production model has a different persisted feature schema."
        loaded = load_model_artifact(incumbent.artifact_uri, expected_checksum=incumbent.artifact_checksum)
        metadata_schema = loaded.metadata.get("featureSchema")
        if not isinstance(metadata_schema, list) or tuple(metadata_schema) != tuple(expected_schema):
            return None, "The production artifact does not match the candidate feature schema."
        if loaded.metadata.get("featureSchemaVersion") != schema_version:
            return None, "The production artifact has an incompatible feature-schema version."
        if loaded.metadata.get("featureDefinition") != feature_definition(schema_version):
            return None, "The production artifact has an incompatible feature definition."
        if loaded.metadata.get("algorithm") != incumbent.algorithm:
            return None, "The production artifact algorithm does not match its persisted version."
        if loaded.metadata.get("modelKey") != incumbent.model_key:
            return None, "The production artifact model key does not match its persisted version."
        dataset = loaded.metadata.get("dataset")
        if not isinstance(dataset, Mapping) or dataset.get("instrument") != request.instrument_symbol or dataset.get("timeframe") != request.timeframe:
            return None, "The production artifact was trained for a different instrument or timeframe."
        protocol = loaded.metadata.get("validationProtocol")
        if not isinstance(protocol, Mapping):
            return None, "The production artifact is missing its temporal validation protocol."
        if (
            protocol.get("horizonBars") != request.horizon_bars
            or protocol.get("neutralThresholdBps") != request.neutral_threshold_bps
            # An incumbent labelled under a different scheme is answering a
            # different question; its score is not comparable to the candidate's,
            # so it is refused rather than silently scored. Absent means an
            # artifact predating schemes, which was fixed-horizon.
            or protocol.get("labelScheme", LABEL_SCHEME_FIXED_HORIZON) != request.label_scheme
            or protocol.get("indicatorAlgorithmVersion") != request.indicator_algorithm_version
            or protocol.get("patternAlgorithmVersion") != request.pattern_algorithm_version
            or protocol.get("priceActionAlgorithmVersion") != request.price_action_algorithm_version
        ):
            return None, "The production artifact uses a different label or analytical-evidence definition."
        training_window = protocol.get("trainingSourceWindow")
        if not isinstance(training_window, Mapping) or not isinstance(training_window.get("end"), str):
            return None, "The production artifact is missing its training-source window."
        incumbent_training_end = parse_timestamp(training_window["end"])
        if incumbent_training_end >= validation[0].observed_at:
            return None, "The production artifact may already have trained on the candidate validation period."
        predicted = predict_labels(loaded.model, validation, schema=expected_schema, alphabet=alphabet)
        return (
            evaluate_predictions(
                [example.label for example in validation], predicted, alphabet=alphabet
            ),
            None,
        )
    except (ArtifactError, OSError, ValueError, RuntimeError) as error:
        return None, f"The production artifact could not be safely evaluated: {error}"


def promotion_assessment(
    *,
    candidate: BaselineTrainingResult,
    incumbent: PersistedModelVersion | None,
    incumbent_metrics: EvaluationMetrics | None,
    incumbent_error: str | None,
    minimum_improvement: float,
    minimum_initial_macro_f1: float,
    maximum_plausible_macro_f1: float,
    override_suspicious: bool,
    minimum_validation_rows: int = MINIMUM_VALIDATION_ROWS,
    minimum_directional_predictions: int = MINIMUM_DIRECTIONAL_PREDICTIONS,
    folds: Mapping[str, Any] | None = None,
) -> tuple[bool, dict[str, Any]]:
    """Decide promotion from unseen-data evidence alone.

    The order of the checks is deliberate. Sample-size sufficiency comes first,
    because a score computed on too few rows is not weak evidence but absent
    evidence, and every later comparison would be reading noise. A suspicious
    score is then refused before any comparison with the incumbent, because a
    leaking candidate that "beats" production is the exact failure this gate
    exists to prevent.
    """

    candidate_metrics = metrics_to_mapping(candidate.validation_metrics)
    assessment: dict[str, Any] = {
        "metric": "macroF1",
        "candidate": candidate_metrics,
        "minimumImprovement": minimum_improvement,
        "minimumInitialMacroF1": minimum_initial_macro_f1,
        "maximumPlausibleMacroF1": maximum_plausible_macro_f1,
        "overridden": override_suspicious,
        "incumbentModelVersionId": None if incumbent is None else incumbent.id,
        "incumbent": None if incumbent_metrics is None else metrics_to_mapping(incumbent_metrics),
        "validationRows": candidate.validation_rows,
        "minimumValidationRows": minimum_validation_rows,
        "minimumDirectionalPredictions": minimum_directional_predictions,
    }
    if folds is not None:
        assessment["walkForward"] = dict(folds)

    # Sample-size sufficiency first: a score on too few rows is absent evidence,
    # not weak evidence, and every check below it would be reading noise.
    directional_predictions = candidate.validation_metrics.directional_predictions
    if candidate.validation_rows < minimum_validation_rows:
        assessment["decision"] = "INSUFFICIENT_VALIDATION_EVIDENCE"
        assessment["reason"] = (
            f"{candidate.validation_rows} validation rows is below the {minimum_validation_rows} "
            "needed for a macro-F1 floor to discriminate. Widen the data window or lower "
            "--minimum-validation-rows deliberately."
        )
        return False, assessment
    if directional_predictions is not None and directional_predictions < minimum_directional_predictions:
        assessment["decision"] = "INSUFFICIENT_DIRECTIONAL_EVIDENCE"
        assessment["reason"] = (
            f"The candidate committed to a direction only {directional_predictions} time(s), below the "
            f"{minimum_directional_predictions} needed to read a hit rate. A model that abstains on "
            "almost every row has not been shown to be right about anything."
        )
        return False, assessment

    # With more than one fold the mean is the headline score, but the persisted
    # artifact is the final fold's model, so both must clear the floor. A mean
    # carried by early folds cannot promote a model whose most recent period
    # failed, and one lucky final fold cannot promote a weak mean.
    gate_scores = {"finalFold": candidate.validation_metrics.macro_f1}
    if folds is not None and int(folds.get("folds", 1)) > 1:
        gate_scores["mean"] = float(folds["meanMacroF1"])
    assessment["gateScores"] = gate_scores
    lowest_gate_score = min(gate_scores.values())
    highest_gate_score = max(gate_scores.values())

    if highest_gate_score > maximum_plausible_macro_f1 and not override_suspicious:
        assessment["decision"] = "SUSPICIOUSLY_HIGH_REQUIRES_AUDIT"
        assessment["reason"] = (
            f"macro-F1 {highest_gate_score:.4f} exceeds the plausible ceiling "
            f"{maximum_plausible_macro_f1:.4f}; run npm run ml:audit before trusting it."
        )
        return False, assessment

    if candidate.validation_metrics.macro_f1 > candidate.training_metrics.macro_f1 and not override_suspicious:
        assessment["decision"] = "HOLDOUT_EXCEEDS_TRAINING_REQUIRES_AUDIT"
        assessment["reason"] = (
            "The holdout score exceeds the training score, which usually means the "
            "model saw information it should not have."
        )
        return False, assessment

    if incumbent is None:
        qualifies = lowest_gate_score >= minimum_initial_macro_f1
        assessment["decision"] = "INITIAL_BASELINE_THRESHOLD_MET" if qualifies else "INITIAL_BASELINE_THRESHOLD_NOT_MET"
        return qualifies, assessment
    if incumbent_error is not None:
        assessment["decision"] = "INCUMBENT_NOT_EVALUABLE"
        assessment["reason"] = incumbent_error
        return False, assessment
    if incumbent_metrics is None:
        assessment["decision"] = "INCUMBENT_NOT_EVALUABLE"
        return False, assessment

    improvement = candidate.validation_metrics.macro_f1 - incumbent_metrics.macro_f1
    # The incumbent is scored on the candidate's final-fold holdout, so the
    # comparison uses that same partition's score on both sides.
    qualifies = improvement > minimum_improvement and lowest_gate_score >= minimum_initial_macro_f1
    assessment["improvement"] = improvement
    if improvement <= minimum_improvement:
        assessment["decision"] = "CANDIDATE_DID_NOT_OUTPERFORM_INCUMBENT"
    elif not qualifies:
        assessment["decision"] = "INITIAL_BASELINE_THRESHOLD_NOT_MET"
        assessment["reason"] = "The candidate beat the incumbent but did not clear the absolute quality floor."
    else:
        assessment["decision"] = "CANDIDATE_OUTPERFORMS_INCUMBENT"
    return qualifies, assessment


def apply_audit_verdict(
    assessment: dict[str, Any],
    audit: Mapping[str, Any],
    *,
    override_suspicious: bool,
) -> bool:
    """Fold a leakage verdict into an otherwise-passing assessment.

    Returns whether promotion may still proceed. The verdict is recorded either
    way, so a promoted model carries the evidence that cleared it and a refused
    one carries the reason it did not.
    """

    assessment["leakageAudit"] = dict(audit)
    if audit.get("verdict") == "PASS":
        return True
    if override_suspicious:
        assessment["overriddenLeakageAudit"] = True
        return True
    assessment["decision"] = "LEAKAGE_AUDIT_REQUIRES_INVESTIGATION"
    assessment["reason"] = str(audit.get("summary", "The leakage audit did not pass."))
    return False


def json_output(value: Mapping[str, Any]) -> None:
    print(json.dumps(value, sort_keys=True, default=str))


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        from dotenv import load_dotenv
    except ImportError as error:
        parser.error("python-dotenv is required to run ML training. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env/environment).")
    # One canonical symbol drives the DatasetRequest so every downstream contract
    # (labelling, schema, artifact gate) keeps exactly one shape. For a pooled run it
    # is the first member, and the full roster travels separately.
    pooled_instruments: tuple[str, ...] = ()
    if args.instruments:
        seen: list[str] = []
        for raw in args.instruments.split(","):
            symbol = raw.strip().upper()
            if not symbol:
                continue
            if symbol in seen:
                parser.error(f"--instruments lists {symbol} more than once.")
            seen.append(symbol)
        if len(seen) < 2:
            parser.error("--instruments needs at least two symbols; use --instrument for one.")
        pooled_instruments = tuple(seen)
    primary_symbol = pooled_instruments[0] if pooled_instruments else args.instrument.upper()

    request = DatasetRequest(
        instrument_symbol=primary_symbol,
        timeframe=args.timeframe,
        data_window_start=parse_timestamp(args.data_window_start),
        data_window_end=parse_timestamp(args.data_window_end, end_of_day=True),
        data_cutoff_at=(parse_timestamp(args.data_cutoff_at) if args.data_cutoff_at else datetime.now(timezone.utc)),
        horizon_bars=args.horizon_bars,
        neutral_threshold_bps=(
            args.neutral_threshold_bps
            if args.neutral_threshold_bps is not None
            else default_neutral_threshold_bps(args.timeframe)
        ),
        label_scheme=args.label_scheme,
        barrier_upper_multiple=args.barrier_upper_multiple,
        barrier_lower_multiple=args.barrier_lower_multiple,
        expansion_band=args.expansion_band,
    )
    if request.data_window_end <= request.data_window_start:
        parser.error("--to must be after --from.")
    if request.data_window_end > request.data_cutoff_at:
        parser.error("--to must not be later than --data-cutoff-at.")
    if args.random_state < 0:
        parser.error("--random-state must be non-negative.")
    hyperparameters = selected_hyperparameters(args, parser)
    # The alphabet follows the scheme. A volatility model predicts
    # CONTRACTION/STABLE/EXPANSION, which must never be scored, explained, or
    # persisted as though it were a directional call.
    is_volatility = request.label_scheme == LABEL_SCHEME_VOLATILITY_EXPANSION
    alphabet: LabelAlphabet = VOLATILITY_ALPHABET if is_volatility else DIRECTIONAL_ALPHABET
    # The 0.38 directional floor was calibrated against a ~0.33 random baseline
    # and a majority-class macro-F1 near 0.19. The volatility target's trivial
    # baseline is far lower (~0.15-0.22 measured), so 0.38 would be a much
    # weaker bar there than it looks; 0.40 keeps the floor genuinely selective
    # for a target whose models reach 0.42-0.46.
    minimum_initial_macro_f1 = (
        args.minimum_initial_macro_f1
        if args.minimum_initial_macro_f1 is not None
        else (0.40 if is_volatility else 0.38)
    )
    if args.feature_schema is not None and args.timeframe in SCALP_TIMEFRAMES:
        parser.error("--feature-schema applies only to swing timeframes; scalp timeframes keep their own schema.")
    schema_version = args.feature_schema or schema_version_for(args.timeframe)
    model_key = args.model_key or default_model_key(
        request, args.algorithm, schema_version, pooled_instruments=pooled_instruments
    )

    try:
        import psycopg
    except ImportError as error:
        parser.error("psycopg is required to run ML training. Install apps/ml/requirements.txt first.")
        raise AssertionError("parser.error exits") from error  # pragma: no cover - helps type checkers only

    trained_at = datetime.now(timezone.utc)
    # Autocommit keeps read queries from holding an implicit transaction open;
    # model mutations use the repository's explicit, atomic transactions.
    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)

        # Fail-closed data-readiness gate (Phase 25, Workstream A): no fitting
        # until the latest audit clears every series this run will read. The
        # provenance travels in validationProtocol.dataReadiness so the artifact
        # can prove which audit it trained under.
        gated_symbols = list(pooled_instruments) if pooled_instruments else [primary_symbol]
        if args.allow_unaudited_data:
            data_readiness: dict[str, Any] = {"enforced": False, "reason": "--allow-unaudited-data"}
            print(
                "warning: data-readiness gate skipped via --allow-unaudited-data; "
                "this artifact will record that it trained unaudited.",
                file=sys.stderr,
            )
        else:
            try:
                data_readiness = {
                    "enforced": True,
                    **require_series_ready(
                        load_latest_report(connection),
                        gated_symbols,
                        args.timeframe,
                        trained_at,
                    ),
                }
            except DataReadinessError as error:
                json_output(
                    {
                        "level": "error",
                        "message": "Training refused by the data-readiness gate",
                        "reason": str(error),
                        "instruments": gated_symbols,
                        "timeframe": args.timeframe,
                    }
                )
                return 1

        def label(records_for_symbol: Sequence[Any], symbol_request: DatasetRequest) -> Sequence[LabeledExample]:
            if symbol_request.label_scheme == LABEL_SCHEME_TRIPLE_BARRIER:
                return build_triple_barrier_examples(records_for_symbol, symbol_request)
            if is_volatility:
                return build_volatility_expansion_examples(records_for_symbol, symbol_request)
            return build_labeled_examples(records_for_symbol, symbol_request)

        # Each instrument is loaded and labelled against its *own* history. Labels and
        # trailing-window features must never be computed across a concatenated frame:
        # SBIN's forward return is not INFY's, and a rolling window that straddles two
        # symbols is meaningless. Pooling happens only after labelling, on rows.
        per_instrument_rows: dict[str, int] = {}
        if pooled_instruments:
            pooled: list[LabeledExample] = []
            records = []
            for symbol in pooled_instruments:
                symbol_request = dataclasses.replace(request, instrument_symbol=symbol)
                symbol_records = repository.load_candle_evidence(symbol_request)
                symbol_examples = list(label(symbol_records, symbol_request))
                per_instrument_rows[symbol] = len(symbol_examples)
                if not symbol_examples:
                    print(
                        f"warning: {symbol} contributed no labelled rows and is absent from the pool.",
                        file=sys.stderr,
                    )
                records.extend(symbol_records)
                pooled.extend(symbol_examples)
            if not pooled:
                raise SystemExit("No pooled instrument produced a labelled row.")
            examples = pooled
        else:
            records = repository.load_candle_evidence(request)
            examples = list(label(records, request))
            per_instrument_rows[request.instrument_symbol] = len(examples)

        if pooled_instruments:
            # Row offsets stop measuring time once instruments share a timestamp, so
            # folds are cut on sessions and the purge is evaluated on real label
            # timestamps. See pooled_walk_forward_splits for what row arithmetic would
            # have leaked here.
            splits = pooled_walk_forward_splits(
                examples,
                folds=args.folds,
                validation_fraction=args.validation_fraction,
            )
        else:
            splits = walk_forward_splits(
                examples,
                horizon_bars=request.horizon_bars,
                folds=args.folds,
                validation_fraction=args.validation_fraction,
            )
        # Progress goes to stderr: stdout carries exactly one JSON object so the
        # command stays machine-readable.
        print(f"Created {len(splits)} temporal split(s).", file=sys.stderr)

        # Each fold is fitted on its own expanding training window. Training once
        # and scoring every fold would put earlier folds' validation rows inside
        # the training set, which is the leak this whole phase exists to prevent.
        fold_results: list[BaselineTrainingResult] = []
        for index, split in enumerate(splits, start=1):
            fold_result = train_model(
                args.algorithm,
                split,
                schema=feature_schema(schema_version),
                random_state=args.random_state,
                hyperparameters=hyperparameters,
                alphabet=alphabet,
            )
            fold_results.append(fold_result)
            print(
                f"Fold {index}/{len(splits)} holdout macro-F1: {fold_result.validation_metrics.macro_f1:.4f}",
                file=sys.stderr,
            )

        # The final fold is the most recent period, so its model is the one
        # persisted and offered for promotion.
        final_split = splits[-1]
        result = fold_results[-1]
        folds = fold_summary(fold_results)
        if len(splits) > 1:
            print(
                f"Walk-forward mean macro-F1: {folds['meanMacroF1']:.4f} "
                f"(spread {folds['spreadMacroF1']:.4f} across {folds['folds']} folds)",
                file=sys.stderr,
            )

        # Research-only second opinion. Walk-forward scores only the trailing
        # `validation_fraction`, so a candidate's whole reputation rests on one
        # recent window; CPCV scores every block and reports how much that number
        # moves. It is deliberately kept out of `gate_scores` below: CPCV trains on
        # later data to score earlier data, which is a fair robustness question and
        # an unfair deployment simulation, so it must never decide a promotion.
        cpcv: dict[str, Any] | None = None
        if args.cpcv_groups:
            cpcv_splits = combinatorial_purged_splits(
                examples,
                groups=args.cpcv_groups,
                test_groups=args.cpcv_test_groups,
                embargo_fraction=args.cpcv_embargo_fraction,
            )
            print(f"Running CPCV over {len(cpcv_splits)} combination(s).", file=sys.stderr)
            cpcv_model_metrics: list[EvaluationMetrics] = []
            cpcv_trivial_metrics: list[EvaluationMetrics] = []
            for index, split in enumerate(cpcv_splits, start=1):
                cpcv_result = train_model(
                    args.algorithm,
                    split,
                    schema=feature_schema(schema_version),
                    random_state=args.random_state,
                    hyperparameters=hyperparameters,
                    alphabet=alphabet,
                )
                trivial = trivial_majority_metrics(split, alphabet=alphabet)
                cpcv_model_metrics.append(cpcv_result.validation_metrics)
                cpcv_trivial_metrics.append(trivial)
                print(
                    f"CPCV {index}/{len(cpcv_splits)} "
                    f"macroF1 {cpcv_result.validation_metrics.macro_f1:.4f} vs {trivial.macro_f1:.4f} | "
                    f"acc {cpcv_result.validation_metrics.accuracy:.4f} vs {trivial.accuracy:.4f}",
                    file=sys.stderr,
                )
            cpcv = cpcv_summary(
                cpcv_model_metrics,
                cpcv_trivial_metrics,
                groups=args.cpcv_groups,
                test_groups=args.cpcv_test_groups,
                embargo_fraction=args.cpcv_embargo_fraction,
            )
            print(
                f"CPCV macro-F1 {cpcv['macroF1']['mean']:.4f} "
                f"(std {cpcv['macroF1']['std']:.4f}) vs trivial {cpcv['trivialMacroF1']['mean']:.4f} "
                f"-> {cpcv['macroF1MinusTrivial']['mean']:+.4f}, "
                f"won {cpcv['macroF1WinRateVsTrivial'] * 100:.0f}% of splits",
                file=sys.stderr,
            )
            print(
                f"CPCV accuracy {cpcv['accuracy']['mean']:.4f} "
                f"(std {cpcv['accuracy']['std']:.4f}) vs trivial {cpcv['trivialAccuracy']['mean']:.4f} "
                f"-> {cpcv['accuracyMinusTrivial']['mean']:+.4f}, "
                f"won {cpcv['accuracyWinRateVsTrivial'] * 100:.0f}% of splits",
                file=sys.stderr,
            )

        protocol = {
            **validation_protocol(
                request,
                validation_fraction=args.validation_fraction,
                purge_count=final_split.purge_count,
                split_train=final_split.train,
                split_validation=final_split.validation,
            ),
            "walkForward": folds,
            # Which data-readiness audit cleared this run (or the recorded fact
            # that the gate was skipped). Part of the checksummed artifact.
            "dataReadiness": data_readiness,
        }
        if len(splits) > 1:
            protocol["method"] = "WALK_FORWARD_PURGED_V1"
        if pooled_instruments:
            # Overrides any chronological name above: the distribution this score
            # averages over is different, and the gate must be able to tell.
            protocol["method"] = POOLED_WALK_FORWARD_METHOD_NAME
            protocol["pooledInstruments"] = list(pooled_instruments)
            protocol["pooledRowsByInstrument"] = per_instrument_rows
            protocol["pooledObservationTimes"] = len({item.observed_at for item in examples})
        if cpcv is not None:
            protocol["crossValidation"] = cpcv
        artifact_metadata = {
            **training_metadata(result, schema_version),
            "modelKey": model_key,
            "trainedAt": trained_at.isoformat(),
            "dataset": {
                "instrument": request.instrument_symbol,
                "timeframe": request.timeframe,
                "labeledRows": len(examples),
                # Recorded so inference can tell a pooled artifact from a
                # single-instrument one and admit exactly the members it saw. Absent for
                # a single-instrument run, which keeps every existing artifact's
                # metadata byte-identical.
                **({"pooledInstruments": list(pooled_instruments)} if pooled_instruments else {}),
            },
            # The artifact gate and Phase 11 inference both require this block, so
            # it must travel inside the checksummed payload, not only in the
            # database row.
            "validationProtocol": protocol,
            # Phase 11 uses only this training partition—never validation rows—
            # to explain label agreement among nearby historical setups.
            "trainingReferenceSet": build_reference_metadata(
                final_split.train, schema=result.feature_schema, alphabet=alphabet
            ),
        }
        destination = artifact_path(args.artifact_dir, model_key, trained_at)
        written_artifact = write_model_artifact(destination, model=result.model, metadata=artifact_metadata)
        validate_candidate_artifact(
            path=written_artifact.path,
            expected_checksum=written_artifact.checksum,
            expected_schema=result.feature_schema,
            schema_version=schema_version,
            model_key=model_key,
            algorithm=result.algorithm,
            request=request,
        )

        incumbent = repository.get_production_model(model_key)
        incumbent_metrics: EvaluationMetrics | None = None
        incumbent_error: str | None = None
        if incumbent is not None:
            incumbent_metrics, incumbent_error = evaluate_incumbent(
                incumbent,
                final_split.validation,
                expected_schema=result.feature_schema,
                schema_version=schema_version,
                request=request,
                alphabet=alphabet,
            )

        qualifies_for_promotion, assessment = promotion_assessment(
            candidate=result,
            incumbent=incumbent,
            incumbent_metrics=incumbent_metrics,
            incumbent_error=incumbent_error,
            minimum_improvement=args.minimum_improvement,
            minimum_initial_macro_f1=minimum_initial_macro_f1,
            maximum_plausible_macro_f1=args.maximum_plausible_macro_f1,
            override_suspicious=args.override_suspicious,
            minimum_validation_rows=args.minimum_validation_rows,
            minimum_directional_predictions=args.minimum_directional_predictions,
            folds=folds,
        )

        # The audit is expensive — it fits three extra models — so it only runs
        # when promotion is actually requested. It must run before the candidate
        # row is written, so its verdict is persisted alongside the decision it
        # influenced rather than being lost.
        audit_result: dict[str, Any] | None = None
        if args.promote and qualifies_for_promotion:
            # Inline on this exact dataset, so the verdict cannot be a stale result
            # from another experiment. Hyperparameters are the trainer's own keyword
            # arguments, not the camelCase metadata form.
            audit_result = run_leakage_audit(
                examples=examples,
                algorithm=args.algorithm,
                horizon_bars=request.horizon_bars,
                schema=result.feature_schema,
                hyperparameters=hyperparameters,
                random_state=args.random_state,
                validation_fraction=args.validation_fraction,
                alphabet=alphabet,
                # Volatility clusters, so a stale feature vector predicts the next
                # window's range about as well as the current one. The feature-lag
                # check cannot discriminate under that persistence, and must report
                # inconclusive rather than a false leakage failure.
                persistence_dominated=is_volatility,
            )
            print(f"Leakage audit verdict: {audit_result['verdict']}", file=sys.stderr)
            qualifies_for_promotion = apply_audit_verdict(
                assessment, audit_result, override_suspicious=args.override_suspicious,
            )

        validation_metrics = {
            **training_metadata(result, schema_version),
            "validationProtocol": protocol,
            "promotionAssessment": assessment,
        }
        candidate = repository.create_candidate_model(
            model_key=model_key,
            algorithm=result.algorithm,
            artifact_uri=str(written_artifact.path.resolve()),
            artifact_checksum=written_artifact.checksum,
            feature_schema=feature_schema_rows(result.feature_schema, schema_version),
            training_window_start=final_split.train[0].observed_at,
            training_window_end=final_split.train[-1].observed_at,
            training_rows=result.training_rows,
            validation_metrics=validation_metrics,
            trained_at=trained_at,
        )

        promoted: PersistedModelVersion | None = None
        if args.promote and qualifies_for_promotion:
            validate_candidate_artifact(
                path=written_artifact.path,
                expected_checksum=written_artifact.checksum,
                expected_schema=result.feature_schema,
                schema_version=schema_version,
                model_key=model_key,
                algorithm=result.algorithm,
                request=request,
            )
            promoted = repository.promote_candidate(
                model_version_id=candidate.id,
                expected_previous_model_id=None if incumbent is None else incumbent.id,
                comparison=assessment,
            )

    json_output(
        {
            "level": "info",
            "message": "ML training complete",
            "modelKey": model_key,
            "algorithm": result.algorithm,
            "hyperparameters": dict(result.hyperparameters),
            "candidateModelVersionId": candidate.id,
            "candidateVersion": candidate.version,
            "candidateStage": candidate.stage,
            "artifactPath": str(written_artifact.path),
            "artifactChecksum": written_artifact.checksum,
            "recordsRead": len(records),
            "labeledRows": len(examples),
            "trainingRows": result.training_rows,
            "validationRows": result.validation_rows,
            "purgeBars": final_split.purge_count,
            "validationMetrics": metrics_to_mapping(result.validation_metrics),
            "walkForward": folds,
            "promotionRequested": args.promote,
            "promotionEligible": qualifies_for_promotion,
            "promotionAssessment": assessment,
            "promotedModelVersionId": None if promoted is None else promoted.id,
            "promotedVersion": None if promoted is None else promoted.version,
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        json_output({"level": "error", "message": "ML training interrupted before completion."})
        raise SystemExit(130)
    except Exception as error:  # noqa: BLE001 - CLI boundary intentionally turns failures into a compact local log.
        json_output({"level": "error", "message": str(error), "errorType": type(error).__name__})
        raise SystemExit(1)
