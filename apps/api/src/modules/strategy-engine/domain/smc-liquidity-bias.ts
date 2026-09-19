import { istSessionDate } from "../../platform/calendar/trading-session.js";
import { isStrictlyHigherTimeframe } from "./timeframe-order.js";
import type { ProposedTradeIdea, StrategyMarketContext } from "./strategy.js";

export type LiquidityBiasDirection = "BULLISH" | "BEARISH" | "NEUTRAL";

export interface HtfLiquidityBiasObservation {
  readonly timeframe: string;
  readonly bias: LiquidityBiasDirection;
  readonly reason: string;
  readonly sourceCandleId?: string;
  readonly sourceCandleCloseTime?: Date;
  readonly signals: readonly {
    readonly code: string;
    readonly type: string;
    readonly direction: "BULLISH" | "BEARISH";
  }[];
}

export interface LiquiditySweepBiasOptions {
  /**
   * Whether to require the HTF candle to be from the same IST trading session.
   * Default: true. At market open (e.g. 09:15-09:29), yesterday's 15:30 bar does
   * not dictate today's open bias after an overnight gap.
   */
  readonly enforceSameSession?: boolean;
}

const BIAS_INDICATOR_CODES = new Set(["LIQUIDITY_SWEEP", "CHOCH"]);

/**
 * Evaluates the directional bias established by the most recent closed higher-timeframe candle.
 *
 * Scans `context.higherTimeframeContexts[htfTimeframe]` for `LIQUIDITY_SWEEP` and `CHOCH` indicators:
 * - Net BULLISH signals -> BULLISH bias (favours LONG, opposes SHORT)
 * - Net BEARISH signals -> BEARISH bias (favours SHORT, opposes LONG)
 * - No signals, missing HTF, cross-session gap, or equal signal counts -> NEUTRAL (no-op)
 */
export function evaluateLiquiditySweepBias(
  context: StrategyMarketContext,
  htfTimeframe = "15m",
  options?: LiquiditySweepBiasOptions,
): HtfLiquidityBiasObservation {
  const enforceSameSession = options?.enforceSameSession ?? true;

  // 1. Resolve the context carrying the target timeframe indicators:
  // - If the base bar is itself the target timeframe (e.g. 15m autonomous agent bar), read its own indicators.
  // - If the base bar is strictly faster (e.g. 1m scalp), read from higherTimeframeContexts.
  // - If the base bar is slower (e.g. 1d), the target timeframe cannot serve as a higher timeframe.
  let htf: StrategyMarketContext | undefined;
  if (context.candle.timeframe === htfTimeframe) {
    htf = context;
  } else if (isStrictlyHigherTimeframe(context.candle.timeframe, htfTimeframe)) {
    htf = context.higherTimeframeContexts?.[
      htfTimeframe as keyof NonNullable<typeof context.higherTimeframeContexts>
    ];
  } else {
    return {
      timeframe: htfTimeframe,
      bias: "NEUTRAL",
      reason: `Base timeframe ${context.candle.timeframe} is slower than HTF ${htfTimeframe}.`,
      signals: [],
    };
  }

  if (!htf) {
    return {
      timeframe: htfTimeframe,
      bias: "NEUTRAL",
      reason: `No completed ${htfTimeframe} context attached to ${context.candle.timeframe} bar.`,
      signals: [],
    };
  }

  // 3. Anti-lookahead assertion
  if (htf.candle.closeTime.getTime() > context.candle.closeTime.getTime()) {
    throw new Error(
      `HTF_BIAS_LOOKAHEAD: ${htfTimeframe} candle closed at ${htf.candle.closeTime.toISOString()} which is after base candle close ${context.candle.closeTime.toISOString()}.`,
    );
  }

  // 4. Session boundary check: ignore HTF bars from prior days for intraday scalp bias
  if (enforceSameSession && istSessionDate(htf.candle.closeTime) !== istSessionDate(context.candle.closeTime)) {
    return {
      timeframe: htfTimeframe,
      bias: "NEUTRAL",
      sourceCandleId: htf.candle.id,
      sourceCandleCloseTime: htf.candle.closeTime,
      reason: `${htfTimeframe} candle is from previous session (${istSessionDate(htf.candle.closeTime)} vs ${istSessionDate(context.candle.closeTime)}); bias reset at session open.`,
      signals: [],
    };
  }

  // 5. Scan indicators for LIQUIDITY_SWEEP and CHOCH
  const observedSignals: Array<{
    code: string;
    type: string;
    direction: "BULLISH" | "BEARISH";
  }> = [];

  let bullishCount = 0;
  let bearishCount = 0;

  for (const indicator of htf.indicators ?? []) {
    if (!BIAS_INDICATOR_CODES.has(indicator.code)) continue;
    const type = typeof indicator.values.type === "string" ? indicator.values.type : "";
    if (type.startsWith("BULLISH")) {
      bullishCount += 1;
      observedSignals.push({ code: indicator.code, type, direction: "BULLISH" });
    } else if (type.startsWith("BEARISH")) {
      bearishCount += 1;
      observedSignals.push({ code: indicator.code, type, direction: "BEARISH" });
    }
  }

  if (bullishCount === 0 && bearishCount === 0) {
    return {
      timeframe: htfTimeframe,
      bias: "NEUTRAL",
      sourceCandleId: htf.candle.id,
      sourceCandleCloseTime: htf.candle.closeTime,
      reason: `No liquidity sweep or CHOCH detected on ${htfTimeframe} candle.`,
      signals: [],
    };
  }

  const netBias = bullishCount - bearishCount;
  if (netBias > 0) {
    return {
      timeframe: htfTimeframe,
      bias: "BULLISH",
      sourceCandleId: htf.candle.id,
      sourceCandleCloseTime: htf.candle.closeTime,
      reason: `BULLISH bias from ${htfTimeframe} (${bullishCount} bullish vs ${bearishCount} bearish signals: ${observedSignals.map((s) => s.type).join(", ")}).`,
      signals: observedSignals,
    };
  }

  if (netBias < 0) {
    return {
      timeframe: htfTimeframe,
      bias: "BEARISH",
      sourceCandleId: htf.candle.id,
      sourceCandleCloseTime: htf.candle.closeTime,
      reason: `BEARISH bias from ${htfTimeframe} (${bearishCount} bearish vs ${bullishCount} bullish signals: ${observedSignals.map((s) => s.type).join(", ")}).`,
      signals: observedSignals,
    };
  }

  return {
    timeframe: htfTimeframe,
    bias: "NEUTRAL",
    sourceCandleId: htf.candle.id,
    sourceCandleCloseTime: htf.candle.closeTime,
    reason: `Balanced signals on ${htfTimeframe} (${bullishCount} bullish, ${bearishCount} bearish); net neutral.`,
    signals: observedSignals,
  };
}

/**
 * Filters out proposals whose direction opposes the higher-timeframe liquidity sweep bias.
 *
 * When an active bias is resolved:
 * - BULLISH bias admits only LONG proposals and drops SHORT proposals.
 * - BEARISH bias admits only SHORT proposals and drops LONG proposals.
 * - NEUTRAL bias admits all proposals unmodified.
 *
 * For admitted proposals that passed an active bias, evidence is attached for observability.
 */
export function filterProposalsByLiquiditySweepBias(
  context: StrategyMarketContext,
  proposals: readonly ProposedTradeIdea[],
  htfTimeframe = "15m",
  options?: LiquiditySweepBiasOptions,
): ProposedTradeIdea[] {
  if (proposals.length === 0) return [];

  const biasObservation = evaluateLiquiditySweepBias(context, htfTimeframe, options);

  if (biasObservation.bias === "NEUTRAL") {
    return proposals as ProposedTradeIdea[];
  }

  const allowedSide: "LONG" | "SHORT" = biasObservation.bias === "BULLISH" ? "LONG" : "SHORT";
  const admitted: ProposedTradeIdea[] = [];

  for (const proposal of proposals) {
    if (proposal.side !== allowedSide) {
      continue;
    }

    admitted.push({
      ...proposal,
      reasoning: [
        ...proposal.reasoning,
        `HTF Liquidity Bias (${htfTimeframe}): Confirmed ${biasObservation.bias} (${biasObservation.reason})`,
      ],
      evidence: {
        ...proposal.evidence,
        htfLiquidityBias: {
          timeframe: htfTimeframe,
          bias: biasObservation.bias,
          sourceCandleId: biasObservation.sourceCandleId,
          sourceCandleCloseTime: biasObservation.sourceCandleCloseTime?.toISOString(),
          reason: biasObservation.reason,
          signals: biasObservation.signals,
        },
      },
      evidenceItems: [
        ...proposal.evidenceItems,
        {
          sourceType: "INDICATOR",
          sourceReference: `HTF_LIQUIDITY_BIAS:${htfTimeframe}`,
          label: biasObservation.reason,
          contribution: 0,
          details: {
            timeframe: htfTimeframe,
            bias: biasObservation.bias,
            signals: biasObservation.signals,
          },
        },
      ],
    });
  }

  return admitted;
}
