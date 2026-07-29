import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { RunBacktest } from "../../modules/backtesting/application/run-backtest.js";
import { trendBreakoutStrategyRegistration } from "../../modules/strategy-engine/domain/trend-breakout-strategy.js";
import { PostgresBacktestMarketDataRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-market-data-repository.js";
import { PostgresBacktestRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-repository.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";
import { parseNonNegativeNumber, parsePositiveNumber } from "./paper-trading-arguments.js";

function optionalDate(argumentsList: string[], option: string, fallback: Date): Date {
  const value = getOption(argumentsList, option);
  return value ? parseDateOption(value, false) : fallback;
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const dataWindowStart = parseDateOption(requireOption(argumentsList, "from"), false);
    const dataWindowEnd = parseDateOption(requireOption(argumentsList, "to"), true);
    const dataCutoffAt = optionalDate(argumentsList, "data-cutoff-at", new Date());
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered.`);
    }

    const strategyVersion = await new PostgresStrategyVersionRepository(database).ensure(trendBreakoutStrategyRegistration);
    if (strategyVersion.isArchived || !strategyVersion.isActive) {
      throw new Error(`Strategy version ${strategyVersion.strategyKey}@${strategyVersion.version} is not active.`);
    }

    const result = await new RunBacktest(
      new PostgresBacktestRepository(database),
      new PostgresBacktestMarketDataRepository(database),
    ).execute({
      strategyVersionId: strategyVersion.id,
      strategyConfiguration: strategyVersion.configuration,
      instrumentId: instrument.id,
      timeframe,
      dataWindowStart,
      dataWindowEnd,
      dataCutoffAt,
      execution: {
        quantity: parsePositiveNumber(getOption(argumentsList, "quantity") ?? "1", "quantity"),
        initialCapital: parsePositiveNumber(getOption(argumentsList, "initial-capital") ?? "100000", "initial-capital"),
        feePerOrder: parseNonNegativeNumber(getOption(argumentsList, "fee-per-order"), "fee-per-order"),
        slippageBps: parseNonNegativeNumber(getOption(argumentsList, "slippage-bps"), "slippage-bps"),
      },
    });

    console.info(JSON.stringify({
      level: "info",
      message: "Historical backtest complete",
      instrument: symbol,
      dataWindowStart: dataWindowStart.toISOString(),
      dataWindowEnd: dataWindowEnd.toISOString(),
      dataCutoffAt: dataCutoffAt.toISOString(),
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
