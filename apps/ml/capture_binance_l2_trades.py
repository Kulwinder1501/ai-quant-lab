"""
Binance L2 Depth and Ground-Truth Trade Capture Daemon
Pre-Registration PREREG-2026-10-21-BINANCE-DEPLETION-VALIDATION-V1

Connects to Binance Spot public WebSocket streams and persists raw order-book depth frames
and ground-truth trade prints to SQLite.

Two tables created in SQLite:
1. depth_updates:
   (id, symbol, received_at_ms, event_time_ms, first_update_id, last_update_id,
    is_snapshot, is_duplicate, is_regression, gap_before,
    bid_price_0, bid_qty_0, ask_price_0, ask_qty_0)
2. trades:
   (id, symbol, trade_id, price, qty, trade_time_ms, received_at_ms, is_buyer_maker)

Maintains local order books according to Binance protocol:
- Buffers diffs during initial / resync snapshot fetch
- Validates sequence continuity: U <= last_applied_u + 1 <= u
- Resynchronizes on gaps / regressions rather than continuing silently
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
import urllib.request

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from ai_quant_lab_ml.binance_book_adapter import BinanceLocalOrderBook, SequenceGapError

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("binance_capture")

DEFAULT_DB_PATH = BASE_DIR / "data" / "binance_l2_trades.db"
DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT"]
BINANCE_WS_BASE = "wss://stream.binance.com:9443/stream"
BINANCE_REST_BASE = "https://api.binance.com/api/v3/depth"


def init_sqlite_db(db_path: Path) -> sqlite3.Connection:
    """Initializes SQLite database with WAL mode and required tables."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False, timeout=30.0)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA busy_timeout = 30000;")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS depth_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            received_at_ms INTEGER NOT NULL,
            event_time_ms INTEGER NOT NULL,
            first_update_id INTEGER,
            last_update_id INTEGER,
            is_snapshot INTEGER NOT NULL DEFAULT 0,
            is_duplicate INTEGER NOT NULL DEFAULT 0,
            is_regression INTEGER NOT NULL DEFAULT 0,
            gap_before INTEGER,
            bid_price_0 REAL NOT NULL,
            bid_qty_0 REAL NOT NULL,
            ask_price_0 REAL NOT NULL,
            ask_qty_0 REAL NOT NULL
        );
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT NOT NULL,
            trade_id INTEGER NOT NULL,
            price REAL NOT NULL,
            qty REAL NOT NULL,
            trade_time_ms INTEGER NOT NULL,
            received_at_ms INTEGER NOT NULL,
            is_buyer_maker INTEGER NOT NULL
        );
    """)

    conn.execute("CREATE INDEX IF NOT EXISTS idx_depth_symbol_time ON depth_updates(symbol, received_at_ms);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_symbol_time ON trades(symbol, trade_time_ms);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_trades_symbol_price ON trades(symbol, price);")
    conn.commit()
    return conn


def fetch_depth_snapshot_sync(symbol: str, limit: int = 1000) -> Dict[str, Any]:
    """Fetches depth snapshot from Binance REST API synchronously."""
    url = f"{BINANCE_REST_BASE}?symbol={symbol.upper()}&limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": "AI-Quant-Lab-Research/1.0"})
    with urllib.request.urlopen(req, timeout=10.0) as resp:
        return json.loads(resp.read().decode("utf-8"))


class BinanceCaptureService:
    def __init__(
        self,
        db_path: Path,
        symbols: List[str],
        duration_seconds: Optional[int] = None,
        snapshot_limit: int = 1000,
    ):
        self.db_path = db_path
        self.symbols = [s.upper() for s in symbols]
        self.duration_seconds = duration_seconds
        self.snapshot_limit = snapshot_limit

        self.conn = init_sqlite_db(self.db_path)
        self.books: Dict[str, BinanceLocalOrderBook] = {s: BinanceLocalOrderBook(s) for s in self.symbols}
        self.snapshot_in_progress: Dict[str, bool] = {s: False for s in self.symbols}

        self.depth_batch: List[Tuple] = []
        self.trades_batch: List[Tuple] = []
        self.lock = asyncio.Lock()
        self.is_running = False

        self.stats = {
            s: {"depth_updates": 0, "trades": 0, "snapshots": 0, "gaps": 0}
            for s in self.symbols
        }

    async def flush_batches(self) -> None:
        """Flushes buffered depth and trade updates to SQLite."""
        async with self.lock:
            if not self.depth_batch and not self.trades_batch:
                return
            to_write_depth = list(self.depth_batch)
            to_write_trades = list(self.trades_batch)
            self.depth_batch.clear()
            self.trades_batch.clear()

        # Run SQLite insert in thread pool to avoid blocking async loop
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._db_write, to_write_depth, to_write_trades)

    def _db_write(self, depth_rows: List[Tuple], trade_rows: List[Tuple]) -> None:
        cur = self.conn.cursor()
        if depth_rows:
            cur.executemany("""
                INSERT INTO depth_updates (
                    symbol, received_at_ms, event_time_ms, first_update_id, last_update_id,
                    is_snapshot, is_duplicate, is_regression, gap_before,
                    bid_price_0, bid_qty_0, ask_price_0, ask_qty_0
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, depth_rows)

        if trade_rows:
            cur.executemany("""
                INSERT INTO trades (
                    symbol, trade_id, price, qty, trade_time_ms, received_at_ms, is_buyer_maker
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """, trade_rows)
        self.conn.commit()

    async def schedule_snapshot(self, symbol: str) -> None:
        """Fetches and applies REST depth snapshot asynchronously."""
        if self.snapshot_in_progress[symbol]:
            return
        self.snapshot_in_progress[symbol] = True
        logger.info(f"[{symbol}] Requesting REST depth snapshot (limit={self.snapshot_limit})...")

        loop = asyncio.get_running_loop()
        try:
            snapshot = await loop.run_in_executor(
                None, fetch_depth_snapshot_sync, symbol, self.snapshot_limit
            )
            now_ms = int(time.time() * 1000)
            book = self.books[symbol]
            frame = book.apply_snapshot(snapshot)

            # Record snapshot row
            row = (
                symbol, now_ms, now_ms, book.last_update_id, book.last_applied_u,
                1, 0, 0, None,
                frame.bid_price_0, frame.bid_qty_0, frame.ask_price_0, frame.ask_qty_0
            )
            async with self.lock:
                self.depth_batch.append(row)
            self.stats[symbol]["snapshots"] += 1
            logger.info(
                f"[{symbol}] Snapshot applied: lastUpdateId={book.last_update_id}, "
                f"touch: {frame.bid_price_0:.2f} ({frame.bid_qty_0}) / {frame.ask_price_0:.2f} ({frame.ask_qty_0})"
            )
        except SequenceGapError as sge:
            logger.warning(f"[{symbol}] Gap during snapshot apply: {sge}. Rescheduling snapshot...")
            await asyncio.sleep(0.5)
            self.snapshot_in_progress[symbol] = False
            asyncio.create_task(self.schedule_snapshot(symbol))
            return
        except Exception as e:
            logger.error(f"[{symbol}] Failed to fetch/apply snapshot: {e}", exc_info=True)
        finally:
            self.snapshot_in_progress[symbol] = False

    async def handle_depth_event(self, symbol: str, data: Dict[str, Any], received_at_ms: int) -> None:
        book = self.books[symbol]
        event_time_ms = int(data.get("E", received_at_ms))
        first_u = int(data.get("U", 0))
        last_u = int(data.get("u", 0))

        if not book.is_synchronized:
            book.buffer_event(data)
            if not self.snapshot_in_progress[symbol]:
                asyncio.create_task(self.schedule_snapshot(symbol))
            return

        # Synchronized: apply diff
        dt_received = datetime.fromtimestamp(received_at_ms / 1000.0, tz=timezone.utc)
        frame = book.apply_diff(data, received_at=dt_received)

        row = (
            symbol,
            received_at_ms,
            event_time_ms,
            first_u,
            last_u,
            1 if frame.is_snapshot else 0,
            1 if frame.is_duplicate else 0,
            1 if frame.is_regression else 0,
            frame.gap_before,
            frame.bid_price_0,
            frame.bid_qty_0,
            frame.ask_price_0,
            frame.ask_qty_0,
        )

        async with self.lock:
            self.depth_batch.append(row)
        self.stats[symbol]["depth_updates"] += 1

        if frame.is_regression:
            logger.warning(f"[{symbol}] Gap detected in stream (gap_before={frame.gap_before}). Triggering resync...")
            self.stats[symbol]["gaps"] += 1
            asyncio.create_task(self.schedule_snapshot(symbol))

    async def handle_trade_event(self, symbol: str, data: Dict[str, Any], received_at_ms: int) -> None:
        trade_id = int(data.get("t", 0))
        price = float(data.get("p", 0.0))
        qty = float(data.get("q", 0.0))
        trade_time_ms = int(data.get("T", received_at_ms))
        is_buyer_maker = 1 if bool(data.get("m", False)) else 0

        row = (
            symbol,
            trade_id,
            price,
            qty,
            trade_time_ms,
            received_at_ms,
            is_buyer_maker,
        )

        async with self.lock:
            self.trades_batch.append(row)
        self.stats[symbol]["trades"] += 1

    async def periodic_flush(self) -> None:
        """Periodically flushes database batches every 500ms."""
        while self.is_running:
            await asyncio.sleep(0.5)
            try:
                await self.flush_batches()
            except Exception as e:
                logger.error(f"Error during periodic batch flush: {e}", exc_info=True)

    async def run(self) -> None:
        import websockets

        stream_names = []
        for s in self.symbols:
            s_lower = s.lower()
            stream_names.append(f"{s_lower}@depth@100ms")
            stream_names.append(f"{s_lower}@trade")

        ws_url = f"{BINANCE_WS_BASE}?streams={'/'.join(stream_names)}"
        logger.info(f"Connecting to Binance combined stream: {ws_url}")

        self.is_running = True
        flush_task = asyncio.create_task(self.periodic_flush())

        start_time = time.time()
        end_time = (start_time + self.duration_seconds) if self.duration_seconds else None

        try:
            async with websockets.connect(
                ws_url,
                ping_interval=20,
                ping_timeout=20,
                max_size=10 * 1024 * 1024,
            ) as ws:
                logger.info("Connected to Binance WebSocket. Commencing capture...")
                # Kick off initial snapshots now that websocket is actively buffering incoming diffs
                for s in self.symbols:
                    asyncio.create_task(self.schedule_snapshot(s))

                while self.is_running:
                    if end_time and time.time() >= end_time:
                        logger.info(f"Capture duration target reached ({self.duration_seconds}s). Stopping capture.")
                        break

                    try:
                        msg = await asyncio.wait_for(ws.recv(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue

                    now_ms = int(time.time() * 1000)
                    payload = json.loads(msg)
                    stream_id = payload.get("stream", "")
                    data = payload.get("data", {})

                    event_type = data.get("e", "")
                    symbol = data.get("s", "").upper()

                    if not symbol and "@" in stream_id:
                        symbol = stream_id.split("@")[0].upper()

                    if event_type == "depthUpdate":
                        await self.handle_depth_event(symbol, data, now_ms)
                    elif event_type == "trade":
                        await self.handle_trade_event(symbol, data, now_ms)

        except asyncio.CancelledError:
            logger.info("Capture task cancelled.")
        except Exception as e:
            logger.error(f"WebSocket connection error: {e}", exc_info=True)
        finally:
            self.is_running = False
            flush_task.cancel()
            await self.flush_batches()
            self.conn.close()
            elapsed = time.time() - start_time
            logger.info(f"Capture stopped. Total elapsed time: {elapsed:.1f}s")
            for s in self.symbols:
                logger.info(
                    f"[{s}] Depth Frames: {self.stats[s]['depth_updates']}, "
                    f"Trades: {self.stats[s]['trades']}, "
                    f"Snapshots: {self.stats[s]['snapshots']}, "
                    f"Gaps: {self.stats[s]['gaps']}"
                )


def main():
    parser = argparse.ArgumentParser(description="Binance L2 Depth and Ground-Truth Trade Capture")
    parser.add_argument("--db-path", type=str, default=str(DEFAULT_DB_PATH), help="Path to SQLite database")
    parser.add_argument("--symbols", type=str, default=",".join(DEFAULT_SYMBOLS), help="Comma-separated symbols")
    parser.add_argument("--duration-seconds", type=int, default=None, help="Capture duration in seconds (optional)")
    parser.add_argument("--snapshot-limit", type=int, default=1000, help="Depth limit for REST snapshots")

    args = parser.parse_args()
    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    db_path = Path(args.db_path)

    service = BinanceCaptureService(
        db_path=db_path,
        symbols=symbols,
        duration_seconds=args.duration_seconds,
        snapshot_limit=args.snapshot_limit,
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def shutdown(signum, frame):
        logger.info(f"Signal {signum} received, stopping capture...")
        service.is_running = False

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        loop.run_until_complete(service.run())
    finally:
        loop.close()


if __name__ == "__main__":
    main()
