import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { PostgresOptionPremiumTickRepository } from "../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { PostgresIndiaVixImpliedVolatilitySource } from "../../modules/paper-trading/infrastructure/india-vix-implied-volatility-source.js";
import { getOption } from "./arguments.js";
import {
  parseNonNegativeNumber,
  parseOptionalNonNegativeNumber,
  parseOptionalTimestamp,
  requirePaperAccount,
} from "./paper-trading-arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const account = await requirePaperAccount(new PostgresPaperAccountRepository(database), argumentsList);
    const result = await new EvaluateOpenPaperTrades(
      new PostgresPaperTradeRepository(database),
      new PostgresCandleRepository(database),
      new PostgresIndiaVixImpliedVolatilitySource(database),
      new PostgresOptionPremiumTickRepository(database),
    ).execute({
      accountId: account.id,
      asOf: parseOptionalTimestamp(argumentsList, "as-of", new Date()),
      // Omitted rather than zeroed when the flag is absent, so the evaluator prices the exit
      // itself. The scheduler calls this with no --exit-fees.
      exitFees: parseOptionalNonNegativeNumber(getOption(argumentsList, "exit-fees"), "exit-fees"),
      exitSlippage: parseNonNegativeNumber(getOption(argumentsList, "exit-slippage"), "exit-slippage"),
    });
    console.info(JSON.stringify({ level: "info", message: "Paper-trade candle evaluation complete", account: account.name, ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
