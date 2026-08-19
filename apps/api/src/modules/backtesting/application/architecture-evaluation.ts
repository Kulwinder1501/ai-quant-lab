import { resolveBracket } from "../../strategy-engine/domain/bracket-outcome.js";
import { MomentumScalpIndexStrategy } from "../../strategy-engine/domain/momentum-scalp-index-strategy.js";
import { TechnicalIndicatorEngine } from "../../technical-analysis/domain/technical-indicator-engine.js";
import type { CompletedPriceCandle } from "../../paper-trading/domain/paper-trade-exit-policy.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";

/**
 * Shared evaluation core for the backtest experiments.
 *
 * Extracted so the architecture comparison and the stop-multiple sweep run the *same* loop. Two copies
 * of "evaluate a bar, resolve the bracket, price the outcome" would drift, and their results are meant
 * to be read against each other.
 */

const ENGINE = new TechnicalIndicatorEngine();

export interface EvaluationConfig {
  readonly indicatorAlgorithmVersion: string;
  /** Open record, matching the strategy's own configuration type. Keys are checked at runtime. */
  readonly indicatorParameters: Record<string, Record<string, string | number | boolean>>;
}

/** The five the strategy reads. Named here so a missing one fails loudly instead of silently. */
const REQUIRED_INDICATORS = [
  { key: "EMA_FAST", code: "EMA" as const },
  { key: "EMA_SLOW", code: "EMA" as const },
  { key: "RSI", code: "RSI" as const },
  { key: "SUPERTREND", code: "SUPERTREND" as const },
  { key: "ATR", code: "ATR" as const },
];

/**
 * Attaches in-memory indicator snapshots to a series, using the production engine.
 *
 * Every architecture is built this way rather than reading stored snapshots, so provenance is not an
 * uncontrolled difference between arms — and stored coverage varies by series, which is how a
 * NIFTYBEES 5m run once scored 0% and reported it as "no signals".
 */
export function buildContexts(input: {
  bars: readonly CompletedPriceCandle[];
  instrumentId: string;
  timeframe: string;
  tickSize: number;
  config: EvaluationConfig;
}): StrategyMarketContext[] {
  const candles = input.bars.map((bar) => ({
    id: bar.id, openTime: bar.openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0,
  }));
  const specs = REQUIRED_INDICATORS.map(({ key, code }) => {
    const parameters = input.config.indicatorParameters[key];
    if (!parameters) {
      // A missing definition would leave the strategy unable to score any bar, and it would look
      // exactly like a quiet market rather than a misconfiguration.
      throw new Error(`Evaluation configuration is missing indicator parameters for ${key}.`);
    }
    return { code, parameters };
  });

  const byCandle = new Map<string, StrategyMarketContext["indicators"]>();
  for (const spec of specs) {
    const points = ENGINE.calculate(candles, { code: spec.code, parameters: spec.parameters } as never);
    for (const point of points) {
      const bucket = byCandle.get(point.candleId) ?? [];
      bucket.push({
        code: spec.code,
        algorithmVersion: input.config.indicatorAlgorithmVersion,
        parameters: spec.parameters as Record<string, unknown>,
        values: point.values,
      });
      byCandle.set(point.candleId, bucket);
    }
  }

  return input.bars.map((bar) => ({
    candle: {
      id: bar.id,
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      openTime: bar.openTime,
      closeTime: bar.closeTime,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: 0,
      tickSize: input.tickSize,
    },
    indicators: byCandle.get(bar.id) ?? [],
    patterns: [],
    priceActionEvents: [],
  }));
}

export interface TradeRecord {
  readonly day: string;
  readonly grossR: number;
  readonly riskPerUnit: number;
  readonly entryPrice: number;
  readonly resolved: boolean;
}

function istDay(at: Date): string {
  return new Date(at.getTime() + (5 * 60 + 30) * 60_000).toISOString().slice(0, 10);
}

/**
 * Runs the strategy bar by bar and prices every proposal it raises.
 *
 * An unresolved bracket is marked to the horizon's close rather than discarded. `expiryCandles` is a
 * real exit, so a timeout has a realised P&L somewhere between the stop and the target. Dropping those
 * rows would report the mean of a filtered distribution — and the filtering is not mild, since roughly
 * half of all 1-minute brackets time out. It also flatters whichever configuration resolves most
 * often, which in both of these experiments is the variable under test.
 */
export function evaluateArchitecture(input: {
  contexts: readonly StrategyMarketContext[];
  bars: readonly CompletedPriceCandle[];
  configuration: Record<string, unknown>;
  horizonBars: number;
}): { trades: TradeRecord[]; timeouts: number } {
  const strategy = new MomentumScalpIndexStrategy();
  const trades: TradeRecord[] = [];
  let timeouts = 0;

  for (let index = 0; index < input.contexts.length; index += 1) {
    let proposals;
    try {
      proposals = strategy.evaluate(input.contexts[index]!, input.configuration);
    } catch {
      continue; // A bar the strategy cannot score (warm-up, missing indicator) is simply not a signal.
    }
    if (proposals.length === 0) continue;

    const forward = input.bars.slice(index + 1, index + 1 + input.horizonBars);
    if (forward.length === 0) continue;

    for (const proposal of proposals) {
      const resolution = resolveBracket({
        side: proposal.side,
        entryPrice: proposal.entryPrice,
        stopLoss: proposal.stopLoss,
        targetPrice: proposal.targetPrice,
      }, forward);
      const riskPerUnit = Math.abs(proposal.entryPrice - proposal.stopLoss);

      let grossR: number;
      let resolved: boolean;
      if (resolution.rMultiple !== null) {
        grossR = resolution.rMultiple;
        resolved = true;
      } else {
        timeouts += 1;
        resolved = false;
        const exit = forward[forward.length - 1]!.close;
        const realised = proposal.side === "LONG" ? exit - proposal.entryPrice : proposal.entryPrice - exit;
        grossR = realised / riskPerUnit;
      }

      trades.push({
        day: istDay(input.contexts[index]!.candle.closeTime),
        grossR,
        riskPerUnit,
        entryPrice: proposal.entryPrice,
        resolved,
      });
    }
  }
  return { trades, timeouts };
}
