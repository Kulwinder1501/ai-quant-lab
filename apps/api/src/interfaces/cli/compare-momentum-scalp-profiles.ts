import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresBacktestMarketDataRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-market-data-repository.js";
import {
  compareScalpProfiles,
  emaWhipsawDiagnostics,
  scalpResearchExecutionConfiguration,
  vwapTimeBucketDiagnostics,
  withResearchEmaSnapshots,
} from "../../modules/strategy-engine/domain/momentum-scalp-research.js";
import { getOption, parseDateOption, requireOption } from "./arguments.js";
import { parseNonNegativeNumber, parsePositiveNumber } from "./paper-trading-arguments.js";

const WARMUP_DAYS = 7;

function fraction(argumentsList: string[], option: string, fallback: number): number {
  const raw = getOption(argumentsList, option);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`--${option} must be a decimal fraction in (0, 1].`);
  }
  return value;
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const symbol = requireOption(argumentsList, "instrument").toUpperCase();
  const from = parseDateOption(requireOption(argumentsList, "from"), false);
  const to = parseDateOption(requireOption(argumentsList, "to"), true);
  const feeRaw = requireOption(argumentsList, "fee-per-order");
  const slippageRaw = requireOption(argumentsList, "slippage-bps");
  const marginRaw = requireOption(argumentsList, "margin-fraction");
  const initialCapital = parsePositiveNumber(getOption(argumentsList, "initial-capital") ?? "1000000", "initial-capital");
  const feePerOrder = parseNonNegativeNumber(feeRaw, "fee-per-order");
  const slippageBps = parseNonNegativeNumber(slippageRaw, "slippage-bps");
  const riskFractionPerTrade = fraction(argumentsList, "risk-fraction", 0.005);
  const marginFraction = Number(marginRaw);
  if (!Number.isFinite(marginFraction) || marginFraction <= 0 || marginFraction > 1) {
    throw new Error("--margin-fraction must be a decimal fraction in (0, 1].");
  }
  if (to <= from) throw new Error("--to must be after --from.");

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) throw new Error(`NSE instrument "${symbol}" is not registered.`);
    const warmupStart = new Date(from.getTime() - WARMUP_DAYS * 86_400_000);
    const loaded = await new PostgresBacktestMarketDataRepository(database).listContexts({
      instrumentId: instrument.id,
      timeframe: "1m",
      dataWindowStart: warmupStart,
      dataWindowEnd: to,
      dataCutoffAt: new Date(),
    });
    const enriched = withResearchEmaSnapshots(loaded);
    const contexts = enriched.filter((context) => (
      context.candle.openTime >= from && context.candle.closeTime <= to
    ));
    if (contexts.length === 0) throw new Error(`No completed ${symbol} 1m contexts exist in the requested window.`);

    const execution = scalpResearchExecutionConfiguration({
      initialCapital,
      feePerOrder,
      slippageBps,
      riskFractionPerTrade,
      marginFraction,
    });
    const profiles = compareScalpProfiles(contexts, execution);
    const output = {
      researchOnly: true,
      persisted: false,
      instrument: symbol,
      timeframe: "1m",
      from: from.toISOString(),
      to: to.toISOString(),
      contextsRead: contexts.length,
      execution,
      limitations: [
        "This replays the NIFTYBEES signal series; it does not model option-chain fills or option-premium exits.",
        "EMA 3/8 and 5/13 are calculated in memory and are not registered or persisted.",
      ],
      emaWhipsawDiagnostics: emaWhipsawDiagnostics(contexts),
      vwapTimeBucketDiagnostics: vwapTimeBucketDiagnostics(contexts),
      profiles,
    };
    console.info(JSON.stringify(output, null, 2));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
