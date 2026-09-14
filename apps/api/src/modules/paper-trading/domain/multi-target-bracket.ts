export interface BracketTarget {
  label: "T1" | "T2" | "RUNNER";
  rewardRiskMultiple: number;
  exitFraction: number; // advisory
  moveStopToBreakeven: boolean;
  trailingMode: "NONE" | "UNDERLYING_SUPERTREND" | "PIVOT" | "PERCENT";
  trailingParam: number;
}

export interface MultiTargetConfiguration {
  breakevenMode: "ENTRY_PRICE" | "COST_ADJUSTED";
  t1Multiple: number;
  t2Multiple: number;
}

export const defaultMultiTargetConfiguration: MultiTargetConfiguration = {
  breakevenMode: "ENTRY_PRICE",
  t1Multiple: 1.5,
  t2Multiple: 2.5,
};

export function allocateMultiTargetLots(totalLots: number): { t1: number; t2: number; runner: number } {
  if (totalLots < 1) {
    return { t1: 0, t2: 0, runner: 0 };
  }

  if (totalLots === 1) {
    // 1 lot -> single target (no multi-target scaling)
    return { t1: 1, t2: 0, runner: 0 };
  }

  if (totalLots === 2) {
    // 2 lots -> T1 (1) + Runner (1)
    return { t1: 1, t2: 0, runner: 1 };
  }

  // 3+ lots
  let t1 = Math.max(1, Math.floor(totalLots * 0.50));
  let t2 = Math.max(1, Math.floor(totalLots * 0.30));
  let runner = totalLots - t1 - t2;

  // If runner < 1, reduce T2 first so Runner remains >= 1
  if (runner < 1) {
    const deficit = 1 - runner;
    const t2Reduction = Math.min(t2, deficit);
    t2 -= t2Reduction;
    runner += t2Reduction;

    if (runner < 1) {
      const remainingDeficit = 1 - runner;
      t1 -= remainingDeficit;
      runner += remainingDeficit;
    }
  }

  return { t1, t2, runner };
}

export interface ResolvedMultiTargetBracket {
  hasMultiTargetPlan: boolean;
  t1TargetPrice: number;
  t1Quantity: number;
  t2TargetPrice: number | null;
  t2Quantity: number;
  runnerQuantity: number;
  initialStopLoss: number;
  breakevenStopLoss: number;
}

export function buildMultiTargetPlan(params: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  quantity: number;
  lotSize: number;
  config?: Partial<MultiTargetConfiguration>;
}): ResolvedMultiTargetBracket {
  const config = { ...defaultMultiTargetConfiguration, ...params.config };
  const totalLots = Math.max(1, Math.floor(params.quantity / Math.max(1, params.lotSize)));
  const { t1: t1Lots, t2: t2Lots, runner: runnerLots } = allocateMultiTargetLots(totalLots);

  const risk = Math.abs(params.entryPrice - params.stopLoss);
  const directionSign = params.side === "LONG" ? 1 : -1;

  const t1TargetPrice = params.entryPrice + directionSign * risk * config.t1Multiple;
  const t2TargetPrice = t2Lots > 0 ? params.entryPrice + directionSign * risk * config.t2Multiple : null;

  return {
    hasMultiTargetPlan: totalLots >= 2,
    t1TargetPrice,
    t1Quantity: t1Lots * params.lotSize,
    t2TargetPrice,
    t2Quantity: t2Lots * params.lotSize,
    runnerQuantity: runnerLots * params.lotSize,
    initialStopLoss: params.stopLoss,
    breakevenStopLoss: params.entryPrice,
  };
}
