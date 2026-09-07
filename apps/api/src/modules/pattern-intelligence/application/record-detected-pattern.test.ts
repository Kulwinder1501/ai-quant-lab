import { describe, expect, it } from "vitest";
import { calculateDefinitionHash } from "../domain/canonical-hash.js";
import type { AnyDetectedPattern, PatternDefinition, PatternLifecycleEvent } from "../domain/contracts.js";
import { lifecycleIdempotencyKey } from "../domain/lifecycle.js";
import { PatternDefinitionUnavailableError, recordDetectedPattern } from "./record-detected-pattern.js";

function observation(definitionHash: string): AnyDetectedPattern {
  return {
    identity: { observationId: "0192f2a9-6cdb-7000-8000-000000000101", patternFamily: "SWEEP_RECLAIM", patternSubtype: "SPRING", orientation: "UP" },
    source: { exchange: "NSE", underlying: "NIFTY50", instrumentType: "FUTIDX", contractSymbol: "NIFTY26AUGFUT", contractExpiry: new Date("2026-08-27T00:00:00.000Z"), contractRole: "NEAR_MONTH", timeframe: "5m", timezone: "Asia/Kolkata", priceScale: 100, tickSize: 0.05, dataVintageId: "nse-feed:2026-08-25T09:15:00.000Z", dataVintageAt: new Date("2026-08-25T09:15:00.000Z") },
    definitionRef: { definitionId: "sweep-reclaim-v1", definitionVersion: "1.0.0", definitionHash },
    timing: { startAt: new Date("2026-08-25T09:15:00.000Z"), dataThrough: new Date("2026-08-25T09:20:00.000Z"), detectedAt: new Date("2026-08-25T09:20:00.000Z"), knownAt: new Date("2026-08-25T09:20:01.000Z"), earliestExecutionAt: new Date("2026-08-25T09:25:00.000Z") },
    geometry: { durationBars: 2, rangeBps: 12.5, rangeAtr: 0.8 },
    context: { trendState: "DOWN", sessionSegment: "OPENING", volumeZscore: 1.2, rangeZscore: 0.2, effortResultDivergence: 1 },
    details: { kind: "SWEEP_RECLAIM", subtype: "SPRING", wyckoffEquivalent: "SPRING", referenceLevel: 24500, penetrationExcursionBps: 4, reclaimDistanceBps: 7, rejectionWickBps: 5 },
    provenance: { engineVersion: "pi-v1", configVersion: "1.0.0", configHash: "b".repeat(64), dataSource: "nse-feed", dataSchemaVersion: "1", observationHash: "" },
  };
}

function initialEvent(item: AnyDetectedPattern): PatternLifecycleEvent {
  return {
    eventId: "0192f2a9-6cdb-7000-8000-000000000102", eventSchemaVersion: "1.0", observationId: item.identity.observationId,
    eventType: "DETECTED", dataThrough: item.timing.dataThrough, eventTime: item.timing.detectedAt, knownAt: item.timing.knownAt,
    sequenceNumber: 1, idempotencyKey: lifecycleIdempotencyKey(item.identity.observationId, "DETECTED", item.timing.dataThrough), cause: null,
  };
}

describe("recordDetectedPattern", () => {
  it("requires a matching frozen definition and writes the sealed master/event pair together", async () => {
    const definition: PatternDefinition = {
      definitionId: "sweep-reclaim-v1", definitionVersion: "1.0.0", family: "SWEEP_RECLAIM", parameters: { reclaimBars: 2 },
      invalidationConditions: ["close below sweep low"], definitionHash: "", frozenAt: new Date("2026-08-25T00:00:00.000Z"),
    };
    definition.definitionHash = calculateDefinitionHash(definition);
    const item = observation(definition.definitionHash);
    const event = initialEvent(item);
    const calls: unknown[] = [];
    const result = await recordDetectedPattern({ observation: item, initialEvent: event }, {
      definitions: { findFrozen: async () => definition },
      ledger: { insertObservationWithInitialEvent: async (input) => { calls.push(input); } },
    });
    expect(result.provenance.observationHash).toHaveLength(64);
    expect(calls).toHaveLength(1);
  });

  it("refuses persistence when the registry has no frozen definition", async () => {
    const item = observation("a".repeat(64));
    await expect(recordDetectedPattern({ observation: item, initialEvent: initialEvent(item) }, {
      definitions: { findFrozen: async () => null }, ledger: { insertObservationWithInitialEvent: async () => undefined },
    })).rejects.toBeInstanceOf(PatternDefinitionUnavailableError);
  });
});
