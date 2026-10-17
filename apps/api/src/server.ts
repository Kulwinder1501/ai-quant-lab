import "dotenv/config";
import { loadEnvironment } from "./config/environment.js";
import { createDatabasePool } from "./infrastructure/database/database.js";
import { PostgresFyersRequestLedger } from "./infrastructure/database/repositories/postgres-fyers-request-ledger.js";
import { fyersRequestCounter, flushFyersRequestCounts } from "./modules/market-data/domain/fyers-request-counter.js";
import { createApp } from "./interfaces/http/app.js";

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
const fyersLedger = new PostgresFyersRequestLedger(database);
fyersLedger.attachToGlobalCounter();

const app = createApp({ database, environment });

const server = app.listen(environment.API_PORT, () => {
  console.info(`AI Quant Lab API listening on port ${environment.API_PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received; shutting down API.`);
  server.close(async () => {
    await flushFyersRequestCounts(fyersRequestCounter, (line) => console.info(line), "server");
    await database.end();
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

