import type { TradeSide } from "./strategy.js";

export type DxyTrend = "BULLISH" | "BEARISH" | "NEUTRAL";
export type DxyMomentum = "STRONG_UP" | "UP" | "FLAT" | "DOWN" | "STRONG_DOWN";
export type DxyStructure = "BOS_UP" | "BOS_DOWN" | "CHOCH_UP" | "CHOCH_DOWN" | "NONE";
export type DxyLocation = "AT_BULLISH_OB" | "AT_BEARISH_OB" | "AT_BULLISH_FVG" | "AT_BEARISH_FVG" | "OPEN_SPACE";
export type DxyBias = "BULLISH" | "BEARISH" | "NEUTRAL";

export type SmtState = "BULLISH_XAU_DXY" | "BEARISH_XAU_DXY" | "NONE_CONFIRMED";
export type DxyAlignment = "SUPPORTIVE" | "NEUTRAL" | "OPPOSING" | "FEATURE_UNAVAILABLE";
export type OutcomeStatus = "AVAILABLE" | "OUTCOME_UNAVAILABLE";

export interface ConfirmedSwing {
  type: "HIGH" | "LOW";
  price: number;
  swingAt: string;
  confirmedAt: string;
}

export interface Bar1m {
  openAt: string;
  closeAt: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DxyEvaluatorInputs {
  proposalSide: TradeSide;
  proposalTimeframe: "5m" | "15m";
  candidateAt: string;
  dataCutoff: string;
  decisionAt: string;

  dxyCandleAvailableAt?: string;
  dxyEma20?: { value: number; availableAt: string };
  dxyEma50?: { value: number; availableAt: string };
  dxyEma20Slope?: number;
  dxyRoc3?: { value: number; availableAt: string };
  dxyRoc5?: { value: number; availableAt: string };
  dxyStructure?: { event: DxyStructure; confirmedAt: string; eventId?: string };
  dxyLocation?: { location: DxyLocation; availableAt: string };

  xauCandleAvailableAt?: string;
  xauATR14?: { value: number; availableAt: string };
  dxyATR14?: { value: number; availableAt: string };

  xauSwings?: ConfirmedSwing[];
  dxySwings?: ConfirmedSwing[];

  xau1mBars?: Bar1m[];
}

export interface DxyIntermarketPayload {
  observationId: string;
  featureVersion: "DXY_INTERMARKET_V1";
  proposalTimeframe: "5m" | "15m";
  candidateAt: string;
  dataCutoff: string;
  decisionAt: string;
  entryAt?: string;
  exitTargetAt?: string;
  exitAt?: string;
  featureAvailableAt: string;
  dxy: {
    trend: DxyTrend;
    structure: DxyStructure;
    momentum: DxyMomentum;
    location: DxyLocation;
    bias: DxyBias;
  };
  smt: {
    state: SmtState;
    windowBars: number;
    xauMinDisplacement: number;
    dxyMinDisplacement: number;
    availableAt: string;
  };
  alignment: DxyAlignment;
  freshness: {
    featureAvailableAt: string;
    ageSeconds: number;
  };
  outcomes?: {
    researchEntryPrice: number;
    researchExitPrice: number;
    grossForwardOutcome15m: number;
    netForwardOutcome15m: number;
    outcomeStatus: OutcomeStatus;
  };
  gateMode: "SHADOW";
  dxyDecisionEffect: "OBSERVATIONAL_ONLY";
  goldStrategyDecision: "APPROVED";
}

const XAU_TICK_SIZE = 0.01;
const DXY_TICK_SIZE = 0.001;
const FRESHNESS_MAX_SECONDS = 300;

export function evaluateDxyBias(structure: DxyStructure, momentum: DxyMomentum): DxyBias {
  const isStructBullish = structure === "BOS_UP" || structure === "CHOCH_UP";
  const isStructBearish = structure === "BOS_DOWN" || structure === "CHOCH_DOWN";
  const isMomBullish = momentum === "UP" || momentum === "STRONG_UP";
  const isMomBearish = momentum === "DOWN" || momentum === "STRONG_DOWN";

  if (isStructBullish && isMomBullish) return "BULLISH";
  if (isStructBearish && isMomBearish) return "BEARISH";
  if (isStructBullish) return "BULLISH";
  if (isStructBearish) return "BEARISH";
  if (structure === "NONE" && momentum === "STRONG_UP") return "BULLISH";
  if (structure === "NONE" && momentum === "STRONG_DOWN") return "BEARISH";
  return "NEUTRAL";
}

export function evaluateDxyTrend(
  ema20?: number,
  ema50?: number,
  slope20?: number
): DxyTrend {
  if (ema20 === undefined || ema50 === undefined || slope20 === undefined) return "NEUTRAL";
  if (ema20 > ema50 && slope20 > 0) return "BULLISH";
  if (ema20 < ema50 && slope20 < 0) return "BEARISH";
  return "NEUTRAL";
}

export function evaluateDxyMomentum(roc3?: number, roc5?: number): DxyMomentum {
  if (roc3 === undefined) return "FLAT";
  if (roc3 > 0.0010 && (roc5 ?? 0) > 0.0015) return "STRONG_UP";
  if (roc3 > 0) return "UP";
  if (roc3 < -0.0010 && (roc5 ?? 0) < -0.0015) return "STRONG_DOWN";
  if (roc3 < 0) return "DOWN";
  return "FLAT";
}

export function evaluateSmtDivergence(
  xauSwings: ConfirmedSwing[],
  dxySwings: ConfirmedSwing[],
  dataCutoff: string,
  xauAtr: number,
  dxyAtr: number
): { state: SmtState; xauMinDisplacement: number; dxyMinDisplacement: number } {
  const xauMinDisplacement = Math.max(XAU_TICK_SIZE * 2, xauAtr * 0.05);
  const dxyMinDisplacement = Math.max(DXY_TICK_SIZE * 2, dxyAtr * 0.05);

  const cutoffTime = new Date(dataCutoff).getTime();

  // Filter PIT safe swings
  const safeXauLows = xauSwings
    .filter((s) => s.type === "LOW" && new Date(s.confirmedAt).getTime() <= cutoffTime)
    .sort((a, b) => new Date(a.swingAt).getTime() - new Date(b.swingAt).getTime());

  const safeXauHighs = xauSwings
    .filter((s) => s.type === "HIGH" && new Date(s.confirmedAt).getTime() <= cutoffTime)
    .sort((a, b) => new Date(a.swingAt).getTime() - new Date(b.swingAt).getTime());

  const safeDxyHighs = dxySwings
    .filter((s) => s.type === "HIGH" && new Date(s.confirmedAt).getTime() <= cutoffTime)
    .sort((a, b) => new Date(a.swingAt).getTime() - new Date(b.swingAt).getTime());

  const safeDxyLows = dxySwings
    .filter((s) => s.type === "LOW" && new Date(s.confirmedAt).getTime() <= cutoffTime)
    .sort((a, b) => new Date(a.swingAt).getTime() - new Date(b.swingAt).getTime());

  let isBullish = false;
  let bullishLatestXau: ConfirmedSwing | null = null;

  if (safeXauLows.length >= 2 && safeDxyHighs.length >= 1) {
    const referenceXau = safeXauLows[safeXauLows.length - 2];
    const latestXau = safeXauLows[safeXauLows.length - 1];
    bullishLatestXau = latestXau;

    const latestXauTime = new Date(latestXau.swingAt).getTime();
    const referenceXauTime = new Date(referenceXau.swingAt).getTime();

    // Pair latestXau with closest DXY High
    let latestDxyHigh: ConfirmedSwing | null = null;
    let minDiffLatest = Infinity;
    for (const dxyHigh of safeDxyHighs) {
      const diff = Math.abs(new Date(dxyHigh.swingAt).getTime() - latestXauTime);
      if (diff < minDiffLatest) {
        minDiffLatest = diff;
        latestDxyHigh = dxyHigh;
      }
    }

    if (latestDxyHigh) {
      // Pair referenceXau with closest DXY High prior to latestDxyHigh
      const latestDxyTime = new Date(latestDxyHigh.swingAt).getTime();
      const priorDxyHighs = safeDxyHighs.filter((s) => new Date(s.swingAt).getTime() < latestDxyTime);

      let referenceDxyHigh: ConfirmedSwing | null = null;
      let minDiffRef = Infinity;
      for (const dxyHigh of priorDxyHighs) {
        const diff = Math.abs(new Date(dxyHigh.swingAt).getTime() - referenceXauTime);
        if (diff < minDiffRef) {
          minDiffRef = diff;
          referenceDxyHigh = dxyHigh;
        }
      }

      if (referenceDxyHigh) {
        const deltaXauLow = latestXau.price - referenceXau.price;
        const deltaDxyHigh = latestDxyHigh.price - referenceDxyHigh.price;

        if (deltaXauLow <= -xauMinDisplacement && deltaDxyHigh < dxyMinDisplacement) {
          isBullish = true;
        }
      }
    }
  }

  let isBearish = false;
  let bearishLatestXau: ConfirmedSwing | null = null;

  if (safeXauHighs.length >= 2 && safeDxyLows.length >= 1) {
    const referenceXau = safeXauHighs[safeXauHighs.length - 2];
    const latestXau = safeXauHighs[safeXauHighs.length - 1];
    bearishLatestXau = latestXau;

    const latestXauTime = new Date(latestXau.swingAt).getTime();
    const referenceXauTime = new Date(referenceXau.swingAt).getTime();

    // Pair latestXau with closest DXY Low
    let latestDxyLow: ConfirmedSwing | null = null;
    let minDiffLatest = Infinity;
    for (const dxyLow of safeDxyLows) {
      const diff = Math.abs(new Date(dxyLow.swingAt).getTime() - latestXauTime);
      if (diff < minDiffLatest) {
        minDiffLatest = diff;
        latestDxyLow = dxyLow;
      }
    }

    if (latestDxyLow) {
      // Pair referenceXau with closest DXY Low prior to latestDxyLow
      const latestDxyTime = new Date(latestDxyLow.swingAt).getTime();
      const priorDxyLows = safeDxyLows.filter((s) => new Date(s.swingAt).getTime() < latestDxyTime);

      let referenceDxyLow: ConfirmedSwing | null = null;
      let minDiffRef = Infinity;
      for (const dxyLow of priorDxyLows) {
        const diff = Math.abs(new Date(dxyLow.swingAt).getTime() - referenceXauTime);
        if (diff < minDiffRef) {
          minDiffRef = diff;
          referenceDxyLow = dxyLow;
        }
      }

      if (referenceDxyLow) {
        const deltaXauHigh = latestXau.price - referenceXau.price;
        const deltaDxyLow = latestDxyLow.price - referenceDxyLow.price;

        if (deltaXauHigh >= xauMinDisplacement && deltaDxyLow > -dxyMinDisplacement) {
          isBearish = true;
        }
      }
    }
  }

  if (isBullish && !isBearish) return { state: "BULLISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };
  if (isBearish && !isBullish) return { state: "BEARISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };
  if (!isBullish && !isBearish) return { state: "NONE_CONFIRMED", xauMinDisplacement, dxyMinDisplacement };

  // Tie breaker if both hold
  if (bullishLatestXau && bearishLatestXau) {
    const bullConf = new Date(bullishLatestXau.confirmedAt).getTime();
    const bearConf = new Date(bearishLatestXau.confirmedAt).getTime();
    if (bullConf > bearConf) return { state: "BULLISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };
    if (bearConf > bullConf) return { state: "BEARISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };

    const bullSwing = new Date(bullishLatestXau.swingAt).getTime();
    const bearSwing = new Date(bearishLatestXau.swingAt).getTime();
    if (bullSwing > bearSwing) return { state: "BULLISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };
    if (bearSwing > bullSwing) return { state: "BEARISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };
  }

  return { state: "BULLISH_XAU_DXY", xauMinDisplacement, dxyMinDisplacement };
}

export function evaluateAlignment(
  side: TradeSide,
  dxyBias: DxyBias,
  smtState: SmtState
): DxyAlignment {
  let score = 0;

  if (side === "LONG") {
    if (dxyBias === "BEARISH") score += 1;
    if (dxyBias === "BULLISH") score -= 1;
    if (smtState === "BULLISH_XAU_DXY") score += 1;
    if (smtState === "BEARISH_XAU_DXY") score -= 1;
  } else {
    if (dxyBias === "BULLISH") score += 1;
    if (dxyBias === "BEARISH") score -= 1;
    if (smtState === "BEARISH_XAU_DXY") score += 1;
    if (smtState === "BULLISH_XAU_DXY") score -= 1;
  }

  if (score >= 1) return "SUPPORTIVE";
  if (score === 0) return "NEUTRAL";
  return "OPPOSING";
}

export class DxyIntermarketEvaluator {
  public evaluate(inputs: DxyEvaluatorInputs): DxyIntermarketPayload {
    const candidateMs = new Date(inputs.candidateAt).getTime();
    const cutoffMs = new Date(inputs.dataCutoff).getTime();
    const decisionMs = new Date(inputs.decisionAt).getTime();

    // Timestamp Hierarchy Invariant
    if (candidateMs > cutoffMs || cutoffMs > decisionMs) {
      throw new Error(
        `PIT Timestamp Hierarchy Violation: candidateAt (${inputs.candidateAt}) <= dataCutoff (${inputs.dataCutoff}) <= decisionAt (${inputs.decisionAt}) required.`
      );
    }

    // Collect timestamps for featureAvailableAt calculation
    const timestamps: number[] = [];

    const checkAvailable = (isoStr?: string) => {
      if (!isoStr) return false;
      const ms = new Date(isoStr).getTime();
      if (ms > cutoffMs) return false; // Future data violation
      timestamps.push(ms);
      return true;
    };

    const hasDxyCandle = checkAvailable(inputs.dxyCandleAvailableAt);
    const hasDxyEma20 = checkAvailable(inputs.dxyEma20?.availableAt);
    const hasDxyEma50 = checkAvailable(inputs.dxyEma50?.availableAt);
    const hasDxyRoc3 = checkAvailable(inputs.dxyRoc3?.availableAt);
    const hasDxyRoc5 = checkAvailable(inputs.dxyRoc5?.availableAt);
    const hasDxyStruct = checkAvailable(inputs.dxyStructure?.confirmedAt);
    const hasDxyLoc = checkAvailable(inputs.dxyLocation?.availableAt);

    const hasXauCandle = checkAvailable(inputs.xauCandleAvailableAt);
    const hasXauAtr = checkAvailable(inputs.xauATR14?.availableAt);
    const hasDxyAtr = checkAvailable(inputs.dxyATR14?.availableAt);

    // Swings
    const pitXauSwings = (inputs.xauSwings ?? []).filter((s) => checkAvailable(s.confirmedAt));
    const pitDxySwings = (inputs.dxySwings ?? []).filter((s) => checkAvailable(s.confirmedAt));

    const isComplete =
      hasDxyCandle &&
      hasDxyEma20 &&
      hasDxyEma50 &&
      hasDxyRoc3 &&
      hasDxyRoc5 &&
      hasDxyStruct &&
      hasDxyLoc &&
      hasXauCandle &&
      hasXauAtr &&
      hasDxyAtr;

    let featureAvailableAt = cutoffMs > 0 ? inputs.dataCutoff : inputs.candidateAt;
    if (timestamps.length > 0) {
      const maxMs = Math.max(...timestamps);
      featureAvailableAt = new Date(maxMs).toISOString();
    }

    const featureAvailableMs = new Date(featureAvailableAt).getTime();
    const ageSeconds = Math.max(0, Math.floor((cutoffMs - featureAvailableMs) / 1000));

    const isFresh = ageSeconds <= FRESHNESS_MAX_SECONDS;

    const dxyTrend = evaluateDxyTrend(
      inputs.dxyEma20?.value,
      inputs.dxyEma50?.value,
      inputs.dxyEma20Slope
    );
    const dxyMomentum = evaluateDxyMomentum(inputs.dxyRoc3?.value, inputs.dxyRoc5?.value);
    const dxyStructure = inputs.dxyStructure?.event ?? "NONE";
    const dxyLocation = inputs.dxyLocation?.location ?? "OPEN_SPACE";
    const dxyBias = evaluateDxyBias(dxyStructure, dxyMomentum);

    const smtResult = evaluateSmtDivergence(
      pitXauSwings,
      pitDxySwings,
      inputs.dataCutoff,
      inputs.xauATR14?.value ?? 1.5,
      inputs.dxyATR14?.value ?? 0.05
    );

    let alignment: DxyAlignment;
    if (!isComplete || !isFresh) {
      alignment = "FEATURE_UNAVAILABLE";
    } else {
      alignment = evaluateAlignment(inputs.proposalSide, dxyBias, smtResult.state);
    }

    // Compute counterfactual outcomes if 1m bars provided
    let outcomes: DxyIntermarketPayload["outcomes"] | undefined = undefined;
    let entryAtIso: string | undefined = undefined;
    let exitTargetAtIso: string | undefined = undefined;
    let exitAtIso: string | undefined = undefined;

    if (inputs.xau1mBars && inputs.xau1mBars.length > 0) {
      const barsSorted = [...inputs.xau1mBars].sort(
        (a, b) => new Date(a.openAt).getTime() - new Date(b.openAt).getTime()
      );

      const entryBar = barsSorted.find((b) => new Date(b.openAt).getTime() >= decisionMs);
      if (entryBar) {
        entryAtIso = entryBar.openAt;
        const entryAtMs = new Date(entryBar.openAt).getTime();
        const exitTargetMs = entryAtMs + 15 * 60 * 1000;
        exitTargetAtIso = new Date(exitTargetMs).toISOString();

        const exitBar = barsSorted.find((b) => new Date(b.closeAt).getTime() >= exitTargetMs);
        if (exitBar) {
          exitAtIso = exitBar.closeAt;
          const researchEntryPrice = entryBar.open;
          const researchExitPrice = exitBar.close;
          const direction = inputs.proposalSide === "LONG" ? 1 : -1;
          const grossForwardOutcome15m = direction * (researchExitPrice - researchEntryPrice);
          const netForwardOutcome15m = grossForwardOutcome15m - 0.20;

          outcomes = {
            researchEntryPrice,
            researchExitPrice,
            grossForwardOutcome15m: Number(grossForwardOutcome15m.toFixed(4)),
            netForwardOutcome15m: Number(netForwardOutcome15m.toFixed(4)),
            outcomeStatus: "AVAILABLE",
          };
        } else {
          outcomes = {
            researchEntryPrice: entryBar.open,
            researchExitPrice: 0,
            grossForwardOutcome15m: 0,
            netForwardOutcome15m: 0,
            outcomeStatus: "OUTCOME_UNAVAILABLE",
          };
        }
      }
    }

    const obsId = `obs-xau-dxy-${inputs.candidateAt.replace(/[:.-]/g, "").slice(0, 15)}`;

    return {
      observationId: obsId,
      featureVersion: "DXY_INTERMARKET_V1",
      proposalTimeframe: inputs.proposalTimeframe,
      candidateAt: inputs.candidateAt,
      dataCutoff: inputs.dataCutoff,
      decisionAt: inputs.decisionAt,
      entryAt: entryAtIso,
      exitTargetAt: exitTargetAtIso,
      exitAt: exitAtIso,
      featureAvailableAt,
      dxy: {
        trend: dxyTrend,
        structure: dxyStructure,
        momentum: dxyMomentum,
        location: dxyLocation,
        bias: dxyBias,
      },
      smt: {
        state: smtResult.state,
        windowBars: 5,
        xauMinDisplacement: Number(smtResult.xauMinDisplacement.toFixed(4)),
        dxyMinDisplacement: Number(smtResult.dxyMinDisplacement.toFixed(4)),
        availableAt: featureAvailableAt,
      },
      alignment,
      freshness: {
        featureAvailableAt,
        ageSeconds,
      },
      outcomes,
      gateMode: "SHADOW",
      dxyDecisionEffect: "OBSERVATIONAL_ONLY",
      goldStrategyDecision: "APPROVED",
    };
  }
}
