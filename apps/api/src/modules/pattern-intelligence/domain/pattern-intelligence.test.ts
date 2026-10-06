import { describe, expect, it } from "vitest";
import {
  calculateDefinitionHash,
  calculateObservationHash,
  calculateObservationLogicalKey,
  encodeCanonical,
  sha256CanonicalBytes,
} from "./canonical-hash.js";
import type { AnyDetectedPattern, PatternDefinition, PatternLifecycleEvent } from "./contracts.js";
import { lifecycleIdempotencyKey, validateInitialLifecycleEvent, validateNextLifecycleEvent } from "./lifecycle.js";
import { PatternObservationValidationError, sealObservation, validateObservation } from "./observation-validation.js";

function baseObservation(): AnyDetectedPattern {
  return {
    identity: { observationId: "0192f2a9-6cdb-7000-8000-000000000001", patternFamily: "SWEEP_RECLAIM", patternSubtype: "SPRING", orientation: "UP" },
    source: {
      exchange: "NSE", underlying: "NIFTY50", instrumentType: "FUTIDX", contractSymbol: "NIFTY26AUGFUT",
      contractExpiry: new Date("2026-08-27T00:00:00.000Z"), contractRole: "NEAR_MONTH", timeframe: "5m", timezone: "Asia/Kolkata",
      priceScale: 100, tickSize: 0.05, dataVintageId: "nse-feed:2026-08-25T09:15:00.000Z", dataVintageAt: new Date("2026-08-25T09:15:00.000Z"),
    },
    definitionRef: { definitionId: "sweep-reclaim-v1", definitionVersion: "1.0.0", definitionHash: "a".repeat(64) },
    timing: {
      startAt: new Date("2026-08-25T09:15:00.000Z"), dataThrough: new Date("2026-08-25T09:20:00.000Z"),
      detectedAt: new Date("2026-08-25T09:20:00.000Z"), knownAt: new Date("2026-08-25T09:20:01.000Z"), earliestExecutionAt: new Date("2026-08-25T09:25:00.000Z"),
    },
    geometry: { durationBars: 2, rangeBps: 12.5, rangeAtr: 0.8 },
    context: { trendState: "DOWN", sessionSegment: "OPENING", volumeZscore: 1.2, rangeZscore: 0.2, effortResultDivergence: 1 },
    details: { kind: "SWEEP_RECLAIM", subtype: "SPRING", wyckoffEquivalent: "SPRING", referenceLevel: 24500, penetrationExcursionBps: 4, reclaimDistanceBps: 7, rejectionWickBps: 5 },
    provenance: { engineVersion: "pi-v1", configVersion: "1.0.0", configHash: "b".repeat(64), dataSource: "nse-feed", dataSchemaVersion: "1", observationHash: "" },
  };
}

function initialEvent(observation: AnyDetectedPattern): PatternLifecycleEvent {
  return {
    eventId: "0192f2a9-6cdb-7000-8000-000000000002", eventSchemaVersion: "1.0", observationId: observation.identity.observationId,
    eventType: "DETECTED", dataThrough: observation.timing.dataThrough, eventTime: observation.timing.detectedAt,
    knownAt: observation.timing.knownAt, sequenceNumber: 1,
    idempotencyKey: lifecycleIdempotencyKey(observation.identity.observationId, "DETECTED", observation.timing.dataThrough), cause: null,
  };
}

describe("Pattern Intelligence V1.0.1 foundation", () => {
  it("seals and verifies a complete immutable observation", () => {
    const sealed = sealObservation(baseObservation());
    expect(sealed.provenance.observationHash).toHaveLength(64);
    expect(calculateObservationHash(sealed)).toBe(sealed.provenance.observationHash);
    expect(() => validateObservation(sealed, { verifyHash: true })).not.toThrow();
  });

  it("pins the observationHash payload to 8 top-level keys with provenance nested, not hoisted", () => {
    // Spec Section 3.1 lists the covered fields as a flat set including five provenance.* members and
    // never says whether they nest or hoist. Both readings conform and they hash differently, so the
    // hash was in fact unspecified. This test is the specification.
    const sealed = sealObservation(baseObservation());
    const { observationHash: _omitted, ...provenance } = sealed.provenance;

    expect(Object.keys(provenance).sort()).toEqual([
      "configHash", "configVersion", "dataSchemaVersion", "dataSource", "engineVersion",
    ]);

    const nested = {
      identity: sealed.identity,
      source: sealed.source,
      definitionRef: sealed.definitionRef,
      timing: sealed.timing,
      geometry: sealed.geometry,
      context: sealed.context,
      details: sealed.details,
      provenance,
    };
    expect(Object.keys(nested).sort()).toEqual([
      "context", "definitionRef", "details", "geometry", "identity", "provenance", "source", "timing",
    ]);
    expect(sealed.provenance.observationHash).toBe(sha256CanonicalBytes(nested));

    // The hoisted reading a second conforming implementation might have picked. It must differ -- if
    // these ever coincided the nesting choice would not be load-bearing and this pin would be empty.
    const { provenance: _dropped, ...withoutProvenance } = nested;
    expect(sha256CanonicalBytes({ ...withoutProvenance, ...provenance })).not.toBe(sealed.provenance.observationHash);
  });

  it("gives a storage key that survives a re-detection but separates genuinely different observations", () => {
    // observationHash cannot serve as the storage key: it covers identity.observationId, a fresh
    // UUID per pass, so re-scanning an overlapping window would insert a duplicate of every pattern.
    // Overrides are cast once at the boundary: spreading a member of a discriminated union and
    // replacing a discriminated field loses the narrowing, and the alternative is rebuilding each
    // fixture by hand for no extra safety.
    // `Partial<AnyDetectedPattern>` still distributes across the union, so the parameter is a loose
    // record and the cast happens once, here.
    const variant = (overrides: Record<string, unknown>): AnyDetectedPattern =>
      ({ ...baseObservation(), ...overrides }) as AnyDetectedPattern;

    const first = sealObservation(baseObservation());
    const rerun = sealObservation(variant({
      identity: { ...baseObservation().identity, observationId: "0192f2a9-6cdb-7000-8000-0000000000ff" },
    }));
    expect(rerun.provenance.observationHash).not.toBe(first.provenance.observationHash);
    expect(calculateObservationLogicalKey(rerun)).toBe(calculateObservationLogicalKey(first));

    // A later pass over the same bar differs in when it ran, and must still collide.
    const backfill = sealObservation(variant({
      identity: { ...baseObservation().identity, observationId: "0192f2a9-6cdb-7000-8000-0000000000fe" },
      timing: { ...baseObservation().timing, knownAt: new Date("2026-09-01T00:00:00.000Z"), earliestExecutionAt: new Date("2026-09-01T00:05:00.000Z") },
      provenance: { ...baseObservation().provenance, engineVersion: "pi-v1.0.2" },
    }));
    expect(calculateObservationLogicalKey(backfill)).toBe(calculateObservationLogicalKey(first));

    // But two real observations on one bar must stay separate. LEVEL_INTERACTION fires once per
    // reference level, so a bar breaking both PDH and prior close agrees on every field but details.
    const otherLevel = sealObservation(variant({
      details: { ...baseObservation().details, referenceLevel: 24600 } as AnyDetectedPattern["details"],
    }));
    expect(calculateObservationLogicalKey(otherLevel)).not.toBe(calculateObservationLogicalKey(first));

    // A threshold change is a different observation of the same bar, not an overwrite of it.
    const newRules = sealObservation(variant({
      definitionRef: { ...baseObservation().definitionRef, definitionHash: "c".repeat(64) },
    }));
    expect(calculateObservationLogicalKey(newRules)).not.toBe(calculateObservationLogicalKey(first));
  });

  it("uses typed, order-independent canonical bytes", () => {
    expect(encodeCanonical({ b: "null", a: null }).equals(encodeCanonical({ a: null, b: "null" }))).toBe(true);
    expect(encodeCanonical("null").equals(encodeCanonical(null))).toBe(false);
    expect(() => encodeCanonical(Number.NaN)).toThrow("Non-finite number");
  });

  it("hashes a definition without including its self-referential hash field", () => {
    const definition: PatternDefinition = {
      definitionId: "sweep-reclaim-v1", definitionVersion: "1.0.0", family: "SWEEP_RECLAIM",
      parameters: { reclaimBars: 2 }, invalidationConditions: ["close below sweep low"], definitionHash: "",
      frozenAt: new Date("2026-08-25T00:00:00.000Z"),
    };
    definition.definitionHash = calculateDefinitionHash(definition);
    expect(calculateDefinitionHash(definition)).toBe(definition.definitionHash);
  });

  it("rejects broken PIT and identity invariants", () => {
    const invalid = baseObservation();
    invalid.timing.knownAt = new Date("2026-08-25T09:19:59.000Z");
    invalid.identity.patternSubtype = "UPTHRUST";
    expect(() => validateObservation(invalid)).toThrow(PatternObservationValidationError);
  });

  it("ties the initial event atomically to the master observation and enforces transitions", () => {
    const observation = sealObservation(baseObservation());
    const detected = initialEvent(observation);
    expect(() => validateInitialLifecycleEvent(observation, detected)).not.toThrow();
    const confirmed: PatternLifecycleEvent = {
      ...detected,
      eventId: "0192f2a9-6cdb-7000-8000-000000000003", eventType: "CONFIRMED", sequenceNumber: 2,
      dataThrough: new Date("2026-08-25T09:25:00.000Z"), eventTime: new Date("2026-08-25T09:25:00.000Z"), knownAt: new Date("2026-08-25T09:25:01.000Z"),
      idempotencyKey: lifecycleIdempotencyKey(observation.identity.observationId, "CONFIRMED", new Date("2026-08-25T09:25:00.000Z")),
    };
    expect(() => validateNextLifecycleEvent([detected], confirmed)).not.toThrow();
    expect(() => validateNextLifecycleEvent([detected], { ...confirmed, eventType: "DETECTED", sequenceNumber: 2, idempotencyKey: lifecycleIdempotencyKey(observation.identity.observationId, "DETECTED", confirmed.dataThrough) })).toThrow("not permitted");
  });

  it("appends nothing after a terminal lifecycle event", () => {
    // Errata Section 9: once an observation reaches INVALIDATED, EXPIRED or COMPLETED, no further
    // event may ever be appended for that observationId.
    const observation = sealObservation(baseObservation());
    const detected = initialEvent(observation);

    const terminalAt = new Date("2026-08-25T09:30:00.000Z");
    for (const terminalType of ["INVALIDATED", "EXPIRED", "COMPLETED"] as const) {
      const terminal: PatternLifecycleEvent = {
        ...detected,
        eventId: "0192f2a9-6cdb-7000-8000-000000000009",
        eventType: terminalType,
        sequenceNumber: 2,
        dataThrough: terminalAt,
        eventTime: terminalAt,
        knownAt: terminalAt,
        idempotencyKey: lifecycleIdempotencyKey(observation.identity.observationId, terminalType, terminalAt),
      };

      // COMPLETED is only reachable from CONFIRMED, so build the right prefix for each case.
      const prefix = terminalType === "COMPLETED"
        ? [detected, {
            ...detected,
            eventId: "0192f2a9-6cdb-7000-8000-00000000000a",
            eventType: "CONFIRMED" as const,
            sequenceNumber: 2,
            dataThrough: new Date("2026-08-25T09:25:00.000Z"),
            eventTime: new Date("2026-08-25T09:25:00.000Z"),
            knownAt: new Date("2026-08-25T09:25:00.000Z"),
            idempotencyKey: lifecycleIdempotencyKey(observation.identity.observationId, "CONFIRMED", new Date("2026-08-25T09:25:00.000Z")),
          }]
        : [detected];
      const sealedTerminal = { ...terminal, sequenceNumber: prefix.length + 1 };
      expect(() => validateNextLifecycleEvent(prefix, sealedTerminal)).not.toThrow();

      // Nothing may follow it -- not another terminal, and not a re-CONFIRM.
      const laterAt = new Date("2026-08-25T09:35:00.000Z");
      for (const followUp of ["CONFIRMED", "INVALIDATED", "EXPIRED", "COMPLETED"] as const) {
        expect(() => validateNextLifecycleEvent([...prefix, sealedTerminal], {
          ...sealedTerminal,
          eventId: "0192f2a9-6cdb-7000-8000-00000000000b",
          eventType: followUp,
          sequenceNumber: prefix.length + 2,
          dataThrough: laterAt,
          eventTime: laterAt,
          knownAt: laterAt,
          idempotencyKey: lifecycleIdempotencyKey(observation.identity.observationId, followUp, laterAt),
        })).toThrow("not permitted");
      }
    }
  });
});
