import type { TradeSide } from "../../../strategy-engine/domain/strategy.js";
import {
  canonicalGeometryPolicyVersion,
  type MarketOpportunity,
  type ResearchGeometry,
} from "./contracts.js";

export const canonicalAtrAlgorithmVersion = "ta-v1";
export const canonicalAtrParameters = Object.freeze({ period: 14, smoothing: "WILDER" });

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive and finite.`);
}

function roundUp(value: number, tickSize: number): number {
  return Number((Math.ceil((value - Number.EPSILON) / tickSize) * tickSize).toFixed(10));
}

function roundDown(value: number, tickSize: number): number {
  return Number((Math.floor((value + Number.EPSILON) / tickSize) * tickSize).toFixed(10));
}

/** Frozen adverse tick directions: LONG entry/target up, stop down; SHORT is the inverse. */
export function roundCanonicalGeometry(input: {
  direction: TradeSide;
  entry: number;
  stop: number;
  target: number;
  tickSize: number;
}): Pick<ResearchGeometry, "entryPrice" | "stopLoss" | "targetPrice"> {
  requirePositive(input.tickSize, "tickSize");
  return input.direction === "LONG"
    ? {
        entryPrice: roundUp(input.entry, input.tickSize),
        stopLoss: roundDown(input.stop, input.tickSize),
        targetPrice: roundUp(input.target, input.tickSize),
      }
    : {
        entryPrice: roundDown(input.entry, input.tickSize),
        stopLoss: roundUp(input.stop, input.tickSize),
        targetPrice: roundDown(input.target, input.tickSize),
      };
}

export interface CanonicalGeometryResult {
  readonly geometry: ResearchGeometry;
  readonly terminalEligible: boolean;
  readonly terminalIneligibleReason: "SESSION_BOUNDARY" | null;
}

export function buildCanonicalGeometry(input: {
  opportunity: MarketOpportunity;
  atr: number;
  tickSize: number;
  sessionCloseAt: Date;
}): CanonicalGeometryResult {
  requirePositive(input.atr, "ATR");
  requirePositive(input.opportunity.referencePrice, "referencePrice");
  const direction = input.opportunity.direction;
  const rawStop = direction === "LONG"
    ? input.opportunity.referencePrice - input.atr
    : input.opportunity.referencePrice + input.atr;
  const rawTarget = direction === "LONG"
    ? input.opportunity.referencePrice + input.atr * 1.5
    : input.opportunity.referencePrice - input.atr * 1.5;
  const rounded = roundCanonicalGeometry({
    direction,
    entry: input.opportunity.referencePrice,
    stop: rawStop,
    target: rawTarget,
    tickSize: input.tickSize,
  });
  if (rounded.stopLoss <= 0 || rounded.targetPrice <= 0) {
    throw new Error("Canonical geometry produced a non-positive barrier.");
  }
  const expiresAt = new Date(input.opportunity.canonicalDecisionAt.getTime() + 60 * 60_000);
  const terminalEligible = expiresAt.getTime() <= input.sessionCloseAt.getTime();
  return {
    geometry: {
      direction,
      entryOrderType: "MARKET_AT_REFERENCE",
      ...rounded,
      expiresAt,
      geometryPolicyVersion: canonicalGeometryPolicyVersion,
    },
    terminalEligible,
    terminalIneligibleReason: terminalEligible ? null : "SESSION_BOUNDARY",
  };
}

export function horizonEligibility(decisionAt: Date, sessionCloseAt: Date, horizonMinutes: number): boolean {
  if (!Number.isInteger(horizonMinutes) || horizonMinutes <= 0) throw new Error("Horizon must be positive minutes.");
  return decisionAt.getTime() + horizonMinutes * 60_000 <= sessionCloseAt.getTime();
}
