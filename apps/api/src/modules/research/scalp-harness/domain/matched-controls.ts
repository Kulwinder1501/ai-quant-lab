import {
  matchingPolicyVersion,
  type MarketOpportunity,
  type ResearchControlPoint,
} from "./contracts.js";
import { logicalKey } from "../../../platform/identity/identity.js";

export const matchedControlCount = 5;
export const matchedControlMinuteCaliper = 15;

export interface ControlMatchResult {
  readonly opportunityId: string;
  readonly commonSupport: boolean;
  readonly reason: "MATCHED" | "INSUFFICIENT_COMMON_SUPPORT";
  readonly candidatesInsideCaliper: number;
  readonly controlIds: readonly string[];
  readonly equalWeight: number | null;
}

/**
 * Outcome-blind matching. Deterministic hash ordering replaces an implementation-specific PRNG.
 * The caller supplies treated decision keys only; no settlement/outcome object is accepted.
 */
export function matchControls(input: {
  opportunity: MarketOpportunity & { readonly id: string };
  selectedVolatilityRegime: string | null;
  controls: readonly (ResearchControlPoint & { readonly id: string })[];
  treatedDecisionKeys: ReadonlySet<string>;
}): ControlMatchResult {
  const minute = (value: Date): number => Math.floor(value.getTime() / 60_000);
  const treatedMinute = minute(input.opportunity.canonicalDecisionAt);
  const seed = logicalKey("control-seed", [input.opportunity.opportunityKey, matchingPolicyVersion]);
  const eligible = input.controls.filter((control) => (
    control.sampleEligible
    && control.instrumentId === input.opportunity.instrumentId
    && control.sessionId === input.opportunity.sessionId
    && control.evaluationDirection === input.opportunity.direction
    && control.volatilityRegime === input.selectedVolatilityRegime
    && Math.abs(minute(control.decisionAt) - treatedMinute) <= matchedControlMinuteCaliper
    && !input.treatedDecisionKeys.has(`${control.instrumentId}|${control.evaluationDirection}|${control.decisionAt.toISOString()}`)
  ));
  const selected = eligible
    .map((control) => ({ control, rank: logicalKey("control-rank", [seed, control.controlPointKey]) }))
    .sort((left, right) => left.rank.localeCompare(right.rank))
    .slice(0, matchedControlCount)
    .map(({ control }) => control.id);
  const commonSupport = selected.length === matchedControlCount;
  return {
    opportunityId: input.opportunity.id,
    commonSupport,
    reason: commonSupport ? "MATCHED" : "INSUFFICIENT_COMMON_SUPPORT",
    candidatesInsideCaliper: eligible.length,
    controlIds: commonSupport ? selected : [],
    equalWeight: commonSupport ? 1 / matchedControlCount : null,
  };
}

export function controlMatchKey(opportunityId: string, controlPointId: string): string {
  return logicalKey("control-match", [opportunityId, controlPointId, matchingPolicyVersion]);
}
