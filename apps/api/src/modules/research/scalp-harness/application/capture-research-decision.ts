import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import type {
  ImmutableStrategyProposal,
  MarketOpportunity,
  RecordedRiskDecision,
  ResearchControlPoint,
  ResearchRiskSnapshot,
  ResearchRiskSnapshotState,
  ResearchRiskSubject,
  ResearchStrategyDefinition,
} from "../domain/contracts.js";
import { buildCanonicalGeometry, canonicalAtrAlgorithmVersion, canonicalAtrParameters } from "../domain/policies.js";
import { resolveOpportunities, type PersistedProposal } from "../domain/opportunity-resolver.js";
import { buildRiskSnapshot, buildRiskSubject, evaluateResearchRisk } from "../domain/research-risk.js";
import { buildControlPoints, researchScalpStrategies } from "../domain/research-strategies.js";

export interface ScalpResearchWritePort {
  saveStrategyDefinition(definition: ResearchStrategyDefinition): Promise<string>;
  saveProposal(proposal: ImmutableStrategyProposal): Promise<PersistedProposal>;
  saveOpportunity(opportunity: MarketOpportunity): Promise<MarketOpportunity & { id: string }>;
  saveControlPoint(control: ResearchControlPoint): Promise<ResearchControlPoint & { id: string }>;
  saveRiskSnapshot(snapshot: ResearchRiskSnapshot): Promise<ResearchRiskSnapshot & { id: string }>;
  saveRiskSubject(subject: ResearchRiskSubject): Promise<ResearchRiskSubject & { id: string }>;
  saveRiskDecision(decision: RecordedRiskDecision): Promise<string>;
}

export interface CaptureResearchDecisionResult {
  readonly strategyDefinitions: number;
  readonly controls: number;
  readonly proposals: number;
  readonly opportunities: number;
  readonly riskSubjects: number;
  readonly riskDecisions: number;
}

function canonicalAtr(context: StrategyMarketContext): number {
  const snapshot = context.indicators.find((item) => (
    item.code === "ATR"
    && item.algorithmVersion === canonicalAtrAlgorithmVersion
    && item.parameters.period === canonicalAtrParameters.period
    && item.parameters.smoothing === canonicalAtrParameters.smoothing
  ));
  const value = snapshot?.values.value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("CANONICAL_GEOMETRY_V1 requires completed ta-v1 Wilder ATR(14)." );
  }
  return value;
}

export class CaptureScalpResearchDecision {
  constructor(private readonly writes: ScalpResearchWritePort) {}

  async execute(input: {
    reference1mContext: StrategyMarketContext;
    strategyContexts: readonly StrategyMarketContext[];
    sessionCloseAt: Date;
    tickSize: number;
    lotSize: number;
    accountSnapshots: readonly { accountId: string; state: ResearchRiskSnapshotState }[];
  }): Promise<CaptureResearchDecisionResult> {
    if (input.reference1mContext.candle.timeframe !== "1m") throw new Error("Capture requires a canonical 1m reference context.");
    const decisionAt = input.reference1mContext.candle.closeTime;
    for (const context of input.strategyContexts) {
      if (context.candle.closeTime.getTime() !== decisionAt.getTime()) {
        throw new Error("Every research strategy context must close at the canonical decisionAt.");
      }
    }

    for (const strategy of researchScalpStrategies) await this.writes.saveStrategyDefinition(strategy.definition);
    const generated = researchScalpStrategies.flatMap((strategy) => input.strategyContexts
      .filter((context) => strategy.supportedTimeframes.includes(context.candle.timeframe))
      .flatMap((context) => strategy.evaluate(context, input.reference1mContext)));
    const proposals = await Promise.all(generated.map((proposal) => this.writes.saveProposal(proposal)));
    const opportunities = await Promise.all(resolveOpportunities(proposals, input.sessionCloseAt).map((opportunity) => this.writes.saveOpportunity(opportunity)));

    const atr = opportunities.length > 0 ? canonicalAtr(input.reference1mContext) : null;
    const subjects: Array<ResearchRiskSubject & { id: string }> = [];
    for (const opportunity of opportunities) {
      const canonical = buildCanonicalGeometry({
        opportunity,
        atr: atr!,
        tickSize: input.tickSize,
        sessionCloseAt: input.sessionCloseAt,
      });
      subjects.push(await this.writes.saveRiskSubject(buildRiskSubject({
        subjectType: "CANONICAL_OPPORTUNITY",
        subjectId: opportunity.id,
        instrumentId: opportunity.instrumentId,
        decisionAt: opportunity.canonicalDecisionAt,
        sessionCloseAt: input.sessionCloseAt,
        geometry: canonical.geometry,
        lotSize: input.lotSize,
      })));
    }
    for (const proposal of proposals) {
      subjects.push(await this.writes.saveRiskSubject(buildRiskSubject({
        subjectType: "NATIVE_PROPOSAL",
        subjectId: proposal.id,
        instrumentId: proposal.instrumentId,
        decisionAt: proposal.decisionAt,
        sessionCloseAt: input.sessionCloseAt,
        geometry: proposal.nativeGeometry,
        lotSize: input.lotSize,
      })));
    }

    let riskDecisions = 0;
    for (const account of input.accountSnapshots) {
      const snapshot = await this.writes.saveRiskSnapshot(buildRiskSnapshot({
        accountId: account.accountId,
        asOf: decisionAt,
        decisionAt,
        state: account.state,
      }));
      for (const subject of subjects) {
        await this.writes.saveRiskDecision(evaluateResearchRisk({ subject, snapshot }));
        riskDecisions += 1;
      }
    }
    // Controls are the decision-completion marker for catch-up. Writing them last means a crash
    // anywhere above leaves this minute discoverable; every preceding retry is immutable/idempotent.
    const controls = await Promise.all(buildControlPoints(input.reference1mContext, input.sessionCloseAt)
      .map((control) => this.writes.saveControlPoint(control)));
    return {
      strategyDefinitions: researchScalpStrategies.length,
      controls: controls.length,
      proposals: proposals.length,
      opportunities: opportunities.length,
      riskSubjects: subjects.length,
      riskDecisions,
    };
  }
}
