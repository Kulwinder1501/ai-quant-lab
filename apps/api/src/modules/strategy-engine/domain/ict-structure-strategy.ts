import type {
  EnsureStrategyVersionInput,
  ProposedTradeIdea,
  StrategyMarketContext,
  TradeIdeaEvidence,
} from "./strategy.js";
import type { StrategyEvaluator } from "./strategy-registry.js";
import { ICT_STRUCTURE_STRATEGY_KEY } from "../../technical-analysis/domain/ict/config.js";

export interface IctStructureStrategyConfiguration {
  minimumRiskReward: number;
  minConfidence: number;
  expiryCandles: number;
  requirePoiReaction: boolean;
}

export const defaultIctStructureStrategyConfiguration: IctStructureStrategyConfiguration = {
  minimumRiskReward: 1.2,
  minConfidence: 0.7,
  expiryCandles: 3,
  requirePoiReaction: true,
};

export const ictStructureStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: ICT_STRUCTURE_STRATEGY_KEY,
  name: "ICT Structural Alignment (V1)",
  description: "Four-pillar structural strategy strictly trading in alignment with the higher-timeframe trend.",
  version: 2,
  configuration: defaultIctStructureStrategyConfiguration as unknown as Record<string, unknown>,
};

export class IctStructureStrategy implements StrategyEvaluator {
  evaluate(context: StrategyMarketContext, strategyConfiguration: Record<string, unknown> = {}): ProposedTradeIdea[] {
    const config: IctStructureStrategyConfiguration = {
      ...defaultIctStructureStrategyConfiguration,
      ...strategyConfiguration,
    };

    const ict = context.ictSnapshot;
    if (!ict) return [];

    const { structure, zones, sessionLevels, bias, liquidity, coverage } = ict;

    // Pillar Gate 1: every coverage input must be COMPLETE. Both UNKNOWN
    // (evidence absent/ambiguous) and NOT_COVERED (engine never ran) fail
    // closed — missing or ambiguous state is never treated as permission.
    if (
      coverage.structure !== "COMPLETE" ||
      coverage.bias !== "COMPLETE" ||
      coverage.zones !== "COMPLETE" ||
      coverage.sessionLevels !== "COMPLETE" ||
      coverage.liquidity !== "COMPLETE" ||
      coverage.htf !== "COMPLETE"
    ) {
      return [];
    }

    // Pillar Gate 2: Directional Alignment (bias + structure agree)
    const isBullish = bias.bias === "BULLISH" && structure.trend === "BULLISH";
    const isBearish = bias.bias === "BEARISH" && structure.trend === "BEARISH";
    if (!isBullish && !isBearish) return [];

    /*
     * There is no separate fractal-alignment gate any more, and its removal is the point.
     *
     * It compared `ict.htfBias` against `bias.bias`. Now that bias is SOURCED from the
     * higher-timeframe read (see bias.ts), those two are the same value, so the comparison could
     * only ever pass -- swapping a circular gate for a tautological one. Gate 2 above is the real
     * alignment test: the higher-timeframe narrative against the execution-timeframe structure.
     *
     * The fractal pillar is still *required*: `coverage.htf` must be COMPLETE in Gate 1, so a bar
     * with no higher-timeframe evidence produces nothing. What is gone is the redundant equality
     * check, not the requirement.
     *
     * The dead `higherTimeframeContexts["15m"]` branch went with it. Nothing in production ever
     * populated that key -- the research harness attaches "5m" and only to the 1m reference context.
     *
     * What remains below is a CONSISTENCY guard, not a pillar. Since bias is sourced from the
     * higher-timeframe read and a sweep may now only confirm it, a snapshot whose bias contradicts
     * its own `htfBias` is malformed and cannot be produced by the engine. Refusing it keeps the
     * fail-closed invariant against a hand-built or future-constructed snapshot rather than trusting
     * that the two can never disagree.
     */
    if (ict.htfBias && ict.htfBias !== bias.bias) return [];

    // Pillar Gate 3: Liquidity Status
    if (isBullish && liquidity.alignmentStatus !== "ALIGNED_LONG") return [];
    if (isBearish && liquidity.alignmentStatus !== "ALIGNED_SHORT") return [];

    const targetPool = liquidity.primaryTarget;
    if (!targetPool) return [];

    // POI interaction check (mitigation of OB, FVG, or session sweep)
    const currentPrice = context.candle.close;
    let poiEvidence: string | null = null;

    if (config.requirePoiReaction) {
      if (sessionLevels.lastSweepEvent?.eventType === "SWEEP") {
        poiEvidence = `Session ${sessionLevels.lastSweepEvent.levelType} swept and reclaimed`;
      } else {
        // Check active zones
        const touchedOb = zones.activeObs.find((o) => o.state === "TOUCHED");
        const filledFvg = zones.activeFvgs.find((f) => f.fillPercentage > 0);
        if (touchedOb) {
          poiEvidence = `Order Block ${touchedOb.id} touched`;
        } else if (filledFvg) {
          poiEvidence = `Fair Value Gap ${filledFvg.id} tapped (${Math.round(filledFvg.fillPercentage * 100)}%)`;
        }
      }

      if (!poiEvidence) {
        return [];
      }
    }

    // Trade Geometry
    const entryPrice = currentPrice;
    let stopLoss: number;
    let targetPrice: number;
    let side: "LONG" | "SHORT";

    if (isBullish) {
      side = "LONG";
      const rawStop = liquidity.invalidationLevel ?? (entryPrice * 0.995);
      stopLoss = rawStop * 0.9995; // 0.05% volatility buffer
      targetPrice = targetPool.price;

      if (stopLoss >= entryPrice || targetPrice <= entryPrice) return [];
      const risk = entryPrice - stopLoss;
      const reward = targetPrice - entryPrice;
      const riskReward = Number((reward / risk).toFixed(2));
      if (riskReward < config.minimumRiskReward) return [];

      const evidence: TradeIdeaEvidence[] = [
        {
          sourceType: "STRATEGY",
          sourceReference: "PILLAR_STACK",
          label: "Four-Pillar ICT Long Alignment",
          contribution: 0.4,
          details: {
            bias: bias.bias,
            structureTrend: structure.trend,
            dealingRangeEq: bias.dealingRange?.equilibrium,
            template: bias.dailyTemplate,
          },
        },
        {
          sourceType: "STRATEGY",
          sourceReference: "LIQUIDITY_TARGET",
          label: `Targeting ERL ${targetPool.kind}`,
          contribution: 0.35,
          details: {
            targetPrice: targetPool.price,
            intermediateTarget: liquidity.intermediateTarget,
          },
        },
      ];

      if (poiEvidence) {
        evidence.push({
          sourceType: "STRATEGY",
          sourceReference: "POI_CONFIRMATION",
          label: poiEvidence,
          contribution: 0.25,
          details: { poiEvidence },
        });
      }

      const expiresAt = new Date(
        context.candle.closeTime.getTime() + config.expiryCandles * 5 * 60_000
      );

      return [
        {
          side,
          entryPrice,
          stopLoss,
          targetPrice,
          riskReward,
          confidence: Math.max(config.minConfidence, 0.75),
          reasoning: [
            `Four-Pillar ICT LONG alignment: ${bias.bias} bias, ${structure.trend} trend, ${bias.dailyTemplate} template.`,
            `Targeting ERL ${targetPool.kind} at ${targetPrice.toFixed(2)}, invalidation beyond ${stopLoss.toFixed(2)}.`,
            poiEvidence ? `POI confirmation: ${poiEvidence}.` : "POI reaction verified.",
            `Risk-Reward ratio: ${riskReward.toFixed(2)}R.`,
          ],
          evidence: {
            strategy: ICT_STRUCTURE_STRATEGY_KEY,
            engineVersion: ict.engineVersion,
            configHash: ict.configHash,
            bias: bias.bias,
            structureTrend: structure.trend,
            targetPoolKind: targetPool.kind,
            targetPrice,
            stopLoss,
            poiEvidence,
          },
          expiresAt,
          evidenceItems: evidence,
        },
      ];
    } else {
      side = "SHORT";
      const rawStop = liquidity.invalidationLevel ?? (entryPrice * 1.005);
      stopLoss = rawStop * 1.0005; // 0.05% volatility buffer
      targetPrice = targetPool.price;

      if (stopLoss <= entryPrice || targetPrice >= entryPrice) return [];
      const risk = stopLoss - entryPrice;
      const reward = entryPrice - targetPrice;
      const riskReward = Number((reward / risk).toFixed(2));
      if (riskReward < config.minimumRiskReward) return [];

      const evidence: TradeIdeaEvidence[] = [
        {
          sourceType: "STRATEGY",
          sourceReference: "PILLAR_STACK",
          label: "Four-Pillar ICT Short Alignment",
          contribution: 0.4,
          details: {
            bias: bias.bias,
            structureTrend: structure.trend,
            dealingRangeEq: bias.dealingRange?.equilibrium,
            template: bias.dailyTemplate,
          },
        },
        {
          sourceType: "STRATEGY",
          sourceReference: "LIQUIDITY_TARGET",
          label: `Targeting ERL ${targetPool.kind}`,
          contribution: 0.35,
          details: {
            targetPrice: targetPool.price,
            intermediateTarget: liquidity.intermediateTarget,
          },
        },
      ];

      if (poiEvidence) {
        evidence.push({
          sourceType: "STRATEGY",
          sourceReference: "POI_CONFIRMATION",
          label: poiEvidence,
          contribution: 0.25,
          details: { poiEvidence },
        });
      }

      const expiresAt = new Date(
        context.candle.closeTime.getTime() + config.expiryCandles * 5 * 60_000
      );

      return [
        {
          side,
          entryPrice,
          stopLoss,
          targetPrice,
          riskReward,
          confidence: Math.max(config.minConfidence, 0.75),
          reasoning: [
            `Four-Pillar ICT SHORT alignment: ${bias.bias} bias, ${structure.trend} trend, ${bias.dailyTemplate} template.`,
            `Targeting ERL ${targetPool.kind} at ${targetPrice.toFixed(2)}, invalidation beyond ${stopLoss.toFixed(2)}.`,
            poiEvidence ? `POI confirmation: ${poiEvidence}.` : "POI reaction verified.",
            `Risk-Reward ratio: ${riskReward.toFixed(2)}R.`,
          ],
          evidence: {
            strategy: ICT_STRUCTURE_STRATEGY_KEY,
            engineVersion: ict.engineVersion,
            configHash: ict.configHash,
            bias: bias.bias,
            structureTrend: structure.trend,
            targetPoolKind: targetPool.kind,
            targetPrice,
            stopLoss,
            poiEvidence,
          },
          expiresAt,
          evidenceItems: evidence,
        },
      ];
    }
  }
}
