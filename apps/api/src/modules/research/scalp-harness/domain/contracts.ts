import type { RiskDecision, VolatilityRegimeEvidence } from "../../../risk-management/domain/risk.js";
import type { StrategyMarketContext, TradeSide } from "../../../strategy-engine/domain/strategy.js";
import { logicalKey, sha256Canonical } from "./identity.js";

export const scalpHarnessVersion = "scalp-research-harness-v1.3.1";
export const referencePolicyVersion = "REFERENCE_1M_CLOSE_V1";
export const groupingPolicyVersion = "EXACT_DECISION_GROUPING_V1";
export const canonicalGeometryPolicyVersion = "CANONICAL_GEOMETRY_V1";
export const fillPolicyVersion = "FILL_POLICY_V1";
export const settlementPolicyVersion = "SCALP_SETTLEMENT_V1";
export const gridPolicyVersion = "GRID_POLICY_V1";
/**
 * V2 widened what `sampleEligible` asserts, so it must not share a version string with V1.
 *
 * V1 read "canonical ATR exists". V2 reads "every 1m indicator the research strategies consume
 * exists, and the candlestick and price-action layers have been computed for this bar". Points
 * stamped V1 are not comparable with points stamped V2 -- a V1-eligible point may have had no
 * pattern layer at all -- and this string is what lets an estimator refuse to pool them.
 */
export const controlPolicyVersion = "MATCHED_CONTROL_POPULATION_V2";
export const matchingPolicyVersion = "MATCHED_CONTROL_N5_V1";
export const riskSnapshotPolicyVersion = "RISK_SNAPSHOT_PIT_V1";
export const researchRiskPolicyVersion = "RESEARCH_RISK_V1";
export const ambiguityPolicyVersion = "INTRABAR_ORDER_UNKNOWN_V1";
export const observationHorizonsMinutes = [5, 15, 30, 60] as const;

/**
 * The frozen component set a settlement version resolves to, plus its hash.
 *
 * FILL_POLICY_V1 says: if the fill semantics change, `settlementPolicyVersion` MUST change. That is the
 * invariant that makes a settlement version mean one thing forever — and until now it was a rule written
 * in a document, enforced by nobody. The obvious-looking fix, adding `fillPolicyVersion` to the
 * observation/terminal identity key, is the wrong one: it would let the same settlement version coexist
 * under two different fill policies as two separate keys, so the database would quietly hold both
 * instead of rejecting the second. That is precisely why payload fingerprints are excluded from logical
 * identities in the first place.
 *
 * So the identity stays `(subject, settlementPolicyVersion, horizon)` and the components are bound
 * *structurally* instead: the version resolves through this registry to an immutable definition, and its
 * `definitionHash` is persisted on every row. If a component is ever edited without bumping the version,
 * the same logical version resolves to a different hash — a `POLICY_DETERMINISM_VIOLATION`, detectable
 * globally against stored rows rather than only when the same subject happens to be re-settled.
 */
export interface SettlementPolicyDefinition {
  readonly settlementPolicyVersion: string;
  readonly geometryPolicyVersion: string;
  readonly fillPolicyVersion: string;
  readonly ambiguityPolicyVersion: string;
  readonly definitionHash: string;
}

function freezeSettlementPolicy(
  components: Omit<SettlementPolicyDefinition, "definitionHash">,
): SettlementPolicyDefinition {
  return Object.freeze({
    ...components,
    definitionHash: logicalKey("settlement-policy-definition", [
      components.settlementPolicyVersion,
      components.geometryPolicyVersion,
      components.fillPolicyVersion,
      components.ambiguityPolicyVersion,
    ]),
  });
}

export const settlementPolicyRegistry: Readonly<Record<string, SettlementPolicyDefinition>> = Object.freeze({
  [settlementPolicyVersion]: freezeSettlementPolicy({
    settlementPolicyVersion,
    geometryPolicyVersion: canonicalGeometryPolicyVersion,
    fillPolicyVersion,
    ambiguityPolicyVersion,
  }),
});

/** Resolves a settlement version to its frozen definition, refusing an unregistered one. */
export function resolveSettlementPolicy(version: string): SettlementPolicyDefinition {
  const definition = settlementPolicyRegistry[version];
  if (!definition) {
    throw new Error(
      `Settlement policy "${version}" is not registered. A settlement version must resolve to a frozen `
      + "component set before any row is written under it.",
    );
  }
  return definition;
}

/**
 * Raised when a stored row's settlement version disagrees with the registry's current definition hash.
 *
 * The row is not wrong — the code is. Some component of a frozen settlement policy was changed without
 * the version bump FILL_POLICY_V1 requires, so previously-settled rows and newly-settled ones no longer
 * mean the same thing despite carrying the same version string.
 */
export class PolicyDeterminismViolationError extends Error {
  constructor(
    readonly version: string,
    readonly storedDefinitionHash: string,
    readonly currentDefinitionHash: string,
  ) {
    super(
      `POLICY_DETERMINISM_VIOLATION: settlement policy "${version}" resolves to definition `
      + `${currentDefinitionHash} but stored rows were written under ${storedDefinitionHash}. A frozen `
      + "policy component changed without a settlement version bump.",
    );
    this.name = "PolicyDeterminismViolationError";
  }
}

/** Asserts a stored row's definition hash still matches the registry. */
export function assertSettlementPolicyDeterminism(version: string, storedDefinitionHash: string): void {
  const current = resolveSettlementPolicy(version).definitionHash;
  if (current !== storedDefinitionHash) {
    throw new PolicyDeterminismViolationError(version, storedDefinitionHash, current);
  }
}

export type ObservationHorizonMinutes = typeof observationHorizonsMinutes[number];
export type ResearchSubjectType = "CANONICAL_OPPORTUNITY" | "NATIVE_PROPOSAL" | "CONTROL_POINT";
export type RiskSubjectType = "CANONICAL_OPPORTUNITY" | "NATIVE_PROPOSAL";
export type EntryOrderType = "MARKET_AT_REFERENCE" | "LIMIT" | "STOP";
export type TerminalOutcome =
  | "TARGET" | "STOP" | "TIMEOUT" | "AMBIGUOUS" | "ENTRY_NOT_TRIGGERED"
  | "DATA_INCOMPLETE" | "POLICY_INVALID";
export type FillCondition =
  | "AT_REFERENCE" | "AT_LEVEL" | "GAP_THROUGH_LIMIT_ENTRY" | "GAP_THROUGH_STOP_ENTRY"
  | "GAP_THROUGH_STOP" | "GAP_THROUGH_TARGET" | "TIMEOUT_CLOSE" | "NONE";
export type ObservationStatus =
  | "ELIGIBLE_COMPLETE" | "ELIGIBLE_DATA_INCOMPLETE" | "INELIGIBLE_SESSION_BOUNDARY";

export interface ResearchStrategyDefinition {
  readonly strategyKey: string;
  readonly researchVersion: number;
  readonly implementationArtifactChecksum: string;
  readonly featureSchemaVersion: string;
  readonly configuration: Record<string, unknown>;
  readonly strategyDefinitionHash: string;
}

export interface ResearchGeometry {
  readonly direction: TradeSide;
  readonly entryOrderType: EntryOrderType;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly targetPrice: number;
  readonly expiresAt: Date;
  readonly geometryPolicyVersion: string;
}

export interface ImmutableStrategyProposal {
  readonly id?: string;
  readonly proposalKey: string;
  readonly payloadHash: string;
  readonly strategyDefinitionHash: string;
  readonly strategyKey: string;
  readonly strategyResearchVersion: number;
  readonly instrumentId: string;
  readonly sourceCandleId: string;
  readonly referenceCandleId: string;
  readonly timeframe: string;
  readonly direction: TradeSide;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly referencePrice: number;
  readonly setupType: string;
  readonly setupFingerprint: string;
  readonly nativeGeometry: ResearchGeometry;
  /** Point-in-time feature values, never an authoritative aggregate score. */
  readonly rawContext: Record<string, unknown>;
}

export interface MarketOpportunity {
  readonly id?: string;
  readonly opportunityKey: string;
  readonly payloadHash: string;
  readonly instrumentId: string;
  readonly sessionId: string;
  readonly sessionCloseAt: Date;
  readonly direction: TradeSide;
  readonly canonicalDecisionAt: Date;
  readonly dataThrough: Date;
  readonly referencePrice: number;
  readonly referenceCandleId: string;
  readonly proposalIds: readonly string[];
  readonly groupingPolicyVersion: string;
  readonly referencePolicyVersion: string;
}

export interface ResearchControlPoint {
  readonly id?: string;
  readonly controlPointKey: string;
  readonly payloadHash: string;
  readonly instrumentId: string;
  readonly sourceCandleId: string;
  readonly sessionId: string;
  readonly sessionCloseAt: Date;
  readonly evaluationDirection: TradeSide;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly referencePrice: number;
  readonly minuteOfDay: number;
  readonly volatilityRegime: string | null;
  readonly sampleEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly controlPolicyVersion: string;
}

export interface ResearchRiskSnapshot {
  readonly id?: string;
  readonly riskSnapshotKey: string;
  readonly payloadHash: string;
  readonly accountId: string;
  readonly asOf: Date;
  readonly state: ResearchRiskSnapshotState;
  readonly riskSnapshotPolicyVersion: string;
}

/** Account state is global; subject-specific volatility evidence is held in a complete instrument map. */
export interface ResearchRiskSnapshotState {
  readonly accountEquity: number;
  readonly peakEquity: number;
  readonly openPositionCount: number;
  readonly realizedPnlToday: number;
  readonly volatilityEvidenceByInstrument: Readonly<Record<string, VolatilityRegimeEvidence | null>>;
}

export interface ResearchRiskSubject {
  readonly id?: string;
  readonly riskSubjectKey: string;
  readonly payloadHash: string;
  readonly subjectType: RiskSubjectType;
  readonly subjectId: string;
  readonly instrumentId: string;
  readonly decisionAt: Date;
  readonly sessionCloseAt: Date;
  readonly geometry: ResearchGeometry;
  readonly lotSize: number;
}

export interface RecordedRiskDecision {
  readonly riskDecisionKey: string;
  readonly payloadHash: string;
  readonly riskSubjectId: string;
  readonly riskSnapshotId: string;
  readonly riskPolicyVersion: string;
  readonly decision: RiskDecision;
}

export interface ResearchPriceCandle {
  readonly id?: string;
  readonly openTime: Date;
  readonly closeTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

export interface ResearchSettlementObservation {
  readonly observationKey: string;
  readonly payloadHash: string;
  readonly subjectType: ResearchSubjectType;
  readonly subjectId: string;
  readonly horizonMinutes: ObservationHorizonMinutes;
  readonly horizonEndAt: Date;
  readonly horizonEligible: boolean;
  readonly status: ObservationStatus;
  readonly statusReason: string | null;
  readonly mfeBps: number | null;
  readonly maeBps: number | null;
  readonly targetTouchedByHorizon: boolean | null;
  readonly stopTouchedByHorizon: boolean | null;
  readonly entryTriggeredAt: Date | null;
  readonly firstTargetTouchAt: Date | null;
  readonly firstStopTouchAt: Date | null;
  readonly barsExpected: number;
  readonly barsObserved: number;
  readonly geometryPolicyVersion: string;
  readonly fillPolicyVersion: string;
  readonly settlementPolicyVersion: string;
  /** Binds the version to its frozen component set; see `settlementPolicyRegistry`. */
  readonly settlementDefinitionHash: string;
}

export interface ResearchTerminalSettlement {
  readonly terminalSettlementKey: string;
  readonly payloadHash: string;
  readonly subjectType: ResearchSubjectType;
  readonly subjectId: string;
  readonly outcome: TerminalOutcome;
  readonly outcomeReason: string;
  readonly entryFillCondition: FillCondition;
  readonly exitFillCondition: FillCondition;
  readonly entryTriggeredAt: Date | null;
  readonly resolvedAt: Date;
  readonly entryFillPrice: number | null;
  readonly exitFillPrice: number | null;
  readonly returnBps: number | null;
  readonly rMultiple: number | null;
  readonly geometryPolicyVersion: string;
  readonly fillPolicyVersion: string;
  readonly settlementPolicyVersion: string;
  /** Binds the version to its frozen component set; see `settlementPolicyRegistry`. */
  readonly settlementDefinitionHash: string;
}

export function istSessionId(value: Date): string {
  if (Number.isNaN(value.getTime())) throw new Error("Cannot derive an NSE session from an invalid date.");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function istMinuteOfDay(value: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(value);
  return (Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24) * 60
    + Number(parts.find((part) => part.type === "minute")?.value ?? 0);
}

/** GRID_POLICY_V1: session anchor 09:15 IST, and the first 1m bar closes one minute later at 09:16. */
export const sessionAnchorIstMinute = 9 * 60 + 15;
export const sessionCloseIstMinute = 15 * 60 + 30;

/**
 * Rejects a decision timestamp that is not on the frozen GRID_POLICY_V1 lattice.
 *
 * GRID_POLICY_V1 is a domain invariant, not a market-feed convention. The grid is
 * `09:15 IST + n x 1 minute`, so a decision at 09:16:12 or 09:17:30 is off-grid no matter what an
 * upstream collector supplied — and an off-grid control point silently corrupts the ±15-minute caliper
 * that matched-control selection depends on, because the caliper assumes both sides sit on the same
 * lattice. Trusting the candle feed to be aligned makes that assumption unverifiable; asserting it here
 * turns a feed defect into a loud failure at capture time rather than a quiet bias in Signal Edge.
 *
 * The bound is the regular session: the first 1m bar closes at 09:16 (anchor + one bar) and the last at
 * 15:30. A special session (Muhurat) does not sit on this lattice at all and must not be captured.
 */
export function assertOnGridDecision(decisionAt: Date): void {
  if (Number.isNaN(decisionAt.getTime())) throw new Error("GRID_POLICY_V1 requires a valid decision timestamp.");
  const milliseconds = decisionAt.getTime();
  if (milliseconds % 60_000 !== 0) {
    // Whole-minute boundary: seconds and milliseconds must both be zero. A sub-minute offset means the
    // bar was not sealed on the minute, so its close is not a grid point.
    throw new Error(`GRID_POLICY_V1 requires a whole-minute decision; ${decisionAt.toISOString()} is off-grid.`);
  }
  const minute = istMinuteOfDay(decisionAt);
  if (minute <= sessionAnchorIstMinute || minute > sessionCloseIstMinute) {
    throw new Error(
      `GRID_POLICY_V1 decisions fall in (09:15, 15:30] IST; ${decisionAt.toISOString()} is outside the regular session.`,
    );
  }
}

export function buildStrategyDefinition(
  input: Omit<ResearchStrategyDefinition, "strategyDefinitionHash">,
): ResearchStrategyDefinition {
  const strategyDefinitionHash = logicalKey("strategy-definition", [
    input.strategyKey,
    input.researchVersion,
    input.configuration,
    input.featureSchemaVersion,
    input.implementationArtifactChecksum,
  ]);
  return { ...input, strategyDefinitionHash };
}

export function buildProposal(input: {
  definition: ResearchStrategyDefinition;
  strategyContext: StrategyMarketContext;
  referenceCandle: StrategyMarketContext["candle"];
  direction: TradeSide;
  setupType: string;
  setupFingerprintParts: readonly unknown[];
  nativeGeometry: ResearchGeometry;
  rawContext: Record<string, unknown>;
}): ImmutableStrategyProposal {
  const decisionAt = input.strategyContext.candle.closeTime;
  const dataThrough = new Date(decisionAt.getTime() - 1);
  if (input.referenceCandle.timeframe !== "1m" || input.referenceCandle.closeTime.getTime() !== decisionAt.getTime()) {
    throw new Error("Research proposals require the exact completed 1m reference candle at decisionAt.");
  }
  // A proposal and its matched controls must share the GRID_POLICY_V1 lattice, or the ±15-minute
  // caliper compares points that were never comparable.
  assertOnGridDecision(decisionAt);
  const setupType = input.setupType.trim();
  if (setupType.length === 0) throw new Error("Research setupType cannot be blank.");
  const setupFingerprint = logicalKey("setup-fingerprint", input.setupFingerprintParts);
  const proposalKey = logicalKey("proposal", [
    input.definition.strategyDefinitionHash,
    input.strategyContext.candle.instrumentId,
    input.strategyContext.candle.timeframe,
    input.direction,
    decisionAt,
    dataThrough,
    setupType,
    setupFingerprint,
  ]);
  const payload = {
    proposalKey,
    strategyDefinitionHash: input.definition.strategyDefinitionHash,
    strategyKey: input.definition.strategyKey,
    strategyResearchVersion: input.definition.researchVersion,
    instrumentId: input.strategyContext.candle.instrumentId,
    sourceCandleId: input.strategyContext.candle.id,
    referenceCandleId: input.referenceCandle.id,
    timeframe: input.strategyContext.candle.timeframe,
    direction: input.direction,
    decisionAt,
    dataThrough,
    referencePrice: input.referenceCandle.close,
    setupType,
    setupFingerprint,
    nativeGeometry: input.nativeGeometry,
    rawContext: input.rawContext,
  };
  return { ...payload, payloadHash: sha256Canonical(payload) };
}
