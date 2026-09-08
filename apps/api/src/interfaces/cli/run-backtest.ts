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
import { decorateContextsWithIct } from "../../modules/technical-analysis/domain/ict/replay-builder.js";
import {
  ICT_STRUCTURE_STRATEGY_KEY,
  defaultIctEngineConfig,
  type IctEngineConfig,
} from "../../modules/technical-analysis/domain/ict/config.js";
import { getOption, parseDateOption, parseHistoricalTimeframe, requireOption } from "./arguments.js";
import { parseNonNegativeNumber, parsePositiveNumber } from "./paper-trading-arguments.js";
import type { StrategyMarketContext } from "../../modules/strategy-engine/domain/strategy.js";
import type { StrategyEvaluator } from "../../modules/strategy-engine/domain/strategy-registry.js";

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

/**
 * Wraps the market-data repository to attach the causal ICT composite snapshot
 * to every context after loading, so the `ict-structure-v1` strategy can read
 * its four-pillar state. The snapshot state lives here in the replay builder,
 * never in the strategy instance, exactly as the live path will persist it per
 * source bar and load it back into the context.
 */
class IctDecoratedMarketData implements BacktestMarketDataRepository {
  constructor(
    private readonly inner: BacktestMarketDataRepository,
    private readonly config: IctEngineConfig
  ) {}

  async listContexts(input: Parameters<BacktestMarketDataRepository["listContexts"]>[0]) {
    return decorateContextsWithIct(await this.inner.listContexts(input), { config: this.config });
  }
}

/**
 * The engine config for this run, which until now was always the default.
 *
 * `--ict-inverted-poi` is the one knob exposed, because it is the only engine setting whose effect
 * is an open question: it decides whether a failed order block survives as an opposite-side point of
 * interest, per lecture 7, or is discarded as this engine has always discarded it. Two arms of the
 * same run differ by that flag alone, and it lands in the config hash, so the two arms cannot share
 * a cached snapshot.
 */
function parseIctEngineConfig(argumentsList: string[]): IctEngineConfig {
  const raw = getOption(argumentsList, "ict-inverted-poi")?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultIctEngineConfig;
  if (raw !== "true" && raw !== "false") {
    throw new Error(`--ict-inverted-poi must be true or false; received "${raw}".`);
  }
  return { ...defaultIctEngineConfig, invertedBlocksRemainPoi: raw === "true" };
}

function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return defaultBacktestConfiguration.maxConcurrentPositions;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--max-concurrent-positions must be an integer >= 1; received "${raw}".`);
  }
  return value;
}

function parsePositionSizing(argumentsList: string[]): BacktestPositionSizing {
  const value = getOption(argumentsList, "position-sizing")?.trim().toUpperCase() || "FIXED_QUANTITY";
  if (value !== "FIXED_QUANTITY" && value !== "CONSTANT_RISK_FRACTION") {
    throw new Error(`--position-sizing must be FIXED_QUANTITY or CONSTANT_RISK_FRACTION, received "${value}".`);
  }
  return value;
}

/**
 * Strategy configuration overrides merged over the registered version's, as JSON.
 *
 * Needed to run an arm that differs only in a strategy setting: without it, comparing two
 * configurations means editing the registration, which changes what every other run means. The
 * merge is shallow and the result is reported on the run, so an arm cannot be mistaken for the
 * registered default afterwards.
 */
function parseStrategyConfigurationOverride(argumentsList: string[]): Record<string, unknown> | null {
  const raw = getOption(argumentsList, "strategy-config")?.trim();
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`--strategy-config must be valid JSON, received "${raw}".`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--strategy-config must be a JSON object of setting overrides.");
  }
  return parsed as Record<string, unknown>;
}

type BacktestEntryFilter = "NONE" | "EMA_STRENGTH_015_ATR" | "FRESH_SETUP";

function parseEntryFilter(argumentsList: string[]): BacktestEntryFilter {
  const raw = getOption(argumentsList, "entry-filter")?.trim().toLowerCase() ?? "none";
  if (raw === "none") return "NONE";
  if (raw === "ema-strength-015") return "EMA_STRENGTH_015_ATR";
  if (raw === "fresh-setup") return "FRESH_SETUP";
  throw new Error(`--entry-filter must be none, ema-strength-015, or fresh-setup, received "${raw}".`);
}

function indicatorValue(
  context: StrategyMarketContext,
  code: string,
  period: number,
): number | null {
  const indicator = context.indicators.find((candidate) => (
    candidate.code === code
    && candidate.parameters.period === period
    && typeof candidate.values.value === "number"
  ));
  return indicator && typeof indicator.values.value === "number" ? indicator.values.value : null;
}

class EmaStrengthFilteredStrategy implements StrategyEvaluator {
  constructor(private readonly inner: StrategyEvaluator) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>) {
    const proposals = this.inner.evaluate(context, configuration);
    const fast = indicatorValue(context, "EMA", 3);
    const slow = indicatorValue(context, "EMA", 8);
    const atr = indicatorValue(context, "ATR", 14);
    if (fast === null || slow === null || atr === null || atr <= 0) return [];
    if (Math.abs(fast - slow) / atr < 0.15) return [];
    return proposals;
  }
}

/** Backtest-only control for repeated proposals from one continuously active setup. */
class FreshSetupFilteredStrategy implements StrategyEvaluator {
  private previousSide: "LONG" | "SHORT" | null = null;

  constructor(private readonly inner: StrategyEvaluator) {}

  evaluate(context: StrategyMarketContext, configuration: Record<string, unknown>) {
    const proposals = this.inner.evaluate(context, configuration);
    const proposal = proposals[0] ?? null;
    if (!proposal) {
      this.previousSide = null;
      return [];
    }
    if (proposal.side === this.previousSide) return [];
    this.previousSide = proposal.side;
    return proposals;
  }
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
    const entryFilter = parseEntryFilter(argumentsList);
    const strategyVersion = await new PostgresStrategyVersionRepository(database).ensure(registration);
    if (strategyVersion.isArchived || !strategyVersion.isActive) {
      throw new Error(`Strategy version ${strategyVersion.strategyKey}@${strategyVersion.version} is not active.`);
    }

    const configurationOverride = parseStrategyConfigurationOverride(argumentsList);
    const higherTimeframeBuckets = parseHigherTimeframeBuckets(argumentsList);
    let marketData: BacktestMarketDataRepository = higherTimeframeBuckets === null
      ? new PostgresBacktestMarketDataRepository(database)
      : new HigherTimeframeDecoratedMarketData(
        new PostgresBacktestMarketDataRepository(database),
        higherTimeframeBuckets,
      );
    // The ICT strategy reads its four-pillar snapshot from the context; attach it
    // in the replay builder. Incumbent strategies never see this decoration.
    if (registration.strategyKey === ICT_STRUCTURE_STRATEGY_KEY) {
      marketData = new IctDecoratedMarketData(marketData, parseIctEngineConfig(argumentsList));
    }

    const strategyEvaluator = new StrategyClass();
    const replayStrategy = entryFilter === "EMA_STRENGTH_015_ATR"
      ? new EmaStrengthFilteredStrategy(strategyEvaluator)
      : entryFilter === "FRESH_SETUP"
        ? new FreshSetupFilteredStrategy(strategyEvaluator)
        : strategyEvaluator;
    const result = await new RunBacktest(
      new PostgresBacktestRepository(database),
      marketData,
      new BacktestEngine(replayStrategy),
    ).execute({
      strategyVersionId: strategyVersion.id,
      strategyConfiguration: configurationOverride === null
        ? strategyVersion.configuration
        : { ...strategyVersion.configuration, ...configurationOverride },
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
        // Defaults to 1, so an invocation that does not ask for concurrency reproduces the runs
        // recorded before the engine supported it. Persisted in the run's `configuration` jsonb,
        // so a concurrent run is never mistaken for a sequential one.
        maxConcurrentPositions: parseConcurrency(getOption(argumentsList, "max-concurrent-positions")),
      },
    });

    console.info(JSON.stringify({
      level: "info",
      message: "Historical backtest complete",
      instrument: symbol,
      strategy: `${strategyVersion.strategyKey}@${strategyVersion.version}`,
      entryFilter,
      dataWindowStart: dataWindowStart.toISOString(),
      dataWindowEnd: dataWindowEnd.toISOString(),
      dataCutoffAt: dataCutoffAt.toISOString(),
      // Recorded on the run so an arm cannot be mistaken for its control after the fact.
      higherTimeframes: higherTimeframeBuckets ?? null,
      strategyConfigurationOverride: configurationOverride ?? null,
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
