"""Stage 5 compact TCN research runner (NIFTYBEES 1m, volatility-expansion).

Kept separate from ``train.py`` so the default tree path stays free of PyTorch.
Authorized only when ``npm run data:audit:sequence`` reports PASS for the
requested candidate. Compares the TCN against a LightGBM lag-feature baseline
on identical purged sequence folds.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from ai_quant_lab_ml.artifacts import write_model_artifact
from ai_quant_lab_ml.contracts import (
    FEATURE_SCHEMA_VERSION_SCALP,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
    DatasetRequest,
)
from ai_quant_lab_ml.data_readiness import DataReadinessError, load_latest_report, require_series_ready
from ai_quant_lab_ml.features import build_volatility_expansion_examples, feature_schema
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository
from ai_quant_lab_ml.sequence_readiness import (
    SequenceReadinessError,
    load_latest_sequence_report,
    require_sequence_candidate_pass,
)
from ai_quant_lab_ml.sequences import (
    SequenceError,
    build_intrasession_sequences,
    sequence_purged_walk_forward,
)
from ai_quant_lab_ml.tcn_explain import temporal_occlusion_contributions
from ai_quant_lab_ml.tcn_model import TCN_ALGORITHM, TcnDependencyError
from ai_quant_lab_ml.tcn_training import train_lag_lightgbm_baseline, train_tcn_classifier
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET
from train import DEFAULT_ARTIFACT_DIRECTORY, json_output, parse_timestamp, positive_int, strict_unit_interval


ROOT = Path(__file__).resolve().parents[2]
AUTHORIZED_SYMBOL = "NIFTYBEES"
AUTHORIZED_TIMEFRAME = "1m"
AUTHORIZED_CANDIDATE = "tcn-1m"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train a compact causal TCN research candidate.")
    parser.add_argument("--instrument", default=AUTHORIZED_SYMBOL, help="Must be NIFTYBEES for Stage 5.")
    parser.add_argument("--timeframe", default=AUTHORIZED_TIMEFRAME, help="Must be 1m for Stage 5.")
    parser.add_argument("--from", dest="data_window_start", required=True)
    parser.add_argument("--to", dest="data_window_end", required=True)
    parser.add_argument("--data-cutoff-at")
    parser.add_argument("--horizon-bars", type=positive_int, default=5)
    parser.add_argument("--expansion-band", type=float, default=0.25)
    parser.add_argument("--lookback", type=positive_int, default=64)
    parser.add_argument("--folds", type=positive_int, default=3)
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2)
    parser.add_argument("--epochs", type=positive_int, default=40)
    parser.add_argument("--channels", type=positive_int, default=16)
    parser.add_argument("--batch-size", type=positive_int, default=256)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIRECTORY)
    parser.add_argument("--database-url")
    parser.add_argument(
        "--allow-unaudited-data",
        action="store_true",
        help="Skip data-readiness and sequence-readiness gates (research only; recorded in the artifact).",
    )
    return parser


def metrics_mapping(metrics: Any) -> dict[str, Any]:
    return {
        "accuracy": metrics.accuracy,
        "balancedAccuracy": metrics.balanced_accuracy,
        "macroF1": metrics.macro_f1,
        "directionalPredictions": metrics.directional_predictions,
        "directionalHitRate": metrics.directional_hit_rate,
        "coverage": metrics.coverage,
        "sampleCount": metrics.sample_count,
        "classCounts": dict(metrics.class_counts),
    }


def trivial_macro_f1(labels: list[str], alphabet_labels: tuple[str, ...]) -> float:
    if not labels:
        return float("nan")
    from collections import Counter

    counts = Counter(labels)
    majority = counts.most_common(1)[0][0]
    predicted = [majority] * len(labels)
    # Reuse evaluate_predictions for an honest trivial baseline.
    from ai_quant_lab_ml.training import evaluate_predictions

    return evaluate_predictions(labels, predicted, alphabet=VOLATILITY_ALPHABET).macro_f1


def main(argv: list[str] | None = None) -> int:
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT / "apps" / "ml" / ".env", override=False)
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.instrument.upper() != AUTHORIZED_SYMBOL or args.timeframe != AUTHORIZED_TIMEFRAME:
        parser.error(
            f"Stage 5 authorizes only {AUTHORIZED_SYMBOL} {AUTHORIZED_TIMEFRAME} "
            f"({AUTHORIZED_CANDIDATE}). Re-run sequence-readiness before expanding."
        )
    if args.expansion_band <= 0 or not math.isfinite(args.expansion_band):
        parser.error("--expansion-band must be a finite number > 0.")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required.")

    request = DatasetRequest(
        instrument_symbol=AUTHORIZED_SYMBOL,
        timeframe=AUTHORIZED_TIMEFRAME,
        data_window_start=parse_timestamp(args.data_window_start),
        data_window_end=parse_timestamp(args.data_window_end, end_of_day=True),
        data_cutoff_at=(parse_timestamp(args.data_cutoff_at) if args.data_cutoff_at else datetime.now(timezone.utc)),
        horizon_bars=args.horizon_bars,
        neutral_threshold_bps=0.0,
        label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION,
        expansion_band=args.expansion_band,
    )
    if request.data_window_end <= request.data_window_start:
        parser.error("--to must be after --from.")
    if request.data_window_end > request.data_cutoff_at:
        parser.error("--to must not be later than --data-cutoff-at.")

    schema_version = FEATURE_SCHEMA_VERSION_SCALP
    schema = feature_schema(schema_version)
    trained_at = datetime.now(timezone.utc)

    try:
        import psycopg
    except ImportError as error:
        parser.error("psycopg is required. Install apps/ml/requirements.txt first.")
        raise AssertionError from error

    try:
        with psycopg.connect(database_url, autocommit=True) as connection:
            if args.allow_unaudited_data:
                data_readiness: dict[str, Any] = {"enforced": False, "reason": "--allow-unaudited-data"}
                sequence_readiness: dict[str, Any] = {"enforced": False, "reason": "--allow-unaudited-data"}
                print("warning: readiness gates skipped via --allow-unaudited-data", file=sys.stderr)
            else:
                try:
                    data_readiness = {
                        "enforced": True,
                        **require_series_ready(
                            load_latest_report(connection),
                            [AUTHORIZED_SYMBOL],
                            AUTHORIZED_TIMEFRAME,
                            trained_at,
                        ),
                    }
                    sequence_readiness = {
                        "enforced": True,
                        **require_sequence_candidate_pass(
                            load_latest_sequence_report(connection),
                            symbol=AUTHORIZED_SYMBOL,
                            timeframe=AUTHORIZED_TIMEFRAME,
                            candidate=AUTHORIZED_CANDIDATE,
                            as_of=trained_at,
                        ),
                    }
                except (DataReadinessError, SequenceReadinessError) as error:
                    json_output({
                        "level": "error",
                        "message": "TCN research refused by a readiness gate",
                        "reason": str(error),
                    })
                    return 1

            repository = PostgresMlRepository(connection)
            records = repository.load_candle_evidence(request)
            labeled = list(build_volatility_expansion_examples(records, request))
            if not labeled:
                json_output({"level": "error", "message": "No labelled rows for TCN training"})
                return 1

            try:
                sequences = build_intrasession_sequences(
                    labeled,
                    lookback=args.lookback,
                    feature_names=schema,
                    timeframe=AUTHORIZED_TIMEFRAME,
                )
                splits = sequence_purged_walk_forward(
                    sequences,
                    folds=args.folds,
                    validation_fraction=args.validation_fraction,
                )
            except SequenceError as error:
                json_output({"level": "error", "message": str(error)})
                return 1

            fold_rows: list[dict[str, Any]] = []
            for index, split in enumerate(splits, start=1):
                print(
                    f"Fold {index}/{len(splits)}: train={len(split.train)} val={len(split.validation)} "
                    f"purged={split.purge_count}",
                    file=sys.stderr,
                )
                try:
                    tcn = train_tcn_classifier(
                        split,
                        alphabet=VOLATILITY_ALPHABET,
                        lookback=args.lookback,
                        channels=args.channels,
                        epochs=args.epochs,
                        batch_size=args.batch_size,
                        random_state=args.random_state,
                    )
                except TcnDependencyError as error:
                    json_output({"level": "error", "message": str(error)})
                    return 1

                baseline = train_lag_lightgbm_baseline(
                    split,
                    alphabet=VOLATILITY_ALPHABET,
                    random_state=args.random_state,
                )
                val_labels = [example.label for example in split.validation]
                trivial = trivial_macro_f1(val_labels, VOLATILITY_ALPHABET.labels)
                explanation = temporal_occlusion_contributions(
                    tcn.model,
                    split.validation[0],
                    medians=tcn.hyperparameters["featureMedians"],
                    alphabet=VOLATILITY_ALPHABET,
                )
                fold_rows.append({
                    "fold": index,
                    "purgeCount": split.purge_count,
                    "trainingRows": tcn.training_rows,
                    "validationRows": tcn.validation_rows,
                    "tcn": {
                        "macroF1": tcn.validation_metrics.macro_f1,
                        "accuracy": tcn.validation_metrics.accuracy,
                        "parameterCount": tcn.parameter_count,
                    },
                    "lagLightgbm": {
                        "macroF1": baseline.validation_metrics.macro_f1,
                        "accuracy": baseline.validation_metrics.accuracy,
                    },
                    "trivialMacroF1": trivial,
                    "beatsTrivial": tcn.validation_metrics.macro_f1 > trivial,
                    "beatsLagBaseline": tcn.validation_metrics.macro_f1 > baseline.validation_metrics.macro_f1,
                    "explanationSample": {
                        "contributionMethod": explanation["contributionMethod"],
                        "prediction": explanation["prediction"],
                        "topBlocks": explanation["blocks"][:3],
                    },
                })
                print(
                    f"  TCN macro-F1={tcn.validation_metrics.macro_f1:.4f} "
                    f"lag-LGBM={baseline.validation_metrics.macro_f1:.4f} "
                    f"trivial={trivial:.4f} params={tcn.parameter_count}",
                    file=sys.stderr,
                )

            # Fit a final model on the last fold's training partition for the artifact.
            final_split = splits[-1]
            final = train_tcn_classifier(
                final_split,
                alphabet=VOLATILITY_ALPHABET,
                lookback=args.lookback,
                channels=args.channels,
                epochs=args.epochs,
                batch_size=args.batch_size,
                random_state=args.random_state,
            )
            mean_tcn = sum(row["tcn"]["macroF1"] for row in fold_rows) / len(fold_rows)
            mean_lgbm = sum(row["lagLightgbm"]["macroF1"] for row in fold_rows) / len(fold_rows)
            mean_trivial = sum(row["trivialMacroF1"] for row in fold_rows) / len(fold_rows)
            advances = (
                all(row["beatsTrivial"] for row in fold_rows)
                and mean_tcn > mean_lgbm
            )

            model_key = (
                f"volatility-expansion-tcn--{AUTHORIZED_SYMBOL}--{AUTHORIZED_TIMEFRAME}"
                f"--h{args.horizon_bars}--lookback{args.lookback}"
                f"--{schema_version}--{LABEL_SCHEME_VOLATILITY_EXPANSION}"
                f"--band{args.expansion_band}"
            )
            artifact_dir = Path(args.artifact_dir) / model_key
            artifact_dir.mkdir(parents=True, exist_ok=True)
            stamp = trained_at.strftime("%Y%m%dT%H%M%S%fZ")
            artifact_path = artifact_dir / f"{stamp}-tcn.pkl"
            metadata = {
                "algorithm": TCN_ALGORITHM,
                "modelKey": model_key,
                "trainedAt": trained_at.isoformat(),
                "featureSchemaVersion": schema_version,
                "featureSchema": list(schema),
                "lookback": args.lookback,
                "parameterCount": final.parameter_count,
                "hyperparameters": dict(final.hyperparameters),
                "labels": list(VOLATILITY_ALPHABET.labels),
                "dataset": {
                    "instrument": AUTHORIZED_SYMBOL,
                    "timeframe": AUTHORIZED_TIMEFRAME,
                    "instrumentSemantics": "ETF_PROXY",
                    "labeledRows": len(labeled),
                    "sequenceRows": len(sequences),
                },
                "validationProtocol": {
                    "method": "SEQUENCE_PURGED_WALK_FORWARD_V1",
                    "labelScheme": LABEL_SCHEME_VOLATILITY_EXPANSION,
                    "expansionBand": args.expansion_band,
                    "horizonBars": args.horizon_bars,
                    "lookback": args.lookback,
                    "folds": args.folds,
                    "sessionBoundaryPolicy": "NO_OVERNIGHT_CROSSING",
                    "dataReadiness": data_readiness,
                    "sequenceReadiness": sequence_readiness,
                    "walkForward": fold_rows,
                    "meanTcnMacroF1": mean_tcn,
                    "meanLagLightgbmMacroF1": mean_lgbm,
                    "meanTrivialMacroF1": mean_trivial,
                    "researchAdvances": advances,
                },
                "trainingMetrics": metrics_mapping(final.training_metrics),
                "validationMetrics": metrics_mapping(final.validation_metrics),
                "enrollment": {
                    "eod": False,
                    "reason": (
                        "TCN beat lag LightGBM and trivial on every fold"
                        if advances
                        else "TCN did not clear Stage 5 acceptance vs lag baseline/trivial"
                    ),
                },
            }
            written = write_model_artifact(artifact_path, model=final.model, metadata=metadata)
            json_output({
                "level": "info",
                "message": "TCN research run complete",
                "algorithm": TCN_ALGORITHM,
                "modelKey": model_key,
                "artifactPath": str(written.path),
                "artifactChecksum": written.checksum,
                "sequenceRows": len(sequences),
                "lookback": args.lookback,
                "parameterCount": final.parameter_count,
                "walkForward": fold_rows,
                "meanTcnMacroF1": mean_tcn,
                "meanLagLightgbmMacroF1": mean_lgbm,
                "meanTrivialMacroF1": mean_trivial,
                "researchAdvances": advances,
                "enrollment": metadata["enrollment"],
            })
            return 0
    except Exception as error:  # noqa: BLE001 - CLI boundary
        json_output({"level": "error", "message": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
