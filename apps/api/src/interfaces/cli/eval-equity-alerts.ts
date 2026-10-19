import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { EquityAlertsEvaluationService } from "../../modules/equity-research/application/equity-alerts-evaluation-service.js";
import { formatIstDateString } from "../../modules/equity-research/domain/state-rules.js";
import { PostgresEquityAlertRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-alert-repository.js";
import { PostgresEquityCorporateActionRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import { PostgresEquityEventFlagRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-event-flag-repository.js";
import { PostgresEquityPriceBarRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-price-bar-repository.js";
import { PostgresEquitySourceHealthRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-source-health-repository.js";
import { PostgresEquityWatchlistRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-watchlist-repository.js";

function parseArgs(args: string[]): {
  date?: string;
  symbol?: string;
  exchange?: "NSE" | "BSE";
} {
  let date: string | undefined;
  let symbol: string | undefined;
  let exchange: "NSE" | "BSE" | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--date" && i + 1 < args.length) {
      date = args[i + 1];
    } else if (args[i] === "--symbol" && i + 1 < args.length) {
      symbol = args[i + 1].toUpperCase();
    } else if (args[i] === "--exchange" && i + 1 < args.length) {
      const ex = args[i + 1].toUpperCase();
      if (ex === "NSE" || ex === "BSE") exchange = ex;
    }
  }

  return { date, symbol, exchange };
}

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const watchlistRepo = new PostgresEquityWatchlistRepository(database);
    const priceBarRepo = new PostgresEquityPriceBarRepository(database);
    const alertRepo = new PostgresEquityAlertRepository(database);
    const eventFlagRepo = new PostgresEquityEventFlagRepository(database);
    const sourceHealthRepo = new PostgresEquitySourceHealthRepository(database);
    const corporateActionRepo = new PostgresEquityCorporateActionRepository(database);

    const alertsService = new EquityAlertsEvaluationService(
      watchlistRepo,
      priceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
      corporateActionRepo,
    );

    const { date, symbol, exchange } = parseArgs(process.argv.slice(2));
    const targetDate = date ?? formatIstDateString(new Date());

    const result = await alertsService.evaluateAll(targetDate, { symbol, exchange });

    console.info(
      JSON.stringify({
        level: "info",
        message: "Equity alerts evaluation complete",
        at: new Date().toISOString(),
        ...result,
      }),
    );
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Equity alerts evaluation crashed",
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
  process.exitCode = 1;
});
