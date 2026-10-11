import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleFeatureCoverageRepository } from "../../infrastructure/database/repositories/postgres-candle-feature-coverage-repository.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresPatternDefinitionRepository } from "../../infrastructure/database/repositories/postgres-pattern-definition-repository.js";
import { PostgresPatternDetectionRepository } from "../../infrastructure/database/repositories/postgres-pattern-detection-repository.js";
import { PostgresPriceActionEventRepository } from "../../infrastructure/database/repositories/postgres-price-action-event-repository.js";
import { DetectMarketPatterns } from "../../modules/pattern-recognition/application/detect-market-patterns.js";
import { atrPriceActionConfiguration, PriceActionEngine } from "../../modules/pattern-recognition/domain/price-action-engine.js";
import { CandlestickPatternEngine } from "../../modules/pattern-recognition/domain/candlestick-pattern-engine.js";
import {
  priceActionAlgorithmVersion,
  priceActionAtrAlgorithmVersion,
} from "../../modules/pattern-recognition/domain/market-pattern.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

/**
 * Without `--threshold-mode` the use case picks the `price-action-v3` engine for the timeframe
 * (ATR units on intraday, percent on daily) and stores under `price-action-v3`; that is the
 * normal run. `--threshold-mode atr` forces ATR units on any timeframe and is stored under its own
 * `price-action-v3-atr` version, because a different unit is a different interpretation of the
 * rules. `--threshold-mode percent` is only accepted for the daily timeframe, where it is what the
 * default already does: forcing percent units onto an intraday series under the `price-action-v3`
 * label would re-create the mixed-rule rows the version bump exists to end.
 */
const priceActionVariants = {
  atr: { engine: () => new PriceActionEngine(atrPriceActionConfiguration), algorithmVersion: priceActionAtrAlgorithmVersion },
} as const;

function parseThresholdMode(value: string | undefined): "default" | "atr" {
  if (value === undefined) return "default";
  const normalized = value.trim().toLowerCase();
  if (normalized !== "percent" && normalized !== "atr") {
    throw new Error(`Unsupported --threshold-mode "${value}". Use: percent, atr.`);
  }
  return normalized === "atr" ? "atr" : "default";
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const requestedMode = getOption(argumentsList, "threshold-mode");
    const thresholdMode = parseThresholdMode(requestedMode);
    if (requestedMode?.trim().toLowerCase() === "percent" && timeframe !== "1d") {
      throw new Error(
        `--threshold-mode percent is only valid for --timeframe 1d (got ${timeframe}); `
        + "omit the flag for the timeframe-appropriate default.",
      );
    }
    const fromArg = getOption(argumentsList, "from");
    const since = fromArg ? parseDateOption(fromArg, false) : undefined;
    const variant = thresholdMode === "atr" ? priceActionVariants.atr : null;
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered.`);
    }
    const result = await new DetectMarketPatterns(
      new PostgresCandleRepository(database),
      new PostgresPatternDefinitionRepository(database),
      new PostgresPatternDetectionRepository(database),
      new PostgresPriceActionEventRepository(database),
      new CandlestickPatternEngine(),
      variant ? variant.engine() : null,
      undefined,
      // Records that this window was processed, which is what lets the scalp research harness
      // tell "no pattern here" from "not detected yet" and stop capturing half-built contexts.
      new PostgresCandleFeatureCoverageRepository(database),
    ).execute({
      instrumentId: instrument.id,
      timeframe,
      priceActionAlgorithmVersion: variant ? variant.algorithmVersion : priceActionAlgorithmVersion,
      since,
      tickSize: Number.isFinite(Number(instrument.tickSize)) && Number(instrument.tickSize) > 0
        ? Number(instrument.tickSize)
        : undefined,
    });
    console.info(JSON.stringify({
      level: "info",
      message: "Market pattern detection complete",
      instrument: symbol,
      timeframe,
      since: since?.toISOString(),
      thresholdMode,
      priceActionAlgorithmVersion: variant ? variant.algorithmVersion : priceActionAlgorithmVersion,
      ...result,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
