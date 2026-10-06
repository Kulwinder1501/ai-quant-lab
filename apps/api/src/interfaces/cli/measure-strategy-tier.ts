import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import {
  registeredStrategies,
  strategySupportsTimeframe,
  type RegisteredStrategy,
} from "../../modules/strategy-engine/domain/strategy-registry.js";
import { measureTier } from "../../modules/strategy-engine/domain/tier-measurement.js";

/**
 * Replays each registered strategy over its own stored bars and reports whether its signals have
 * edge, per instrument and timeframe.
 *
 * This is the answer to "scalp, intraday and swing on different timeframes, but no result": twelve
 * days of live operation produced two signals and three closed trades, which is not a P&L anyone
 * can read. Rather than enable three tiers and wait months for another ambiguous ledger, this
 * measures each tier against the history that already exists -- ~54k 1m bars, 22k 15m, 8k 60m --
 * and says which is worth deploying today.
 *
 * A "tier" is just a timeframe: point it at one and it measures whichever strategies own that
 * timeframe in the registry (scalp: 1m/5m momentum-scalp-index; intraday: 15m trend-breakout;
 * swing: 60m/1d trend-breakout). Each strategy's geometry and indicator version come from its own
 * registration, so the measurement uses the exact bracket the live bot would trade.
 *
 * The column that decides a tier is gated-vs-unconditional, not the raw hit rate -- see
 * `tier-measurement.ts`. A strategy beating break-even while only matching the same-side baseline
 * has found the ATR bracket, not an edge, and that is invisible in a live P&L until the drawdown
 * arrives.
 */

interface Options {
  symbol: string;
  timeframe: string;
  /** Only measure this strategy key, if given; otherwise every strategy that owns the timeframe. */
  strategyKey: string | null;
  bars: number;
  horizonBars: number;
  /** Shallow overrides merged over the registered configuration. */
  configurationOverride: Record<string, unknown> | null;
}

/**
 * Strategy configuration overrides, as JSON. Same flag and semantics as `run-backtest`.
 *
 * Needed to measure an arm that differs only in a setting: without it, comparing two
 * configurations means editing the registration, which changes what every other run means. The
 * merge is shallow and the override is echoed on the result, so an arm cannot later be mistaken for
 * the registered default.
 */
function parseConfigurationOverride(values: Map<string, string>): Record<string, unknown> | null {
  const raw = values.get("strategy-config")?.trim();
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

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }
  const positive = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive number.`);
    return Math.floor(parsed);
  };
  const timeframe = (values.get("timeframe") ?? "").trim().toLowerCase();
  if (!timeframe) throw new Error("--timeframe is required, for example --timeframe=15m.");
  return {
    configurationOverride: parseConfigurationOverride(values),
    symbol: (values.get("instrument") ?? "NIFTY50").trim().toUpperCase(),
    timeframe,
    strategyKey: values.get("strategy")?.trim() ?? null,
    bars: positive("bars", 20_000),
    // A default sized to the tier: a scalp bracket should resolve in minutes, a swing over days, so
    // a fixed bar horizon means very different clock time. These are generous ceilings, not targets.
    horizonBars: positive("horizon", defaultHorizonFor(timeframe)),
  };
}

/** How many bars a bracket may run before it is called unresolved, per timeframe. */
function defaultHorizonFor(timeframe: string): number {
  switch (timeframe) {
    case "1m": return 60;   // an hour
    case "5m": return 48;   // four hours
    case "15m": return 32;  // roughly a session and a half
    case "30m": return 24;
    case "60m": return 24;  // a few sessions
    default: return 20;     // 1d and anything longer
  }
}

function configNumber(configuration: Record<string, unknown>, key: string, fallback: number): number {
  const value = configuration[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function configString(configuration: Record<string, unknown>, key: string, fallback: string): string {
  const value = configuration[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const instruments = new PostgresInstrumentRepository(database);
    const contexts = new PostgresStrategyMarketContextRepository(database);

    const instrument = await instruments.findByExchangeAndSymbol("NSE", options.symbol);
    if (!instrument) throw new Error(`${options.symbol} is not a registered NSE instrument.`);

    const owners: RegisteredStrategy[] = registeredStrategies.filter((strategy) => {
      if (!strategySupportsTimeframe(strategy, options.timeframe)) return false;
      if (options.strategyKey && strategy.registration.strategyKey !== options.strategyKey) return false;
      return true;
    });
    if (owners.length === 0) {
      throw new Error(
        `No registered strategy owns the ${options.timeframe} timeframe`
        + `${options.strategyKey ? ` under key ${options.strategyKey}` : ""}. `
        + `Registered: ${registeredStrategies.map((s) => `${s.registration.strategyKey} `
          + `[${s.supportedTimeframes.join(",")}]`).join("; ")}.`,
      );
    }

    const history = await contexts.listCompletedContexts({
      instrumentId: instrument.id,
      timeframe: options.timeframe,
      limit: options.bars,
    });
    if (history.length < options.horizonBars + 30) {
      throw new Error(
        `Only ${history.length} completed ${options.timeframe} contexts exist for ${options.symbol}; `
        + `a ${options.horizonBars}-bar horizon needs materially more before a rate means anything. `
        + "Collect history first.",
      );
    }

    const strategies = owners.map((owner) => {
      const configuration = {
        ...(owner.registration.configuration as Record<string, unknown>),
        ...(options.configurationOverride ?? {}),
      };
      const measurement = measureTier({
        contexts: history,
        strategy: new owner.StrategyClass(),
        configuration,
        horizonBars: options.horizonBars,
        atrStopMultiple: configNumber(configuration, "atrStopMultiple", 1),
        rewardRiskMultiple: configNumber(configuration, "rewardRiskMultiple", 1.5),
        atrAlgorithmVersion: configString(configuration, "indicatorAlgorithmVersion", "ta-v1"),
      });
      return {
        strategy: owner.registration.strategyKey,
        version: owner.registration.version,
        // Echoed so a swept arm can never be read back as the registered default.
        configurationOverride: options.configurationOverride,
        ...measurement,
      };
    });

    console.info(JSON.stringify({
      level: "info",
      message: "Strategy tier measurement",
      instrument: options.symbol,
      timeframe: options.timeframe,
      protocol: {
        barsAvailable: history.length,
        horizonBars: options.horizonBars,
        entryRule: "bar close",
        exitRules: "paper-trading exit policy (gap fills, conservative same-candle stop-first)",
        baseline: "same side, same ATR geometry, taken on every scored bar",
        readEdgeFrom: "gated hitRate vs unconditional hitRate, not the raw rate",
      },
      strategies,
    }, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Strategy tier measurement failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
