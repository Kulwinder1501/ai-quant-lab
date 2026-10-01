export interface O1ExitEvaluationInput {
  side: "LONG" | "SHORT";
  underlyingDirection: "LONG" | "SHORT";
  entryUnderlying: number;
  invalidationLevelAtEntry: number;
  initialRiskDistance: number;
  entryOptionPrice: number;
  openedAt: Date;
  now: Date;
  currentOptionPrice: number;
  effectivePremiumStop: number;
  effectivePremiumTarget: number;
  currentUnderlyingPrice: number | null;
}

export interface O1ExitEvaluationResult {
  shouldExit: boolean;
  exitReason: "HARD_STOP" | "UNDERLYING_INVALIDATION" | "TIME_STOP" | "PREMIUM_TOLERANCE" | "TARGET_REACHED" | null;
  telemetry: {
    holdingMinutes: number;
    progressR: number | null;
    underlyingMoveBps: number | null;
    premiumDrawdownPct: number | null;
  };
}

export function evaluateO1TradeExit(input: O1ExitEvaluationInput): O1ExitEvaluationResult {
  const holdingMinutes = Math.max(0, (input.now.getTime() - input.openedAt.getTime()) / 60_000);

  const isUnderlyingAvailable =
    input.currentUnderlyingPrice !== null &&
    Number.isFinite(input.currentUnderlyingPrice) &&
    input.currentUnderlyingPrice > 0;

  const favorableUnderlyingMove = isUnderlyingAvailable
    ? input.underlyingDirection === "LONG"
      ? input.currentUnderlyingPrice! - input.entryUnderlying
      : input.entryUnderlying - input.currentUnderlyingPrice!
    : null;

  const progressR =
    isUnderlyingAvailable && input.initialRiskDistance > 0 && favorableUnderlyingMove !== null
      ? favorableUnderlyingMove / input.initialRiskDistance
      : null;

  const underlyingMoveBps =
    isUnderlyingAvailable && favorableUnderlyingMove !== null && input.entryUnderlying > 0
      ? (favorableUnderlyingMove / input.entryUnderlying) * 10_000
      : null;

  // Premium drawdown relative to entry option price
  const premiumDrawdownPct =
    input.entryOptionPrice > 0
      ? (input.entryOptionPrice - input.currentOptionPrice) / input.entryOptionPrice
      : null;

  const telemetry = {
    holdingMinutes,
    progressR,
    underlyingMoveBps,
    premiumDrawdownPct,
  };

  // 1. HARD_STOP: option premium hits or falls below option stop loss
  if (input.currentOptionPrice <= input.effectivePremiumStop) {
    return { shouldExit: true, exitReason: "HARD_STOP", telemetry };
  }

  // 2. UNDERLYING_INVALIDATION: underlying price hits/breaches invalidation level
  if (isUnderlyingAvailable) {
    const isInvalidated =
      input.underlyingDirection === "LONG"
        ? input.currentUnderlyingPrice! <= input.invalidationLevelAtEntry
        : input.currentUnderlyingPrice! >= input.invalidationLevelAtEntry;

    if (isInvalidated) {
      return { shouldExit: true, exitReason: "UNDERLYING_INVALIDATION", telemetry };
    }
  }

  // 3. TIME_STOP: holding > 15m and progressR < 0.30 (skipped if underlying unavailable)
  if (holdingMinutes > 15 && progressR !== null && progressR < 0.30) {
    return { shouldExit: true, exitReason: "TIME_STOP", telemetry };
  }

  // 4. PREMIUM_TOLERANCE: underlying move >= +15 bps but option premium drawdown >= 25%
  if (
    underlyingMoveBps !== null &&
    underlyingMoveBps >= 15 &&
    premiumDrawdownPct !== null &&
    premiumDrawdownPct >= 0.25
  ) {
    return { shouldExit: true, exitReason: "PREMIUM_TOLERANCE", telemetry };
  }

  // 5. TARGET_REACHED: option premium hits target
  if (input.currentOptionPrice >= input.effectivePremiumTarget) {
    return { shouldExit: true, exitReason: "TARGET_REACHED", telemetry };
  }

  return { shouldExit: false, exitReason: null, telemetry };
}
