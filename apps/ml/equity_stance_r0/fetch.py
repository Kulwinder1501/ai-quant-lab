"""
Equity Stance R0: Step A1 - External Data Fetcher & Manifest Generator
Pre-Registered Spec: docs/2026-10-17-equity-stance-r0-spec.md

Strict Rules (from frozen spec & reviewer agreement):
1. Bounded strictly by cut-off date: 2026-10-17 (period2 = 1792281599).
2. Explicit period1=0, period2=1792281599, interval=1d.
3. Daily granularity assertion: meta.dataGranularity == "1d".
4. Polite rate limit: 1.2s delay between requests.
5. If HTTP 429 received, stop immediately and report.
6. Raw responses stored with SHA-256 in apps/ml/research_data/raw/{symbol}.json.
7. Drops series with fewer than 756 bars.
8. Flags 1-day absolute moves > 40% as suspected corporate action/demerger artifacts.
9. Produces manifest.csv and fetch.log.
"""

from __future__ import annotations

import csv
import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests

# Frozen cut-off timestamp: 2026-10-17 23:59:59 UTC
CUTOFF_DATE_STR = "2026-10-17"
PERIOD1 = 0
PERIOD2 = 1792281599  # datetime(2026, 10, 17, 23, 59, 59, tzinfo=timezone.utc).timestamp()
MIN_BARS_REQUIRED = 756
ARTIFACT_MOVE_PCT = 0.40
REQUEST_DELAY_SECONDS = 1.2

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

logger = logging.getLogger("equity_stance_r0.fetch")


class RateLimitError(Exception):
    """Raised when Yahoo Finance returns HTTP 429."""
    pass


class GranularityError(Exception):
    """Raised when Yahoo Finance response is not daily granularity."""
    pass


def setup_logging(log_file: Path) -> None:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.FileHandler(log_file, mode="a", encoding="utf-8"),
            logging.StreamHandler(sys.stdout),
        ],
    )


def compute_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def timestamp_to_date_str(ts: int) -> str:
    # NSE trades between 09:15 and 15:30 IST; UTC timestamp represents 03:45 UTC on the same date.
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def parse_and_validate_chart_response(
    raw_json: dict[str, Any],
    symbol: str,
    cutoff_date: str = CUTOFF_DATE_STR,
) -> dict[str, Any]:
    chart = raw_json.get("chart", {})
    error = chart.get("error")
    if error:
        raise ValueError(f"Yahoo chart error for {symbol}: {error}")

    results = chart.get("result")
    if not results or len(results) == 0:
        raise ValueError(f"No chart result returned for {symbol}")

    result = results[0]
    meta = result.get("meta", {})
    granularity = meta.get("dataGranularity")
    if granularity != "1d":
        raise GranularityError(
            f"Expected dataGranularity '1d', got '{granularity}' for symbol {symbol}"
        )

    timestamps = result.get("timestamp", [])
    indicators = result.get("indicators", {})
    quote_data = indicators.get("quote", [{}])[0]
    adjclose_data = indicators.get("adjclose", [{}])[0].get("adjclose", [])

    opens = quote_data.get("open", [])
    highs = quote_data.get("high", [])
    lows = quote_data.get("low", [])
    closes = quote_data.get("close", [])
    volumes = quote_data.get("volume", [])

    valid_bars: list[dict[str, Any]] = []
    prev_close: Optional[float] = None
    artifact_count = 0

    for i, ts in enumerate(timestamps):
        date_str = timestamp_to_date_str(ts)
        # Strict cut-off constraint
        if date_str > cutoff_date:
            continue

        o = opens[i] if i < len(opens) else None
        h = highs[i] if i < len(highs) else None
        l = lows[i] if i < len(lows) else None
        c = closes[i] if i < len(closes) else None
        v = volumes[i] if i < len(volumes) else 0

        # Quality rule: drop non-positive or non-finite values
        if (
            o is None
            or h is None
            or l is None
            or c is None
            or o <= 0
            or h <= 0
            or l <= 0
            or c <= 0
        ):
            continue

        # Check for 1-day absolute move > 40% (suspected corporate action / demerger artifact)
        if prev_close is not None and prev_close > 0:
            pct_move = abs(c - prev_close) / prev_close
            if pct_move > ARTIFACT_MOVE_PCT:
                artifact_count += 1

        prev_close = c
        valid_bars.append({
            "date": date_str,
            "timestamp": ts,
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "volume": int(v) if v is not None else 0,
        })

    total_bars = len(valid_bars)
    first_date = valid_bars[0]["date"] if total_bars > 0 else None
    last_date = valid_bars[-1]["date"] if total_bars > 0 else None

    return {
        "symbol": symbol,
        "total_bars": total_bars,
        "first_date": first_date,
        "last_date": last_date,
        "artifact_count": artifact_count,
        "bars": valid_bars,
    }


def fetch_symbol_data(
    symbol: str,
    yahoo_symbol: str,
    raw_dir: Path,
    session: requests.Session,
    delay: float = REQUEST_DELAY_SECONDS,
    force: bool = False,
) -> dict[str, Any]:
    raw_file = raw_dir / f"{symbol}.json"

    # Resume support: check if already downloaded and valid
    if raw_file.exists() and not force:
        try:
            raw_bytes = raw_file.read_bytes()
            sha256 = compute_sha256(raw_bytes)
            raw_json = json.loads(raw_bytes.decode("utf-8"))
            parsed = parse_and_validate_chart_response(raw_json, symbol)

            # Determine qualification
            if parsed["total_bars"] < MIN_BARS_REQUIRED:
                status = "DROPPED"
                reason = f"INSUFFICIENT_BARS ({parsed['total_bars']} < {MIN_BARS_REQUIRED})"
            else:
                status = "QUALIFIED" if symbol != "^NSEI" else "BENCHMARK_OK"
                reason = "NONE"

            logger.info(
                f"[CACHED] {symbol} ({yahoo_symbol}): {parsed['total_bars']} bars "
                f"[{parsed['first_date']} -> {parsed['last_date']}], sha256={sha256[:12]}..., status={status}"
            )
            return {
                "symbol": symbol,
                "yahoo_symbol": yahoo_symbol,
                "bars": parsed["total_bars"],
                "first_date": parsed["first_date"] or "NONE",
                "last_date": parsed["last_date"] or "NONE",
                "sha256": sha256,
                "status": status,
                "reason": reason,
                "artifact_count": parsed["artifact_count"],
            }
        except Exception as e:
            logger.warning(f"Failed to read cached {raw_file}: {e}. Re-fetching...")

    # Network fetch from Yahoo Finance
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(yahoo_symbol)}"
        f"?period1={PERIOD1}&period2={PERIOD2}&interval=1d"
    )

    t0 = time.time()
    try:
        resp = session.get(url, timeout=25)
    except Exception as exc:
        logger.error(f"[NETWORK_ERROR] {symbol} ({yahoo_symbol}): {exc}")
        time.sleep(delay)
        return {
            "symbol": symbol,
            "yahoo_symbol": yahoo_symbol,
            "bars": 0,
            "first_date": "NONE",
            "last_date": "NONE",
            "sha256": "NONE",
            "status": "ERROR",
            "reason": f"NETWORK_ERROR: {str(exc)[:60]}",
            "artifact_count": 0,
        }

    duration = time.time() - t0
    time.sleep(delay)

    if resp.status_code == 429:
        logger.critical(f"[RATE_LIMITED] Received HTTP 429 for {symbol}. Halting fetch immediately!")
        raise RateLimitError(f"HTTP 429 Too Many Requests on symbol {symbol}")

    if resp.status_code == 404:
        logger.warning(f"[NOT_FOUND] {symbol} ({yahoo_symbol}): HTTP 404 Not Found")
        return {
            "symbol": symbol,
            "yahoo_symbol": yahoo_symbol,
            "bars": 0,
            "first_date": "NONE",
            "last_date": "NONE",
            "sha256": "NONE",
            "status": "DROPPED",
            "reason": "HTTP_404_NOT_FOUND",
            "artifact_count": 0,
        }

    if resp.status_code != 200:
        logger.warning(f"[HTTP_ERROR] {symbol} ({yahoo_symbol}): HTTP {resp.status_code}")
        return {
            "symbol": symbol,
            "yahoo_symbol": yahoo_symbol,
            "bars": 0,
            "first_date": "NONE",
            "last_date": "NONE",
            "sha256": "NONE",
            "status": "DROPPED",
            "reason": f"HTTP_{resp.status_code}",
            "artifact_count": 0,
        }

    raw_bytes = resp.content
    sha256 = compute_sha256(raw_bytes)

    try:
        raw_json = resp.json()
        parsed = parse_and_validate_chart_response(raw_json, symbol)
    except GranularityError as ge:
        logger.error(f"[GRANULARITY_ERROR] {symbol}: {ge}")
        return {
            "symbol": symbol,
            "yahoo_symbol": yahoo_symbol,
            "bars": 0,
            "first_date": "NONE",
            "last_date": "NONE",
            "sha256": sha256,
            "status": "DROPPED",
            "reason": f"GRANULARITY_ERROR: {ge}",
            "artifact_count": 0,
        }
    except Exception as pe:
        logger.warning(f"[PARSE_ERROR] {symbol}: {pe}")
        return {
            "symbol": symbol,
            "yahoo_symbol": yahoo_symbol,
            "bars": 0,
            "first_date": "NONE",
            "last_date": "NONE",
            "sha256": sha256,
            "status": "DROPPED",
            "reason": f"PARSE_ERROR: {pe}",
            "artifact_count": 0,
        }

    # Save raw JSON file
    raw_file.write_bytes(raw_bytes)

    # Qualification check
    if parsed["total_bars"] < MIN_BARS_REQUIRED:
        status = "DROPPED"
        reason = f"INSUFFICIENT_BARS ({parsed['total_bars']} < {MIN_BARS_REQUIRED})"
    else:
        status = "QUALIFIED" if symbol != "^NSEI" else "BENCHMARK_OK"
        reason = "NONE"

    logger.info(
        f"[FETCHED] {symbol} ({yahoo_symbol}) in {duration:.2f}s: {parsed['total_bars']} bars "
        f"[{parsed['first_date']} -> {parsed['last_date']}], sha256={sha256[:12]}..., status={status}"
    )

    return {
        "symbol": symbol,
        "yahoo_symbol": yahoo_symbol,
        "bars": parsed["total_bars"],
        "first_date": parsed["first_date"] or "NONE",
        "last_date": parsed["last_date"] or "NONE",
        "sha256": sha256,
        "status": status,
        "reason": reason,
        "artifact_count": parsed["artifact_count"],
    }


def load_universe_symbols(universe_csv: Path) -> list[str]:
    symbols: list[str] = []
    with open(universe_csv, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if not line.strip().startswith("#")]
        reader = csv.DictReader(lines)
        for row in reader:
            sym = row.get("Symbol")
            if sym and sym.strip():
                symbols.append(sym.strip())
    # Preserve order and deduplicate
    seen = set()
    unique: list[str] = []
    for s in symbols:
        if s not in seen:
            seen.add(s)
            unique.append(s)
    return unique


def run_a1_fetch(
    universe_csv: Path,
    output_root: Path,
    force: bool = False,
    delay: float = REQUEST_DELAY_SECONDS,
) -> tuple[Path, Path]:
    raw_dir = output_root / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    log_file = output_root / "fetch.log"
    setup_logging(log_file)

    manifest_csv = output_root / "manifest.csv"

    logger.info("=" * 70)
    logger.info("Equity Stance R0: Step A1 Universe Fetch Started")
    logger.info(f"Cut-off Date: {CUTOFF_DATE_STR} (period2={PERIOD2})")
    logger.info(f"Universe File: {universe_csv}")
    logger.info(f"Output Raw Directory: {raw_dir}")
    logger.info(f"Manifest Output: {manifest_csv}")
    logger.info(f"Rate Limit Delay: {delay}s per request")
    logger.info("=" * 70)

    symbols = load_universe_symbols(universe_csv)
    logger.info(f"Loaded {len(symbols)} constituents from universe CSV")

    # Target list: benchmark ^NSEI followed by constituents
    targets: list[tuple[str, str]] = [("^NSEI", "^NSEI")]
    for sym in symbols:
        # Standard NSE symbol mapping on Yahoo Finance
        yahoo_sym = f"{sym}.NS"
        targets.append((sym, yahoo_sym))

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    manifest_rows: list[dict[str, Any]] = []

    for idx, (sym, yahoo_sym) in enumerate(targets, 1):
        logger.info(f"[{idx}/{len(targets)}] Processing {sym} ({yahoo_sym})...")
        row = fetch_symbol_data(
            symbol=sym,
            yahoo_symbol=yahoo_sym,
            raw_dir=raw_dir,
            session=session,
            delay=delay,
            force=force,
        )
        manifest_rows.append(row)

    # Write manifest CSV
    fieldnames = [
        "symbol",
        "yahoo_symbol",
        "bars",
        "first_date",
        "last_date",
        "sha256",
        "status",
        "reason",
        "artifact_count",
    ]
    with open(manifest_csv, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(manifest_rows)

    logger.info("=" * 70)
    logger.info("Step A1 Fetch Completed")
    total_processed = len(manifest_rows)
    qualified = sum(1 for r in manifest_rows if r["status"] in ("QUALIFIED", "BENCHMARK_OK"))
    dropped = sum(1 for r in manifest_rows if r["status"] == "DROPPED")
    errors = sum(1 for r in manifest_rows if r["status"] == "ERROR")

    logger.info(f"Total Targets: {total_processed}")
    logger.info(f"Qualified Series (>= 756 bars): {qualified}")
    logger.info(f"Dropped Series (< 756 bars or 404): {dropped}")
    logger.info(f"Errors: {errors}")
    logger.info(f"Manifest written to: {manifest_csv}")
    logger.info("=" * 70)

    return manifest_csv, log_file


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Equity Stance R0: Step A1 Data Fetch")
    parser.add_argument(
        "--universe",
        type=Path,
        default=Path("apps/ml/data/equity_universe_nifty500.csv"),
        help="Path to Nifty 500 universe CSV",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("apps/ml/research_data"),
        help="Output root directory for research data cache",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=REQUEST_DELAY_SECONDS,
        help="Seconds delay between network requests (default: 1.2)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force re-fetch of existing cached raw files",
    )

    args = parser.parse_args()
    run_a1_fetch(args.universe, args.output, force=args.force, delay=args.delay)
