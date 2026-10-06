import "dotenv/config";
import { loadEnvironment } from "./config/environment.js";
import { createDatabasePool } from "./infrastructure/database/database.js";
import { createApp } from "./interfaces/http/app.js";

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
const app = createApp({ database, environment });

const server = app.listen(environment.API_PORT, () => {
  console.info(`AI Quant Lab API listening on port ${environment.API_PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.info(`${signal} received; shutting down API.`);
  server.close(async () => {
    await database.end();
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
