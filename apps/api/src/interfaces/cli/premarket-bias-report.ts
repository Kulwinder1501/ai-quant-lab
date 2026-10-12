import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresPremarketBiasRepository } from "../../infrastructure/database/repositories/postgres-premarket-repository.js";
import { baselineAccuracy, buildObservations } from "../../modules/premarket-intelligence/domain/observations.js";
import { scoreLevels, scoreObservations } from "../../modules/premarket-intelligence/domain/scoring.js";

/**
 * The pre-registered scorecard: the deterministic baselines over every measured session, and the
 * model against them over the sessions where it produced a validated assessment. Read-only.
 */
async function main(): Promise<void> {
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const repository = new PostgresPremarketBiasRepository(database);
    const [bias, outcomes] = await Promise.all([repository.listBiasRows(), repository.listOutcomes()]);
    const { observations, levels } = buildObservations(bias, outcomes);
    console.info(JSON.stringify({
      snapshots: bias.length,
      snapshotsWithValidatedModel: bias.filter((row) => row.llmStatus === "VALIDATED").length,
      measuredInstrumentSessions: outcomes.length,
      baselines: baselineAccuracy(bias, outcomes),
      model: scoreObservations(observations),
      levels: scoreLevels(levels),
    }, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
