import type {
  MarketOpportunity,
  ResearchControlPoint,
  ResearchGeometry,
  ResearchPriceCandle,
  ResearchSettlementObservation,
  ResearchSubjectType,
  ResearchTerminalSettlement,
} from "../domain/contracts.js";
import { buildCanonicalGeometry } from "../domain/policies.js";
import { settleResearchPath } from "../domain/settlement.js";

export interface PendingResearchSubject {
  readonly subjectType: ResearchSubjectType;
  readonly subjectId: string;
  readonly instrumentId: string;
  readonly decisionAt: Date;
  readonly sessionCloseAt: Date;
  readonly geometry: ResearchGeometry;
}

export interface SettlementReadPort {
  listPendingRiskSubjects(limit: number): Promise<Array<Omit<PendingResearchSubject, "instrumentId">>>;
  listPendingControls(limit: number): Promise<Array<ResearchControlPoint & { id: string; atr: number; tickSize: number }>>;
  findInstrumentIdForSubject(subjectType: ResearchSubjectType, subjectId: string): Promise<string | null>;
  listForwardCandles(input: { instrumentId: string; decisionAt: Date; endAt: Date }): Promise<ResearchPriceCandle[]>;
}

export interface SettlementWritePort {
  saveSettlements(input: {
    observations: readonly ResearchSettlementObservation[];
    terminal: ResearchTerminalSettlement | null;
  }): Promise<void>;
}

function fullyObservableAt(input: {
  decisionAt: Date;
  sessionCloseAt: Date;
  expiresAt: Date;
}): Date {
  const observationEnd = new Date(Math.min(
    input.decisionAt.getTime() + 60 * 60_000,
    input.sessionCloseAt.getTime(),
  ));
  const terminalEnd = input.expiresAt <= input.sessionCloseAt ? input.expiresAt : input.decisionAt;
  return new Date(Math.max(observationEnd.getTime(), terminalEnd.getTime()));
}

export class SettleScalpResearchSubjects {
  constructor(private readonly reads: SettlementReadPort, private readonly writes: SettlementWritePort) {}

  async execute(input: { asOf: Date; limit: number }): Promise<{
    riskSubjectsSettled: number;
    controlsSettled: number;
    deferred: number;
  }> {
    let riskSubjectsSettled = 0;
    let controlsSettled = 0;
    let deferred = 0;
    const subjects = await this.reads.listPendingRiskSubjects(input.limit);
    for (const subject of subjects) {
      const instrumentId = await this.reads.findInstrumentIdForSubject(subject.subjectType, subject.subjectId);
      if (!instrumentId) throw new Error(`Orphan research settlement subject ${subject.subjectId}.`);
      const observableAt = fullyObservableAt({ ...subject, expiresAt: subject.geometry.expiresAt });
      if (observableAt > input.asOf) {
        deferred += 1;
        continue;
      }
      const endAt = new Date(Math.max(
        Math.min(subject.decisionAt.getTime() + 60 * 60_000, subject.sessionCloseAt.getTime()),
        subject.geometry.expiresAt <= subject.sessionCloseAt ? subject.geometry.expiresAt.getTime() : subject.decisionAt.getTime(),
      ));
      const forwardCandles = await this.reads.listForwardCandles({ instrumentId, decisionAt: subject.decisionAt, endAt });
      await this.writes.saveSettlements(settleResearchPath({ ...subject, forwardCandles }));
      riskSubjectsSettled += 1;
    }

    const controls = await this.reads.listPendingControls(input.limit);
    for (const control of controls) {
      const observableAt = new Date(Math.min(
        control.decisionAt.getTime() + 60 * 60_000,
        control.sessionCloseAt.getTime(),
      ));
      if (observableAt > input.asOf) {
        deferred += 1;
        continue;
      }
      const opportunityShape: MarketOpportunity = {
        opportunityKey: control.controlPointKey,
        payloadHash: control.payloadHash,
        instrumentId: control.instrumentId,
        sessionId: control.sessionId,
        sessionCloseAt: control.sessionCloseAt,
        direction: control.evaluationDirection,
        canonicalDecisionAt: control.decisionAt,
        dataThrough: control.dataThrough,
        referencePrice: control.referencePrice,
        referenceCandleId: control.sourceCandleId,
        proposalIds: [],
        groupingPolicyVersion: "CONTROL_POINT",
        referencePolicyVersion: "REFERENCE_1M_CLOSE_V1",
      };
      const geometry = buildCanonicalGeometry({
        opportunity: opportunityShape,
        atr: control.atr,
        tickSize: control.tickSize,
        sessionCloseAt: control.sessionCloseAt,
      }).geometry;
      const forwardCandles = await this.reads.listForwardCandles({
        instrumentId: control.instrumentId,
        decisionAt: control.decisionAt,
        endAt: observableAt,
      });
      await this.writes.saveSettlements(settleResearchPath({
        subjectType: "CONTROL_POINT",
        subjectId: control.id,
        geometry,
        decisionAt: control.decisionAt,
        sessionCloseAt: control.sessionCloseAt,
        forwardCandles,
      }));
      controlsSettled += 1;
    }
    return { riskSubjectsSettled, controlsSettled, deferred };
  }
}
