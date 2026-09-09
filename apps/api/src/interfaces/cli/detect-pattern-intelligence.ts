import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import {
  PostgresPatternCoverageRecorder,
  PostgresPatternDefinitionRegistry,
  PostgresPatternObservationLedger,
} from "../../infrastructure/database/repositories/postgres-pattern-intelligence-repository.js";
import { DetectPatternIntelligence } from "../../modules/pattern-intelligence/application/detect-pattern-intelligence.js";
import type { ObservationSource } from "../../modules/pattern-intelligence/domain/contracts.js";
import {
  normalizeTimeframe,
  normalizeUnderlying,
  priceScaleFromTickSize,
} from "../../modules/pattern-intelligence/domain/instrument-identifiers.js";
import { istSessionDate } from "../../modules/platform/calendar/trading-session.js";
import { getOption, parseDateOption, requireOption } from "./arguments.js";

/**
 * Runs Pattern Intelligence V1.0.1 detection over a stored candle window and persists the result.
 *
 * ## Why this is a separate entry point from `detect-market-patterns`
 *
 * The incumbent writes `pattern_detections` and `price_action_events`, both built on `confidence` and
 * `direction: BULLISH/BEARISH` — fields V1.0.1 bans. The two detectors answer different questions and
 * neither reads the other's tables, so folding them into one command would only create a run where
 * half the flags do nothing. Errata Section 8 keeps them isolated.
 *
 * ## Definitions are registered before anything is detected
 *
 * The Implementation Gate forbids persisting an observation whose PatternDefinition is not frozen and
 * stored. `registerFrozenDefinitions` runs first and refuses outright if a stored hash disagrees with
 * the code's, because that means detection rules moved without a version bump and any observation
 * already recorded cites a specification that no longer exists.
 *
 * ## Re-running is safe and expected
 *
 * Inserts are keyed on the observation's logical key — the observable facts of the event, not the
 * per-run UUID — so a re-scan of an overlapping window is a no-op rather than a duplicate set. That
 * is what allows a scheduled pass to use overlapping windows for warmup without polluting the store.
 *
 * ## The window needs a warmup runway
 *
 * A detector refuses to emit for any bar with fewer than 14 closed bars behind it, and the context
 * statistics need 20. Passing exactly the window of interest therefore silently yields nothing for
 * its first bars. `--from` should sit at least 20 bars before the range actually wanted; the run
 * reports how many candidates it refused for warmup so a too-tight window is visible rather than
 * looking like a quiet market.
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = normalizeUnderlying(requireOption(argumentsList, "instrument"));
    const timeframe = normalizeTimeframe(requireOption(argumentsList, "timeframe"));
    const fromArg = getOption(argumentsList, "from");
    const toArg = getOption(argumentsList, "to");
    const from = fromArg ? parseDateOption(fromArg, false) : null;
    const to = toArg ? parseDateOption(toArg, true) : null;

    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) throw new Error(`NSE instrument "${symbol}" is not registered.`);

    const definitions = new PostgresPatternDefinitionRegistry(database);
    const registration = await definitions.registerFrozenDefinitions();
    console.log(`Definitions: ${registration.inserted} newly frozen, ${registration.alreadyPresent} already present.`);

    const candleRepo = new PostgresCandleRepository(database);
    const stored = await candleRepo.listCompleted(instrument.id, timeframe);
    const candles = stored
      .filter((candle) => (from === null || candle.openTime >= from) && (to === null || candle.openTime <= to))
      .map((candle) => ({
        openTime: candle.openTime,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close: Number(candle.close),
        volume: Number(candle.volume),
      }));

    if (candles.length === 0) {
      console.log(`No completed ${timeframe} candles for ${symbol} in the requested window.`);
      return;
    }

    const firstBarDate = istSessionDate(candles[0]!.openTime);
    let referenceLevels: { pdh: number; pdl: number; pdc: number } | undefined;

    // Resolve causal reference levels from prior session completed bars
    const priorBars = stored.filter((c) => istSessionDate(c.openTime) < firstBarDate);
    if (priorBars.length > 0) {
      const latestPriorDate = istSessionDate(priorBars[priorBars.length - 1]!.openTime);
      const priorSessionBars = priorBars.filter((c) => istSessionDate(c.openTime) === latestPriorDate);
      if (priorSessionBars.length > 0) {
        referenceLevels = {
          pdh: Math.max(...priorSessionBars.map((c) => Number(c.high))),
          pdl: Math.min(...priorSessionBars.map((c) => Number(c.low))),
          pdc: Number(priorSessionBars[priorSessionBars.length - 1]!.close),
        };
      }
    }

    if (!referenceLevels) {
      const dailyCandles = await candleRepo.listCompleted(instrument.id, "1d");
      const priorDailyBars = dailyCandles.filter((c) => istSessionDate(c.openTime) < firstBarDate);
      if (priorDailyBars.length > 0) {
        const lastDaily = priorDailyBars[priorDailyBars.length - 1]!;
        referenceLevels = {
          pdh: Number(lastDaily.high),
          pdl: Number(lastDaily.low),
          pdc: Number(lastDaily.close),
        };
      }
    }

    if (referenceLevels) {
      console.log(
        `PIT Session Reference Levels resolved: PDH=${referenceLevels.pdh}, PDL=${referenceLevels.pdl}, PDC=${referenceLevels.pdc}`
      );
    }

    /*
     * `dataVintageAt` sets every observation's `knownAt`, and through it `earliestExecutionAt` —
     * Bar 0 for any forward evaluation. Which vintage is correct depends on what the run is for, so
     * it is an explicit mode rather than a default nobody notices.
     *
     * BACKFILL — the vintage of the *data*, taken as the first bar in the window. The detector is
     * strictly causal (every engine reads indices <= the detection bar, and the one that inspects a
     * forward window, SwingStructureEngine, stamps `detectedIndex = pivot + swingWindow` so the
     * pivot is dated when it became knowable). A pattern on a closed bar was therefore computable at
     * that bar's close, whenever the job happens to run. `knownAt` collapses to `detectedAt` and
     * `earliestExecutionAt` becomes the next bar open, which is what a forward-return study needs.
     * It asserts computability, not that anything actually computed it then.
     *
     * LIVE — the wall clock, for a run happening alongside the tape. `knownAt` then records genuine
     * computation time, which is the only basis for an operational claim that a live system could
     * have acted on the signal.
     *
     * Getting this wrong is not subtle but it is silent: stamping the wall clock on a historical
     * window gave all 6,471 observations of a five-session backfill the *same* `earliestExecutionAt`
     * — one distinct value across the whole store — because every `knownAt` landed after every bar,
     * so the forward scan for the next bar always fell through to the duration fallback.
     */
    const mode = (getOption(argumentsList, "mode") ?? "backfill").trim().toLowerCase();
    if (mode !== "backfill" && mode !== "live") {
      throw new Error(`Unsupported --mode "${mode}". Use: backfill, live.`);
    }
    const dataVintageAt = mode === "live" ? new Date() : candles[0]!.openTime;
    const source: ObservationSource = {
      exchange: "NSE",
      underlying: symbol,
      instrumentType: instrument.instrumentType === "INDEX" ? "INDEX" : "FUTIDX",
      contractSymbol: instrument.symbol,
      contractExpiry: instrument.instrumentType === "INDEX" || !instrument.expiryDate
        ? null
        : new Date(instrument.expiryDate),
      contractRole: instrument.instrumentType === "INDEX" ? "SPOT" : "NEAR_MONTH",
      timeframe,
      timezone: "Asia/Kolkata",
      priceScale: priceScaleFromTickSize(Number(instrument.tickSize)),
      tickSize: Number(instrument.tickSize),
      // The mode is in the id so a stored row says which vintage rule produced its knownAt, rather
      // than leaving a reader to infer it from whether the timestamp looks like a bar time.
      dataVintageId: `pattern-intelligence-${mode}:${dataVintageAt.toISOString()}`,
      dataVintageAt,
    };

    const ledger = new PostgresPatternObservationLedger(database, instrument.id);
    const result = await new DetectPatternIntelligence({
      definitions,
      ledger,
      coverage: new PostgresPatternCoverageRecorder(database, instrument.id),
    }).execute({ candles, source, referenceLevels });

    console.log([
      `${symbol} ${timeframe} [${mode}]: evaluated ${result.candlesEvaluated} candles`,
      // Sealed vs actually stored. A re-scan seals every observation it re-finds and stores none of
      // them, so reporting only the seal count would claim writes that did not happen.
      `detected ${result.patternsDetected}, sealed ${result.patternsRecorded}`
      + ` -> stored ${ledger.insertedCount} new, ${ledger.deduplicatedCount} already present`,
      `refused -> warmup ${result.candidatesRefusedBeforeWarmup},`
      + ` out-of-session ${result.candidatesRefusedOutsideSession},`
      + ` stale-bar ${result.candidatesRefusedStaleBar},`
      + ` unregistered ${result.candidatesRefusedUnregistered}`,
      result.unregisteredDefinitionIds.length > 0
        ? `missing definitions: ${result.unregisteredDefinitionIds.join(", ")}` : null,
      result.familiesBlockedByDataReadiness.length > 0
        ? `blocked by data readiness: ${result.familiesBlockedByDataReadiness.join(", ")}` : null,
    ].filter(Boolean).join("\n"));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
