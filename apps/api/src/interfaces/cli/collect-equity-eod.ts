import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { EquityAlertsEvaluationService } from "../../modules/equity-research/application/equity-alerts-evaluation-service.js";
import { EquityEodCollector } from "../../modules/equity-research/application/equity-eod-collector.js";
import { PostgresEquityAlertRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-alert-repository.js";
import { PostgresEquityCorporateActionRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import { PostgresEquityEventFlagRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-event-flag-repository.js";
import { PostgresEquityPriceBarRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-price-bar-repository.js";
import { PostgresEquityQuoteCacheRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-quote-cache-repository.js";
import { PostgresEquityRawRecordRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-raw-record-repository.js";
import { PostgresEquitySecondaryFactRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import { PostgresEquitySourceHealthRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-source-health-repository.js";
import { PostgresEquityWatchlistRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-watchlist-repository.js";
import { YahooClient } from "../../modules/equity-research/infrastructure/yahoo-client.js";

function parseArgs(args: string[]): { symbol?: string; exchange?: "NSE" | "BSE" } {
  let symbol: string | undefined;
  let exchange: "NSE" | "BSE" | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbol" && i + 1 < args.length) {
      symbol = args[i + 1].toUpperCase();
    } else if (args[i] === "--exchange" && i + 1 < args.length) {
      const ex = args[i + 1].toUpperCase();
      if (ex === "NSE" || ex === "BSE") exchange = ex;
    }
  }

  return { symbol, exchange };
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const watchlistRepo = new PostgresEquityWatchlistRepository(database);
    const rawRecordRepo = new PostgresEquityRawRecordRepository(database);
    const priceBarRepo = new PostgresEquityPriceBarRepository(database);
    const corporateActionRepo = new PostgresEquityCorporateActionRepository(database);
    const secondaryFactRepo = new PostgresEquitySecondaryFactRepository(database);
    const quoteCacheRepo = new PostgresEquityQuoteCacheRepository(database);
    const sourceHealthRepo = new PostgresEquitySourceHealthRepository(database);

    const yahooClient = new YahooClient({
      sourceHealthRepo,
      maxDailyBudget: 300,
      minIntervalMs: 1000, // 1 req/s per-host gate
    });

    const alertRepo = new PostgresEquityAlertRepository(database);
    const eventFlagRepo = new PostgresEquityEventFlagRepository(database);
    const alertsService = new EquityAlertsEvaluationService(
      watchlistRepo,
      priceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
      corporateActionRepo,
    );

    const collector = new EquityEodCollector(
      watchlistRepo,
      rawRecordRepo,
      priceBarRepo,
      corporateActionRepo,
      secondaryFactRepo,
      quoteCacheRepo,
      yahooClient,
      alertsService,
    );

    const options = parseArgs(process.argv.slice(2));
    const result = await collector.collectAll(options);

    console.info(JSON.stringify({
      level: "info",
      message: "Equity EOD collection complete",
      at: new Date().toISOString(),
      ...result,
    }));

    if (result.totalStocks > 0 && result.successfulStocks === 0) {
      process.exitCode = 1;
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Equity EOD collection crashed",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  }));
  process.exitCode = 1;
});
