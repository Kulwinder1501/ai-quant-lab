import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { EquityAlertsEvaluationService } from "../../modules/equity-research/application/equity-alerts-evaluation-service.js";
import { formatIstDateString } from "../../modules/equity-research/domain/state-rules.js";
import { PostgresEquityAlertRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-alert-repository.js";
import { PostgresEquityCorporateActionRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import { PostgresEquityEventFlagRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-event-flag-repository.js";
import { PostgresEquityPriceBarRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-price-bar-repository.js";
import { PostgresEquitySecondaryFactRepository } from "../../modules/equity-research/infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
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
    const secondaryFactRepo = new PostgresEquitySecondaryFactRepository(database);

    const alertsService = new EquityAlertsEvaluationService(
      watchlistRepo,
      priceBarRepo,
      alertRepo,
      eventFlagRepo,
      sourceHealthRepo,
      corporateActionRepo,
      secondaryFactRepo,
    );

    const { date, symbol, exchange } = parseArgs(process.argv.slice(2));
    const targetDate = date ?? formatIstDateString(new Date());

    const result = await alertsService.evaluateAll(targetDate, { symbol, exchange });

    // Only record completion if evaluating a past date, or today after 17:05 IST
    const now = new Date();
    const istMs = now.getTime() + 5.5 * 60 * 60_000;
    const istDate = new Date(istMs);
    const todayIst = istDate.toISOString().slice(0, 10);
    const minuteOfDay = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
    const isPastDate = targetDate < todayIst;
    const isTodayAfterCutoff = targetDate === todayIst && minuteOfDay >= 17 * 60 + 5;

    if (isPastDate || isTodayAfterCutoff) {
      try {
        await database.query(
          `INSERT INTO scheduled_job_runs (
            id, job_type, scheduled_for, status, claimed_by, claimed_at, completed_at
          ) VALUES (
            gen_random_uuid(),
            'EQUITY_ALERTS_EVAL',
            ($1 || ' 17:00:00+05:30')::timestamptz,
            'COMPLETED',
            'eval-equity-alerts',
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT (job_type, scheduled_for)
          DO UPDATE SET
            status = 'COMPLETED',
            completed_at = CURRENT_TIMESTAMP`,
          [targetDate],
        );
      } catch {
        // Non-critical tracking error
      }
    }

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
