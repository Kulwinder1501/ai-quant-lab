import "dotenv/config";
import { loadEnvironment } from "./config/environment.js";
import { createDatabasePool } from "./infrastructure/database/database.js";
import { PostgresFyersRequestLedger } from "./infrastructure/database/repositories/postgres-fyers-request-ledger.js";
import { mayRestartForTokenRotation } from "./infrastructure/market-data/fyers-token-rotation.js";
import { fyersRequestCounter, flushFyersRequestCounts } from "./modules/market-data/domain/fyers-request-counter.js";
import { createApp } from "./interfaces/http/app.js";

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
const fyersLedger = new PostgresFyersRequestLedger(database);
fyersLedger.attachToGlobalCounter();

let restartingForNewFyersToken = false;

const app = createApp({ database, environment, onFyersTokenRotated: () => void restartForNewFyersToken() });

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

/**
 * The vendor's live socket keeps the Fyers token it was created with, so once the token is reissued (every morning) this process
 * can only use the new one by starting again; see fyers-token-rotation.ts. On 2026-10-26 the option-chain page showed "Connecting
 * live feed" for hours because the API kept authenticating with the old token. The container's restart policy brings it back.
 *
 * Unlike `shutdown`, this forces the exit: open server-sent-event streams never end on their own, so `server.close` alone would
 * wait for them forever and leave a process with no working feed.
 */
async function restartForNewFyersToken(): Promise<void> {
  if (!mayRestartForTokenRotation({ uptimeSeconds: process.uptime(), alreadyRestarting: restartingForNewFyersToken })) return;
  restartingForNewFyersToken = true;
  console.warn(JSON.stringify({
    level: "warn",
    message: "Fyers access token rotated; restarting the API so its live socket can use the new one",
    uptimeSeconds: Math.round(process.uptime()),
  }));
  setTimeout(() => process.exit(0), 5_000);
  server.close();
  try {
    await flushFyersRequestCounts(fyersRequestCounter, (line) => console.info(line), "server");
    await database.end();
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "Could not finish the shutdown before restarting for the new Fyers token", error: error instanceof Error ? error.message : String(error) }));
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
