"""Stage 6 OOF logistic stack research runner (NIFTYBEES 1m).

Stacks the Stage 5 TCN against the lag-LightGBM baseline on identical purged
sequence folds. Meta-learner trains on earlier OOF folds and is evaluated on the
final untouched fold. Kept separate from ``train.py`` / ``train_tcn.py``.
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
from ai_quant_lab_ml.sequences import SequenceError, build_intrasession_sequences, sequence_purged_walk_forward
from ai_quant_lab_ml.stack_explain import explain_stack_prediction
from ai_quant_lab_ml.stacking import (
    NESTED_VALIDATION_METHOD,
    STACK_ALGORITHM,
    meta_coefficients,
    train_oof_stack,
)
from ai_quant_lab_ml.tcn_model import TcnDependencyError
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET
from train import DEFAULT_ARTIFACT_DIRECTORY, json_output, parse_timestamp, positive_int, strict_unit_interval
from train_tcn import metrics_mapping


ROOT = Path(__file__).resolve().parents[2]
AUTHORIZED_SYMBOL = "NIFTYBEES"
AUTHORIZED_TIMEFRAME = "1m"
AUTHORIZED_CANDIDATE = "tcn-1m"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Train a leakage-safe OOF logistic stack.")
    parser.add_argument("--instrument", default=AUTHORIZED_SYMBOL)
    parser.add_argument("--timeframe", default=AUTHORIZED_TIMEFRAME)
    parser.add_argument("--from", dest="data_window_start", required=True)
    parser.add_argument("--to", dest="data_window_end", required=True)
    parser.add_argument("--data-cutoff-at")
    parser.add_argument("--horizon-bars", type=positive_int, default=5)
    parser.add_argument("--expansion-band", type=float, default=0.25)
    parser.add_argument("--lookback", type=positive_int, default=64)
    parser.add_argument("--folds", type=positive_int, default=3)
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2)
    parser.add_argument("--epochs", type=positive_int, default=25)
    parser.add_argument("--channels", type=positive_int, default=16)
    parser.add_argument("--batch-size", type=positive_int, default=256)
    parser.add_argument("--meta-c", type=float, default=1.0)
    parser.add_argument("--random-state", type=int, default=42)
    parser.add_argument("--artifact-dir", type=Path, default=DEFAULT_ARTIFACT_DIRECTORY)
    parser.add_argument("--database-url")
    parser.add_argument(
        "--allow-unaudited-data",
        action="store_true",
        help="Skip data-readiness and sequence-readiness gates (research only).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    load_dotenv(ROOT / ".env")
    load_dotenv(ROOT / "apps" / "ml" / ".env", override=False)
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.instrument.upper() != AUTHORIZED_SYMBOL or args.timeframe != AUTHORIZED_TIMEFRAME:
        parser.error(
            f"Stage 6 authorizes only {AUTHORIZED_SYMBOL} {AUTHORIZED_TIMEFRAME} "
            f"(bases cleared under {AUTHORIZED_CANDIDATE})."
        )
    if args.folds < 2:
        parser.error("--folds must be at least 2 (earlier OOF train + later holdout).")
    if args.expansion_band <= 0 or not math.isfinite(args.expansion_band):
        parser.error("--expansion-band must be a finite number > 0.")
    if args.meta_c <= 0 or not math.isfinite(args.meta_c):
        parser.error("--meta-c must be a finite number > 0.")

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
    except ImportError:
        parser.error("psycopg is required. Install apps/ml/requirements.txt first.")
        return 1

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
                        "message": "Stack research refused by a readiness gate",
                        "reason": str(error),
                    })
                    return 1

            repository = PostgresMlRepository(connection)
            records = repository.load_candle_evidence(request)
            labeled = list(build_volatility_expansion_examples(records, request))
            if not labeled:
                json_output({"level": "error", "message": "No labelled rows for stack training"})
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

            def progress(message: str) -> None:
                print(message, file=sys.stderr)

            try:
                result, fits, oof_rows = train_oof_stack(
                    splits,
                    lookback=args.lookback,
                    channels=args.channels,
                    epochs=args.epochs,
                    batch_size=args.batch_size,
                    random_state=args.random_state,
                    meta_c=args.meta_c,
                    progress=progress,
                )
            except TcnDependencyError as error:
                json_output({"level": "error", "message": str(error)})
                return 1

            holdout_rows = [row for row in oof_rows if row.fold == result.holdout_fold]
            holdout_fit = fits[result.holdout_fold - 1]
            sample_sequence = next(
                seq for seq in splits[result.holdout_fold - 1].validation
                if seq.candle_id == holdout_rows[0].candle_id
            )
            explanation = explain_stack_prediction(
                result.model,
                sequence=sample_sequence,
                tcn_model=holdout_fit.tcn_model,
                tcn_medians=holdout_fit.tcn_medians,
                tcn_proba=holdout_rows[0].tcn_proba,
                lag_lgbm_proba=holdout_rows[0].lag_lgbm_proba,
            )

            fold_summaries = []
            for fit in fits:
                fold_summaries.append({
                    "fold": fit.fold,
                    "purgeCount": fit.purge_count,
                    "trainingRows": fit.training_rows,
                    "validationRows": fit.validation_rows,
                    "tcnMacroF1": fit.tcn_metrics.macro_f1,
                    "lagLightgbmMacroF1": fit.lag_lgbm_metrics.macro_f1,
                    "tcnParameterCount": fit.tcn_parameter_count,
                })

            model_key = (
                f"volatility-expansion-stack--{AUTHORIZED_SYMBOL}--{AUTHORIZED_TIMEFRAME}"
                f"--h{args.horizon_bars}--lookback{args.lookback}"
                f"--{schema_version}--{LABEL_SCHEME_VOLATILITY_EXPANSION}"
                f"--band{args.expansion_band}"
            )
            artifact_dir = Path(args.artifact_dir) / model_key
            artifact_dir.mkdir(parents=True, exist_ok=True)
            stamp = trained_at.strftime("%Y%m%dT%H%M%S%fZ")

            # Persist holdout-fold bases so the stack artifact can cite checksums.
            base_artifacts: list[dict[str, Any]] = []
            tcn_base_path = artifact_dir / f"{stamp}-base-tcn.pkl"
            lag_base_path = artifact_dir / f"{stamp}-base-lag-lgbm.pkl"
            tcn_written = write_model_artifact(
                tcn_base_path,
                model=holdout_fit.tcn_model,
                metadata={
                    "algorithm": "pytorch-causal-tcn-v1",
                    "role": "stack-base",
                    "fold": holdout_fit.fold,
                    "featureMedians": list(holdout_fit.tcn_medians),
                    "parameterCount": holdout_fit.tcn_parameter_count,
                },
            )
            lag_written = write_model_artifact(
                lag_base_path,
                model=holdout_fit.lag_lgbm_model,
                metadata={
                    "algorithm": "lightgbm-gradient-boosting-v1",
                    "role": "stack-base",
                    "fold": holdout_fit.fold,
                    "featureSchema": list(holdout_fit.lag_lgbm_schema),
                },
            )
            base_artifacts.append({
                "role": "tcn",
                "path": str(tcn_written.path),
                "checksum": tcn_written.checksum,
                "algorithm": "pytorch-causal-tcn-v1",
            })
            base_artifacts.append({
                "role": "lagLightgbm",
                "path": str(lag_written.path),
                "checksum": lag_written.checksum,
                "algorithm": "lightgbm-gradient-boosting-v1",
            })

            oof_sidecar = artifact_dir / f"{stamp}-oof-folds.json"
            oof_payload = {
                "holdoutFold": result.holdout_fold,
                "rows": [
                    {
                        "candleId": row.candle_id,
                        "fold": row.fold,
                        "observedAt": row.observed_at.isoformat(),
                        "label": str(row.label),
                    }
                    for row in oof_rows
                ],
            }
            oof_sidecar.write_text(
                json.dumps(oof_payload, separators=(",", ":")),
                encoding="utf-8",
            )

            metadata = {
                "algorithm": STACK_ALGORITHM,
                "modelKey": model_key,
                "trainedAt": trained_at.isoformat(),
                "featureSchemaVersion": schema_version,
                "featureSchema": list(schema),
                "metaFeatureNames": list(result.meta_feature_names),
                "labels": list(VOLATILITY_ALPHABET.labels),
                "lookback": args.lookback,
                "hyperparameters": dict(result.hyperparameters),
                "baseArtifacts": base_artifacts,
                "metaCoefficients": meta_coefficients(
                    result.model, result.meta_feature_names, result.labels,
                ),
                "dataset": {
                    "instrument": AUTHORIZED_SYMBOL,
                    "timeframe": AUTHORIZED_TIMEFRAME,
                    "instrumentSemantics": "ETF_PROXY",
                    "labeledRows": len(labeled),
                    "sequenceRows": len(sequences),
                    "oofRows": len(oof_rows),
                },
                "validationProtocol": {
                    "method": NESTED_VALIDATION_METHOD,
                    "labelScheme": LABEL_SCHEME_VOLATILITY_EXPANSION,
                    "expansionBand": args.expansion_band,
                    "horizonBars": args.horizon_bars,
                    "lookback": args.lookback,
                    "folds": args.folds,
                    "holdoutFold": result.holdout_fold,
                    "oofFoldSidecar": str(oof_sidecar),
                    "oofFoldCounts": {
                        str(fold): sum(1 for row in oof_rows if row.fold == fold)
                        for fold in range(1, args.folds + 1)
                    },
                    "outerFolds": fold_summaries,
                    "diversity": {
                        "disagreementRate": result.diversity.disagreement_rate,
                        "errorCorrelation": result.diversity.error_correlation,
                        "bothCorrectRate": result.diversity.both_correct_rate,
                        "bothWrongRate": result.diversity.both_wrong_rate,
                        "passes": result.diversity.passes,
                        "reason": result.diversity.reason,
                    },
                    "calibration": dict(result.calibration),
                    "dataReadiness": data_readiness,
                    "sequenceReadiness": sequence_readiness,
                    "researchAdvances": result.advances,
                },
                "trainingMetrics": metrics_mapping(result.training_metrics),
                "holdoutMetrics": metrics_mapping(result.holdout_metrics),
                "bestBaseHoldout": {
                    "name": result.best_base_name,
                    **metrics_mapping(result.best_base_holdout_metrics),
                },
                "explanationSample": {
                    "contributionMethod": explanation["contributionMethod"],
                    "prediction": explanation["prediction"],
                    "topMetaContributions": explanation["meta"]["topContributions"][:3],
                },
                "enrollment": {
                    "eod": False,
                    "reason": (
                        "Stack beat best base and calibration gate on holdout fold"
                        if result.advances
                        else "Stack did not clear Stage 6 acceptance vs best base/calibration/diversity"
                    ),
                },
            }
            stack_path = artifact_dir / f"{stamp}-stack.pkl"
            written = write_model_artifact(stack_path, model=result.model, metadata=metadata)

            json_output({
                "level": "info",
                "message": "Stack research run complete",
                "algorithm": STACK_ALGORITHM,
                "modelKey": model_key,
                "artifactPath": str(written.path),
                "artifactChecksum": written.checksum,
                "baseArtifacts": base_artifacts,
                "sequenceRows": len(sequences),
                "oofRows": len(oof_rows),
                "holdoutFold": result.holdout_fold,
                "diversity": {
                    "disagreementRate": result.diversity.disagreement_rate,
                    "errorCorrelation": result.diversity.error_correlation,
                    "passes": result.diversity.passes,
                    "reason": result.diversity.reason,
                },
                "holdout": {
                    "stack": metrics_mapping(result.holdout_metrics),
                    "bestBase": {
                        "name": result.best_base_name,
                        **metrics_mapping(result.best_base_holdout_metrics),
                    },
                    "calibration": dict(result.calibration),
                },
                "outerFolds": fold_summaries,
                "beatsBestBase": result.beats_best_base,
                "beatsTrivial": result.beats_trivial,
                "researchAdvances": result.advances,
                "enrollment": metadata["enrollment"],
                "explanationSample": metadata["explanationSample"],
            })
            return 0
    except Exception as error:  # noqa: BLE001 - CLI boundary
        json_output({"level": "error", "message": str(error)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
