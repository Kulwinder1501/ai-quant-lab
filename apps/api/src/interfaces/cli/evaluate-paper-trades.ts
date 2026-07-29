import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { EvaluateOpenPaperTrades } from "../../modules/paper-trading/application/evaluate-open-paper-trades.js";
import { getOption } from "./arguments.js";
import { parseNonNegativeNumber, parseOptionalTimestamp, requirePaperAccount } from "./paper-trading-arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const account = await requirePaperAccount(new PostgresPaperAccountRepository(database), argumentsList);
    const result = await new EvaluateOpenPaperTrades(
      new PostgresPaperTradeRepository(database),
      new PostgresCandleRepository(database),
    ).execute({
      accountId: account.id,
      asOf: parseOptionalTimestamp(argumentsList, "as-of", new Date()),
      exitFees: parseNonNegativeNumber(getOption(argumentsList, "exit-fees"), "exit-fees"),
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
