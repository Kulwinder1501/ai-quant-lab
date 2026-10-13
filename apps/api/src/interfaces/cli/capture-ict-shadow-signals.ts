import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresIctShadowSignalRepository } from "../../infrastructure/database/repositories/postgres-ict-shadow-signal-repository.js";
import { captureIctShadowSignals } from "../../modules/strategy-engine/application/ict-shadow-signals.js";

/**
 * Evaluates the ICT shadow variants on the latest completed bar of each tracked series and records
 * what they would have proposed. Idempotent per bar, so it is safe to run on every scheduler tick.
 *
 * It opens no position and creates no trade idea: see `ict-shadow-variant.ts`. A failing series is
 * reported and skipped, and the process exits non-zero only if every series failed.
 */
async function main(): Promise<void> {
  const database = createDatabasePool(loadEnvironment().DATABASE_URL);
  try {
    const instruments = new PostgresInstrumentRepository(database);
    const contexts = new PostgresStrategyMarketContextRepository(database);
    const store = new PostgresIctShadowSignalRepository(database);
    const now = new Date();

    const results = await captureIctShadowSignals({
      findInstrumentId: async (symbol) => (await instruments.findByExchangeAndSymbol("NSE", symbol))?.id ?? null,
      findLatestCompleted: (input) => contexts.findLatestCompleted(input),
      insert: (signal) => store.insert(signal),
    }, now);

    console.info(JSON.stringify({ level: "info", message: "ICT shadow capture", at: now.toISOString(), results }));
    if (results.every((result) => result.status === "FAILED")) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error("ICT shadow capture failed:", error);
  process.exitCode = 1;
});
