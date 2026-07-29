import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresPatternDefinitionRepository } from "../../infrastructure/database/repositories/postgres-pattern-definition-repository.js";
import { PostgresPatternDetectionRepository } from "../../infrastructure/database/repositories/postgres-pattern-detection-repository.js";
import { PostgresPriceActionEventRepository } from "../../infrastructure/database/repositories/postgres-price-action-event-repository.js";
import { DetectMarketPatterns } from "../../modules/pattern-recognition/application/detect-market-patterns.js";
import { atrPriceActionConfiguration, PriceActionEngine } from "../../modules/pattern-recognition/domain/price-action-engine.js";
import { CandlestickPatternEngine } from "../../modules/pattern-recognition/domain/candlestick-pattern-engine.js";
import { getOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

/**
 * ATR-measured distances are a different interpretation of the same rules, so their
 * evidence has to be stored under its own algorithm version. Pairing the two here
 * means a run cannot write ATR-mode events under the percentage-mode label.
 */
const priceActionVariants = {
  percent: { engine: () => new PriceActionEngine(), algorithmVersion: "price-action-v2" },
  atr: { engine: () => new PriceActionEngine(atrPriceActionConfiguration), algorithmVersion: "price-action-v2-atr" },
} as const;

function parseThresholdMode(value: string | undefined): keyof typeof priceActionVariants {
  const normalized = (value ?? "percent").trim().toLowerCase();
  if (normalized !== "percent" && normalized !== "atr") {
    throw new Error(`Unsupported --threshold-mode "${value}". Use: percent, atr.`);
  }
  return normalized;
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const thresholdMode = parseThresholdMode(getOption(argumentsList, "threshold-mode"));
    const variant = priceActionVariants[thresholdMode];
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
      variant.engine(),
    ).execute({
      instrumentId: instrument.id,
      timeframe,
      priceActionAlgorithmVersion: variant.algorithmVersion,
    });
    console.info(JSON.stringify({
      level: "info",
      message: "Market pattern detection complete",
      instrument: symbol,
      timeframe,
      thresholdMode,
      priceActionAlgorithmVersion: variant.algorithmVersion,
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
