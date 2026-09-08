import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database.js";
import { PostgresDecisionLedger } from "./postgres-decision-ledger.js";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import type { SnapshotRegistry } from "../../../modules/platform/snapshot/snapshot-registry.js";
import {
  decisionEventHash,
  type DecisionEventType,
  type DecisionLedgerEvent,
} from "../../../modules/autonomous-v2/domain/decision-ledger.js";
import type { DecisionState } from "../../../modules/autonomous-v2/domain/decision-lifecycle.js";
import type { ShadowLedgerPort } from "../../../modules/autonomous-v2/application/shadow-decision.js";

/**
 * Writes a shadow decision to the real decision ledger.
 *
 * A shadow decision is not a dry run: the record is authoritative about what V2.2 decided, and P13
 * later grades V1 against it. So it goes through the same append-only ledger, the same content-addressed
 * snapshot reference and the same version arbitration as a decision with authority. Only authority
 * differs.
 *
 * ## Two events, because the ledger refuses an invented prior state
 *
 * `assertAppendable` requires the first event of an aggregate to record *arrival* at
 * `CANDIDATE_RESOLVED`, with `stateFrom` equal to `stateTo` — the opening event is not a move between
 * two states, and requiring one would force an invented predecessor. Its own comment says it: *"an
 * invented state in the ledger is a record of something that did not happen."*
 *
 * A shadow decision that terminates immediately therefore writes two events: the decision existed,
 * and then it ended. That is a truthful sequence rather than a bookkeeping tax — a reader can see
 * that a decision was opened at all, which matters when the terminal reason is "we have no rule".
 *
 * ## The snapshot must already be sealed
 *
 * `decision_ledger.context_snapshot_id` carries an FK to `decision_snapshots` (migration 087's
 * `decision_ledger_context_resolvable`), so a caller seals the market snapshot through the registry
 * first and passes its id. That ordering is the point of the constraint: a ledger entry pointing at a
 * context nobody stored would replay as an empty decision rather than as a missing dependency.
 */

const SERVICE = "autonomous-v2-shadow";
const SERVICE_VERSION = "1";

/** How a thesis outcome lands in the ledger's vocabulary. */
function terminalFor(outcome: string): { readonly eventType: DecisionEventType; readonly stateTo: DecisionState } {
  switch (outcome) {
    case "REJECTED": return { eventType: "DECISION_REJECTED", stateTo: "REJECTED" };
    case "DEFERRED": return { eventType: "DECISION_DEFERRED", stateTo: "DEFERRED" };
    case "NO_ACTION": return { eventType: "DECISION_CLOSED_NO_ACTION", stateTo: "CLOSED_NO_ACTION" };
    /*
     * An approval in shadow advances one stage and stops. THESIS_FORMED is the honest state: a thesis
     * exists, and the edge, risk and instrument stages were not run — shadow mode holds no authority
     * to select an instrument. Recording it as EXECUTED would claim a position that does not exist.
     */
    case "APPROVED": return { eventType: "STAGE_COMPLETED", stateTo: "THESIS_FORMED" };
    default:
      throw new Error(`Unmapped thesis outcome "${outcome}": refusing to invent a ledger state for it.`);
  }
}

export class PostgresShadowLedger implements ShadowLedgerPort {
  private readonly registry: SnapshotRegistry;

  constructor(
    private readonly database: DatabasePool,
    private readonly instanceId: string,
    registry?: SnapshotRegistry,
  ) {
    this.registry = registry ?? new PostgresSnapshotRegistry(database);
  }

  async append(input: {
    readonly decisionId: string;
    readonly contextSnapshotId: string;
    readonly policyVersions: Readonly<Record<string, string>>;
    readonly outcome: string;
    readonly detail: string;
  }): Promise<void> {
    const producer = { service: SERVICE, version: SERVICE_VERSION, instanceId: this.instanceId };
    const correlationId = input.decisionId;
    const occurredAt = new Date();

    /*
     * The reason, sealed as its own snapshot and referenced by the terminal event.
     *
     * `detail` used to arrive here and go nowhere: both events hardcoded `payloadSnapshotId: null`,
     * so the ledger recorded THAT a decision refused and never WHY. Measured 2026-09-08: 2,204
     * terminal events across three weeks of shadow operation, and not one could say whether it
     * refused on the executable-window gate or on a real one -- which is the only question the
     * shadow phase exists to answer. `terminalFor` collapses every outcome into four event types, so
     * nothing downstream could recover it either.
     *
     * Sealed BEFORE the transaction below, deliberately. Snapshots are content-addressed and
     * append-only, so a snapshot whose event never commits is unreferenced rather than wrong, and
     * re-sealing the same reason yields the same id. Sealing inside the transaction would trade that
     * harmless orphan for a longer write lock on the shared snapshot table.
     */
    const payload = await this.registry.seal({
      kind: "SHADOW_DECISION_OUTCOME",
      outcome: input.outcome,
      detail: input.detail,
    });

    const opening: DecisionLedgerEvent = {
      eventId: randomUUID(),
      decisionId: input.decisionId,
      aggregateId: input.decisionId,
      aggregateVersion: 1,
      occurredAt,
      eventType: "STAGE_COMPLETED",
      schemaVersion: 1,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo: "CANDIDATE_RESOLVED",
      contextSnapshotId: input.contextSnapshotId,
      policyVersions: input.policyVersions,
      correlationId,
      causationId: null,
      /*
       * The opening event carries no payload: it records that the decision existed, and at that
       * point there is no outcome to explain. The reason belongs to the event that terminates it.
       */
      payloadSnapshotId: null,
      previousEventHash: null,
      producer,
    };

    const { eventType, stateTo } = terminalFor(input.outcome);
    const closing: DecisionLedgerEvent = {
      ...opening,
      eventId: randomUUID(),
      aggregateVersion: 2,
      eventType,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo,
      causationId: opening.eventId,
      payloadSnapshotId: payload.snapshotId,
      previousEventHash: decisionEventHash(opening),
    };

    /*
     * Both events in one transaction, because a decision with an opening and no terminal is not a
     * partial record -- it is a false one. It says a decision was opened and is still live.
     *
     * They were two independent appends on two pooled connections. `SHADOW_DECISION` failed 12 times
     * on 2026-09-03 and left exactly 12 aggregates stranded at CANDIDATE_RESOLVED, which is still
     * how they read today. Nothing has failed since, so this was dormant rather than fixed.
     */
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const ledger = new PostgresDecisionLedger(client);
      await ledger.append({ aggregateId: input.decisionId, expectedVersion: 0, event: opening });
      await ledger.append({ aggregateId: input.decisionId, expectedVersion: 1, event: closing });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
