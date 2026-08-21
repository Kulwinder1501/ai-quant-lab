import "dotenv/config";
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
 * Usage:
 *   collect-depth-frames --symbols=NSE:BANKNIFTY26AUGFUT[,...] [--levels=10]
 *                        [--flush-seconds=2] [--minutes=N] [--min-pairs=500]
 */

interface Options {
  symbols: string[];
  levels: number;
  flushSeconds: number;
  /** Stop after this many minutes. Omitted means run until interrupted. */
  minutes: number | null;
  minimumComparablePairs: number;
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
  if (symbols.length === 0) {
    throw new Error("--symbols is required, for example --symbols=NSE:BANKNIFTY26AUGFUT");
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
    levels: Math.floor(positive("levels", 10)),
    flushSeconds: positive("flush-seconds", 2),
    minutes: values.has("minutes") ? positive("minutes", 1) : null,
    minimumComparablePairs: Math.floor(positive("min-pairs", 500)),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const appId = environment.FYERS_APP_ID ?? "";
  if (!appId) throw new Error("FYERS_APP_ID is not set.");

  const repository = new PostgresDepthFrameRepository(database);
  const buffer = new DepthFrameBuffer("fyers-tbt", DEFAULT_MAX_BUFFERED_FRAMES);
  const startedAt = new Date();

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
      written += await repository.append(rows);
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

  let finished = false;
  const finish = async (reason: string): Promise<void> => {
    if (finished) return;
    finished = true;
    clearInterval(flushTimer);
    streamer.close();
    await flush();

    const finishedAt = new Date();
    const bufferStats = buffer.stats();
    const streamStats = streamer.stats();

    const perSymbol = [];
    for (const symbol of options.symbols) {
      const classified = await repository.listClassifiedFrames({
        providerSymbol: symbol,
        from: startedAt,
        to: finishedAt,
      });
      perSymbol.push({
        symbol,
        health: summariseSequenceHealth(classified, {
          minimumComparablePairs: options.minimumComparablePairs,
        }),
      });
    }

    console.info(JSON.stringify({
      level: "info",
      message: "Depth frame capture complete",
      stoppedBecause: reason,
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
    symbols: options.symbols,
    levels: options.levels,
    flushSeconds: options.flushSeconds,
    minutes: options.minutes,
  }));

  streamer.subscribe(options.symbols);
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
