import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { PostgresTradeIdeaRepository } from "../../infrastructure/database/repositories/postgres-trade-idea-repository.js";
import { GenerateTradeIdeas } from "../../modules/strategy-engine/application/generate-trade-ideas.js";
import { parseHistoricalTimeframe, requireOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered.`);
    }
    const result = await new GenerateTradeIdeas(
      new PostgresStrategyVersionRepository(database),
      new PostgresStrategyMarketContextRepository(database),
      new PostgresTradeIdeaRepository(database),
    ).execute({ instrumentId: instrument.id, timeframe });
    for (const res of result) {
      if (res.skippedReason === "STRATEGY_FAILED") {
        console.error(`Failed (${res.strategyKey}): ${res.failureMessage ?? "unknown error"}`);
      } else if (res.skippedReason) {
        console.log(`Skipped (${res.strategyKey}): ${res.skippedReason}`);
      } else {
        console.log(`Success (${res.strategyKey}): Generated ${res.candidatesGenerated} candidate(s).`);
        for (const ideaId of res.tradeIdeaIds) {
          console.log(` - Idea ID: ${ideaId}`);
        }
      }
    }
    console.info(JSON.stringify({ level: "info", message: "Trade-idea generation complete", instrument: symbol, timeframe, result }));
    // A strategy that could not run is a real failure even though the strategies
    // that did run kept their results, so the exit code has to reflect it.
    if (result.some((res) => res.skippedReason === "STRATEGY_FAILED")) {
      process.exitCode = 1;
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
