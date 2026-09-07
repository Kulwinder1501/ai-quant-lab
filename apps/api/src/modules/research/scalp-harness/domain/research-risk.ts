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
import { logicalKey, sha256CanonicalJson } from "../../../platform/identity/identity.js";
import { narrowToInstrument, sealRiskSnapshot } from "../../../platform/risk/risk-snapshot.js";

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
  /*
   * Structural validation through the shared primitive: finite money, a whole position count, and a
   * peak that is genuinely a running maximum. All 5,130 stored snapshots satisfy these, with a
   * minimum peak-minus-equity gap of 697.63, so this adds a guard rather than changing behaviour.
   *
   * The return value is deliberately discarded. The sealed object carries `asOf`, and putting it into
   * `payload.state` would add a field to the hashed state -- changing `payloadHash` on every snapshot
   * and re-identifying all 5,130 already stored. Validation is the whole reason for the call.
   */
  sealRiskSnapshot({ asOf: input.asOf, ...input.state });
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
  return { ...payload, payloadHash: sha256CanonicalJson(payload) };
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
  return { ...payload, payloadHash: sha256CanonicalJson(payload) };
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
    /*
     * Narrowed through the platform primitive rather than indexed inline.
     *
     * This was `volatilityEvidenceByInstrument[instrumentId] ?? null`, which silently turned "this
     * snapshot was never built for that instrument" into "no regime could be established". The two
     * mean opposite things: the second is a reading risk may act on, the first is a pipeline defect.
     *
     * Measured on the 15,282 stored risk decisions the absent case has never fired -- every subject's
     * instrument was covered -- so this is preventive. It is worth having precisely because 1,968 of
     * those decisions (12.9%) carry a legitimate null: an absent instrument would have been invisible
     * among them, indistinguishable once stored.
     */
  }, narrowToInstrument(
    { asOf: input.snapshot.asOf, ...input.snapshot.state },
    input.subject.instrumentId,
  ), input.policy ?? defaultRiskPolicy);
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
  return { ...payload, payloadHash: sha256CanonicalJson(payload) };
}
