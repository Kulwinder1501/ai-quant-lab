import type { DatabasePool } from "../database.js";
import { PostgresDecisionLedger } from "./postgres-decision-ledger.js";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import { logicalKey } from "../../../modules/platform/identity/identity.js";
import {
  decisionEventHash,
  type DecisionEventType,
  type DecisionLedgerEvent,
} from "../../../modules/autonomous-v2/domain/decision-ledger.js";
import type { DecisionState, LiveDecisionState } from "../../../modules/autonomous-v2/domain/decision-lifecycle.js";
import type { DecisionPipelineRun } from "../../../modules/autonomous-v2/domain/decision-pipeline.js";

/**
 * Writes a Decision Pipeline run (`decision-pipeline.ts`) to the real decision ledger.
 *
 * `decision-pipeline.ts` is a pure function; its own docstring deferred real ledger events because
 * building them needs a real snapshot store and process metadata a pure function cannot fabricate.
 * Both exist now (`PostgresDecisionLedger`, `PostgresSnapshotRegistry`), so this is that adapter.
 *
 * ## The template: `postgres-shadow-ledger.ts`
 *
 * That file already solved the one non-obvious rule here: `assertAppendable` (`decision-ledger.ts`)
 * requires the *first* event of an aggregate to record arrival at `CANDIDATE_RESOLVED`
 * (`stateFrom === stateTo`), so even a run whose `lineage` is `null` -- P5 itself deferred or found
 * nothing -- still gets an opening event. "A truthful sequence rather than a bookkeeping tax," per that
 * file's own docstring. This adapter generalises the same idea from a fixed two-event shape (shadow mode
 * never runs past a thesis) to a full walk of however many live states this pipeline actually reached.
 *
 * ## Payloads are sealed, not left null
 *
 * `postgres-shadow-ledger.ts` has nothing stage-shaped to seal and leaves `payloadSnapshotId: null`
 * throughout. This pipeline's lineage carries a real, distinct value per state
 * (`stages.candidates`/`.marketState`/`.thesis`/...), so each `STAGE_COMPLETED` event seals that state's
 * actual value and carries it as `payloadSnapshotId`. The final terminal event (when the outcome is not
 * `EXECUTED`) seals `run.outcome` itself, so a reader can see *why* without re-deriving it.
 *
 * ## Event ids are deterministic, not random
 *
 * `postgres-shadow-ledger.ts` uses `randomUUID()` per event, so a full retry of `.append(...)` (a
 * network blip, a restart) mints new ids that collide on `(aggregateId, aggregateVersion)` rather than
 * being recognised as the same event -- `PostgresDecisionLedger`'s own dedup path only fires on a
 * matching event id. Not a defect fixed in that file (untouched, out of scope); a choice available to
 * this new one: `eventId = logicalKey("decision-ledger-event", [decisionId, aggregateVersion, stateFrom,
 * stateTo])` makes a full re-run of this adapter naturally idempotent, the same content-addressing
 * discipline every other id in this codebase already follows.
 */

const SERVICE = "autonomous-v2-pipeline";
const SERVICE_VERSION = "1";

/** How a pipeline outcome that stopped short of EXECUTED lands in the ledger's vocabulary. */
function terminalFor(outcome: DecisionPipelineRun["outcome"]): {
  readonly eventType: DecisionEventType;
  readonly stateTo: DecisionState;
} {
  switch (outcome.kind) {
    case "REJECTED": return { eventType: "DECISION_REJECTED", stateTo: "REJECTED" };
    case "DEFERRED": return { eventType: "DECISION_DEFERRED", stateTo: "DEFERRED" };
    case "CLOSED_NO_ACTION": return { eventType: "DECISION_CLOSED_NO_ACTION", stateTo: "CLOSED_NO_ACTION" };
    case "EXECUTED":
      throw new Error("terminalFor is only for a run that stopped short of EXECUTED.");
  }
}

interface Hop {
  readonly stateFrom: DecisionState;
  readonly stateTo: DecisionState;
  readonly eventType: DecisionEventType;
  /** Sealed via the snapshot registry when present; null when there is genuinely nothing to seal. */
  readonly payload: unknown;
}

/** The ordered hops this run's aggregate must write, from CANDIDATE_RESOLVED to wherever it stopped. */
function hopsFor(run: DecisionPipelineRun): readonly Hop[] {
  const hops: Hop[] = [];

  if (run.lineage === null) {
    hops.push({ stateFrom: "CANDIDATE_RESOLVED", stateTo: "CANDIDATE_RESOLVED", eventType: "STAGE_COMPLETED", payload: null });
  } else {
    const payloadByState: Partial<Record<LiveDecisionState, unknown>> = {
      CANDIDATE_RESOLVED: run.stages.candidates,
      MARKET_STATE_INTERPRETED: run.stages.marketState,
      THESIS_FORMED: run.stages.thesis,
      EDGE_ASSESSED: run.stages.edge,
      RISK_APPROVED: run.stages.risk,
      INSTRUMENT_SELECTED: run.stages.instrument,
      EXECUTED: run.stages.execution,
    };
    const entries = run.lineage.entries;
    hops.push({
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo: "CANDIDATE_RESOLVED",
      eventType: "STAGE_COMPLETED",
      payload: payloadByState.CANDIDATE_RESOLVED ?? null,
    });
    for (let index = 1; index < entries.length; index += 1) {
      const previous = entries[index - 1]!;
      const current = entries[index]!;
      hops.push({
        stateFrom: previous.state,
        stateTo: current.state,
        eventType: "STAGE_COMPLETED",
        payload: payloadByState[current.state] ?? null,
      });
    }
  }

  if (run.outcome.kind !== "EXECUTED") {
    const last = hops[hops.length - 1]!;
    const { eventType, stateTo } = terminalFor(run.outcome);
    hops.push({ stateFrom: last.stateTo, stateTo, eventType, payload: run.outcome });
  }

  return hops;
}

export class PostgresDecisionPipelineLedger {
  private readonly ledger: PostgresDecisionLedger;
  private readonly snapshots: PostgresSnapshotRegistry;

  constructor(database: DatabasePool, private readonly instanceId: string) {
    this.ledger = new PostgresDecisionLedger(database);
    this.snapshots = new PostgresSnapshotRegistry(database);
  }

  /**
   * Writes every hop this run reached as one ledger aggregate. Idempotent under a full retry.
   *
   * `PostgresDecisionLedger.append`'s own dedup path only recognises a retry of the *last* unconfirmed
   * write -- it validates every event against the aggregate's real current head, so replaying an entire
   * historical sequence from version 1 fails once the head has moved past that point (a `LedgerAppendError`,
   * not a silent no-op). So this resumes from wherever the aggregate already stands rather than always
   * starting at version 1: a fresh decision starts from nothing, a full retry finds every hop already
   * written and appends nothing further, and a resume after a partial write (a crash mid-sequence)
   * continues from the real head -- the same three cases, one mechanism.
   */
  async append(run: DecisionPipelineRun): Promise<void> {
    const contextRef = await this.snapshots.seal(run.context);
    const producer = { service: SERVICE, version: SERVICE_VERSION, instanceId: this.instanceId };
    const hops = hopsFor(run);

    let previous = await this.ledger.head(run.decisionId);
    const alreadyWritten = previous?.aggregateVersion ?? 0;

    for (const [index, hop] of hops.entries()) {
      const aggregateVersion = index + 1;
      if (aggregateVersion <= alreadyWritten) continue;

      const payloadSnapshotId = hop.payload === null || hop.payload === undefined
        ? null
        : (await this.snapshots.seal(hop.payload)).snapshotId;

      const event: DecisionLedgerEvent = {
        eventId: logicalKey("decision-ledger-event", [run.decisionId, aggregateVersion, hop.stateFrom, hop.stateTo]),
        decisionId: run.decisionId,
        aggregateId: run.decisionId,
        aggregateVersion,
        occurredAt: run.context.decisionAt,
        eventType: hop.eventType,
        schemaVersion: 1,
        stateFrom: hop.stateFrom,
        stateTo: hop.stateTo,
        contextSnapshotId: contextRef.snapshotId,
        policyVersions: run.context.policyVersions,
        correlationId: run.decisionId,
        causationId: previous === null ? null : previous.eventId,
        payloadSnapshotId,
        previousEventHash: previous === null ? null : decisionEventHash(previous),
        producer,
      };

      await this.ledger.append({ aggregateId: run.decisionId, expectedVersion: aggregateVersion - 1, event });
      previous = event;
    }
  }
}
