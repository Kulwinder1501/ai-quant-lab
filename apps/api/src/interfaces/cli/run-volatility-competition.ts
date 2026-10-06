import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresVolatilityCompetitionRepository } from "../../infrastructure/database/repositories/postgres-volatility-competition-repository.js";
import { RunVolatilityCompetition } from "../../modules/model-predictions/application/run-volatility-competition.js";

/**
 * Ranks volatility models on settled live outcomes and assigns PRIMARY/CHALLENGER.
 *
 * A sibling of `models:compete`, never a replacement. A volatility PRIMARY informs risk
 * and regime context only; it is not a trade direction and nothing in the directional
 * path reads it.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const result = await new RunVolatilityCompetition(
      new PostgresVolatilityCompetitionRepository(database),
    ).execute();
    console.info(JSON.stringify({
      level: "info",
      message: "Volatility competition complete",
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
