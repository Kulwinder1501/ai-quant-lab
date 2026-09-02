import { randomUUID } from "node:crypto";
import type { DatabasePool } from "../database.js";
import { PostgresDecisionLedger } from "./postgres-decision-ledger.js";
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
  private readonly ledger: PostgresDecisionLedger;

  constructor(private readonly database: DatabasePool, private readonly instanceId: string) {
    this.ledger = new PostgresDecisionLedger(database);
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
      payloadSnapshotId: null,
      previousEventHash: null,
      producer,
    };
    await this.ledger.append({ aggregateId: input.decisionId, expectedVersion: 0, event: opening });

    const { eventType, stateTo } = terminalFor(input.outcome);
    const closing: DecisionLedgerEvent = {
      ...opening,
      eventId: randomUUID(),
      aggregateVersion: 2,
      eventType,
      stateFrom: "CANDIDATE_RESOLVED",
      stateTo,
      causationId: opening.eventId,
      previousEventHash: decisionEventHash(opening),
    };
    await this.ledger.append({ aggregateId: input.decisionId, expectedVersion: 1, event: closing });
  }
}
