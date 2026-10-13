import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresIctShadowSignalRepository } from "../../infrastructure/database/repositories/postgres-ict-shadow-signal-repository.js";

/**
 * Prints the shadow ledger by variant, instrument, timeframe and bias alignment.
 *
 * `biasAligned = true` rows are the control: setups the live strategy also proposes, measured the
 * same way. `false` is the counter-bias population this ledger exists to measure. Mean R is the
 * UNDERLYING's path in R from the signal bar's close with no costs, so it is an upper bound on
 * anything a bot would book; read it only as a comparison between the two populations.
 */
async function main(): Promise<void> {
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const rows = await new PostgresIctShadowSignalRepository(database).summarise();
    console.info(JSON.stringify({
      level: "info",
      message: "ICT shadow ledger",
      rows: rows.map((row) => ({ ...row, meanR: row.meanR === null ? null : Number(row.meanR.toFixed(3)) })),
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("ICT shadow report failed:", error);
  process.exitCode = 1;
});
