import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresIndicatorDefinitionRepository } from "../../infrastructure/database/repositories/postgres-indicator-definition-repository.js";
import { PostgresIndicatorSnapshotRepository } from "../../infrastructure/database/repositories/postgres-indicator-snapshot-repository.js";
import { PostgresPatternDefinitionRepository } from "../../infrastructure/database/repositories/postgres-pattern-definition-repository.js";
import { PostgresPatternDetectionRepository } from "../../infrastructure/database/repositories/postgres-pattern-detection-repository.js";
import { PostgresPriceActionEventRepository } from "../../infrastructure/database/repositories/postgres-price-action-event-repository.js";
import { DetectMarketPatterns } from "../../modules/pattern-recognition/application/detect-market-patterns.js";
import { CandlestickPatternEngine } from "../../modules/pattern-recognition/domain/candlestick-pattern-engine.js";
import { PriceActionEngine } from "../../modules/pattern-recognition/domain/price-action-engine.js";
import { CalculateTechnicalIndicators } from "../../modules/technical-analysis/application/calculate-technical-indicators.js";
import type { HistoricalTimeframe } from "../../modules/market-data/domain/historical-data-provider.js";

interface MigratedSeries {
  instrument_id: string;
  symbol: string;
  timeframe: HistoricalTimeframe;
}

/** Recomputes every derived technical row invalidated by the source cutover. */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const rows = await database.query<MigratedSeries>(`
      SELECT DISTINCT c.instrument_id, i.symbol, c.timeframe
      FROM candles c
      JOIN instruments i ON i.id = c.instrument_id
      WHERE c.source = 'fyers-api-v3'
        AND c.source_metadata->>'migration' = 'yahoo-to-fyers'
      ORDER BY i.symbol, c.timeframe
    `);
    const candles = new PostgresCandleRepository(database);
    const indicators = new CalculateTechnicalIndicators(
      candles,
      new PostgresIndicatorDefinitionRepository(database),
      new PostgresIndicatorSnapshotRepository(database),
    );
    const patterns = new DetectMarketPatterns(
      candles,
      new PostgresPatternDefinitionRepository(database),
      new PostgresPatternDetectionRepository(database),
      new PostgresPriceActionEventRepository(database),
      new CandlestickPatternEngine(),
      new PriceActionEngine(),
    );

    for (const [index, row] of rows.rows.entries()) {
      const indicatorResult = await indicators.execute({
        instrumentId: row.instrument_id,
        timeframe: row.timeframe,
      });
      const patternResult = await patterns.execute({
        instrumentId: row.instrument_id,
        timeframe: row.timeframe,
        priceActionAlgorithmVersion: "price-action-v2",
      });
      console.info(JSON.stringify({
        phase: "evidence-rebuilt",
        series: `${index + 1}/${rows.rows.length}`,
        symbol: row.symbol,
        timeframe: row.timeframe,
        indicators: indicatorResult,
        patterns: patternResult,
      }));
    }
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
