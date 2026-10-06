import { createHash } from "node:crypto";
import type { AnyDetectedPattern, PatternLifecycleEvent, PatternLifecycleEventType } from "./contracts.js";

export class PatternLifecycleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternLifecycleValidationError";
  }
}

const permittedTransitions: Readonly<Record<PatternLifecycleEventType, readonly PatternLifecycleEventType[]>> = {
  DETECTED: ["CONFIRMED", "INVALIDATED", "EXPIRED"],
  CONFIRMED: ["COMPLETED", "INVALIDATED", "EXPIRED"],
  INVALIDATED: [],
  EXPIRED: [],
  COMPLETED: [],
};

export function lifecycleIdempotencyKey(observationId: string, eventType: PatternLifecycleEventType, dataThrough: Date): string {
  return createHash("sha256").update(`${observationId}|${eventType}|${dataThrough.toISOString()}`, "utf8").digest("hex");
}

function validateEventShape(event: PatternLifecycleEvent): void {
  if (!Number.isInteger(event.sequenceNumber) || event.sequenceNumber < 1) throw new PatternLifecycleValidationError("sequenceNumber must be a positive integer.");
  if ([event.dataThrough, event.eventTime, event.knownAt].some((date) => Number.isNaN(date.getTime()))) {
    throw new PatternLifecycleValidationError("Lifecycle event dates must be valid.");
  }
  if (!(event.dataThrough <= event.eventTime && event.eventTime <= event.knownAt)) {
    throw new PatternLifecycleValidationError("Lifecycle event must satisfy dataThrough <= eventTime <= knownAt.");
  }
  if (event.idempotencyKey !== lifecycleIdempotencyKey(event.observationId, event.eventType, event.dataThrough)) {
    throw new PatternLifecycleValidationError("Lifecycle event idempotencyKey does not match its canonical inputs.");
  }
}

export function validateInitialLifecycleEvent(observation: AnyDetectedPattern, event: PatternLifecycleEvent): void {
  validateEventShape(event);
  if (event.eventType !== "DETECTED" || event.sequenceNumber !== 1) throw new PatternLifecycleValidationError("The initial lifecycle event must be DETECTED at sequenceNumber 1.");
  if (event.observationId !== observation.identity.observationId) throw new PatternLifecycleValidationError("Initial event observationId must match the master record.");
  if (event.dataThrough.getTime() !== observation.timing.dataThrough.getTime()
    || event.eventTime.getTime() !== observation.timing.detectedAt.getTime()
    || event.knownAt.getTime() !== observation.timing.knownAt.getTime()) {
    throw new PatternLifecycleValidationError("Initial DETECTED event timing must match its master observation.");
  }
}

/** Validates the next append-only lifecycle event before it enters its serialized transaction. */
export function validateNextLifecycleEvent(events: readonly PatternLifecycleEvent[], next: PatternLifecycleEvent): void {
  validateEventShape(next);
  if (events.length === 0) throw new PatternLifecycleValidationError("Use validateInitialLifecycleEvent for the first DETECTED event.");
  const prior = events[events.length - 1]!;
  if (next.observationId !== prior.observationId) throw new PatternLifecycleValidationError("Lifecycle events must share an observationId.");
  if (next.sequenceNumber !== prior.sequenceNumber + 1) throw new PatternLifecycleValidationError("Lifecycle sequenceNumber must be exactly one greater than the prior event.");
  if (!permittedTransitions[prior.eventType].includes(next.eventType)) {
    throw new PatternLifecycleValidationError(`${next.eventType} is not permitted after ${prior.eventType}.`);
  }
  if (events.some((event) => event.idempotencyKey === next.idempotencyKey)) {
    throw new PatternLifecycleValidationError("Duplicate idempotencyKey must be discarded before lifecycle validation.");
  }
}
