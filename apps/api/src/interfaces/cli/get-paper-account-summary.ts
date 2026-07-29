import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { PostgresPaperTradeRepository } from "../../infrastructure/database/repositories/postgres-paper-trade-repository.js";
import { GetPaperAccountSummary } from "../../modules/paper-trading/application/get-paper-account-summary.js";
import { requirePaperAccount } from "./paper-trading-arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const account = await requirePaperAccount(new PostgresPaperAccountRepository(database), argumentsList);
    const summary = await new GetPaperAccountSummary(new PostgresPaperTradeRepository(database)).execute(account.id);
    console.info(JSON.stringify({ level: "info", message: "Paper account summary", account: account.name, ...summary }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
