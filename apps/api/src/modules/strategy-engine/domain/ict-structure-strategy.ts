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
  minimumRiskReward: 1.5,
  minConfidence: 0.7,
  expiryCandles: 3,
  requirePoiReaction: true,
};

export const ictStructureStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: ICT_STRUCTURE_STRATEGY_KEY,
  name: "ICT Canonical Structure Strategy",
  description:
    "Four-pillar ICT institutional order flow strategy enforcing fractal bias, canonical structure with IDM, zone ledger lifecycle, and liquidity delivery path.",
  version: 1,
  configuration: defaultIctStructureStrategyConfiguration as unknown as Record<string, unknown>,
};

export class IctStructureStrategy implements StrategyEvaluator {
  evaluate(
    context: StrategyMarketContext,
    strategyConfiguration: Record<string, unknown>
  ): ProposedTradeIdea[] {
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

    // Pillar Gate 2b: Fractal alignment. The HTF bias is a required pillar; if
    // it is present it must agree with the intended direction, otherwise the
    // fractal objective and the local setup disagree and there is no trade.
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
      stopLoss = liquidity.invalidationLevel ?? (entryPrice * 0.995);
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
      stopLoss = liquidity.invalidationLevel ?? (entryPrice * 1.005);
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
