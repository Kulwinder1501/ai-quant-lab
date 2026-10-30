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
import { priceActionAlgorithmVersion } from "../../modules/pattern-recognition/domain/market-pattern.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

/**
 * Detects candlestick, chart-pattern and price-action events for one instrument and timeframe and stores them under the current
 * versions. The price-action rules pick their unit by timeframe (ATR on intraday, percent on daily), carry the ATR across sessions,
 * re-anchor swings whose confirming candle is a suppressed bar, and ask for a retest before a swing is called SUPPORT or RESISTANCE
 * on the timeframes below 15m; see `priceActionConfigurationForTimeframe` and `DetectMarketPatterns`.
 *
 * There is one rule set and one label (`price-action-v4`). The earlier versions and their `--threshold-mode` / `--engine` switches
 * were retired on 2026-10-30; their rows remain in the table as history and every ordinary reader excludes them.
 */
async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const fromArg = getOption(argumentsList, "from");
    const since = fromArg ? parseDateOption(fromArg, false) : undefined;
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered.`);
    }
    const result = await new DetectMarketPatterns(
      new PostgresCandleRepository(database),
      new PostgresPatternDefinitionRepository(database),
      new PostgresPatternDetectionRepository(database),
      new PostgresPriceActionEventRepository(database),
      undefined,
      undefined,
      undefined,
      // Records that this window was processed, which is what lets the scalp research harness
      // tell "no pattern here" from "not detected yet" and stop capturing half-built contexts.
      new PostgresCandleFeatureCoverageRepository(database),
    ).execute({
      instrumentId: instrument.id,
      timeframe,
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
      priceActionAlgorithmVersion,
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
