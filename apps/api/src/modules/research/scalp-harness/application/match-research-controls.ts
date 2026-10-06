import type { MarketOpportunity, ResearchControlPoint } from "../domain/contracts.js";
import { matchingPolicyVersion } from "../domain/contracts.js";
import { matchControls } from "../domain/matched-controls.js";

interface MatchableOpportunity extends MarketOpportunity { readonly id: string; readonly volatilityRegime: string | null }

export interface ControlMatchReadPort {
  listUnmatchedOpportunities(limit: number): Promise<MatchableOpportunity[]>;
  listControlsForOpportunity(input: {
    instrumentId: string;
    sessionId: string;
    direction: "LONG" | "SHORT";
    decisionAt: Date;
  }): Promise<Array<ResearchControlPoint & { id: string }>>;
  listTreatedDecisionKeys(sessionId: string): Promise<Set<string>>;
}

export interface ControlMatchWritePort {
  saveControlMatches(input: { opportunityId: string; controlPointIds: readonly string[]; equalWeight: number }): Promise<void>;
  appendEvent(input: {
    entityId: string;
    eventType: string;
    policyVersion: string;
    logicalEventAt: Date;
    causationId: string;
    payload: Record<string, unknown>;
  }): Promise<string>;
}

export class MatchScalpResearchControls {
  constructor(private readonly reads: ControlMatchReadPort, private readonly writes: ControlMatchWritePort) {}

  async execute(input: { asOf: Date; limit: number }): Promise<{ matched: number; commonSupportFailures: number; deferred: number }> {
    let matched = 0;
    let commonSupportFailures = 0;
    let deferred = 0;
    for (const opportunity of await this.reads.listUnmatchedOpportunities(input.limit)) {
      const matchingWindowEnd = new Date(Math.min(
        opportunity.canonicalDecisionAt.getTime() + 15 * 60_000,
        opportunity.sessionCloseAt.getTime(),
      ));
      if (matchingWindowEnd > input.asOf) {
        deferred += 1;
        continue;
      }
      const controls = await this.reads.listControlsForOpportunity({
        instrumentId: opportunity.instrumentId,
        sessionId: opportunity.sessionId,
        direction: opportunity.direction,
        decisionAt: opportunity.canonicalDecisionAt,
      });
      const result = matchControls({
        opportunity,
        selectedVolatilityRegime: opportunity.volatilityRegime,
        controls,
        treatedDecisionKeys: await this.reads.listTreatedDecisionKeys(opportunity.sessionId),
      });
      if (result.commonSupport) {
        await this.writes.saveControlMatches({
          opportunityId: opportunity.id,
          controlPointIds: result.controlIds,
          equalWeight: result.equalWeight!,
        });
        matched += 1;
      } else {
        await this.writes.appendEvent({
          entityId: opportunity.id,
          eventType: "CONTROL_COMMON_SUPPORT_FAILED",
          policyVersion: matchingPolicyVersion,
          logicalEventAt: matchingWindowEnd,
          causationId: opportunity.opportunityKey,
          payload: { candidatesInsideCaliper: result.candidatesInsideCaliper, requiredControls: 5 },
        });
        commonSupportFailures += 1;
      }
    }
    return { matched, commonSupportFailures, deferred };
  }
}
