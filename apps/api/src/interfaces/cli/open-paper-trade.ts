import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { OpenPaperTrade } from "../../modules/paper-trading/application/open-paper-trade.js";
import { getOption, requireOption } from "./arguments.js";
import { parseNonNegativeNumber, parseOptionalTimestamp, parsePositiveNumber, requirePaperAccount } from "./paper-trading-arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const accountRepository = new PostgresPaperAccountRepository(database);
    const account = await requirePaperAccount(accountRepository, argumentsList);
    const trade = await new OpenPaperTrade(new PostgresPaperTradeRepository(database)).execute({
      accountId: account.id,
      tradeIdeaId: requireOption(argumentsList, "idea"),
      quantity: parsePositiveNumber(requireOption(argumentsList, "quantity"), "quantity"),
      fillPrice: parsePositiveNumber(requireOption(argumentsList, "fill-price"), "fill-price"),
      entryFees: parseNonNegativeNumber(getOption(argumentsList, "fees"), "fees"),
      entrySlippage: parseNonNegativeNumber(getOption(argumentsList, "slippage"), "slippage"),
      notes: getOption(argumentsList, "notes"),
      openedAt: parseOptionalTimestamp(argumentsList, "opened-at", new Date()),
    });
    console.info(JSON.stringify({ level: "info", message: "Simulated paper trade opened", trade }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
