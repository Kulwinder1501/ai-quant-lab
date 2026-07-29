import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { instrumentTypes, type Instrument, type InstrumentType } from "../../modules/market-data/domain/instrument.js";
import { getOption, requireOption } from "./arguments.js";

function parseExchange(value: string): Instrument["exchange"] {
  if (value === "NSE" || value === "NFO" || value === "BSE") {
    return value;
  }
  throw new Error("Unsupported exchange. Use NSE, NFO, or BSE.");
}

function parseInstrumentType(value: string): InstrumentType {
  if ((instrumentTypes as readonly string[]).includes(value)) {
    return value as InstrumentType;
  }
  throw new Error(`Unsupported instrument type. Use: ${instrumentTypes.join(", ")}.`);
}

function parsePositiveInteger(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Lot size must be a positive integer.");
  }
  return parsed;
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const instrument = await new PostgresInstrumentRepository(database).upsert({
      exchange: parseExchange((getOption(argumentsList, "exchange") ?? "NSE").toUpperCase()),
      symbol: requireOption(argumentsList, "symbol"),
      displayName: requireOption(argumentsList, "name"),
      instrumentType: parseInstrumentType((getOption(argumentsList, "type") ?? "EQUITY").toUpperCase()),
      isin: getOption(argumentsList, "isin") ?? null,
      tickSize: getOption(argumentsList, "tick-size") ?? "0.05",
      lotSize: parsePositiveInteger(getOption(argumentsList, "lot-size"), 1),
      metadata: getOption(argumentsList, "kite-quote-symbol")
        ? { kiteQuoteSymbol: getOption(argumentsList, "kite-quote-symbol") }
        : {},
    });
    console.info(JSON.stringify({ level: "info", message: "Instrument registered", instrument }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
