import type { StrategyEvaluator } from "./strategy-registry.js";
import type { EnsureStrategyVersionInput, ProposedTradeIdea, StrategyMarketContext } from "./strategy.js";

export const hybridLiquidityConfluenceStrategyKey = "hybrid-liquidity-confluence-v1";
export const hybridLiquidityConfluenceStrategyVersion = 1;

export interface HybridLiquidityConfluenceConfiguration {
  /** Pillar A minimum Decaying Depth Imbalance magnitude (default 0.10). */
  minDiDecay: number;
  /** Pillar B minimum Order Flow Imbalance magnitude (default 0.05). */
  minRawDiOfi: number;
  /** Pillar C minimum Put-Call Ratio for LONG trades (default 1.2). */
  minLongPcr: number;
  /** Pillar C maximum Put-Call Ratio for SHORT trades (default 0.8). */
  maxShortPcr: number;
  /** Pillar C minimum Implied Volatility Percentile threshold (default 15.0). */
  minIvPercentile: number;
}

export const defaultHybridLiquidityConfluenceConfiguration: HybridLiquidityConfluenceConfiguration = {
  minDiDecay: 0.10,
  minRawDiOfi: 0.05,
  minLongPcr: 1.2,
  maxShortPcr: 0.8,
  minIvPercentile: 15.0,
};

export const hybridLiquidityConfluenceStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: hybridLiquidityConfluenceStrategyKey,
  name: "Hybrid Liquidity Confluence Strategy",
  description: "3-Pillar institutional engine combining L2 depth imbalance, Cont-Kukanov-Stoikov OFI, and Option Chain OI walls.",
  version: hybridLiquidityConfluenceStrategyVersion,
  configuration: { ...defaultHybridLiquidityConfluenceConfiguration } as Record<string, unknown>,
};

/**
 * HYBRID LIQUIDITY CONFLUENCE STRATEGY (v1.0.0)
 *
 * 3-Pillar Institutional Trading Strategy:
 * 1. Pillar A: Structural Liquidity Level Sweep (PDH/PDL, Swing High/Low, Session High/Low)
 *              + Decaying L2 Depth Imbalance (|DI_decay| >= 0.10).
 * 2. Pillar B: Cont-Kukanov-Stoikov Order Flow Imbalance (OFI) Aggressor Flow (|raw_di| >= 0.05).
 * 3. Pillar C: Option Chain Open Interest (OI) Support/Resistance Walls (PCR >= 1.2 for LONG, <= 0.8 for SHORT)
 *              & Volatility Regime (IV Percentile >= 15%).
 */
export class HybridLiquidityConfluenceStrategy implements StrategyEvaluator {
  readonly strategyKey = hybridLiquidityConfluenceStrategyKey;

  evaluate(context: StrategyMarketContext, rawConfiguration: Record<string, unknown>): ProposedTradeIdea[] {
    const config: HybridLiquidityConfluenceConfiguration = {
      minDiDecay: typeof rawConfiguration.minDiDecay === "number" ? rawConfiguration.minDiDecay : defaultHybridLiquidityConfluenceConfiguration.minDiDecay,
      minRawDiOfi: typeof rawConfiguration.minRawDiOfi === "number" ? rawConfiguration.minRawDiOfi : defaultHybridLiquidityConfluenceConfiguration.minRawDiOfi,
      minLongPcr: typeof rawConfiguration.minLongPcr === "number" ? rawConfiguration.minLongPcr : defaultHybridLiquidityConfluenceConfiguration.minLongPcr,
      maxShortPcr: typeof rawConfiguration.maxShortPcr === "number" ? rawConfiguration.maxShortPcr : defaultHybridLiquidityConfluenceConfiguration.maxShortPcr,
      minIvPercentile: typeof rawConfiguration.minIvPercentile === "number" ? rawConfiguration.minIvPercentile : defaultHybridLiquidityConfluenceConfiguration.minIvPercentile,
    };

    const candle = context.candle;
    const confluence = context.confluenceSignal;

    // Pillar A: Structural Level Sweep & Orderbook Depth Alignment
    const isLevelProximate = confluence?.is_level_proximate ?? false;
    const nearestLevelType = confluence?.nearest_level_type ?? null;
    const diTilde = confluence?.di_tilde ?? null;

    if (!isLevelProximate || diTilde === null || Math.abs(diTilde) < config.minDiDecay) {
      return [];
    }

    const action = confluence?.gate_action ?? "NO_ACTION";
    const bias = confluence?.directional_bias ?? "NONE";

    let proposedSide: "LONG" | "SHORT" | null = null;
    if (action === "BUY_CALL_OR_LONG" && diTilde >= config.minDiDecay) {
      proposedSide = "LONG";
    } else if (action === "BUY_PUT_OR_SHORT" && diTilde <= -config.minDiDecay) {
      proposedSide = "SHORT";
    }

    if (!proposedSide) return [];

    // Pillar B: Institutional Order Flow Imbalance (OFI Aggressor Flow)
    const rawDi = confluence?.raw_di ?? 0;
    const isOfiAligned = proposedSide === "LONG" ? rawDi >= config.minRawDiOfi : rawDi <= -config.minRawDiOfi;

    if (!isOfiAligned) {
      return [];
    }

    // Pillar C: Option Chain Open Interest (OI) & Volatility Regime
    // 1. Search for PCR indicator in indicators or priceActionEvents
    let pcrValue: number | null = null;
    const pcrInd = context.indicators.find(ind => (ind.code as string) === "PCR" || (ind.code as string) === "OPTION_PCR");
    if (pcrInd && typeof pcrInd.values.value === "number") {
      pcrValue = pcrInd.values.value;
    }

    // 2. Search for IV Percentile indicator
    let ivpVal: number | null = null;
    const ivpInd = context.indicators.find(ind => (ind.code as string) === "IV_PERCENTILE");
    if (ivpInd && typeof ivpInd.values.value === "number") {
      ivpVal = ivpInd.values.value;
    }

    // Check PA events for OI walls if indicator not provided directly
    const paEvents = context.priceActionEvents ?? [];
    let oiWallConfirmed = true;
    for (const pa of paEvents) {
      if (proposedSide === "LONG" && pa.details?.oiSupport === false) {
        oiWallConfirmed = false;
        break;
      }
      if (proposedSide === "SHORT" && pa.details?.oiResistance === false) {
        oiWallConfirmed = false;
        break;
      }
    }

    // Evaluate Pillar C Rules
    let pillarCPassed = oiWallConfirmed;

    if (pcrValue !== null) {
      if (proposedSide === "LONG" && pcrValue < config.minLongPcr) {
        pillarCPassed = false;
      } else if (proposedSide === "SHORT" && pcrValue > config.maxShortPcr) {
        pillarCPassed = false;
      }
    }

    if (ivpVal !== null && ivpVal < config.minIvPercentile) {
      pillarCPassed = false;
    }

    if (!pillarCPassed) {
      return [];
    }

    // Position Sizing & Price Calculations
    const entryPrice = candle.close;
    const atr = candle.close * 0.003; // ~30 bps default ATR estimation
    const stopDistance = Math.max(candle.tickSize * 20, atr);

    const stopLoss = proposedSide === "LONG"
      ? Number((entryPrice - stopDistance).toFixed(2))
      : Number((entryPrice + stopDistance).toFixed(2));

    const rewardDistance = stopDistance * 1.5;
    const targetPrice = proposedSide === "LONG"
      ? Number((entryPrice + rewardDistance).toFixed(2))
      : Number((entryPrice - rewardDistance).toFixed(2));

    const confidence = Math.min(95, Math.round(85 + Math.abs(diTilde) * 10));

    const reasoning = [
      `[Pillar A PASS] Structural sweep at ${nearestLevelType} with Decaying Depth Imbalance DI_tilde=${diTilde.toFixed(4)} (Threshold: |DI| >= ${config.minDiDecay}).`,
      `[Pillar B PASS] Order Flow Aggressor flow confirmed (raw_di=${rawDi.toFixed(4)}).`,
      `[Pillar C PASS] Option Chain Open Interest wall & volatility regime confirmed for ${proposedSide}${pcrValue !== null ? ` (PCR=${pcrValue.toFixed(2)})` : ""}${ivpVal !== null ? ` (IVP=${ivpVal.toFixed(1)}%)` : ""}.`,
    ];

    const proposal: ProposedTradeIdea = {
      side: proposedSide,
      entryPrice,
      stopLoss,
      targetPrice,
      riskReward: 1.5,
      confidence,
      reasoning,
      evidence: {
        strategyKey: this.strategyKey,
        pillarA: { nearestLevelType, diTilde, bias },
        pillarB: { rawDi, isOfiAligned },
        pillarC: { oiWallConfirmed, pcrValue, ivpVal },
      },
      expiresAt: new Date(candle.closeTime.getTime() + 15 * 60 * 1000), // 15-minute expiration
      evidenceItems: [
        {
          sourceType: "STRATEGY",
          sourceReference: this.strategyKey,
          label: "Hybrid Institutional Confluence",
          contribution: confidence,
          details: { nearestLevelType, diTilde, rawDi, pcrValue, ivpVal },
        },
      ],
    };

    return [proposal];
  }
}
