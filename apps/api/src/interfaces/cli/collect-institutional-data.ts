import "dotenv/config";
import pg from "pg";
import { NseApiClient } from "../../infrastructure/external/nse-api-client.js";
import { PostgresInstitutionalFlowRepository } from "../../infrastructure/database/repositories/postgres-institutional-flow-repository.js";
import { PostgresOffshoreDerivativeRepository } from "../../infrastructure/database/repositories/postgres-offshore-derivative-repository.js";
import { CollectInstitutionalDataService } from "../../modules/market-data/application/collect-institutional-data.js";

async function main(): Promise<void> {
  const database = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const service = new CollectInstitutionalDataService(
      new NseApiClient(),
      new PostgresInstitutionalFlowRepository(database),
      new PostgresOffshoreDerivativeRepository(database),
    );

    console.info("Starting institutional data collection...");
    const result = await service.execute();

    for (const warning of result.warnings) {
      console.warn(`⚠️  ${warning}`);
    }
    console.info(
      `Stored FII/DII for session ${result.flowSessionDate}. ` +
        `GIFT Nifty: ${result.offshoreStored ? "stored" : "unavailable"}.`,
    );

    // A stale print is not a crash, but it does mean the expected session is
    // still missing. A distinct non-zero code lets a scheduler retry rather than
    // treating a publication delay as a completed collection.
    if (result.flowIsStale) {
      console.warn("Expected session not yet available; exiting non-zero so the caller can retry.");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error("Institutional data collection failed:", error);
    process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main();
