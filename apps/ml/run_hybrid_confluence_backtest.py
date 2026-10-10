#!/usr/bin/env python3
"""HYBRID LIQUIDITY CONFLUENCE BACKTEST BENCHMARK (v1.1.0)

Benchmarks the 3-Pillar Hybrid Institutional Confluence Engine against
standalone 2D Candlestick Patterns over historical OOS contact events.

Pillars Evaluated:
- Pillar A: L2 Depth Imbalance (DI_decay >= 0.10, `--pillar-a-threshold`) at
  Level Sweeps / Touches. 0.10 is the settled value -- see the sensitivity
  sweep note below and `--sensitivity-sweep` to reproduce it.
- Pillar B: Cont-Kukanov-Stoikov Order Flow Imbalance (raw DI / OFI
  confirmation, >= 0.05 in the direction of the proposed side).
- Pillar C: Option Chain Put/Call Ratio wall (PCR >= 1.2 confirms a LONG
  rejection at a down-level, PCR <= 0.8 confirms a SHORT rejection at an
  up-level), computed from real `option_chain_snapshots` rows via an as-of
  join -- never a stub that defaults to "pass" when unmeasured.

v1.1.0 (2026-09-28) changes, made after independent review found two defects
in v1.0.0:
  1. Pillar A's own threshold disagreed with itself: the TS strategy gated at
     0.10 while this script (and the TS docstring) said 0.15. A sensitivity
     sweep at 0.10/0.125/0.15 (`--sensitivity-sweep`) settled it decisively in
     0.10's favour and not narrowly: 0.10 is n=14,678, WR 38.36%, PF 0.93,
     binomial p=1.6e-29; 0.125 is already worse (WR 36.20%, PF 0.85); 0.15 --
     what this script and the docstring used to claim -- is WR 33.65%, *below*
     the 33.93% unfiltered baseline, PF 0.76, p=0.74 (not significant). The
     code was right; the docstring and this script's default were wrong.
     Full numbers in docs/2026-09-28-hybrid-liquidity-confluence-v1-validation.md.
  2. Pillar B and Pillar C were never actually implemented here -- the
     "hybrid" population this script reported was Pillar A alone. Both are
     now real: Pillar B reuses the same raw_di this script already computes
     for Pillar A (see the note in `evaluate_pillars` on why Pillar B turns
     out to add nothing on top of Pillar A in this feature construction).
     Pillar C is a genuine as-of join against `option_chain_snapshots`,
     modeled on `apps/ml/oi_pcr_signal_check.py`'s bisect-based lookup, with
     the same "unmeasured stays unmeasured, never defaults to a pass" rule.
     (Corrected 2026-10: the staleness ceiling is now ONE shared 20 minutes,
     not 60, and the PCR is the nearest-un-settled-expiry WINDOWED PCR chosen
     expiry-first via `ai_quant_lab_ml/option_chain_pcr.py` -- see that module.
     Results quoted below this line were produced under the old 60-minute,
     latest-observed_at join and are not directly comparable.)

This script creates no model version, no prediction, no paper trade, and no
order. It only reads.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from datetime import date, datetime, timedelta
import zoneinfo
from bisect import bisect_left, bisect_right

import numpy as np
from scipy import stats

script_dir = Path(__file__).resolve().parent
if str(script_dir) not in sys.path:
    sys.path.insert(0, str(script_dir))

import psycopg
from ai_quant_lab_ml.structure_intelligence import get_db_connection_string
from ai_quant_lab_ml.option_chain_pcr import (
    MAX_SNAPSHOT_AGE_MINUTES,
    OptionChainBooks,
    load_option_chain_books,
)

INDIA_TZ = zoneinfo.ZoneInfo("Asia/Kolkata")
LOG_FILE = Path(__file__).resolve().parent.parent.parent / "logs" / "hybrid-confluence-backtest.log"

# Pillar B: raw OFI confirmation threshold, matching the TS strategy
# (`hybrid-liquidity-confluence-strategy.ts`, `isOfiAligned`).
PILLAR_B_RAW_DI_THRESHOLD = 0.05

# Pillar C: windowed PCR wall thresholds, matching the TS strategy's
# docstring ("PCR >= 1.2 for LONG, <= 0.8 for SHORT"). The PCR is over the
# collector's +/-strikecount window around spot, not the whole chain.
PILLAR_C_PCR_LONG_MIN = 1.2
PILLAR_C_PCR_SHORT_MAX = 0.8

# How stale the most recent option-chain snapshot may be and still count as
# "known at decision time". ONE ceiling shared with the live gate
# (OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES in option-chain-signal.ts) and
# `oi_pcr_signal_check.py`: 20 minutes -- the collector polls every 12 minutes
# (median) and up to 18 (p90), so 20 admits one healthy cycle plus jitter. This
# was 60 here while the live gate used 15, so the validated gate was not the
# gate that runs live. Rationale and the selection rule: ai_quant_lab_ml/option_chain_pcr.py.
PILLAR_C_MAX_SNAPSHOT_AGE_MINUTES = MAX_SNAPSHOT_AGE_MINUTES

DEFAULT_RESAMPLES = 1000
DEFAULT_SEED = 42


def log_output(msg: str):
    timestamp = datetime.now(INDIA_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")
    formatted = f"[{timestamp}] {msg}"
    print(msg, flush=True)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")


def fetch_contact_events(conn: psycopg.Connection) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT
                lcl.id::text,
                lcl.contact_time,
                lcl.distance_bps,
                lcl.breached,
                lpc.pool_type,
                lpc.side,
                lpc.symbol,
                lpc.price AS level_price
            FROM liquidity_contact_labels lcl
            JOIN liquidity_pool_candidates lpc ON lpc.id = lcl.candidate_id
            WHERE lcl.contact_time >= '2026-08-01'
              AND lcl.contacted = TRUE
            ORDER BY lcl.contact_time ASC;
        """)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_depth_frames_for_day(conn: psycopg.Connection, day: date) -> list[tuple[datetime, float, float]]:
    day_start = datetime.combine(day, datetime.min.time(), tzinfo=zoneinfo.ZoneInfo("UTC"))
    day_end = day_start + timedelta(days=1)
    with conn.cursor() as cur:
        cur.execute("""
            SELECT received_at, total_buy_qty, total_sell_qty
            FROM depth_frames
            WHERE received_at >= %s
              AND received_at < %s
              AND is_duplicate = FALSE
              AND is_regression = FALSE
            ORDER BY received_at ASC
        """, (day_start, day_end))
        rows = cur.fetchall()
        return [(r[0], float(r[1]), float(r[2])) for r in rows]


def find_nearest_depth_frame(
    frames: list[tuple[datetime, float, float]],
    contact_time: datetime,
    max_gap_seconds: float = 5.0,
) -> tuple[float, float] | None:
    if not frames:
        return None
    times = [f[0] for f in frames]
    pos = bisect_left(times, contact_time)

    best = None
    best_gap = float("inf")
    for idx in range(max(0, pos - 10), min(len(frames), pos + 10)):
        dt = (contact_time - times[idx]).total_seconds()
        if 0 <= dt <= max_gap_seconds and dt < best_gap:
            best_gap = dt
            best = (frames[idx][1], frames[idx][2])
    return best


# --- Pillar C: option-chain PCR, as-of join --------------------------------

def fetch_pcr_series(conn: psycopg.Connection, underlying_symbol: str) -> OptionChainBooks:
    """Per-expiry in-session book series + expiry calendar for the as-of PCR join.

    The selection rule is shared with the live gate and `oi_pcr_signal_check.py`
    (`ai_quant_lab_ml/option_chain_pcr.py`): pick the nearest expiry whose 15:30 IST
    settlement is still ahead of the decision time FIRST, then the latest 09:15-15:30 IST
    snapshot of that expiry. The old query minimised `expiry_date` per `observed_at`
    (a no-op: each snapshot holds one expiry) and then took the latest `observed_at`,
    which is the farther "tradable roll" book. The value is a WINDOWED PCR
    (collector's +/-strikecount around spot), not a whole-chain PCR.
    """
    return load_option_chain_books(conn, underlying_symbol)


def pcr_as_of(
    books: OptionChainBooks,
    as_of: datetime,
    max_age_minutes: float = PILLAR_C_MAX_SNAPSHOT_AGE_MINUTES,
) -> float | None:
    """Windowed PCR known at `as_of`, or None when unavailable.

    None is never a pass: the reason (STALE / NO_SNAPSHOT / INCOMPLETE_OPEN_INTEREST / ...)
    is available from `books.resolve(as_of).reason` and is tallied by the caller.
    """
    return books.resolve(as_of, max_age_minutes).pcr_windowed


# --- Pillar evaluation -------------------------------------------------------

UP_LEVELS = ("PDH", "SWING_HIGH", "SESSION_HIGH", "ITH")


def evaluate_pillars(
    di_decay: float,
    raw_di: float,
    is_up_level: bool,
    pillar_a_threshold: float,
    pcr: float | None,
) -> dict:
    """Returns which pillars pass for one contact event.

    Pillar A: |di_decay| past `pillar_a_threshold`, signed toward a rejection
    (an up-level sweep needs sell-heavy depth, di_decay <= -threshold; a
    down-level sweep needs buy-heavy depth, di_decay >= +threshold).

    Pillar B: |raw_di| >= PILLAR_B_RAW_DI_THRESHOLD in the same direction.
    This is reported honestly even though it turns out to be tautological
    here: di_decay = raw_di * decay_factor with 0 < decay_factor <= 1, so
    |raw_di| >= |di_decay| always. Any event that clears Pillar A's 0.10-0.15
    band already clears Pillar B's looser 0.05 band on the same underlying
    quantity -- Pillar B never removes an additional event in this
    construction. That is a real finding about this feature design, not a
    filtering step that adds anything on top of Pillar A, and is reported as
    such rather than silently dropped.

    Pillar C: the resolved PCR must be measured (not stale/absent) and on the
    correct side of the wall for the direction implied by the rejection --
    PCR <= 0.8 for the SHORT call at an up-level rejection, PCR >= 1.2 for
    the LONG call at a down-level rejection.
    """
    if is_up_level:
        pillar_a = di_decay <= -pillar_a_threshold
        proposed_side = "SHORT"
    else:
        pillar_a = di_decay >= pillar_a_threshold
        proposed_side = "LONG"

    pillar_b = abs(raw_di) >= PILLAR_B_RAW_DI_THRESHOLD

    if pcr is None:
        pillar_c = False
    elif proposed_side == "SHORT":
        pillar_c = pcr <= PILLAR_C_PCR_SHORT_MAX
    else:
        pillar_c = pcr >= PILLAR_C_PCR_LONG_MIN

    return {
        "proposed_side": proposed_side,
        "pillar_a": pillar_a,
        "pillar_b": pillar_b,
        "pillar_c": pillar_c,
        "pcr_measured": pcr is not None,
    }


def summarise_trades(trades: list[dict]) -> dict:
    n = len(trades)
    wins = sum(1 for t in trades if t["win"])
    wr = (wins / n * 100) if n > 0 else 0.0
    net_r = sum(t["return_r"] for t in trades)
    gross_win = sum(t["return_r"] for t in trades if t["win"])
    gross_loss = abs(sum(t["return_r"] for t in trades if not t["win"]))
    pf = (gross_win / gross_loss) if gross_loss > 0 else 0.0
    return {"n": n, "wins": wins, "win_rate": wr, "net_r": net_r, "profit_factor": pf}


def run_random_subsample_null(
    returns_array: np.ndarray,
    sample_size: int,
    resamples: int,
    seed: int,
) -> dict:
    """Draws `resamples` size-matched random subsamples (without replacement) from the
    raw population and returns their net-R / win-rate / profit-factor distributions,
    plus the actual filtered result's percentile rank and one-sided p-value within each.
    """
    rng = np.random.default_rng(seed)
    n_total = len(returns_array)
    net_rs = np.empty(resamples)
    win_rates = np.empty(resamples)
    profit_factors = np.empty(resamples)

    for i in range(resamples):
        idx = rng.permutation(n_total)[:sample_size]
        sample = returns_array[idx]
        wins_mask = sample > 0
        net_rs[i] = sample.sum()
        win_rates[i] = wins_mask.sum() / sample_size * 100.0
        gross_win = sample[wins_mask].sum()
        gross_loss = -sample[~wins_mask].sum()
        profit_factors[i] = (gross_win / gross_loss) if gross_loss > 0 else 0.0

    return {
        "net_r": net_rs,
        "win_rate": win_rates,
        "profit_factor": profit_factors,
    }


def percentile_and_pvalue(null_distribution: np.ndarray, actual: float) -> tuple[float, float]:
    """percentile_rank: share of null draws strictly below `actual` (0-100).
    p_value: share of null draws >= actual -- the one-sided "is actual better than
    random" significance, correct for testing whether the observed value sits in the
    upper tail of the null distribution.
    """
    n = len(null_distribution)
    percentile_rank = float((null_distribution < actual).sum()) / n * 100.0
    p_value = float((null_distribution >= actual).sum()) / n
    return percentile_rank, p_value


def run_backtest(
    pillar_a_threshold: float,
    enable_pillar_b: bool,
    enable_pillar_c: bool,
    resamples: int,
    seed: int,
    quiet: bool = False,
) -> dict:
    log = (lambda *_a, **_k: None) if quiet else log_output

    conn = psycopg.connect(get_db_connection_string())
    events = fetch_contact_events(conn)
    log(f"Loaded {len(events):,} level contact events.")

    pcr_books_by_symbol: dict[str, OptionChainBooks] = {}
    if enable_pillar_c:
        for symbol in ("NIFTY50", "BANKNIFTY"):
            books = fetch_pcr_series(conn, symbol)
            pcr_books_by_symbol[symbol] = books
            book_count = sum(len(series) for series in books.books_by_expiry.values())
            log(f"Pillar C: loaded {book_count:,} in-session per-expiry chain books for {symbol}.")

    events_by_day: dict[date, list[dict]] = {}
    for ev in events:
        day = ev["contact_time"].date()
        events_by_day.setdefault(day, []).append(ev)

    standalone_trades = []
    hybrid_trades = []  # Pillar A only (the population this script reported pre-2026-09-28)
    full_pillar_trades = []  # Pillar A + B + C, all real
    pillar_c_unmeasured = 0
    pillar_c_unavailable_reasons: dict[str, int] = {}

    for day in sorted(events_by_day.keys()):
        frames = fetch_depth_frames_for_day(conn, day)
        day_events = events_by_day[day]

        for ev in day_events:
            contact_time = ev["contact_time"]
            distance_bps = ev["distance_bps"]
            breached = ev["breached"]
            pool_type = ev["pool_type"]
            symbol = ev["symbol"]

            is_rejection = not breached
            standalone_trades.append({
                "win": is_rejection,
                "return_r": 1.5 if is_rejection else -1.0,
            })

            frame = find_nearest_depth_frame(frames, contact_time)
            if frame is None:
                continue
            buy_qty, sell_qty = frame
            if (buy_qty + sell_qty) <= 0:
                continue

            raw_di = (buy_qty - sell_qty) / (buy_qty + sell_qty)
            decay_factor = np.exp(-0.05 * float(distance_bps or 0))
            di_decay = raw_di * decay_factor
            is_up_level = pool_type in UP_LEVELS

            pcr = None
            pcr_reason = None
            if enable_pillar_c and symbol in pcr_books_by_symbol:
                resolution = pcr_books_by_symbol[symbol].resolve(contact_time, PILLAR_C_MAX_SNAPSHOT_AGE_MINUTES)
                pcr = resolution.pcr_windowed
                pcr_reason = resolution.reason

            pillars = evaluate_pillars(di_decay, raw_di, is_up_level, pillar_a_threshold, pcr)

            if pillars["pillar_a"]:
                hybrid_trades.append({
                    "win": is_rejection,
                    "return_r": 1.5 if is_rejection else -1.0,
                })

            if enable_pillar_c and pillars["pillar_a"] and not pillars["pcr_measured"]:
                pillar_c_unmeasured += 1
                # Explicit reason (e.g. "STALE"), not a silent drop.
                reason_key = pcr_reason or "NO_CHAIN_FOR_SYMBOL"
                pillar_c_unavailable_reasons[reason_key] = pillar_c_unavailable_reasons.get(reason_key, 0) + 1

            passes_full = pillars["pillar_a"] and (not enable_pillar_b or pillars["pillar_b"]) \
                and (not enable_pillar_c or pillars["pillar_c"])
            if passes_full:
                full_pillar_trades.append({
                    "win": is_rejection,
                    "return_r": 1.5 if is_rejection else -1.0,
                })

    conn.close()

    standalone_stats = summarise_trades(standalone_trades)
    hybrid_stats = summarise_trades(hybrid_trades)
    full_stats = summarise_trades(full_pillar_trades)

    p_value_hybrid = (
        stats.binomtest(
            hybrid_stats["wins"], hybrid_stats["n"], p=standalone_stats["win_rate"] / 100.0, alternative="greater"
        ).pvalue
        if hybrid_stats["n"] > 0 else 1.0
    )

    result = {
        "pillar_a_threshold": pillar_a_threshold,
        "enable_pillar_b": enable_pillar_b,
        "enable_pillar_c": enable_pillar_c,
        "standalone": standalone_stats,
        "pillar_a_only": hybrid_stats,
        "pillar_a_only_binomial_p": p_value_hybrid,
        "full_pillar": full_stats,
        "pillar_c_unmeasured_at_pillar_a_pass": pillar_c_unmeasured,
        "pillar_c_unavailable_reasons": pillar_c_unavailable_reasons,
    }

    if not quiet:
        log_output("\n--- BENCHMARK RESULTS ---")
        log_output(f"Pillar A threshold: {pillar_a_threshold}")
        log_output(f"1. Standalone baseline: n={standalone_stats['n']:,} "
                   f"WR={standalone_stats['win_rate']:.2f}% PF={standalone_stats['profit_factor']:.2f} "
                   f"NetR={standalone_stats['net_r']:+.2f}")
        log_output(f"2. Pillar A only: n={hybrid_stats['n']:,} "
                   f"WR={hybrid_stats['win_rate']:.2f}% PF={hybrid_stats['profit_factor']:.2f} "
                   f"NetR={hybrid_stats['net_r']:+.2f} binom_p={p_value_hybrid:.4e}")
        if enable_pillar_b or enable_pillar_c:
            log_output(f"3. Full pillar (A{'+B' if enable_pillar_b else ''}"
                       f"{'+C' if enable_pillar_c else ''}): n={full_stats['n']:,} "
                       f"WR={full_stats['win_rate']:.2f}% PF={full_stats['profit_factor']:.2f} "
                       f"NetR={full_stats['net_r']:+.2f}")
            if enable_pillar_c:
                log_output(f"   Pillar-A-pass events with no measurable PCR (excluded, not defaulted): "
                           f"{pillar_c_unmeasured} (by reason: {pillar_c_unavailable_reasons})")

    if resamples > 0 and full_stats["n"] > 0:
        returns_array = np.array([t["return_r"] for t in standalone_trades])
        null_dist = run_random_subsample_null(returns_array, full_stats["n"], resamples, seed)
        net_r_percentile, net_r_p = percentile_and_pvalue(null_dist["net_r"], full_stats["net_r"])
        wr_percentile, wr_p = percentile_and_pvalue(null_dist["win_rate"], full_stats["win_rate"])
        pf_percentile, pf_p = percentile_and_pvalue(null_dist["profit_factor"], full_stats["profit_factor"])

        result["random_subsample_null"] = {
            "resamples": resamples,
            "seed": seed,
            "sample_size": full_stats["n"],
            "net_r_null_mean": float(null_dist["net_r"].mean()),
            "net_r_null_std": float(null_dist["net_r"].std()),
            "net_r_actual": full_stats["net_r"],
            "net_r_percentile_rank": net_r_percentile,
            "net_r_p_value": net_r_p,
            "win_rate_null_mean": float(null_dist["win_rate"].mean()),
            "win_rate_null_std": float(null_dist["win_rate"].std()),
            "win_rate_actual": full_stats["win_rate"],
            "win_rate_percentile_rank": wr_percentile,
            "win_rate_p_value": wr_p,
            "profit_factor_null_mean": float(null_dist["profit_factor"].mean()),
            "profit_factor_null_std": float(null_dist["profit_factor"].std()),
            "profit_factor_actual": full_stats["profit_factor"],
            "profit_factor_percentile_rank": pf_percentile,
            "profit_factor_p_value": pf_p,
        }

        if not quiet:
            log_output("\n--- RANDOM-SUBSAMPLE NULL COMPARISON "
                       f"(n={resamples} draws, size-matched to {full_stats['n']:,}) ---")
            log_output(f"   Net R   -- null mean {null_dist['net_r'].mean():+.2f} (sd {null_dist['net_r'].std():.2f}), "
                       f"actual {full_stats['net_r']:+.2f}, percentile {net_r_percentile:.1f}, p={net_r_p:.4f}")
            log_output(f"   WinRate -- null mean {null_dist['win_rate'].mean():.2f}% (sd {null_dist['win_rate'].std():.2f}), "
                       f"actual {full_stats['win_rate']:.2f}%, percentile {wr_percentile:.1f}, p={wr_p:.4f}")
            log_output(f"   PF      -- null mean {null_dist['profit_factor'].mean():.2f} (sd {null_dist['profit_factor'].std():.2f}), "
                       f"actual {full_stats['profit_factor']:.2f}, percentile {pf_percentile:.1f}, p={pf_p:.4f}")
        log_output("==========================================================================")

    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pillar-a-threshold", type=float, default=0.10,
                         help="DI_decay magnitude Pillar A requires (default 0.10, settled by the "
                              "2026-09-28 sensitivity sweep -- see the module docstring).")
    parser.add_argument("--sensitivity-sweep", action="store_true",
                         help="Runs Pillar A alone at 0.10/0.125/0.15 and exits, for choosing the threshold.")
    parser.add_argument("--disable-pillar-b", action="store_true")
    parser.add_argument("--disable-pillar-c", action="store_true")
    parser.add_argument("--resamples", type=int, default=DEFAULT_RESAMPLES)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    return parser


if __name__ == "__main__":
    args = build_parser().parse_args()

    if args.sensitivity_sweep:
        log_output("==========================================================================")
        log_output("PILLAR A THRESHOLD SENSITIVITY SWEEP (Pillar A alone, B/C disabled)")
        log_output("==========================================================================")
        for threshold in (0.10, 0.125, 0.15):
            run_backtest(
                pillar_a_threshold=threshold,
                enable_pillar_b=False,
                enable_pillar_c=False,
                resamples=0,
                seed=args.seed,
            )
    else:
        log_output("==========================================================================")
        log_output("HYBRID LIQUIDITY CONFLUENCE ENGINE: OOS BACKTEST BENCHMARK (v1.1.0)")
        log_output("==========================================================================")
        run_backtest(
            pillar_a_threshold=args.pillar_a_threshold,
            enable_pillar_b=not args.disable_pillar_b,
            enable_pillar_c=not args.disable_pillar_c,
            resamples=args.resamples,
            seed=args.seed,
        )
