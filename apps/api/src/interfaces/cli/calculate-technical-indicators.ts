import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresIndicatorDefinitionRepository } from "../../infrastructure/database/repositories/postgres-indicator-definition-repository.js";
import { PostgresIndicatorSnapshotRepository } from "../../infrastructure/database/repositories/postgres-indicator-snapshot-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { CalculateTechnicalIndicators } from "../../modules/technical-analysis/application/calculate-technical-indicators.js";
import { defaultIndicatorDefinitions, SMC_ALGORITHM_VERSION } from "../../modules/technical-analysis/domain/technical-indicator.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const fromArg = getOption(argumentsList, "from");
    const since = fromArg ? parseDateOption(fromArg, false) : undefined;
    const family = (getOption(argumentsList, "family") ?? "all").toLowerCase();
    if (family !== "all" && family !== "smc") {
      throw new Error(`Unsupported indicator family "${family}". Use all or smc.`);
    }
    const definitions = family === "smc"
      ? defaultIndicatorDefinitions.filter((definition) => definition.algorithmVersion === SMC_ALGORITHM_VERSION)
      : undefined;
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered.`);
    }
    const result = await new CalculateTechnicalIndicators(
      new PostgresCandleRepository(database),
      new PostgresIndicatorDefinitionRepository(database),
      new PostgresIndicatorSnapshotRepository(database),
    ).execute({ instrumentId: instrument.id, timeframe, since, definitions });
    console.info(JSON.stringify({ level: "info", message: "Technical indicator calculation complete", instrument: symbol, timeframe, family, since: since?.toISOString(), ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
