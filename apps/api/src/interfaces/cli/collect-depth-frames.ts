import "dotenv/config";
import { randomUUID } from "node:crypto";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { FyersTbtDepthStreamer } from "../../infrastructure/market-data/fyers-tbt-depth-streamer.js";
import { PostgresDepthFrameRepository } from "../../infrastructure/database/repositories/postgres-depth-frame-repository.js";
import {
  DepthFrameBuffer,
  DEFAULT_MAX_BUFFERED_FRAMES,
} from "../../modules/market-data/application/capture-depth-frames.js";
import { summariseSequenceHealth } from "../../modules/market-data/domain/depth-frame-sequencing.js";
import { NseMarketSession } from "../../modules/market-data/domain/nse-market-session.js";
import { frontMonthFuturesSymbol } from "../../modules/market-data/domain/depth-frame-staleness.js";

/**
 * Captures raw order-book depth for a set of contracts and reports the feed's integrity (Phase 28
 * step 1).
 *
 * A daemon, not a scheduled job, for the same reason `collect-live-market-data` is: it holds a
 * socket open for a session, so the scheduler's overlap guard would see a run that never ends and
 * write it off mid-session.
 *
 * ## The report is the deliverable, not the rows
 *
 * Phase 1's gate is not "frames were stored" but "the stored frames are provably reconstructible".
 * On shutdown this reads back what it persisted and prints a sequence-health verdict per symbol,
 * computed over the *table* rather than over in-memory counters, so the number describes what a
 * researcher would actually query. A capture that cannot publish that verdict has not met the gate,
 * however many rows it wrote.
 *
 * ## It is a daemon, so it says so while it runs
 *
 * Without `--minutes` this runs until interrupted, and it deliberately does not log per frame -- at
 * the feed's peak that would flood a session's output and cost more than the capture. The first
 * version therefore printed one startup line and then nothing, which is indistinguishable from a
 * hung process; it was reported as "not working" when it was in fact capturing normally. A heartbeat
 * every `--progress-seconds` now reports frames, rows and buffer depth, so silence means stalled
 * rather than merely quiet.
 *
 * Usage:
 *   collect-depth-frames --underlying=BANKNIFTY[,...] [--levels=10]
 *                        [--flush-seconds=2] [--minutes=N] [--min-pairs=500]
 *                        [--progress-seconds=30]
 *
 * `--underlying` resolves the front-month futures contract from `option_expiry_calendar` at startup.
 * `--symbols=NSE:BANKNIFTY26SEPFUT` still pins an exact contract, for a one-off capture of a specific
 * expiry or to reproduce a past session. Passing both is refused.
 *
 * ## The staleness guard, and the failure it exists for
 *
 * Contract symbols roll. `NSE:BANKNIFTY26AUGFUT` stops existing after the August expiry, and an ATM
 * option symbol stops being ATM long before that. Subscribing to a dead symbol does not error --
 * this feed accepts the subscription and delivers **nothing**, which is the same shape as a quiet
 * book. A long-running collector pointed at a rolled contract would therefore look healthy while
 * capturing zero frames, and the first sign of trouble would be an empty table weeks later.
 *
 * So during market hours, a gap of `--stale-after-seconds` with no frames is logged as an ERROR on
 * every check. It deliberately does **not** exit: this project has already lost a session to a
 * crash-restart loop (85 restarts on 2026-08-18), and a self-killing daemon under
 * `restart: unless-stopped` would reproduce that shape. Loud and running beats dead and restarting.
 *
 * The guard remains, but the front-month half of the underlying problem is now fixed rather than
 * merely alarmed: `--underlying` resolves the contract from the calendar at every startup, so a roll
 * takes a container restart instead of someone remembering to edit compose. ATM *option* symbols are
 * still pinned by the caller and still drift, so the guard is what covers that half.
 *
 * Ctrl+C (or SIGTERM) stops it and prints the integrity report.
 */

interface Options {
  /** Explicitly pinned contracts. Empty when `--underlying` is used instead. */
  symbols: string[];
  /** Underlyings whose front month is resolved at startup. Empty when `--symbols` is used. */
  underlyings: string[];
  levels: number;
  flushSeconds: number;
  /** Stop after this many minutes. Omitted means run until interrupted. */
  minutes: number | null;
  minimumComparablePairs: number;
  progressSeconds: number;
  /** Seconds of silence during market hours before an ERROR is logged. */
  staleAfterSeconds: number;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }

  const symbols = (values.get("symbols") ?? "")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol !== "");
  const underlyings = (values.get("underlying") ?? "")
    .split(",")
    .map((underlying) => underlying.trim().toUpperCase())
    .filter((underlying) => underlying !== "");

  /*
   * Exactly one of the two, and `--underlying` is the one to use.
   *
   * `--symbols` pins a contract for the life of the container, which is how BANKNIFTY26AUGFUT stayed
   * subscribed after its 2026-08-25 expiry and cost two unbackfillable sessions of L2 to a feed that
   * answers a dead subscription with silence. `--underlying` resolves the front month from
   * `option_expiry_calendar` at startup, so the roll happens by restarting rather than by someone
   * remembering to edit compose.
   *
   * `--symbols` is kept, not deprecated: pinning an exact contract is the right thing for a one-off
   * capture of a specific expiry, and for reproducing a past session. Refusing both together rather
   * than silently preferring one keeps a half-migrated compose file from looking like it works.
   */
  if (symbols.length > 0 && underlyings.length > 0) {
    throw new Error("Pass --underlying or --symbols, not both. --underlying resolves the front month; --symbols pins an exact contract.");
  }
  if (symbols.length === 0 && underlyings.length === 0) {
    throw new Error("--underlying is required, for example --underlying=BANKNIFTY (or --symbols=NSE:BANKNIFTY26SEPFUT to pin one contract).");
  }

  const positive = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be positive.`);
    return parsed;
  };

  return {
    symbols,
    underlyings,
    levels: Math.floor(positive("levels", 10)),
    flushSeconds: positive("flush-seconds", 2),
    minutes: values.has("minutes") ? positive("minutes", 1) : null,
    minimumComparablePairs: Math.floor(positive("min-pairs", 500)),
    progressSeconds: positive("progress-seconds", 30),
    staleAfterSeconds: positive("stale-after-seconds", 300),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const appId = environment.FYERS_APP_ID ?? "";
  if (!appId) throw new Error("FYERS_APP_ID is not set.");

  /*
   * Resolve the front month before anything else opens a socket.
   *
   * Refuses to start when the calendar lists no unexpired expiry, rather than falling back to a
   * computed last-Thursday date. A wrong symbol here is the worst outcome available: the feed accepts
   * it and delivers silence, which is what cost two sessions of L2 in August.
   */
  const resolvedSymbols = options.symbols.length > 0 ? options.symbols : [];
  for (const underlying of options.underlyings) {
    const expiries = await database.query<{ expiry_date: string }>(
      `SELECT DISTINCT to_char(expiry_date, 'YYYY-MM-DD') AS expiry_date
       FROM option_expiry_calendar
       WHERE underlying_symbol = $1
       ORDER BY expiry_date`,
      [underlying],
    );
    const symbol = frontMonthFuturesSymbol({
      underlying,
      now: new Date(),
      expiries: expiries.rows.map((row) => row.expiry_date),
    });
    if (symbol === null) {
      throw new Error(
        `No unexpired ${underlying} expiry is listed in option_expiry_calendar, so the front-month `
        + "contract cannot be resolved. Refusing to start: this feed accepts an invalid symbol and "
        + "then delivers nothing. Check the OPTION_CHAIN job is populating the calendar.",
      );
    }
    console.info(JSON.stringify({
      level: "info",
      message: "Resolved front-month futures contract",
      underlying,
      symbol,
      source: "option_expiry_calendar",
    }));
    resolvedSymbols.push(symbol);
  }

  const repository = new PostgresDepthFrameRepository(database);
  const buffer = new DepthFrameBuffer("fyers-tbt", DEFAULT_MAX_BUFFERED_FRAMES);
  const startedAt = new Date();
  // Attributes every row this process writes, so the report below describes this capture rather than
  // whatever else happened to be writing the same contract. See migration 071.
  const captureSessionId = randomUUID();

  const streamer = new FyersTbtDepthStreamer({
    tokenService: new FyersTokenService({
      pool: database,
      appId,
      appSecret: environment.FYERS_APP_SECRET ?? "",
      pin: process.env.FYERS_PIN ?? "",
    }),
    levelsToStore: options.levels,
  });

  streamer.on("frame", (frame) => { buffer.accept(frame); });

  let written = 0;
  let flushFailures = 0;
  const flush = async (): Promise<void> => {
    const rows = buffer.drain();
    if (rows.length === 0) return;
    try {
      written += await repository.append(rows, captureSessionId);
    } catch (error) {
      // Counted and logged, never silent: a failing flush is indistinguishable from a quiet feed in
      // the row count alone, and it is the most likely cause of an unexplained gap.
      flushFailures += 1;
      console.error(JSON.stringify({
        level: "error",
        message: "Could not append a depth frame batch; those frames are lost.",
        rows: rows.length,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const flushTimer = setInterval(() => { void flush(); }, options.flushSeconds * 1_000);

  const marketSession = new NseMarketSession(
    (process.env.NSE_HOLIDAYS ?? "").split(",").map((day) => day.trim()).filter((day) => day !== ""),
  );

  // The heartbeat. Without it a working daemon is indistinguishable from a hung one.
  const progressTimer = setInterval(() => {
    const bufferStats = buffer.stats();
    const streamStats = streamer.stats();

    // Silence during market hours is the symptom of a rolled or mistyped symbol, which this feed
    // reports by delivering nothing at all rather than by erroring. See the header.
    const now = new Date();
    if (marketSession.isOpen(now)) {
      const lastFrameMs = streamStats.lastFrameAt?.getTime() ?? startedAt.getTime();
      const silentForSeconds = Math.round((now.getTime() - lastFrameMs) / 1_000);
      if (silentForSeconds >= options.staleAfterSeconds) {
        console.error(JSON.stringify({
          level: "error",
          message: "No depth frames during market hours; the subscription may be dead.",
          silentForSeconds,
          symbols: resolvedSymbols,
          hint: "A rolled or mistyped contract is accepted by this feed and then delivers nothing. "
            + "Check the expiry and strike are still live.",
          framesReceived: streamStats.framesReceived,
        }));
      }
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Depth capture progress",
      elapsedSeconds: Math.round((Date.now() - startedAt.getTime()) / 1_000),
      framesReceived: streamStats.framesReceived,
      rowsWritten: written,
      buffered: bufferStats.buffered,
      selfDropped: bufferStats.selfDropped,
      flushFailures,
      lastFrameAt: streamStats.lastFrameAt?.toISOString() ?? null,
    }));
  }, options.progressSeconds * 1_000);

  let finished = false;
  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearInterval(flushTimer);
    clearInterval(progressTimer);
    streamer.close();
    await flush();

    const finishedAt = new Date();
    const bufferStats = buffer.stats();
    const streamStats = streamer.stats();

    const perSymbol = [];
    for (const symbol of resolvedSymbols) {
      const classified = await repository.listClassifiedFrames({
        providerSymbol: symbol,
        captureSessionId,
      });
      const foreignRows = await repository.countForeignRowsInWindow({
        providerSymbol: symbol,
        captureSessionId,
        from: startedAt,
        to: finishedAt,
      });
      perSymbol.push({
        symbol,
        // Non-zero means another writer was capturing this contract at the same time. The health
        // below is still sound (it is scoped to this session), but any window-scoped query a
        // researcher writes later would mix the two streams.
        foreignRowsInWindow: foreignRows,
        health: summariseSequenceHealth(classified, {
          minimumComparablePairs: options.minimumComparablePairs,
        }),
      });
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Depth frame capture complete",
      stoppedBecause: reason,
      captureSessionId,
      window: { from: startedAt.toISOString(), to: finishedAt.toISOString() },
      levelsStored: options.levels,
      rowsWritten: written,
      flushFailures,
      // Non-zero selfDropped means gaps below are partly ours, so the feed verdict describes our
      // plumbing rather than the vendor's. Reported next to the verdict for exactly that reason.
      buffer: bufferStats,
      stream: {
        framesReceived: streamStats.framesReceived,
        unparseableMessages: streamStats.droppedMessages,
        lastFrameAt: streamStats.lastFrameAt?.toISOString() ?? null,
      },
      perSymbol,
    }, null, 2));

    await database.end();
    process.exit(0);
  };

  process.on("SIGINT", () => { void finish("SIGINT"); });
  process.on("SIGTERM", () => { void finish("SIGTERM"); });
  if (options.minutes !== null) {
    setTimeout(() => { void finish(`reached --minutes=${options.minutes}`); },
      options.minutes * 60_000);
  }

  console.info(JSON.stringify({
    level: "info",
    message: "Starting depth frame capture",
    captureSessionId,
    symbols: resolvedSymbols,
    levels: options.levels,
    flushSeconds: options.flushSeconds,
    minutes: options.minutes,
    note: options.minutes === null
      ? `Running until interrupted; progress every ${options.progressSeconds}s. Ctrl+C to stop and report.`
      : `Stopping after ${options.minutes} minute(s).`,
  }));

  streamer.subscribe(resolvedSymbols);
  await streamer.connect();
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Depth frame capture failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
