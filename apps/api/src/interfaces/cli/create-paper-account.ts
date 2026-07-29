import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPaperAccountRepository } from "../../infrastructure/database/repositories/postgres-paper-account-repository.js";
import { CreatePaperAccount } from "../../modules/paper-trading/application/create-paper-account.js";
import { requireOption } from "./arguments.js";
import { parsePositiveNumber } from "./paper-trading-arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const account = await new CreatePaperAccount(new PostgresPaperAccountRepository(database)).execute({
      name: requireOption(argumentsList, "name"),
      openingBalance: parsePositiveNumber(requireOption(argumentsList, "opening-balance"), "opening-balance"),
    });
    console.info(JSON.stringify({ level: "info", message: "Paper account created", account }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
