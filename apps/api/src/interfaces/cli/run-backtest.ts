import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyVersionRepository } from "../../infrastructure/database/repositories/postgres-strategy-version-repository.js";
import { RunBacktest } from "../../modules/backtesting/application/run-backtest.js";
import { BacktestEngine, defaultBacktestConfiguration } from "../../modules/backtesting/domain/backtest-engine.js";
import type { BacktestPositionSizing } from "../../modules/backtesting/domain/backtesting.js";
import { requireRegisteredStrategy } from "../../modules/strategy-engine/domain/strategy-registry.js";
import { PostgresBacktestMarketDataRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-market-data-repository.js";
import type { BacktestMarketDataRepository } from "../../modules/backtesting/domain/backtesting.js";
import {
  attachHigherTimeframes,
  defaultHigherTimeframeResolverOptions,
  type HigherTimeframeResolverOptions,
} from "../../modules/strategy-engine/domain/higher-timeframe-resolver.js";
import { PostgresBacktestRepository } from "../../modules/backtesting/infrastructure/postgres-backtest-repository.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";
import { parseNonNegativeNumber, parsePositiveNumber } from "./paper-trading-arguments.js";

function optionalDate(argumentsList: string[], option: string, fallback: Date): Date {
  const value = getOption(argumentsList, option);
  return value ? parseDateOption(value, false) : fallback;
}

/**
 * Higher-timeframe buckets to resolve, as base-bar counts: `--higher-timeframes 15m:3,60m:12`.
 *
 * Omitted means no higher-timeframe context, which is the existing behaviour and the control arm.
 * Both arms load the same contexts through the same repository and differ only in whether this
 * decoration runs, so a difference in results cannot come from a difference in data.
 */
function parseHigherTimeframeBuckets(
  argumentsList: string[],
): HigherTimeframeResolverOptions["buckets"] | null {
  const raw = getOption(argumentsList, "higher-timeframes")?.trim();
  if (!raw) return null;
  const buckets = raw.split(",").map((entry) => {
    const [htfTimeframe, bars] = entry.split(":");
    const barsPerBucket = Number(bars);
    if (!htfTimeframe?.trim() || !Number.isInteger(barsPerBucket) || barsPerBucket < 2) {
      throw new Error(
        `--higher-timeframes entries must be "<timeframe>:<baseBars>" with at least 2 base bars, received "${entry}".`,
      );
    }
    return { htfTimeframe: htfTimeframe.trim(), barsPerBucket };
  });
  if (buckets.length === 0) throw new Error("--higher-timeframes was empty.");
  return buckets;
}

/**
 * Wraps the market-data repository to attach higher-timeframe context after loading.
 *
 * A decorator rather than a change to the repository or the replay engine: the engine takes
 * contexts as data and neither layer needs to know this exists, so the control arm runs code that
 * is byte-identical to what it ran before this flag was added.
 */
class HigherTimeframeDecoratedMarketData implements BacktestMarketDataRepository {
  constructor(
    private readonly inner: BacktestMarketDataRepository,
    private readonly buckets: HigherTimeframeResolverOptions["buckets"],
  ) {}

  async listContexts(input: Parameters<BacktestMarketDataRepository["listContexts"]>[0]) {
    const contexts = await this.inner.listContexts(input);
    return attachHigherTimeframes(contexts, { ...defaultHigherTimeframeResolverOptions, buckets: this.buckets });
  }
}

function parsePositionSizing(argumentsList: string[]): BacktestPositionSizing {
  const value = getOption(argumentsList, "position-sizing")?.trim().toUpperCase() || "FIXED_QUANTITY";
  if (value !== "FIXED_QUANTITY" && value !== "CONSTANT_RISK_FRACTION") {
    throw new Error(`--position-sizing must be FIXED_QUANTITY or CONSTANT_RISK_FRACTION, received "${value}".`);
  }
  return value;
}

/** A decimal fraction in (0, 1], falling back to the engine default. */
function parseFractionOption(argumentsList: string[], option: string, fallback: number): number {
  const raw = getOption(argumentsList, option);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`--${option} must be a decimal fraction in (0, 1], received "${raw}".`);
  }
  return value;
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const symbol = requireOption(argumentsList, "instrument").toUpperCase();
    const timeframe = parseHistoricalTimeframe(requireOption(argumentsList, "timeframe"));
    const dataWindowStart = parseDateOption(requireOption(argumentsList, "from"), false);
    const dataWindowEnd = parseDateOption(requireOption(argumentsList, "to"), true);
    const dataCutoffAt = optionalDate(argumentsList, "data-cutoff-at", new Date());
    const instrument = await new PostgresInstrumentRepository(database).findByExchangeAndSymbol("NSE", symbol);
    if (!instrument) {
      throw new Error(`NSE instrument "${symbol}" is not registered.`);
    }

    // Defaults to trend-breakout so existing invocations keep their meaning. Any
    // other registered strategy has to be asked for by key, and the replay engine
    // is given the matching evaluator — passing only the configuration would run
    // the default strategy against another strategy's settings.
    const { registration, StrategyClass } = requireRegisteredStrategy(
      getOption(argumentsList, "strategy")?.trim() || "trend-breakout",
    );
    const strategyVersion = await new PostgresStrategyVersionRepository(database).ensure(registration);
    if (strategyVersion.isArchived || !strategyVersion.isActive) {
      throw new Error(`Strategy version ${strategyVersion.strategyKey}@${strategyVersion.version} is not active.`);
    }

    const higherTimeframeBuckets = parseHigherTimeframeBuckets(argumentsList);
    const marketData: BacktestMarketDataRepository = higherTimeframeBuckets === null
      ? new PostgresBacktestMarketDataRepository(database)
      : new HigherTimeframeDecoratedMarketData(
        new PostgresBacktestMarketDataRepository(database),
        higherTimeframeBuckets,
      );

    const result = await new RunBacktest(
      new PostgresBacktestRepository(database),
      marketData,
      new BacktestEngine(new StrategyClass()),
    ).execute({
      strategyVersionId: strategyVersion.id,
      strategyConfiguration: strategyVersion.configuration,
      instrumentId: instrument.id,
      timeframe,
      dataWindowStart,
      dataWindowEnd,
      dataCutoffAt,
      execution: {
        quantity: parsePositiveNumber(getOption(argumentsList, "quantity") ?? "1", "quantity"),
        initialCapital: parsePositiveNumber(getOption(argumentsList, "initial-capital") ?? "100000", "initial-capital"),
        feePerOrder: parseNonNegativeNumber(getOption(argumentsList, "fee-per-order"), "fee-per-order"),
        slippageBps: parseNonNegativeNumber(getOption(argumentsList, "slippage-bps"), "slippage-bps"),
        positionSizing: parsePositionSizing(argumentsList),
        riskFractionPerTrade: parseFractionOption(argumentsList, "risk-fraction", defaultBacktestConfiguration.riskFractionPerTrade),
        marginFraction: parseFractionOption(argumentsList, "margin-fraction", defaultBacktestConfiguration.marginFraction),
      },
    });

    console.info(JSON.stringify({
      level: "info",
      message: "Historical backtest complete",
      instrument: symbol,
      strategy: `${strategyVersion.strategyKey}@${strategyVersion.version}`,
      dataWindowStart: dataWindowStart.toISOString(),
      dataWindowEnd: dataWindowEnd.toISOString(),
      dataCutoffAt: dataCutoffAt.toISOString(),
      // Recorded on the run so an arm cannot be mistaken for its control after the fact.
      higherTimeframes: higherTimeframeBuckets ?? null,
      ...result,
    }));
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
