import {
  fillPolicyVersion,
  observationHorizonsMinutes,
  resolveSettlementPolicy,
  settlementPolicyVersion,
  type FillCondition,
  type ObservationHorizonMinutes,
  type ResearchGeometry,
  type ResearchPriceCandle,
  type ResearchSettlementObservation,
  type ResearchSubjectType,
  type ResearchTerminalSettlement,
  type TerminalOutcome,
} from "./contracts.js";
import { logicalKey, sha256Canonical } from "../../../platform/identity/identity.js";
import { horizonEligibility } from "./policies.js";

/**
 * Binds every row this module writes to the frozen component set behind `settlementPolicyVersion`.
 *
 * Resolved once at module load, so an unregistered settlement version fails immediately rather than at
 * the first settled subject. See `settlementPolicyRegistry` for why this is persisted alongside the
 * version instead of being folded into the identity key.
 */
const settlementDefinitionHash = resolveSettlementPolicy(settlementPolicyVersion).definitionHash;

interface WalkTerminal {
  readonly outcome: TerminalOutcome;
  readonly reason: string;
  readonly fillCondition: FillCondition;
  readonly resolvedAt: Date;
  readonly exitFillPrice: number | null;
}

interface WalkResult {
  readonly complete: boolean;
  readonly barsObserved: number;
  readonly entryTriggeredAt: Date | null;
  readonly entryFillPrice: number | null;
  readonly entryFillCondition: FillCondition;
  readonly firstTargetTouchAt: Date | null;
  readonly firstStopTouchAt: Date | null;
  readonly targetTouched: boolean;
  readonly stopTouched: boolean;
  readonly mfeBps: number | null;
  readonly maeBps: number | null;
  readonly terminal: WalkTerminal | null;
}

function validGeometry(geometry: ResearchGeometry): boolean {
  const prices = [geometry.entryPrice, geometry.stopLoss, geometry.targetPrice];
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) return false;
  if (Number.isNaN(geometry.expiresAt.getTime())) return false;
  return geometry.direction === "LONG"
    ? geometry.stopLoss < geometry.entryPrice && geometry.entryPrice < geometry.targetPrice
    : geometry.targetPrice < geometry.entryPrice && geometry.entryPrice < geometry.stopLoss;
}

function assertCandle(candle: ResearchPriceCandle): void {
  const values = [candle.open, candle.high, candle.low, candle.close];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("Settlement candle prices must be positive.");
  if (candle.closeTime.getTime() <= candle.openTime.getTime()) throw new Error("Settlement candle close must follow open.");
  if (candle.high < Math.max(candle.open, candle.close, candle.low) || candle.low > Math.min(candle.open, candle.close)) {
    throw new Error("Settlement candle OHLC geometry is invalid.");
  }
}

function returnBps(direction: ResearchGeometry["direction"], entry: number, exit: number): number {
  const signed = direction === "LONG" ? exit - entry : entry - exit;
  return Number((signed / entry * 10_000).toFixed(6));
}

function walkPath(input: {
  geometry: ResearchGeometry;
  decisionAt: Date;
  endAt: Date;
  forwardCandles: readonly ResearchPriceCandle[];
  terminalAtEnd: boolean;
}): WalkResult {
  const expectedBars = Math.round((input.endAt.getTime() - input.decisionAt.getTime()) / 60_000);
  const byClose = new Map<number, ResearchPriceCandle>();
  for (const candle of input.forwardCandles) {
    assertCandle(candle);
    if (candle.closeTime > input.decisionAt && candle.closeTime <= input.endAt) {
      if (byClose.has(candle.closeTime.getTime())) throw new Error("Duplicate 1m settlement candle close time.");
      byClose.set(candle.closeTime.getTime(), candle);
    }
  }

  let active = input.geometry.entryOrderType === "MARKET_AT_REFERENCE";
  let entryTriggeredAt: Date | null = active ? input.decisionAt : null;
  let entryFillPrice: number | null = active ? input.geometry.entryPrice : null;
  let entryFillCondition: FillCondition = active ? "AT_REFERENCE" : "NONE";
  let firstTargetTouchAt: Date | null = null;
  let firstStopTouchAt: Date | null = null;
  let targetTouched = false;
  let stopTouched = false;
  let maximumFavourable = 0;
  let maximumAdverse = 0;
  let barsObserved = 0;

  const terminal = (
    outcome: TerminalOutcome,
    reason: string,
    fillCondition: FillCondition,
    resolvedAt: Date,
    exitFillPrice: number | null,
  ): WalkResult => ({
    complete: outcome !== "DATA_INCOMPLETE",
    barsObserved,
    entryTriggeredAt,
    entryFillPrice,
    entryFillCondition,
    firstTargetTouchAt,
    firstStopTouchAt,
    targetTouched,
    stopTouched,
    mfeBps: entryFillPrice === null ? null : Number((maximumFavourable / entryFillPrice * 10_000).toFixed(6)),
    maeBps: entryFillPrice === null ? null : Number((maximumAdverse / entryFillPrice * 10_000).toFixed(6)),
    terminal: { outcome, reason, fillCondition, resolvedAt, exitFillPrice },
  });

  for (let bar = 1; bar <= expectedBars; bar += 1) {
    const expectedClose = input.decisionAt.getTime() + bar * 60_000;
    const candle = byClose.get(expectedClose);
    if (!candle) {
      return terminal("DATA_INCOMPLETE", "MISSING_1M_CANDLE", "NONE", new Date(expectedClose), null);
    }
    barsObserved += 1;
    let entryTriggeredThisCandle = false;
    let entryAtOpen = false;

    if (!active) {
      const isLong = input.geometry.direction === "LONG";
      const isLimit = input.geometry.entryOrderType === "LIMIT";
      const gapTriggered = isLimit
        ? (isLong ? candle.open <= input.geometry.entryPrice : candle.open >= input.geometry.entryPrice)
        : (isLong ? candle.open >= input.geometry.entryPrice : candle.open <= input.geometry.entryPrice);
      const rangeTriggered = candle.low <= input.geometry.entryPrice && candle.high >= input.geometry.entryPrice;
      if (!gapTriggered && !rangeTriggered) continue;
      active = true;
      entryTriggeredThisCandle = true;
      entryAtOpen = gapTriggered;
      entryTriggeredAt = gapTriggered ? candle.openTime : candle.closeTime;
      entryFillPrice = gapTriggered ? candle.open : input.geometry.entryPrice;
      entryFillCondition = gapTriggered
        ? (isLimit ? "GAP_THROUGH_LIMIT_ENTRY" : "GAP_THROUGH_STOP_ENTRY")
        : "AT_LEVEL";
    }

    const isLong = input.geometry.direction === "LONG";
    const stopGap = isLong ? candle.open <= input.geometry.stopLoss : candle.open >= input.geometry.stopLoss;
    const targetGap = isLong ? candle.open >= input.geometry.targetPrice : candle.open <= input.geometry.targetPrice;

    if (!entryTriggeredThisCandle || entryAtOpen) {
      if (stopGap) {
        stopTouched = true;
        firstStopTouchAt ??= candle.openTime;
        const entry = entryFillPrice!;
        maximumAdverse = Math.max(maximumAdverse, isLong ? entry - candle.open : candle.open - entry, 0);
        return terminal("STOP", "GAP_THROUGH_STOP", "GAP_THROUGH_STOP", candle.openTime, candle.open);
      }
      if (targetGap) {
        targetTouched = true;
        firstTargetTouchAt ??= candle.openTime;
        const entry = entryFillPrice!;
        maximumFavourable = Math.max(
          maximumFavourable,
          isLong ? input.geometry.targetPrice - entry : entry - input.geometry.targetPrice,
          0,
        );
        return terminal("TARGET", "GAP_THROUGH_TARGET", "GAP_THROUGH_TARGET", candle.openTime, input.geometry.targetPrice);
      }
    }

    const stopInRange = isLong ? candle.low <= input.geometry.stopLoss : candle.high >= input.geometry.stopLoss;
    const targetInRange = isLong ? candle.high >= input.geometry.targetPrice : candle.low <= input.geometry.targetPrice;
    if (stopInRange) {
      stopTouched = true;
      firstStopTouchAt ??= candle.closeTime;
    }
    if (targetInRange) {
      targetTouched = true;
      firstTargetTouchAt ??= candle.closeTime;
    }

    if (entryTriggeredThisCandle && (stopInRange || targetInRange)) {
      return terminal(
        "AMBIGUOUS",
        stopInRange && targetInRange ? "ENTRY_STOP_TARGET_INTRABAR_ORDER_UNKNOWN" : "ENTRY_BARRIER_INTRABAR_ORDER_UNKNOWN",
        "AT_LEVEL",
        candle.closeTime,
        null,
      );
    }
    if (stopInRange && targetInRange) {
      if (!entryTriggeredThisCandle || entryAtOpen) {
        const entry = entryFillPrice!;
        maximumFavourable = Math.max(maximumFavourable, isLong ? candle.high - entry : entry - candle.low, 0);
        maximumAdverse = Math.max(maximumAdverse, isLong ? entry - candle.low : candle.high - entry, 0);
      }
      return terminal("AMBIGUOUS", "STOP_TARGET_INTRABAR_ORDER_UNKNOWN", "AT_LEVEL", candle.closeTime, null);
    }
    if (stopInRange) {
      const entry = entryFillPrice!;
      maximumAdverse = Math.max(maximumAdverse, Math.abs(entry - input.geometry.stopLoss));
      return terminal("STOP", "STOP_TOUCHED", "AT_LEVEL", candle.closeTime, input.geometry.stopLoss);
    }
    if (targetInRange) {
      const entry = entryFillPrice!;
      maximumFavourable = Math.max(maximumFavourable, Math.abs(input.geometry.targetPrice - entry));
      return terminal("TARGET", "TARGET_TOUCHED", "AT_LEVEL", candle.closeTime, input.geometry.targetPrice);
    }

    // For an intrabar entry, that candle's extremes may have occurred before entry. Start excursions
    // on the next candle; a gap entry is active from the open and is safe to measure immediately.
    if (!entryTriggeredThisCandle || entryAtOpen) {
      const entry = entryFillPrice!;
      maximumFavourable = Math.max(maximumFavourable, isLong ? candle.high - entry : entry - candle.low, 0);
      maximumAdverse = Math.max(maximumAdverse, isLong ? entry - candle.low : candle.high - entry, 0);
    }
  }

  if (input.terminalAtEnd) {
    if (!active) return terminal("ENTRY_NOT_TRIGGERED", "ENTRY_EXPIRED", "NONE", input.endAt, null);
    const last = byClose.get(input.endAt.getTime());
    if (!last) return terminal("DATA_INCOMPLETE", "MISSING_TIMEOUT_CANDLE", "NONE", input.endAt, null);
    return terminal("TIMEOUT", "MAX_HOLD_REACHED", "TIMEOUT_CLOSE", input.endAt, last.close);
  }
  return {
    complete: true,
    barsObserved,
    entryTriggeredAt,
    entryFillPrice,
    entryFillCondition,
    firstTargetTouchAt,
    firstStopTouchAt,
    targetTouched,
    stopTouched,
    mfeBps: entryFillPrice === null ? null : Number((maximumFavourable / entryFillPrice * 10_000).toFixed(6)),
    maeBps: entryFillPrice === null ? null : Number((maximumAdverse / entryFillPrice * 10_000).toFixed(6)),
    terminal: null,
  };
}

function observation(input: {
  subjectType: ResearchSubjectType;
  subjectId: string;
  geometry: ResearchGeometry;
  horizonMinutes: ObservationHorizonMinutes;
  decisionAt: Date;
  sessionCloseAt: Date;
  forwardCandles: readonly ResearchPriceCandle[];
}): ResearchSettlementObservation {
  const horizonEndAt = new Date(input.decisionAt.getTime() + input.horizonMinutes * 60_000);
  const eligible = horizonEligibility(input.decisionAt, input.sessionCloseAt, input.horizonMinutes);
  const base = {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    horizonMinutes: input.horizonMinutes,
    horizonEndAt,
    horizonEligible: eligible,
    barsExpected: input.horizonMinutes,
    geometryPolicyVersion: input.geometry.geometryPolicyVersion,
    fillPolicyVersion,
    settlementPolicyVersion,
    settlementDefinitionHash,
  };
  const values = eligible
    ? (() => {
        const walked = walkPath({
          geometry: input.geometry,
          decisionAt: input.decisionAt,
          endAt: horizonEndAt,
          forwardCandles: input.forwardCandles,
          terminalAtEnd: false,
        });
        const complete = walked.terminal?.outcome !== "DATA_INCOMPLETE";
        return {
          status: complete ? "ELIGIBLE_COMPLETE" as const : "ELIGIBLE_DATA_INCOMPLETE" as const,
          statusReason: complete ? null : walked.terminal?.reason ?? "DATA_INCOMPLETE",
          mfeBps: complete ? walked.mfeBps : null,
          maeBps: complete ? walked.maeBps : null,
          targetTouchedByHorizon: complete ? walked.targetTouched : null,
          stopTouchedByHorizon: complete ? walked.stopTouched : null,
          entryTriggeredAt: complete ? walked.entryTriggeredAt : null,
          firstTargetTouchAt: complete ? walked.firstTargetTouchAt : null,
          firstStopTouchAt: complete ? walked.firstStopTouchAt : null,
          barsObserved: walked.barsObserved,
        };
      })()
    : {
        status: "INELIGIBLE_SESSION_BOUNDARY" as const,
        statusReason: "SESSION_BOUNDARY",
        mfeBps: null,
        maeBps: null,
        targetTouchedByHorizon: null,
        stopTouchedByHorizon: null,
        entryTriggeredAt: null,
        firstTargetTouchAt: null,
        firstStopTouchAt: null,
        barsObserved: 0,
      };
  const observationKey = logicalKey("settlement-observation", [
    input.subjectType, input.subjectId, settlementPolicyVersion, input.horizonMinutes,
  ]);
  const payload = { observationKey, ...base, ...values };
  return { ...payload, payloadHash: sha256Canonical(payload) };
}

export function settleResearchPath(input: {
  subjectType: ResearchSubjectType;
  subjectId: string;
  geometry: ResearchGeometry;
  decisionAt: Date;
  sessionCloseAt: Date;
  forwardCandles: readonly ResearchPriceCandle[];
}): {
  observations: ResearchSettlementObservation[];
  terminal: ResearchTerminalSettlement | null;
} {
  const geometryIsValid = validGeometry(input.geometry);
  const observations = geometryIsValid
    ? observationHorizonsMinutes.map((horizonMinutes) => observation({ ...input, horizonMinutes }))
    : observationHorizonsMinutes.map((horizonMinutes): ResearchSettlementObservation => {
        const horizonEndAt = new Date(input.decisionAt.getTime() + horizonMinutes * 60_000);
        const eligible = horizonEligibility(input.decisionAt, input.sessionCloseAt, horizonMinutes);
        const observationKey = logicalKey("settlement-observation", [
          input.subjectType, input.subjectId, settlementPolicyVersion, horizonMinutes,
        ]);
        const payload = {
          observationKey,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          horizonMinutes,
          horizonEndAt,
          horizonEligible: eligible,
          status: eligible ? "ELIGIBLE_DATA_INCOMPLETE" as const : "INELIGIBLE_SESSION_BOUNDARY" as const,
          statusReason: eligible ? "POLICY_INVALID" : "SESSION_BOUNDARY",
          mfeBps: null,
          maeBps: null,
          targetTouchedByHorizon: null,
          stopTouchedByHorizon: null,
          entryTriggeredAt: null,
          firstTargetTouchAt: null,
          firstStopTouchAt: null,
          barsExpected: horizonMinutes,
          barsObserved: 0,
          geometryPolicyVersion: input.geometry.geometryPolicyVersion,
          fillPolicyVersion,
          settlementPolicyVersion,
          settlementDefinitionHash,
        };
        return { ...payload, payloadHash: sha256Canonical(payload) };
      });
  if (!geometryIsValid) {
    const terminalSettlementKey = logicalKey("terminal-settlement", [
      input.subjectType, input.subjectId, settlementPolicyVersion,
    ]);
    const payload = {
      terminalSettlementKey,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      outcome: "POLICY_INVALID" as const,
      outcomeReason: "INVALID_GEOMETRY",
      entryFillCondition: "NONE" as const,
      exitFillCondition: "NONE" as const,
      entryTriggeredAt: null,
      resolvedAt: input.decisionAt,
      entryFillPrice: null,
      exitFillPrice: null,
      returnBps: null,
      rMultiple: null,
      geometryPolicyVersion: input.geometry.geometryPolicyVersion,
      fillPolicyVersion,
      settlementPolicyVersion,
      settlementDefinitionHash,
    };
    return { observations, terminal: { ...payload, payloadHash: sha256Canonical(payload) } };
  }
  if (input.geometry.expiresAt.getTime() > input.sessionCloseAt.getTime()) {
    return { observations, terminal: null };
  }
  const walked = walkPath({
    geometry: input.geometry,
    decisionAt: input.decisionAt,
    endAt: input.geometry.expiresAt,
    forwardCandles: input.forwardCandles,
    terminalAtEnd: true,
  });
  const result = walked.terminal;
  if (!result) throw new Error("A terminal-eligible settlement did not produce a terminal outcome.");
  const entry = walked.entryFillPrice;
  const exit = result.exitFillPrice;
  const plannedRisk = Math.abs(input.geometry.entryPrice - input.geometry.stopLoss);
  const bps = entry !== null && exit !== null ? returnBps(input.geometry.direction, entry, exit) : null;
  const signedMove = entry !== null && exit !== null
    ? (input.geometry.direction === "LONG" ? exit - entry : entry - exit)
    : null;
  const terminalSettlementKey = logicalKey("terminal-settlement", [
    input.subjectType, input.subjectId, settlementPolicyVersion,
  ]);
  const payload = {
    terminalSettlementKey,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    outcome: result.outcome,
    outcomeReason: result.reason,
    entryFillCondition: walked.entryFillCondition,
    exitFillCondition: result.fillCondition,
    entryTriggeredAt: walked.entryTriggeredAt,
    resolvedAt: result.resolvedAt,
    entryFillPrice: entry,
    exitFillPrice: exit,
    returnBps: bps,
    rMultiple: signedMove === null ? null : Number((signedMove / plannedRisk).toFixed(6)),
    geometryPolicyVersion: input.geometry.geometryPolicyVersion,
    fillPolicyVersion,
    settlementPolicyVersion,
    settlementDefinitionHash,
  };
  return { observations, terminal: { ...payload, payloadHash: sha256Canonical(payload) } };
}

/** Primary scalar for Signal Edge. Ambiguous and engineering outcomes stay outside the estimate. */
export function canonicalOutcomeR(settlement: ResearchTerminalSettlement): number | null {
  if (["AMBIGUOUS", "DATA_INCOMPLETE", "POLICY_INVALID", "ENTRY_NOT_TRIGGERED"].includes(settlement.outcome)) {
    return null;
  }
  return settlement.rMultiple;
}

/** Intent-to-trade assigns a non-triggered native order zero; conditional-on-entry excludes it. */
export function nativeOutcomeR(
  settlement: ResearchTerminalSettlement,
  estimand: "INTENT_TO_TRADE" | "CONDITIONAL_ON_ENTRY",
): number | null {
  if (settlement.outcome === "ENTRY_NOT_TRIGGERED") return estimand === "INTENT_TO_TRADE" ? 0 : null;
  return canonicalOutcomeR(settlement);
}
