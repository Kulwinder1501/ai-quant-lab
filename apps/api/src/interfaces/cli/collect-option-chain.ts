import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresOptionChainRepository } from "../../infrastructure/database/repositories/postgres-option-chain-repository.js";
import { FyersOptionChainClient } from "../../infrastructure/market-data/fyers-option-chain-client.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import { IngestOptionChain } from "../../modules/market-data/application/ingest-option-chain.js";
import { getOption } from "./arguments.js";

/**
 * Collects the current option chain for one or more underlyings.
 *
 * Forward-accumulating by nature: a chain endpoint returns the book as it stands, there
 * is no historical option-chain source, and Workstream D3 forbids presenting today's
 * page as though it were the past. Run it on a schedule and history deepens; run it once
 * and you have one observation.
 */
const DEFAULT_UNDERLYINGS = ["NIFTY50", "BANKNIFTY"];

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();

  const appId = process.env.FYERS_APP_ID;
  const appSecret = process.env.FYERS_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("Option-chain collection requires FYERS_APP_ID and FYERS_APP_SECRET in .env.");
  }

  const underlyingsOption = getOption(argumentsList, "underlyings");
  const underlyingSymbols = underlyingsOption
    ? underlyingsOption.split(",").map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_UNDERLYINGS;
  const strikeCountOption = getOption(argumentsList, "strike-count");
  const strikeCount = strikeCountOption ? Number(strikeCountOption) : undefined;
  if (strikeCount !== undefined && (!Number.isInteger(strikeCount) || strikeCount < 1)) {
    throw new Error("--strike-count must be a positive integer.");
  }

  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const service = new IngestOptionChain(
      new FyersOptionChainClient({
        appId,
        tokenService: new FyersTokenService({
          pool: database,
          appId,
          appSecret,
          pin: process.env.FYERS_PIN ?? "",
        }),
      }),
      new PostgresOptionChainRepository(database),
    );

    const result = await service.execute({ underlyingSymbols, strikeCount });
    console.info(JSON.stringify({
      level: result.failures.length > 0 && result.chains.length === 0 ? "error" : "info",
      message: "Option-chain collection complete",
      ...result,
    }));
    // A run where nothing at all was collected is a failure, not a quiet no-op.
    if (result.chains.length === 0) process.exitCode = 1;
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
