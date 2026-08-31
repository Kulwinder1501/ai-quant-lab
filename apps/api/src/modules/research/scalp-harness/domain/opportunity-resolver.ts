import {
  groupingPolicyVersion,
  istSessionId,
  referencePolicyVersion,
  type ImmutableStrategyProposal,
  type MarketOpportunity,
} from "./contracts.js";
import { logicalKey, sha256CanonicalJson } from "../../../platform/identity/identity.js";

export interface PersistedProposal extends ImmutableStrategyProposal { readonly id: string }

/** Exact-time grouping only. No proposal score or geometry is read by this service. */
export function resolveOpportunities(proposals: readonly PersistedProposal[], sessionCloseAt: Date): MarketOpportunity[] {
  const groups = new Map<string, PersistedProposal[]>();
  for (const proposal of proposals) {
    const sessionId = istSessionId(proposal.decisionAt);
    const key = logicalKey("opportunity", [
      proposal.instrumentId,
      sessionId,
      proposal.direction,
      proposal.decisionAt,
      groupingPolicyVersion,
      referencePolicyVersion,
    ]);
    const members = groups.get(key) ?? [];
    members.push(proposal);
    groups.set(key, members);
  }

  return [...groups.entries()].map(([opportunityKey, unordered]) => {
    const members = [...unordered].sort((left, right) => left.id.localeCompare(right.id));
    const first = members[0]!;
    for (const member of members.slice(1)) {
      if (
        member.referenceCandleId !== first.referenceCandleId
        || member.referencePrice !== first.referencePrice
        || member.dataThrough.getTime() !== first.dataThrough.getTime()
      ) {
        throw new Error(`Opportunity ${opportunityKey} has inconsistent reference evidence.`);
      }
    }
    const payload = {
      opportunityKey,
      instrumentId: first.instrumentId,
      sessionId: istSessionId(first.decisionAt),
      sessionCloseAt,
      direction: first.direction,
      canonicalDecisionAt: first.decisionAt,
      dataThrough: first.dataThrough,
      referencePrice: first.referencePrice,
      referenceCandleId: first.referenceCandleId,
      proposalIds: members.map((member) => member.id),
      groupingPolicyVersion,
      referencePolicyVersion,
    };
    return { ...payload, payloadHash: sha256CanonicalJson(payload) };
  }).sort((left, right) => left.opportunityKey.localeCompare(right.opportunityKey));
}

export function opportunityMembershipKey(opportunityId: string, proposalId: string): string {
  return logicalKey("opportunity-membership", [opportunityId, proposalId]);
}
