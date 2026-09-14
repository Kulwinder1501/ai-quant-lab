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
  readonly reason: "MATCHED" | "INSUFFICIENT_COMMON_SUPPORT" | "MIXED_CONTROL_POLICY_VERSION";
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
  /*
   * Population homogeneity (D4).
   *
   * `controlPolicyVersion` was persisted on every control point and enforced by nothing. Each version
   * widened what `sampleEligible` asserts -- V1 read "canonical ATR exists", V2 "every consumed 1m
   * indicator plus both feature layers", V3 adds "and the tape was moving" -- so a matched set drawn
   * across a boundary compares points admitted under different rules, and the baseline it forms is not
   * one population.
   *
   * Refusing rather than choosing. The matcher has no basis for preferring one version, and silently
   * picking the larger group would produce a baseline nobody selected -- exactly the kind of quiet
   * decision `controlPolicyVersion` exists to make visible.
   *
   * Measured before adding it: no session mixes versions (V1 is 2026-08-24 alone, V2 every session
   * after), and matching is within-session, so **0 of 1,822 stored matched sets are mixed**. This is a
   * proven no-op on every population that exists. What it guards is the case that has not happened yet:
   * a version bump deploying mid-session, which is precisely when the boundary would fall inside a
   * session and go unnoticed.
   */
  const eligible = input.controls.filter((control) => (
    control.sampleEligible
    && control.instrumentId === input.opportunity.instrumentId
    && control.sessionId === input.opportunity.sessionId
    && control.evaluationDirection === input.opportunity.direction
    && control.volatilityRegime === input.selectedVolatilityRegime
    && Math.abs(minute(control.decisionAt) - treatedMinute) <= matchedControlMinuteCaliper
    && !input.treatedDecisionKeys.has(`${control.instrumentId}|${control.evaluationDirection}|${control.decisionAt.toISOString()}`)
  ));
  const versionsPresent = [...new Set(eligible.map((control) => control.controlPolicyVersion))];
  if (versionsPresent.length > 1) {
    return {
      opportunityId: input.opportunity.id,
      commonSupport: false,
      reason: "MIXED_CONTROL_POLICY_VERSION",
      candidatesInsideCaliper: eligible.length,
      controlIds: [],
      equalWeight: null,
    };
  }

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
