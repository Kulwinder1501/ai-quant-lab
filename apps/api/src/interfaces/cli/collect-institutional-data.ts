import "dotenv/config";
import pg from "pg";
import { NseApiClient } from "../../infrastructure/external/nse-api-client.js";
import { PostgresInstitutionalFlowRepository } from "../../infrastructure/database/repositories/postgres-institutional-flow-repository.js";
import { PostgresOffshoreDerivativeRepository } from "../../infrastructure/database/repositories/postgres-offshore-derivative-repository.js";
import { CollectInstitutionalDataService } from "../../modules/market-data/application/collect-institutional-data.js";

async function main() {
  const database = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const nseApiClient = new NseApiClient();
    const institutionalFlowRepo = new PostgresInstitutionalFlowRepository(database);
    const offshoreDerivativeRepo = new PostgresOffshoreDerivativeRepository(database);

    const service = new CollectInstitutionalDataService(
      nseApiClient,
      institutionalFlowRepo,
      offshoreDerivativeRepo
    );

    console.info("Starting institutional data collection...");
    await service.execute();
    console.info("Collection complete.");

  } catch (error) {
    console.error("Critical error during institutional data collection:", error);
    process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main();
