import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresCandleRepository } from "../../infrastructure/database/repositories/postgres-candle-repository.js";
import { PostgresIndicatorDefinitionRepository } from "../../infrastructure/database/repositories/postgres-indicator-definition-repository.js";
import { PostgresIndicatorSnapshotRepository } from "../../infrastructure/database/repositories/postgres-indicator-snapshot-repository.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { CalculateTechnicalIndicators } from "../../modules/technical-analysis/application/calculate-technical-indicators.js";
import { defaultIndicatorDefinitions, SMC_ALGORITHM_VERSION } from "../../modules/technical-analysis/domain/technical-indicator.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, parseInstrumentExchange, requireOption } from "./arguments.js";

/*
 * Frozen-feed (flat, zero-volume) bars -- exchange holidays the feed kept printing -- are
 * excluded from ATR / Bollinger / Supertrend by the indicator engine, and no snapshot is written
 * for them or for windows that are mostly flat (see `volatilityOnLiveBars`).
 *
 * This job only UPSERTS, so snapshots written before that rule existed are neither corrected nor
 * removed by a plain re-run unless their candle is live. Listing the affected rows, the optional
 * (never auto-run) cleanup, and the exact recompute commands are in
 * docs/2026-10-10-volatility-audit-fixes.md. `--from` is the only bound (there is no `--to`):
 * the whole series is computed and `--from` limits what is written, unless `--warmup-bars N` is
 * also given, which reads only N bars before `--from` as well (for XAU_USD and DXY, whose 1m
 * series are millions of bars; see CalculateTechnicalIndicators for why N = 5000 is enough).
 */

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const fromArg = getOption(argumentsList, "from");
    const since = fromArg ? parseDateOption(fromArg, false) : undefined;
    const warmupArg = getOption(argumentsList, "warmup-bars");
    const warmupBars = warmupArg === undefined ? undefined : Number(warmupArg);
    if (warmupBars !== undefined && (!Number.isInteger(warmupBars) || warmupBars < 1)) {
      throw new Error(`--warmup-bars must be a positive integer, got "${warmupArg}".`);
    }
    if (warmupBars !== undefined && !since) {
      throw new Error("--warmup-bars is measured back from --from, so --from is required with it.");
    }
    const family = (getOption(argumentsList, "family") ?? "all").toLowerCase();
    if (family !== "all" && family !== "smc") {
      throw new Error(`Unsupported indicator family "${family}". Use all or smc.`);
    }
    const definitions = family === "smc"
      ? defaultIndicatorDefinitions.filter((definition) => definition.algorithmVersion === SMC_ALGORITHM_VERSION)
      : undefined;
    // Defaults to NSE, unchanged for every existing call site -- only a non-Indian instrument
    // (e.g. `--exchange TWELVEDATA --instrument XAU_USD`) needs to pass this explicitly.
    const exchange = parseInstrumentExchange(getOption(argumentsList, "exchange") ?? "NSE");
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol(exchange, symbol);
    if (!instrument) {
      throw new Error(`${exchange} instrument "${symbol}" is not registered.`);
    }
    const result = await new CalculateTechnicalIndicators(
      new PostgresCandleRepository(database),
      new PostgresIndicatorDefinitionRepository(database),
      new PostgresIndicatorSnapshotRepository(database),
    ).execute({ instrumentId: instrument.id, timeframe, since, definitions, warmupBars });
    console.info(JSON.stringify({ level: "info", message: "Technical indicator calculation complete", instrument: symbol, timeframe, family, since: since?.toISOString(), warmupBars, ...result }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
