"""Straddle Breakeven Gate for a volatility-expansion shadow model.

Turns the model's out-of-sample EXPANSION calls into a cost-aware, buyer-only
straddle book and asks whether it earns its place. Same rolling-origin walk-forward
as ``backfill_volatility_shadow.py`` (train-on-past-only), but at every scored bar it
also prices an intraday ATM straddle and tags it with the model's prediction.

The economics reuse ``straddle_economics.black_scholes_straddle`` unchanged. The one
adaptation over the daily equity study is intraday decay: the option is a *tradable
tenor* (weekly for NIFTY, monthly for BANKNIFTY, which has no weekly expiry), held for
h2 bars (~2 hours) and marked to market, so time decay is the ACTUAL calendar time
between the two bars' close times -- not h2 trading days. Over a two-hour hold theta is
tiny and the P&L is dominated by the gamma capture of the move, which is exactly the
long-vol payoff the signal is meant to harvest. IV is held flat over the hold (a 2h
window is far too short for the multi-day mean reversion the equity study modelled);
that omits any vega gain during an expansion, so it is if anything conservative.

Buyer-only mapping: EXPANSION -> buy the straddle; STABLE/CONTRACTION -> stay flat
(you cannot write options). The model's value is concentrating entries in the windows
that expand and skipping the theta-bleed windows.

Reports, against the trivial baselines and across a fee sweep:
  * straddle breakeven precision (the EXPANSION hit-rate at which it stops losing),
  * the model's out-of-sample EXPANSION precision,
  * model-gated vs always-enter vs never-enter mean P&L.
Writes NOTHING to the database. Output is a JSON verdict on stdout.
"""

from __future__ import annotations

import argparse
from bisect import bisect_left
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# NSE trades in IST (UTC+5:30); the VIX map is keyed by IST session date, so entry
# timestamps are converted with this fixed offset rather than the host's local zone.
IST = timezone(timedelta(hours=5, minutes=30))

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
from ai_quant_lab_ml.straddle_economics import (  # noqa: E402
    black_scholes_straddle,
    cost_aware_promotion_verdict,
)
from ai_quant_lab_ml.training import predict_labels, train_model  # noqa: E402
from ai_quant_lab_ml.validation import walk_forward_splits  # noqa: E402
from ai_quant_lab_ml.volatility_expansion import VOLATILITY_ALPHABET  # noqa: E402
from train import non_negative_float, positive_float, positive_int, non_blank, parse_timestamp, strict_unit_interval  # noqa: E402

EXPANSION = "EXPANSION"
CALENDAR_DAYS_PER_YEAR = 365.0
FEE_SWEEP_BPS = (0.0, 5.0, 10.0, 20.0, 40.0)


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def _std_error(values: list[float]) -> float | None:
    n = len(values)
    if n < 2:
        return None
    mean = sum(values) / n
    variance = sum((v - mean) ** 2 for v in values) / (n - 1)
    return (variance / n) ** 0.5


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Straddle breakeven gate for a volatility-expansion model. Writes nothing to the database.")
    parser.add_argument("--instrument", required=True, type=non_blank)
    parser.add_argument("--timeframe", required=True, type=non_blank)
    parser.add_argument("--from", dest="data_window_start", required=True)
    parser.add_argument("--to", dest="data_window_end", required=True)
    parser.add_argument("--horizon-bars", type=positive_int, default=2)
    parser.add_argument("--expansion-band", type=positive_float, default=0.25)
    parser.add_argument("--folds", type=positive_int, default=10)
    parser.add_argument("--validation-fraction", type=strict_unit_interval, default=0.2)
    parser.add_argument("--algorithm", choices=ALGORITHM_CHOICES, default="xgboost")
    parser.add_argument("--days-to-expiry", type=positive_int, default=7, help="Tradable tenor in calendar days (NIFTY weekly=7; BANKNIFTY monthly=30).")
    parser.add_argument("--iv-scale", type=positive_float, default=1.0, help="Multiplier on India VIX for this instrument's IV (1.0 for NIFTY; >1 for BANKNIFTY).")
    parser.add_argument("--fee-bps", type=non_negative_float, default=5.0, help="Round-trip execution cost applied by the promotion verdict (default: 5bps of spot).")
    parser.add_argument("--minimum-scored", type=positive_int, default=300, help="Minimum out-of-sample opportunities required by the promotion verdict.")
    parser.add_argument("--minimum-gated", type=positive_int, default=60, help="Minimum model-selected entries required by the promotion verdict.")
    parser.add_argument("--confidence-z", type=positive_float, default=1.96, help="One-sided safety multiplier applied to the gated P&L standard error.")
    parser.add_argument("--database-url")
    return parser


def load_vix_history(connection: object) -> list[tuple[date, float]]:
    """Completed daily India VIX closes, ordered by their IST session date."""
    with connection.cursor() as cursor:  # type: ignore[attr-defined]
        cursor.execute(
            """
            SELECT (c.open_time AT TIME ZONE 'Asia/Kolkata')::date::text AS date, c.close::float8
            FROM candles c JOIN instruments i ON i.id = c.instrument_id
            WHERE i.symbol = 'INDIAVIX' AND c.timeframe = '1d' AND c.is_complete = TRUE
            ORDER BY c.open_time
            """
        )
        return [
            (date.fromisoformat(str(session_date)), float(close) / 100.0)
            for session_date, close in cursor.fetchall()
        ]


def latest_vix_before_session(
    history: list[tuple[date, float]],
    session_date: date,
) -> float | None:
    """Latest close that was public before the requested trading session began.

    A same-session daily close is future information for every intraday entry before the close.
    The strict date bound also handles weekends and exchange holidays by carrying the most recent
    completed observation forward instead of assuming consecutive calendar days.
    """
    index = bisect_left(history, (session_date, float("-inf"))) - 1
    if index < 0:
        return None
    value = history[index][1]
    return value if value > 0 else None


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
    horizon = request.horizon_bars

    import psycopg

    with psycopg.connect(database_url, autocommit=True) as connection:
        repository = PostgresMlRepository(connection)
        records = repository.load_candle_evidence(request)
        vix_history = load_vix_history(connection)

    records = sorted(records, key=lambda r: r.close_time)
    index_by_close = {r.close_time: i for i, r in enumerate(records)}
    examples = list(build_volatility_expansion_examples(records, request))
    if len(examples) < args.folds * 2:
        parser.error(f"Only {len(examples)} labelled rows: too few for {args.folds} windows.")

    def price_straddle(entry_index: int) -> float | None:
        """Reverted-flat-IV mark-to-market P&L of one intraday ATM straddle, as a fraction of spot."""
        exit_index = entry_index + horizon
        if exit_index >= len(records):
            return None
        entry, exit_bar = records[entry_index], records[exit_index]
        # Match the VIX map's IST session-date key. close_time is tz-aware UTC.
        ist_date = entry.close_time.astimezone(IST).date()
        vix = latest_vix_before_session(vix_history, ist_date)
        if vix is None:
            return None
        implied = vix * args.iv_scale
        spot = float(entry.close)
        exit_spot = float(exit_bar.close)
        if spot <= 0:
            return None
        elapsed_days = (exit_bar.close_time - entry.close_time).total_seconds() / 86_400.0
        entry_years = args.days_to_expiry / CALENDAR_DAYS_PER_YEAR
        exit_years = max(0.0, entry_years - elapsed_days / CALENDAR_DAYS_PER_YEAR)
        strike = spot
        entry_premium = black_scholes_straddle(spot=spot, strike=strike, time_to_expiry_years=entry_years, volatility=implied)
        exit_premium = black_scholes_straddle(spot=exit_spot, strike=strike, time_to_expiry_years=exit_years, volatility=implied)
        return (exit_premium - entry_premium) / spot

    splits = walk_forward_splits(
        examples, horizon_bars=horizon, folds=args.folds, validation_fraction=args.validation_fraction
    )
    print(f"Gating {len(examples)} rows across {len(splits)} forward windows.", file=sys.stderr)

    # Per out-of-sample entry: (predicted_label, is_actual_expansion, straddle_pnl_fraction)
    scored: list[tuple[str, bool, float]] = []
    for index, split in enumerate(splits, start=1):
        result = train_model(args.algorithm, split, schema=schema, random_state=42, alphabet=alphabet)
        predicted = predict_labels(result.model, split.validation, schema=schema, alphabet=alphabet)
        for example, prediction in zip(split.validation, predicted):
            entry_index = index_by_close.get(example.observed_at)
            if entry_index is None:
                continue
            pnl = price_straddle(entry_index)
            if pnl is None:
                continue
            scored.append((str(prediction), str(example.label) == EXPANSION, pnl))
        print(f"  window {index}/{len(splits)} scored (running entries: {len(scored)})", file=sys.stderr)

    if not scored:
        parser.error("No entries could be priced (India VIX only covers 2023-01 onward; check the window).")

    expansion_pnls = [pnl for _, expanded, pnl in scored if expanded]
    other_pnls = [pnl for _, expanded, pnl in scored if not expanded]
    mean_win = _mean(expansion_pnls)
    mean_loss = _mean(other_pnls)
    breakeven_precision = None
    if mean_win is not None and mean_loss is not None and mean_win > 0 > mean_loss:
        breakeven_precision = -mean_loss / (mean_win - mean_loss)

    gated = [(pnl, expanded) for label, expanded, pnl in scored if label == EXPANSION]
    gated_pnls = [pnl for pnl, _ in gated]
    all_pnls = [pnl for _, _, pnl in scored]
    model_precision = (sum(1 for _, expanded in gated if expanded) / len(gated)) if gated else None
    base_rate = sum(1 for _, expanded, _ in scored if expanded) / len(scored)
    promotion_verdict = cost_aware_promotion_verdict(
        gated_pnls=gated_pnls,
        always_enter_pnls=all_pnls,
        fee_bps=args.fee_bps,
        minimum_scored=args.minimum_scored,
        minimum_gated=args.minimum_gated,
        confidence_z=args.confidence_z,
    )

    def net_table(pnls: list[float]) -> dict[str, object]:
        mean = _mean(pnls)
        se = _std_error(pnls)
        return {
            "entries": len(pnls),
            "grossMeanBps": round(mean * 10_000, 2) if mean is not None else None,
            "stdErrorBps": round(se * 10_000, 2) if se is not None else None,
            "netMeanBpsByFee": {
                f"{int(fee)}bps": round((mean - fee / 10_000) * 10_000, 2) if mean is not None else None
                for fee in FEE_SWEEP_BPS
            },
        }

    verdict = {
        "level": "info",
        "message": "Volatility straddle gate complete",
        "dataset": {
            "instrument": request.instrument_symbol,
            "timeframe": request.timeframe,
            "horizonBars": horizon,
            "daysToExpiry": args.days_to_expiry,
            "ivScale": args.iv_scale,
            "expansionBand": request.expansion_band,
        },
        "entriesScored": len(scored),
        "expansionBaseRate": round(base_rate, 4),
        "straddleEconomics": {
            "meanWinBps": round(mean_win * 10_000, 2) if mean_win is not None else None,
            "meanLossBps": round(mean_loss * 10_000, 2) if mean_loss is not None else None,
            "breakevenPrecision": round(breakeven_precision, 4) if breakeven_precision is not None else None,
        },
        "modelExpansionPrecision": round(model_precision, 4) if model_precision is not None else None,
        "precisionClearsTheoreticalBreakeven": (
            bool(model_precision is not None and breakeven_precision is not None and model_precision > breakeven_precision)
        ),
        # Backward-compatible name, now aligned with the actual cost-aware
        # promotion decision rather than the label-precision shortcut.
        "clearsBreakeven": promotion_verdict["decision"] == "COST_GATE_PASSED",
        "promotionVerdict": promotion_verdict,
        "pnl": {
            "modelGated": net_table(gated_pnls),
            "alwaysEnter": net_table(all_pnls),
            "neverEnter": {"entries": 0, "grossMeanBps": 0.0, "netMeanBpsByFee": {f"{int(f)}bps": 0.0 for f in FEE_SWEEP_BPS}},
        },
        "modelVersionCreated": False,
        "predictionCreated": False,
    }
    print(json.dumps(verdict, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
