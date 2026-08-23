import { defaultRiskPolicy, evaluateRisk, type RiskPolicy } from "../../../risk-management/domain/risk.js";
import {
  researchRiskPolicyVersion,
  riskSnapshotPolicyVersion,
  type RecordedRiskDecision,
  type ResearchGeometry,
  type ResearchRiskSnapshot,
  type ResearchRiskSnapshotState,
  type ResearchRiskSubject,
  type RiskSubjectType,
} from "./contracts.js";
import { logicalKey, sha256Canonical } from "./identity.js";

export function buildRiskSnapshot(input: {
  accountId: string;
  asOf: Date;
  decisionAt: Date;
  state: ResearchRiskSnapshotState;
}): ResearchRiskSnapshot {
  if (input.asOf.getTime() > input.decisionAt.getTime()) {
    throw new Error("A research risk snapshot cannot be later than decisionAt.");
  }
  if (Object.values(input.state.volatilityEvidenceByInstrument).some(
    (evidence) => evidence !== null && evidence.evidenceCutoffAt.getTime() > input.asOf.getTime(),
  )) {
    throw new Error("A research risk snapshot cannot contain future volatility evidence.");
  }
  const riskSnapshotKey = logicalKey("risk-snapshot", [
    input.accountId, input.asOf, riskSnapshotPolicyVersion,
  ]);
  const payload = {
    riskSnapshotKey,
    accountId: input.accountId,
    asOf: input.asOf,
    state: input.state,
    riskSnapshotPolicyVersion,
  };
  return { ...payload, payloadHash: sha256Canonical(payload) };
}

export function buildRiskSubject(input: {
  subjectType: RiskSubjectType;
  subjectId: string;
  instrumentId: string;
  decisionAt: Date;
  sessionCloseAt: Date;
  geometry: ResearchGeometry;
  lotSize: number;
}): ResearchRiskSubject {
  if (!Number.isInteger(input.lotSize) || input.lotSize <= 0) throw new Error("Risk subject lotSize must be positive.");
  const riskSubjectKey = logicalKey("risk-subject", [
    input.subjectType, input.subjectId, input.geometry.geometryPolicyVersion,
  ]);
  if (input.sessionCloseAt.getTime() < input.decisionAt.getTime()) throw new Error("Risk subject session cannot close before decisionAt.");
  const payload = { riskSubjectKey, ...input };
  return { ...payload, payloadHash: sha256Canonical(payload) };
}

export function evaluateResearchRisk(input: {
  subject: ResearchRiskSubject & { readonly id: string };
  snapshot: ResearchRiskSnapshot & { readonly id: string };
  policy?: RiskPolicy;
}): RecordedRiskDecision {
  if (input.snapshot.asOf.getTime() > input.subject.decisionAt.getTime()) {
    throw new Error("Risk snapshot is from after the research decision.");
  }
  const geometry = input.subject.geometry;
  const decision = evaluateRisk({
    instrumentId: input.subject.instrumentId,
    decisionTimestamp: input.subject.decisionAt,
    side: geometry.direction,
    entryPrice: geometry.entryPrice,
    stopLoss: geometry.stopLoss,
    targetPrice: geometry.targetPrice,
    lotSize: input.subject.lotSize,
  }, {
    accountEquity: input.snapshot.state.accountEquity,
    peakEquity: input.snapshot.state.peakEquity,
    openPositionCount: input.snapshot.state.openPositionCount,
    realizedPnlToday: input.snapshot.state.realizedPnlToday,
    volatilityRegime: input.snapshot.state.volatilityEvidenceByInstrument[input.subject.instrumentId] ?? null,
  }, input.policy ?? defaultRiskPolicy);
  const riskDecisionKey = logicalKey("risk-decision", [
    input.subject.riskSubjectKey, input.snapshot.id, researchRiskPolicyVersion,
  ]);
  const payload = {
    riskDecisionKey,
    riskSubjectId: input.subject.id,
    riskSnapshotId: input.snapshot.id,
    riskPolicyVersion: researchRiskPolicyVersion,
    decision,
  };
  return { ...payload, payloadHash: sha256Canonical(payload) };
}
