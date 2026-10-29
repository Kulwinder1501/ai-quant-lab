import "dotenv/config";
import { loadEnvironment } from "./config/environment.js";
import { createDatabasePool } from "./infrastructure/database/database.js";
import { PostgresFyersRequestLedger } from "./infrastructure/database/repositories/postgres-fyers-request-ledger.js";
import { mayRestartForDeadFeed, mayRestartForTokenRotation } from "./infrastructure/market-data/fyers-token-rotation.js";
import { fyersRequestCounter, flushFyersRequestCounts } from "./modules/market-data/domain/fyers-request-counter.js";
import { createApp } from "./interfaces/http/app.js";

const environment = loadEnvironment();
const database = createDatabasePool(environment.DATABASE_URL);
const fyersLedger = new PostgresFyersRequestLedger(database);
fyersLedger.attachToGlobalCounter();

let restartingForFyersSocket = false;

const app = createApp({
  database,
  environment,
  onFyersTokenRotated: () => void restartForNewFyersToken(),
  onFyersFeedDead: () => void restartForDeadFyersFeed(),
});

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
  if (!mayRestartForTokenRotation({ uptimeSeconds: process.uptime(), alreadyRestarting: restartingForFyersSocket })) return;
  await restartForFyersSocket("Fyers access token rotated; restarting the API so its live socket can use the new one");
}

/**
 * The live socket was connected but delivered nothing for a minute during the session. On 2026-10-29 the watchdog replaced the socket
 * and the replacement stayed dead for over two minutes; restarting the API cured it. Same forced exit as for a rotated token, but
 * with a ten-minute uptime guard (see fyers-token-rotation.ts), so a feed that stays dead after a restart cannot loop the API.
 */
async function restartForDeadFyersFeed(): Promise<void> {
  if (!mayRestartForDeadFeed({ uptimeSeconds: process.uptime(), alreadyRestarting: restartingForFyersSocket })) return;
  await restartForFyersSocket("The Fyers live socket delivered nothing for a minute in the session; restarting the API to get a working one");
}

async function restartForFyersSocket(message: string): Promise<void> {
  restartingForFyersSocket = true;
  console.warn(JSON.stringify({
    level: "warn",
    message,
    uptimeSeconds: Math.round(process.uptime()),
  }));
  setTimeout(() => process.exit(0), 5_000);
  server.close();
  try {
    await flushFyersRequestCounts(fyersRequestCounter, (line) => console.info(line), "server");
    await database.end();
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "Could not finish the shutdown before restarting for the Fyers socket", error: error instanceof Error ? error.message : String(error) }));
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
