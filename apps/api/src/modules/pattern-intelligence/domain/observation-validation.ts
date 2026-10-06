import { calculateObservationHash } from "./canonical-hash.js";
import type { AnyDetectedPattern, PatternFamily } from "./contracts.js";

export class PatternObservationValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid Pattern Intelligence observation: ${issues.join(" ")}`);
    this.name = "PatternObservationValidationError";
  }
}

function isDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateNumbers(value: unknown, path: string, issues: string[]): void {
  if (typeof value === "number" && !Number.isFinite(value)) issues.push(`${path} must be finite.`);
  if (Array.isArray(value)) value.forEach((child, index) => validateNumbers(child, `${path}[${index}]`, issues));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) validateNumbers(child, `${path}.${key}`, issues);
  }
}

/** Validates all write-time invariants except a hash comparison when requested. */
export function validateObservation(observation: AnyDetectedPattern, options: { verifyHash?: boolean } = {}): void {
  const issues: string[] = [];
  const { timing, source, identity, details, geometry, context } = observation;

  if (identity.patternFamily !== details.kind) issues.push("identity.patternFamily must equal details.kind.");
  if (identity.patternSubtype !== details.subtype) issues.push("identity.patternSubtype must equal details.subtype.");

  const dates: ReadonlyArray<[string, Date]> = [
    ["timing.startAt", timing.startAt], ["timing.dataThrough", timing.dataThrough], ["timing.detectedAt", timing.detectedAt],
    ["timing.knownAt", timing.knownAt], ["timing.earliestExecutionAt", timing.earliestExecutionAt], ["source.dataVintageAt", source.dataVintageAt],
  ];
  for (const [name, date] of dates) if (!isDate(date)) issues.push(`${name} must be a valid Date.`);
  if (issues.length === 0) {
    if (!(timing.startAt <= timing.dataThrough && timing.dataThrough <= timing.detectedAt && timing.detectedAt <= timing.knownAt)) {
      issues.push("Timing must satisfy startAt <= dataThrough <= detectedAt <= knownAt.");
    }
    if (!(timing.earliestExecutionAt.getTime() > Math.max(timing.detectedAt.getTime(), timing.knownAt.getTime()))) {
      issues.push("earliestExecutionAt must be after both detectedAt and knownAt.");
    }
    if (source.dataVintageAt.getTime() > timing.knownAt.getTime()) issues.push("source.dataVintageAt must be <= timing.knownAt.");
  }

  if (!/^[^:\s]+:.+$/.test(source.dataVintageId)) issues.push("source.dataVintageId must be provider-namespaced (provider:snapshot)." );
  if (!isFinitePositive(source.priceScale)) issues.push("source.priceScale must be finite and positive.");
  if (!isFinitePositive(source.tickSize)) issues.push("source.tickSize must be finite and positive.");
  if (!Number.isInteger(geometry.durationBars) || geometry.durationBars < 1) issues.push("geometry.durationBars must be a positive integer.");
  if (context.effortResultDivergence !== null && (context.volumeZscore === null || context.rangeZscore === null)) {
    issues.push("context.effortResultDivergence must be null when either z-score is null.");
  }
  if (context.effortResultDivergence !== null && context.volumeZscore !== null && context.rangeZscore !== null
    && context.effortResultDivergence !== context.volumeZscore - context.rangeZscore) {
    issues.push("context.effortResultDivergence must equal volumeZscore - rangeZscore.");
  }

  if (source.instrumentType === "INDEX" && (source.contractExpiry !== null || source.contractRole !== "SPOT")) {
    issues.push("INDEX observations require contractExpiry=null and contractRole=SPOT.");
  }
  if (source.instrumentType === "FUTIDX" && (source.contractExpiry === null || !["NEAR_MONTH", "MID_MONTH", "FAR_MONTH"].includes(source.contractRole ?? ""))) {
    issues.push("FUTIDX observations require an expiry and a futures contractRole.");
  }
  if (identity.patternFamily === "AUCTION_PROFILE" && (source.instrumentType !== "FUTIDX" || source.contractRole !== "NEAR_MONTH")) {
    issues.push("AUCTION_PROFILE observations require a near-month FUTIDX source.");
  }
  validateNumbers(observation, "observation", issues);

  if (options.verifyHash) {
    const expectedHash = calculateObservationHash(observation);
    if (observation.provenance.observationHash !== expectedHash) issues.push("provenance.observationHash does not match the canonical observation hash.");
  }
  if (issues.length > 0) throw new PatternObservationValidationError(issues);
}

/** Creates the immutable-record hash after validating all non-hash invariants. */
export function sealObservation(observation: AnyDetectedPattern): AnyDetectedPattern {
  validateObservation(observation);
  const sealed = {
    ...observation,
    provenance: { ...observation.provenance, observationHash: calculateObservationHash(observation) },
  } as AnyDetectedPattern;
  validateObservation(sealed, { verifyHash: true });
  return sealed;
}

/** Useful to Pattern Definition Registry implementations before a detector may start. */
export function assertDefinitionFamily(definitionFamily: PatternFamily, observation: AnyDetectedPattern): void {
  if (definitionFamily !== observation.identity.patternFamily) {
    throw new PatternObservationValidationError(["Pattern definition family must match observation identity.patternFamily."]);
  }
}
