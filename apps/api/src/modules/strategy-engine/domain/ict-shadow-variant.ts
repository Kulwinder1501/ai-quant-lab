import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";
import { IctStructureStrategy, ictStructureStrategyRegistration } from "./ict-structure-strategy.js";
import type { StrategyMarketContext, TradeSide } from "./strategy.js";

/**
 * The first shadow variant of the live ICT sweep -> MSS -> retrace strategy: the same sequence with
 * the bias-agreement gates lifted.
 *
 * ## Why it exists
 *
 * Between 2026-10-12 and 10-13 the live strategy raised no idea at all. Replaying its entry
 * conditions over every stored snapshot, the first gate to fail was "daily bias opposes the shift"
 * on 74 of 147 BANKNIFTY 5m bars and 30 of 49 NIFTY 15m bars: the monthly-to-daily bias stayed
 * BEARISH throughout a rising session, and a bullish shift against it is the counter-trend case the
 * strategy is built to skip. Whether skipping it is right has never been measured on live data. This
 * records what the strategy *would* propose with that one gate lifted, so the question can be
 * answered from outcomes instead of argued.
 *
 * ## How it lifts the gate without touching the strategy
 *
 * The strategy reads `ict.bias.bias` and `ict.htfBias` and compares each with the shift's direction.
 * The variant hands it a copy of the snapshot in which both equal the shift's direction, so those
 * two comparisons pass trivially and every other condition (the shift's age, the leg size, the
 * tap-and-hold of the OTE band, the stop, the risk-reward floor) runs unchanged. The live strategy
 * file is not edited, so the live bots' behaviour cannot move because of this.
 *
 * The real bias is recorded next to each signal, along with whether the unmodified strategy would
 * also have proposed it, so aligned signals form a control population measured the same way.
 *
 * ## What it is not
 *
 * Not a strategy anyone trades and not an idea: it creates no `trade_ideas` row, so no bot, no
 * dashboard and no V2.2 differential comparison can see it.
 */
export const COUNTER_BIAS_VARIANT = "COUNTER_BIAS_V1";

export interface IctShadowSignal {
  readonly variant: string;
  readonly side: TradeSide;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly riskReward: number;
  readonly setupId: string | null;
  readonly bias: string;
  readonly htfBias: string | null;
  /** The daily bias agrees with the shift's direction. FALSE is the counter-bias population. */
  readonly biasAligned: boolean;
  /** The higher-timeframe bias is absent or agrees with the shift's direction. */
  readonly htfAligned: boolean;
  /** The unmodified live strategy also proposed this side on this bar. */
  readonly liveWouldFire: boolean;
  readonly details: Record<string, unknown>;
}

/**
 * Evaluates the variant on one completed bar. Pure: it reads the context and returns signals.
 * An empty list is the ordinary answer -- no shift, no snapshot, or a gate other than bias failed.
 */
export function evaluateCounterBiasVariant(
  context: StrategyMarketContext,
  configuration: Record<string, unknown> = ictStructureStrategyRegistration.configuration,
): IctShadowSignal[] {
  const ict = context.ictSnapshot;
  const mss = ict?.mss ?? null;
  if (!ict || mss === null) return [];

  const strategy = new IctStructureStrategy();
  const liveSides = new Set(strategy.evaluate(context, configuration).map((idea) => idea.side));

  const agreeing: IctStateCompositeSnapshot = {
    ...ict,
    bias: { ...ict.bias, bias: mss.direction },
    htfBias: mss.direction,
  };
  const proposals = strategy.evaluate({ ...context, ictSnapshot: agreeing }, configuration);

  return proposals.map((idea) => {
    const setupId = idea.evidence.setupId;
    return {
      variant: COUNTER_BIAS_VARIANT,
      side: idea.side,
      entryPrice: idea.entryPrice,
      stopLoss: idea.stopLoss,
      targetPrice: idea.targetPrice,
      riskReward: idea.riskReward,
      setupId: typeof setupId === "string" ? setupId : null,
      bias: ict.bias.bias,
      htfBias: ict.htfBias ?? null,
      biasAligned: ict.bias.bias === mss.direction,
      htfAligned: !ict.htfBias || ict.htfBias === mss.direction,
      liveWouldFire: liveSides.has(idea.side),
      details: {
        mssDirection: mss.direction,
        mssBreakBarTime: mss.breakBarTime,
        barsSinceBreak: mss.barsSinceBreak,
        displacementBodyAtr: mss.displacementBodyAtr,
        legStart: mss.legStart,
        legEnd: mss.legEnd,
        atr14: ict.atr14,
      },
    };
  });
}
