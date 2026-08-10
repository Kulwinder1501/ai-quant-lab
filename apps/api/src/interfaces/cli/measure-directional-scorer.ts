import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { PostgresInstrumentRepository } from "../../infrastructure/database/repositories/postgres-instrument-repository.js";
import { PostgresStrategyMarketContextRepository } from "../../infrastructure/database/repositories/postgres-strategy-market-context-repository.js";
import {
  AGENT_ATR_STOP_MULTIPLE,
  AGENT_REWARD_RISK_MULTIPLE,
  PRODUCTION_INDICATOR_VERSION,
} from "../../modules/strategy-engine/application/ai-autonomous-agent.js";
import { breakEvenHitRate, resolveBracket } from "../../modules/strategy-engine/domain/bracket-outcome.js";
import { scoreDirectionalSetup } from "../../modules/strategy-engine/domain/directional-setup-score.js";
import type { CompletedPriceCandle } from "../../modules/paper-trading/domain/paper-trade-exit-policy.js";
import type { TradeSide } from "../../modules/strategy-engine/domain/strategy.js";

/**
 * Measures whether the directional scorer's **short side** actually selects anything.
 *
 * Why this exists. `directional-setup-score.ts` scores both directions by reflecting terms that
 * were tuned for longs -- RSI's healthy band mirrored through 50, the Bollinger opportunity and
 * risk bands swapped. That reflection is a structural assumption, and shipping it without
 * measurement would be asserting an edge this project has repeatedly failed to find. So this
 * replays the scorer over stored history and reports what the assumption is worth.
 *
 * ## What is measured
 *
 * For every completed bar with a production ATR snapshot, both theses are scored and the agent's
 * own bracket is applied -- `AGENT_ATR_STOP_MULTIPLE` for the stop, `AGENT_REWARD_RISK_MULTIPLE`
 * for the target -- then resolved forward with the paper-trading engine's exit rules, gaps and
 * conservative same-candle tie-break included.
 *
 * Three numbers per side, because a hit rate alone answers nothing:
 *
 * - **Gated**: bars where that thesis cleared the 80 threshold. This is what the agent trades.
 * - **Unconditional**: every bar, taking that side regardless of score. The baseline the score has
 *   to beat, and the one that reveals a "signal" that is really just the instrument's drift.
 * - **Break-even**: `1 / (1 + rewardRisk)`, the rate at which the bracket stops losing money.
 *
 * A gated rate above break-even *and* above unconditional is the only combination that means the
 * score is doing work. Above break-even but level with unconditional means the bracket is fine
 * and the score is decoration.
 *
 * ## What is deliberately held out
 *
 * News sentiment and institutional flow are neutralised. This is not for convenience -- it is the
 * point. Those two terms are handled by evaluating the *same tested function* on negated inputs,
 * which is exact rather than assumed, so including them would blur the thing under test. What is
 * being measured is precisely the mirrored indicator and pattern terms. The stored newswire is
 * also only weeks deep, so folding it in would shrink the window to nothing.
 *
 * Consequently the scores here are lower than a live tick's, and the 80 gate is correspondingly
 * harder to clear. That is reported, not hidden: if the gated sample is small, the output says so
 * and the result should be treated as indicative.
 */

interface Options {
  symbol: string;
  timeframe: string;
  /** Bars of history to replay. */
  bars: number;
  /** Bars a bracket may take to resolve before it is recorded UNRESOLVED. */
  horizon: number;
  /** Score a thesis must reach to count as gated. Matches the agent's own threshold. */
  threshold: number;
}

function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) values.set(match[1]!, match[2]!);
  }
  const number = (key: string, fallback: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--${key} must be a positive number.`);
    }
    return parsed;
  };
  return {
    symbol: (values.get("instrument") ?? "NIFTY50").trim().toUpperCase(),
    timeframe: (values.get("timeframe") ?? "15m").trim().toLowerCase(),
    bars: Math.floor(number("bars", 4_000)),
    horizon: Math.floor(number("horizon", 32)),
    threshold: number("threshold", 80),
  };
}

interface SideTally {
  resolved: number;
  targets: number;
  unresolved: number;
  totalR: number;
}

function emptyTally(): SideTally {
  return { resolved: 0, targets: 0, unresolved: 0, totalR: 0 };
}

function record(tally: SideTally, outcome: "TARGET" | "STOP" | "UNRESOLVED", rMultiple: number | null): void {
  if (outcome === "UNRESOLVED") {
    tally.unresolved += 1;
    return;
  }
  tally.resolved += 1;
  if (outcome === "TARGET") tally.targets += 1;
  if (rMultiple !== null) tally.totalR += rMultiple;
}

function summarise(tally: SideTally) {
  return {
    resolved: tally.resolved,
    unresolved: tally.unresolved,
    targets: tally.targets,
    // Rates over *resolved* brackets only. Folding unresolved ones into either bucket is how a
    // hit rate gets inflated, so they are reported separately instead.
    hitRate: tally.resolved === 0 ? null : Number((tally.targets / tally.resolved).toFixed(4)),
    expectancyR: tally.resolved === 0 ? null : Number((tally.totalR / tally.resolved).toFixed(4)),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);

  try {
    const instruments = new PostgresInstrumentRepository(database);
    const contexts = new PostgresStrategyMarketContextRepository(database);

    const instrument = await instruments.findByExchangeAndSymbol("NSE", options.symbol);
    if (!instrument) throw new Error(`${options.symbol} is not a registered instrument.`);

    const history = await contexts.listCompletedContexts({
      instrumentId: instrument.id,
      timeframe: options.timeframe,
      limit: options.bars,
    });
    if (history.length < options.horizon + 10) {
      throw new Error(
        `Only ${history.length} completed ${options.timeframe} contexts exist for ${options.symbol}; `
        + `a ${options.horizon}-bar horizon needs materially more. Collect history first.`,
      );
    }

    // Forward candles come from the contexts themselves, which are already chronological. Using
    // one series for both the signal and its resolution keeps them aligned by construction --
    // fetching bars separately is how an off-by-one silently shifts every outcome by a bar.
    const bars: CompletedPriceCandle[] = history.map((context) => ({
      id: context.candle.id,
      openTime: context.candle.openTime,
      closeTime: context.candle.closeTime,
      open: context.candle.open,
      high: context.candle.high,
      low: context.candle.low,
      close: context.candle.close,
    }));

    const gated: Record<TradeSide, SideTally> = { LONG: emptyTally(), SHORT: emptyTally() };
    const unconditional: Record<TradeSide, SideTally> = { LONG: emptyTally(), SHORT: emptyTally() };
    let scored = 0;
    let skippedNoAtr = 0;

    for (let index = 0; index < history.length - options.horizon; index += 1) {
      const context = history[index]!;
      const atr = context.indicators.find(
        (indicator) => indicator.code === "ATR" && indicator.algorithmVersion === PRODUCTION_INDICATOR_VERSION,
      );
      const atrValue = atr ? Number(atr.values["value"] ?? Number.NaN) : Number.NaN;
      if (!Number.isFinite(atrValue) || atrValue <= 0) {
        // The agent refuses to trade without a production ATR, so a bar without one is not part
        // of the population it would have acted on.
        skippedNoAtr += 1;
        continue;
      }

      const rsiSnapshot = context.indicators.find(
        (indicator) => indicator.code === "RSI" && indicator.algorithmVersion === PRODUCTION_INDICATOR_VERSION,
      );
      const bollinger = context.indicators.find(
        (indicator) => indicator.code === "BOLLINGER_BANDS"
          && indicator.algorithmVersion === PRODUCTION_INDICATOR_VERSION,
      );
      if (!rsiSnapshot || !bollinger) continue;

      // Entry is the bar's close, which is the first price knowable once the bar completes. Using
      // the next bar's open would be more realistic still, but it would also mix an execution
      // assumption into a measurement of the score.
      const entryPrice = context.candle.close;
      const pattern = context.patterns[0];
      const score = scoreDirectionalSetup({
        rsi: Number(rsiSnapshot.values["value"] ?? 50),
        livePrice: entryPrice,
        bollingerUpper: Number(bollinger.values["upper"] ?? entryPrice * 1.02),
        bollingerLower: Number(bollinger.values["lower"] ?? entryPrice * 0.98),
        pattern: pattern
          ? { code: pattern.code, direction: pattern.direction, confidence: pattern.confidence }
          : null,
        // Held out on purpose -- see the header. Neutral on both sides so neither is advantaged.
        flowBias: {
          long: { adjustment: 0, reasoning: null },
          short: { adjustment: 0, reasoning: null },
        },
        newsSentiment: 0,
        newsLabel: "HELD OUT",
        hasMacroEvent: false,
        macroEventNames: [],
      });
      scored += 1;

      const forward = bars.slice(index + 1, index + 1 + options.horizon);
      const stopDistance = atrValue * AGENT_ATR_STOP_MULTIPLE;
      const targetDistance = stopDistance * AGENT_REWARD_RISK_MULTIPLE;

      for (const side of ["LONG", "SHORT"] as const) {
        const resolution = resolveBracket({
          side,
          entryPrice,
          stopLoss: side === "LONG" ? entryPrice - stopDistance : entryPrice + stopDistance,
          targetPrice: side === "LONG" ? entryPrice + targetDistance : entryPrice - targetDistance,
        }, forward);

        record(unconditional[side], resolution.outcome, resolution.rMultiple);
        const sideScore = side === "LONG" ? score.longConfidence : score.shortConfidence;
        if (sideScore >= options.threshold) {
          record(gated[side], resolution.outcome, resolution.rMultiple);
        }
      }
    }

    const breakEven = Number(breakEvenHitRate(AGENT_REWARD_RISK_MULTIPLE).toFixed(4));
    console.info(JSON.stringify({
      level: "info",
      message: "Directional scorer measurement",
      instrument: options.symbol,
      timeframe: options.timeframe,
      protocol: {
        barsAvailable: history.length,
        barsScored: scored,
        skippedNoProductionAtr: skippedNoAtr,
        horizonBars: options.horizon,
        gateThreshold: options.threshold,
        atrStopMultiple: AGENT_ATR_STOP_MULTIPLE,
        rewardRiskMultiple: AGENT_REWARD_RISK_MULTIPLE,
        heldOut: ["newsSentiment", "institutionalFlow", "macroEvents"],
        entryRule: "bar close",
        exitRules: "paper-trading exit policy (gap fills, conservative same-candle stop-first)",
      },
      breakEvenHitRate: breakEven,
      gated: { LONG: summarise(gated.LONG), SHORT: summarise(gated.SHORT) },
      unconditional: { LONG: summarise(unconditional.LONG), SHORT: summarise(unconditional.SHORT) },
    }, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    message: "Directional scorer measurement failed",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
