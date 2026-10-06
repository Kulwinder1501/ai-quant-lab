import type { StrategyEvaluator } from "./strategy-registry.js";
import type { EnsureStrategyVersionInput, ProposedTradeIdea, StrategyMarketContext } from "./strategy.js";

export const hybridLiquidityConfluenceStrategyKey = "hybrid-liquidity-confluence-v1";
// Bumped 1 -> 2: version 1's stored configuration ({"minDiDecay": 0.15, "minLongPcr": 1.2,
// "maxShortPcr": 0.8, "minRawDiOfi": 0.05, "minIvPercentile": 15}, registered 2026-09-28) predates
// the thresholds moving inline into evaluate() below (this strategy now declares configuration: {}).
// `PostgresStrategyVersionRepository.ensure()` correctly refuses to silently rewrite an existing
// version's immutable configuration, so every live tick failed with STRATEGY_FAILED ("already
// exists with a different immutable configuration") once the scheduler process restarted and
// re-ran this check fresh -- this strategy generated zero trade ideas on any tick since.
export const hybridLiquidityConfluenceStrategyVersion = 2;

export const hybridLiquidityConfluenceStrategyRegistration: EnsureStrategyVersionInput = {
  strategyKey: hybridLiquidityConfluenceStrategyKey,
  name: "Hybrid Liquidity Confluence Strategy",
  description: "3-Pillar institutional engine combining L2 depth imbalance, Cont-Kukanov-Stoikov OFI, and Option Chain OI walls.",
  version: hybridLiquidityConfluenceStrategyVersion,
  configuration: {},
};

/**
 * HYBRID LIQUIDITY CONFLUENCE STRATEGY (v1.1.0)
 *
 * 3-Pillar Institutional Trading Strategy:
 * 1. Pillar A: Structural Liquidity Level Sweep (PDH/PDL, Swing High/Low, Session High/Low)
 *              + Decaying L2 Depth Imbalance (DI_decay > 0.10).
 * 2. Pillar B: Cont-Kukanov-Stoikov Order Flow Imbalance (OFI) Aggressor Flow.
 * 3. Pillar C: Option Chain Open Interest (OI) Put/Call Ratio Wall (PCR >= 1.2 for LONG, <= 0.8 for SHORT).
 *
 * Pillar A threshold fixed 2026-09-28: this code gated at 0.10 while the docstring (until this
 * revision) and `apps/ml/run_hybrid_confluence_backtest.py` both said 0.15 -- a real mismatch
 * between shipped code and its own documentation. A sensitivity sweep at 0.10/0.125/0.15 on the
 * same 172,667-event population settled it in 0.10's favour, and not narrowly: 0.10 is n=14,678,
 * win rate 38.36%, PF 0.93, binomial p=1.6e-29 against the standalone baseline; 0.125 is already
 * worse (36.20%, PF 0.85, p=1.5e-08); 0.15 -- the value the docstring used to claim -- is n=12,290,
 * win rate 33.65% (*below* the 33.93% unfiltered baseline), PF 0.76, p=0.74 (not significant). The
 * threshold that shipped in code was the right one; the docstring and backtest script were wrong,
 * not the gate. Full numbers in docs/2026-09-28-hybrid-liquidity-confluence-v1-validation.md.
 */
export class HybridLiquidityConfluenceStrategy implements StrategyEvaluator {
  readonly strategyKey = hybridLiquidityConfluenceStrategyKey;

  evaluate(context: StrategyMarketContext, _configuration: Record<string, unknown>): ProposedTradeIdea[] {
    const candle = context.candle;
    const confluence = context.confluenceSignal;

    // Pillar A: Structural Level Sweep & Orderbook Depth Alignment
    const isLevelProximate = confluence?.is_level_proximate ?? false;
    const nearestLevelType = confluence?.nearest_level_type ?? null;
    const diTilde = confluence?.di_tilde ?? null;

    // Threshold 0.10, confirmed (not just left alone) by the 2026-09-28 sensitivity sweep -- see
    // the class docstring above for the 0.10/0.125/0.15 comparison this settled.
    if (!isLevelProximate || diTilde === null || diTilde <= 0.10) {
      return [];
    }

    const action = confluence?.gate_action ?? "NO_ACTION";
    const bias = confluence?.directional_bias ?? "NONE";

    let proposedSide: "LONG" | "SHORT" | null = null;
    if (action === "BUY_CALL_OR_LONG") proposedSide = "LONG";
    else if (action === "BUY_PUT_OR_SHORT") proposedSide = "SHORT";

    if (!proposedSide) return [];

    // Pillar B: Institutional Order Flow Imbalance (OFI Aggressor Flow)
    // Check price action / indicator flow or raw_di confirmation
    const rawDi = confluence?.raw_di ?? 0;
    const isOfiAligned = proposedSide === "LONG" ? rawDi >= 0.05 : rawDi <= -0.05;

    // Pillar C: Option Chain Open Interest (OI) Put/Call Ratio Wall Check.
    //
    // Real as-of PCR from `optionChainSignal` (`PostgresStrategyMarketContextRepository
    // .resolveOptionChainSignal`), never a default pass. Until 2026-09-28 this read a
    // `priceActionEvents[].details.oiSupport/oiResistance` flag that nothing in the codebase ever
    // set, so it was always `true` -- Pillar C never rejected a single proposal. `pcr === null`
    // (no snapshot yet, or the nearest one older than `optionChainSignal.ageMinutes`'s ceiling)
    // is treated as unconfirmed, not as a pass.
    const pcr = context.optionChainSignal?.pcr ?? null;
    if (!isOfiAligned || pcr === null) {
      return [];
    }
    const oiWallConfirmed = proposedSide === "LONG" ? pcr >= 1.2 : pcr <= 0.8;

    if (!oiWallConfirmed) {
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

    const confidence = Math.min(95, Math.round(85 + diTilde * 10));

    const reasoning = [
      `[Pillar A PASS] Structural sweep at ${nearestLevelType} with Decaying Depth Imbalance DI_tilde=${diTilde.toFixed(4)}.`,
      `[Pillar B PASS] Order Flow Aggressor flow confirmed (raw_di=${rawDi.toFixed(4)}).`,
      `[Pillar C PASS] Option Chain PCR wall confirmed for ${proposedSide} (pcr=${pcr.toFixed(4)}).`,
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
        pillarC: { pcr, oiWallConfirmed },
      },
      expiresAt: new Date(candle.closeTime.getTime() + 15 * 60 * 1000), // 15-minute expiration
      evidenceItems: [
        {
          sourceType: "STRATEGY",
          sourceReference: this.strategyKey,
          label: "Hybrid Institutional Confluence",
          contribution: confidence,
          details: { nearestLevelType, diTilde, rawDi, pcr },
        },
      ],
    };

    return [proposal];
  }
}
