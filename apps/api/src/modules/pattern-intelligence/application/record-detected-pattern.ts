import { calculateDefinitionHash } from "../domain/canonical-hash.js";
import type {
  AnyDetectedPattern,
  PatternDefinitionRegistry,
  PatternLifecycleEvent,
  PatternObservationLedger,
} from "../domain/contracts.js";
import { validateInitialLifecycleEvent } from "../domain/lifecycle.js";
import { assertDefinitionFamily, sealObservation } from "../domain/observation-validation.js";

export class PatternDefinitionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternDefinitionUnavailableError";
  }
}

export interface RecordDetectedPatternDependencies {
  definitions: PatternDefinitionRegistry;
  ledger: PatternObservationLedger;
}

/**
 * The only write path for a newly detected V1.0.1 observation. It enforces the
 * implementation gate, seals the immutable record, and delegates the required
 * atomic master-record + DETECTED-event write to the ledger.
 */
export async function recordDetectedPattern(
  input: { observation: AnyDetectedPattern; initialEvent: PatternLifecycleEvent },
  dependencies: RecordDetectedPatternDependencies,
): Promise<AnyDetectedPattern> {
  const definition = await dependencies.definitions.findFrozen({
    definitionId: input.observation.definitionRef.definitionId,
    definitionVersion: input.observation.definitionRef.definitionVersion,
  });
  if (!definition) {
    throw new PatternDefinitionUnavailableError("A frozen PatternDefinition record is required before a detector may persist an observation.");
  }
  if (definition.definitionHash !== input.observation.definitionRef.definitionHash) {
    throw new PatternDefinitionUnavailableError("Observation definitionHash does not match the frozen PatternDefinition record.");
  }
  if (definition.definitionHash !== calculateDefinitionHash(definition)) {
    throw new PatternDefinitionUnavailableError("Stored PatternDefinition definitionHash does not match its canonical frozen payload.");
  }

  assertDefinitionFamily(definition.family, input.observation);
  const observation = sealObservation(input.observation);
  validateInitialLifecycleEvent(observation, input.initialEvent);
  await dependencies.ledger.insertObservationWithInitialEvent({ observation, initialEvent: input.initialEvent });
  return observation;
}
