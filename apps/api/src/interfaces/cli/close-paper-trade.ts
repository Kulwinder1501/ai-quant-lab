import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { ClosePaperTrade } from "../../modules/paper-trading/application/close-paper-trade.js";
import { getOption, requireOption } from "./arguments.js";
import {
  parseNonNegativeNumber,
  parseOptionalNonNegativeNumber,
  parseOptionalTimestamp,
  parsePositiveNumber,
} from "./paper-trading-arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const trade = await new ClosePaperTrade(new PostgresPaperTradeRepository(database)).execute({
      paperTradeId: requireOption(argumentsList, "trade"),
      exitPrice: parsePositiveNumber(requireOption(argumentsList, "price"), "price"),
      // `ClosePaperTrade` falls back to a computed breakdown, which an explicit 0 would suppress.
      exitFees: parseOptionalNonNegativeNumber(getOption(argumentsList, "fees"), "fees"),
      exitSlippage: parseNonNegativeNumber(getOption(argumentsList, "slippage"), "slippage"),
      notes: getOption(argumentsList, "notes"),
      closedAt: parseOptionalTimestamp(argumentsList, "closed-at", new Date()),
    });
    console.info(JSON.stringify({ level: "info", message: "Paper trade manually closed", trade }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
