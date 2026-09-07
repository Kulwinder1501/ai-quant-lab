"""Rolling-origin walk-forward backfill for a volatility-expansion shadow model.

Why this exists, and why it is separate from the live shadow pool:

The live shadow pool (``predict.py --shadow-scheme``) enforces *no backdating* --
a candidate's track record must start at its enrollment time -- so it cannot be
made to score history. That guard is correct for a live scoreboard and must not
be circumvented. But it means the only way to see how a freshly trained model
*would have* performed if it had been deployed across past regimes is an explicit,
labelled-as-research backtest. That is this script.

It is an expanding-window, train-on-the-past-only simulation. For each of ``--folds``
forward windows it fits the model on every bar before the window and scores the
window it never saw, then reports both metrics against the trivial majority-class
predictor -- the same comparison the CPCV gate uses (``cpcv-accuracy-discriminator``),
because a macro-F1 win with an accuracy loss is the class-spreading artifact, not skill.

It reuses the production label, split, train and evaluation primitives unchanged
(``build_volatility_expansion_examples``, ``walk_forward_splits``, ``train_model``,
``predict_labels``, ``evaluate_predictions``, ``trivial_majority_metrics``), so the
numbers are directly comparable to a training run. It writes NOTHING to the database:
its output is a JSON verdict on stdout, not a model version, prediction, or trade.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT_DIRECTORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_quant_lab_ml.contracts import (  # noqa: E402
    ALGORITHM_CHOICES,
    DatasetRequest,
    LABEL_SCHEME_VOLATILITY_EXPANSION,
    schema_version_for,
)
from ai_quant_lab_ml.features import build_volatility_expansion_examples, feature_schema  # noqa: E402
from ai_quant_lab_ml.postgres_repository import PostgresMlRepository  # noqa: E402
from ai_quant_lab_ml.training import (  # noqa: E402
    evaluate_predictions,
    predict_labels,
    train_model,
)
from ai_quant_lab_ml.validation import walk_forward_splits  # noqa: E402
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET  # noqa: E402
from train import positive_float, positive_int, non_blank, parse_timestamp, strict_unit_interval, trivial_majority_metrics  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Rolling-origin walk-forward backtest of a volatility-expansion model. "
            "Train-on-past-only, forward-scored, reported against the trivial baseline. "
            "Writes nothing to the database."
        ),
    )
    parser.add_argument("--instrument", required=True, type=non_blank)
    parser.add_argument("--timeframe", required=True, type=non_blank)
    parser.add_argument("--from", dest="data_window_start", required=True)
    parser.add_argument("--to", dest="data_window_end", required=True)
    parser.add_argument("--horizon-bars", type=positive_int, default=2)
    parser.add_argument("--expansion-band", type=positive_float, default=0.25)
    parser.add_argument("--folds", type=positive_int, default=10, help="Forward windows (default: 10).")
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2)
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="xgboost")
    parser.add_argument("--database-url")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    try:
        from dotenv import load_dotenv
    except ImportError:
        parser.error("python-dotenv is required. Install apps/ml/requirements.txt first.")
    load_dotenv(ROOT_DIRECTORY / ".env")

    database_url = args.database_url or os.environ.get("DATABASE_URL")
    if not database_url:
        parser.error("DATABASE_URL is required (pass --database-url or define it in .env).")

    request = DatasetRequest(
        instrument_symbol=args.instrument.upper(),
        timeframe=args.timeframe,
        data_window_start=parse_timestamp(args.data_window_start),
        data_window_end=parse_timestamp(args.data_window_end, end_of_day=True),
        data_cutoff_at=datetime.now(timezone.utc),
        horizon_bars=args.horizon_bars,
        neutral_threshold_bps=0.0,
        label_scheme=LABEL_SCHEME_VOLATILITY_EXPANSION,
        expansion_band=args.expansion_band,
    )
    schema = feature_schema(schema_version_for(request.timeframe))
    alphabet = VOLATILITY_ALPHABET

    import psycopg

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        records = repository.load_candle_evidence(request)
        examples = list(build_volatility_expansion_examples(records, request))

    if len(examples) < args.folds * 2:
        parser.error(f"Only {len(examples)} labelled rows: too few for {args.folds} forward windows.")

    splits = walk_forward_splits(
        examples,
        horizon_bars=request.horizon_bars,
        folds=args.folds,
        validation_fraction=args.validation_fraction,
    )
    print(f"Backtesting {len(examples)} labelled rows across {len(splits)} forward windows.", file=sys.stderr)

    windows = []
    pooled_actual: list = []
    pooled_predicted: list = []
    accuracy_wins = 0
    macro_f1_wins = 0

    for index, split in enumerate(splits, start=1):
        result = train_model(
            args.algorithm,
            split,
            schema=schema,
            random_state=42,
            alphabet=alphabet,
        )
        predicted = predict_labels(result.model, split.validation, schema=schema, alphabet=alphabet)
        actual = [item.label for item in split.validation]
        model_metrics = evaluate_predictions(actual, predicted, alphabet=alphabet)
        trivial = trivial_majority_metrics(split, alphabet=alphabet)

        pooled_actual.extend(actual)
        pooled_predicted.extend(predicted)
        acc_delta = model_metrics.accuracy - trivial.accuracy
        f1_delta = model_metrics.macro_f1 - trivial.macro_f1
        if acc_delta > 0:
            accuracy_wins += 1
        if f1_delta > 0:
            macro_f1_wins += 1

        expansion = model_metrics.per_class.get("EXPANSION")
        windows.append({
            "window": index,
            "trainRows": len(split.train),
            "validationRows": len(split.validation),
            "modelAccuracy": round(model_metrics.accuracy, 4),
            "trivialAccuracy": round(trivial.accuracy, 4),
            "accuracyDelta": round(acc_delta, 4),
            "modelMacroF1": round(model_metrics.macro_f1, 4),
            "trivialMacroF1": round(trivial.macro_f1, 4),
            "macroF1Delta": round(f1_delta, 4),
            "expansionF1": round(expansion.f1, 4) if expansion is not None else None,
        })
        print(
            f"Window {index}/{len(splits)} n={len(split.validation)} "
            f"acc {model_metrics.accuracy:.4f} vs {trivial.accuracy:.4f} ({acc_delta:+.4f}) | "
            f"macroF1 {model_metrics.macro_f1:.4f} vs {trivial.macro_f1:.4f} ({f1_delta:+.4f})",
            file=sys.stderr,
        )

    pooled = evaluate_predictions(pooled_actual, pooled_predicted, alphabet=alphabet)
    pooled_expansion = pooled.per_class.get("EXPANSION")
    verdict = {
        "level": "info",
        "message": "Volatility shadow walk-forward backtest complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "labelScheme": request.label_scheme,
            "horizonBars": request.horizon_bars,
            "expansionBand": request.expansion_band,
            "labeledRows": len(examples),
        },
        "algorithm": args.algorithm,
        "forwardWindows": len(splits),
        "settledPredictions": len(pooled_actual),
        "accuracyWonWindows": f"{accuracy_wins}/{len(splits)}",
        "macroF1WonWindows": f"{macro_f1_wins}/{len(splits)}",
        "pooled": {
            "accuracy": round(pooled.accuracy, 4),
            "balancedAccuracy": round(pooled.balanced_accuracy, 4),
            "macroF1": round(pooled.macro_f1, 4),
            "expansionF1": round(pooled_expansion.f1, 4) if pooled_expansion is not None else None,
        },
        "windows": windows,
        "modelVersionCreated": False,
        "predictionCreated": False,
    }
    print(json.dumps(verdict, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
