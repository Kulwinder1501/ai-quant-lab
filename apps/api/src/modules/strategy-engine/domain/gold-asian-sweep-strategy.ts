import type {
  EnsureStrategyVersionInput,
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeIdeaEvidence,
  TradeSide,
} from "./strategy.js";
import type { StrategyEvaluator } from "./strategy-registry.js";
import { evaluateAsianSession } from "../../technical-analysis/domain/ict/asian-session.js";

export const GOLD_ASIAN_SWEEP_STRATEGY_KEY = "gold-asian-sweep-v1";
/**
 * Version 2. A version 1 row was registered in the shared database on 2026-10-22 (about 20:58 IST) by a
 * local run of the first commit, with that commit's configuration (`targetR`, `confidence: 0.75`, none of
 * the risk-distance or coverage fields). A registered version's configuration is immutable, so the corrected
 * configuration below could not be registered under 1: the first gold-bot pass would have thrown "already
 * exists with a different immutable configuration" and the strategy would have returned STRATEGY_FAILED on
 * every run. Registering under 2 deactivates the stray 1, which has no ideas or backtests attached.
 *
 * From here on, any change to `defaultGoldAsianSweepConfiguration` needs a new version number;
 * `gold-asian-sweep-config-pin.test.ts` fails when the configuration changes without one.
 */
export const goldAsianSweepStrategyVersion = 2;

export interface GoldAsianSweepStrategyConfiguration {
  asiaStartHourUtc: number;
  asiaEndHourUtc: number;
  londonStartHourUtc: number;
  londonEndHourUtc: number;
  minPenetrationBps: number;
  maxPenetrationBps: number;
  minRejectionWickPct: number;
  minRangeBps: number;
  maxRangeBps: number;
  stopBuffer: number;
  rewardRiskMultiple: number;
  minRiskDistance: number;
  maxRiskDistance: number;
  confidence: number;
  expiryCandles: number;
  minAsiaCoveragePct: number;
}

export const defaultGoldAsianSweepConfiguration: GoldAsianSweepStrategyConfiguration = {
  asiaStartHourUtc: 0,
  asiaEndHourUtc: 6,
  londonStartHourUtc: 6.5,
  londonEndHourUtc: 11.5,
  minPenetrationBps: 3.0,
  maxPenetrationBps: 50.0,
  minRejectionWickPct: 0.30,
  minRangeBps: 15.0,
  maxRangeBps: 180.0,
  stopBuffer: 0.40,
  rewardRiskMultiple: 1.5,
  minRiskDistance: 0.20,
  maxRiskDistance: 15.0,
  confidence: 0.50, // Uncalibrated baseline score prior to OOS replication
  expiryCandles: 4,
  minAsiaCoveragePct: 0.90,
};

export const goldAsianSweepStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: GOLD_ASIAN_SWEEP_STRATEGY_KEY,
  name: "Gold Asian Session Sweep",
  description:
    "Trades London-session liquidity sweeps and reclaims of the Asian session high/low on XAU/USD. "
    + "Enforces strict range validity, penetration bounds, and rejection wicks.",
  version: goldAsianSweepStrategyVersion,
  configuration: defaultGoldAsianSweepConfiguration as unknown as Record<string, unknown>,
};

/**
 * Stateless evaluator for the Asian Session Sweep strategy on XAU/USD.
 *
 * Evaluates the day's candle history causally and point-in-time using its own
 * versioned configuration thresholds (session hours, penetration, rejection wick,
 * Asian range limits, coverage).
 *
 * Design note on "First Sweep of the Day" lifecycle:
 * A liquidity sweep event consumes the session's single execution allowance for the day,
 * regardless of whether the resulting proposal is subsequently filtered out by risk distance
 * bounds (minRiskDistance 0.20 / maxRiskDistance 15.0 USD) or other downstream trade guards.
 * This is an intentional design choice, not yet measured: once the Asian level is swept and reclaimed,
 * the initial liquidity pool is treated as absorbed and the session's directional displacement underway;
 * whether subsequent penetrations on the same day offer viable edge remains an open empirical question.
 */
export class GoldAsianSweepStrategy implements StrategyEvaluator {
  evaluate(
    context: StrategyMarketContext,
    strategyConfiguration: Record<string, unknown> = {}
  ): ProposedTradeIdea[] {
    const config: GoldAsianSweepStrategyConfiguration = {
      ...defaultGoldAsianSweepConfiguration,
      ...strategyConfiguration,
    };

    // Strict symbol guard (fail-closed): this strategy is calibrated solely for XAU_USD.
    // Missing symbol or non-XAU_USD is strictly rejected.
    if (!context.candle.symbol || context.candle.symbol !== "XAU_USD") {
      return [];
    }

    if (context.candle.tickSize !== 0.01) {
      return [];
    }

    // Single source of truth: Asian session state must be derived from point-in-time dayCandles
    if (!context.dayCandles || context.dayCandles.length === 0) {
      return [];
    }

    // Evaluate Asian session using the strategy's own versioned configuration
    const snapshot = evaluateAsianSession(context.dayCandles, context.candle, {
      asiaStartHourUtc: config.asiaStartHourUtc,
      asiaEndHourUtc: config.asiaEndHourUtc,
      londonStartHourUtc: config.londonStartHourUtc,
      londonEndHourUtc: config.londonEndHourUtc,
      minPenetrationBps: config.minPenetrationBps,
      maxPenetrationBps: config.maxPenetrationBps,
      minRejectionWickPct: config.minRejectionWickPct,
      minRangeBps: config.minRangeBps,
      maxRangeBps: config.maxRangeBps,
      minAsiaCoveragePct: config.minAsiaCoveragePct,
    });

    if (!snapshot || !snapshot.isValid || !snapshot.sweepEvent) {
      return [];
    }

    const sweep = snapshot.sweepEvent;
    const isBullish = sweep.type === "BULLISH_SWEEP";
    const side: TradeSide = isBullish ? "LONG" : "SHORT";
    const entryPrice = context.candle.close;

    let stopLoss: number;
    let targetPrice: number;
    let riskDistance: number;

    if (isBullish) {
      stopLoss = Number((sweep.sweepExtreme - config.stopBuffer).toFixed(2));
      riskDistance = entryPrice - stopLoss;
      if (riskDistance < config.minRiskDistance || riskDistance > config.maxRiskDistance) {
        return [];
      }
      targetPrice = Number((entryPrice + riskDistance * config.rewardRiskMultiple).toFixed(2));
    } else {
      stopLoss = Number((sweep.sweepExtreme + config.stopBuffer).toFixed(2));
      riskDistance = stopLoss - entryPrice;
      if (riskDistance < config.minRiskDistance || riskDistance > config.maxRiskDistance) {
        return [];
      }
      targetPrice = Number((entryPrice - riskDistance * config.rewardRiskMultiple).toFixed(2));
    }

    const candleDurationMs = context.candle.closeTime.getTime() - context.candle.openTime.getTime();
    const expiresAt = new Date(context.candle.closeTime.getTime() + config.expiryCandles * candleDurationMs);

    const evidenceItems: TradeIdeaEvidence[] = [
      {
        sourceType: "STRATEGY",
        sourceReference: `${GOLD_ASIAN_SWEEP_STRATEGY_KEY}:v${goldAsianSweepStrategyVersion}`,
        label: `Asian session sweep (${sweep.type}) at ${sweep.level.toFixed(2)} with ${Math.round(sweep.rejectionWickPct * 100)}% rejection wick`,
        contribution: config.confidence,
        details: {
          asianHigh: snapshot.asiaHigh,
          asianLow: snapshot.asiaLow,
          asianRangeBps: snapshot.asiaRangeBps,
          asianMidpoint: snapshot.midpoint,
          sweepExtreme: sweep.sweepExtreme,
          penetrationBps: sweep.penetrationBps,
          reclaimBps: sweep.reclaimBps,
          rejectionWickPct: sweep.rejectionWickPct,
        },
      },
    ];

    const proposal: ProposedTradeIdea = {
      side,
      entryPrice,
      stopLoss,
      targetPrice,
      riskReward: config.rewardRiskMultiple,
      confidence: config.confidence,
      reasoning: [
        `Asian session sweep (${sweep.type}) at ${sweep.level.toFixed(2)}.`,
        `Penetration was ${sweep.penetrationBps} bps, rejection wick ${Math.round(sweep.rejectionWickPct * 100)}%.`,
        `Entry ${entryPrice.toFixed(2)}, stop ${stopLoss.toFixed(2)}, target ${targetPrice.toFixed(2)} (${config.rewardRiskMultiple.toFixed(2)}R).`,
      ],
      evidence: {
        strategy: GOLD_ASIAN_SWEEP_STRATEGY_KEY,
        strategyVersion: goldAsianSweepStrategyVersion,
        sourceCandleId: context.candle.id,
        asianHigh: snapshot.asiaHigh,
        asianLow: snapshot.asiaLow,
        asianMidpoint: snapshot.midpoint,
        sweepLevel: sweep.level,
        sweepExtreme: sweep.sweepExtreme,
        penetrationBps: sweep.penetrationBps,
        rejectionWickPct: sweep.rejectionWickPct,
      },
      evidenceItems,
      expiresAt,
    };

    return [proposal];
  }
}
