import { calculateDefinitionHash } from "./canonical-hash.js";
import type {
  AnyDetectedPattern,
  PatternCoverageRecord,
  PatternCoverageRecorder,
  PatternDefinition,
  PatternDefinitionRegistry,
  PatternLifecycleEvent,
  PatternObservationLedger,
} from "./contracts.js";
import { assertDefinitionRegistrable } from "./pattern-definition-registry.js";

/**
 * A registry for ad-hoc definitions, for tests and for callers building their own records.
 *
 * `register` applies `assertDefinitionRegistrable`, the same admission rule
 * `StaticPatternDefinitionRegistry` enforces. Without it this was the laxer of two paths into the
 * same gate — it would happily accept a definition with no invalidation condition, an unnamespaced
 * id or empty parameters, so a test could pass against a record production would refuse. A gate with
 * a second door that does not lock is not a gate.
 */
export class InMemoryPatternDefinitionRegistry implements PatternDefinitionRegistry {
  private readonly definitions = new Map<string, PatternDefinition>();

  register(definition: Omit<PatternDefinition, "definitionHash"> & { definitionHash?: string }): PatternDefinition {
    const withoutHash = {
      definitionId: definition.definitionId,
      definitionVersion: definition.definitionVersion,
      family: definition.family,
      parameters: definition.parameters,
      invalidationConditions: definition.invalidationConditions,
      definitionHash: "",
      frozenAt: definition.frozenAt,
    };
    const definitionHash = calculateDefinitionHash(withoutHash);
    const frozen: PatternDefinition = {
      ...withoutHash,
      definitionHash,
    };
    assertDefinitionRegistrable(frozen);
    const key = `${frozen.definitionId}:${frozen.definitionVersion}`;
    this.definitions.set(key, frozen);
    return frozen;
  }

  async findFrozen(input: { definitionId: string; definitionVersion: string }): Promise<PatternDefinition | null> {
    const key = `${input.definitionId}:${input.definitionVersion}`;
    return this.definitions.get(key) ?? null;
  }
}

export class InMemoryPatternObservationLedger implements PatternObservationLedger {
  readonly observations = new Map<string, AnyDetectedPattern>();
  readonly lifecycleEvents = new Map<string, PatternLifecycleEvent[]>();

  async insertObservationWithInitialEvent(input: {
    observation: AnyDetectedPattern;
    initialEvent: PatternLifecycleEvent;
  }): Promise<void> {
    const obsId = input.observation.identity.observationId;
    if (this.observations.has(obsId)) {
      throw new Error(`Observation with id ${obsId} already exists in ledger.`);
    }
    this.observations.set(obsId, input.observation);
    this.lifecycleEvents.set(obsId, [input.initialEvent]);
  }

  async appendLifecycleEvent(event: PatternLifecycleEvent): Promise<void> {
    const events = this.lifecycleEvents.get(event.observationId);
    if (!events) {
      throw new Error(`No observation found for lifecycle event ${event.observationId}.`);
    }
    events.push(event);
  }
}

/**
 * First-cover-stable coverage store.
 *
 * The `has` check is the in-memory equivalent of the `ON CONFLICT DO NOTHING` a SQL implementation
 * must use: re-running detection over an already-covered window must not advance `recordedAt`, or the
 * value stops dating a feature's earliest availability and starts dating the most recent write —
 * which is exactly why `pattern_detections.detected_at` cannot answer this question.
 */
export class InMemoryPatternCoverageRecorder implements PatternCoverageRecorder {
  readonly records = new Map<string, PatternCoverageRecord>();

  private key(record: PatternCoverageRecord): string {
    const { underlying, timeframe, contractSymbol } = record.source;
    return [underlying, contractSymbol, timeframe, record.fromTime.toISOString(), record.toTime.toISOString()].join("|");
  }

  async recordCoverage(record: PatternCoverageRecord): Promise<void> {
    const key = this.key(record);
    if (this.records.has(key)) return;
    this.records.set(key, record);
  }
}
