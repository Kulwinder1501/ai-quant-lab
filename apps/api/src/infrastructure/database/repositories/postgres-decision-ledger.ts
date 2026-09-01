import type { DatabasePool } from "../database.js";
import {
  assertAppendable,
  decisionEventHash,
  type DecisionLedgerEvent,
} from "../../../modules/autonomous-v2/domain/decision-ledger.js";
import { researchIdentityEncodingVersion } from "../../../modules/platform/identity/identity.js";

/**
 * The append-only ledger store: Brain P3's persistence for I13, I15, I23 and I24.
 *
 * ## `expectedVersion` is checked by the constraint, not by a read
 *
 * `append` writes at `expectedVersion + 1` and lets
 * `decision_ledger_aggregate_version_key` decide. There is no "read the head, compare, then write"
 * sequence, because that sequence has a window in which another writer can slip between the read and
 * the write -- and no amount of care in application code closes it.
 *
 * The domain validation still runs first, against the head this caller believes in. That is not
 * redundant: the constraint proves *someone* got version N, and the domain check proves the event
 * being written continues the chain legally. A constraint cannot express "stateFrom continues from the
 * head" or "previousEventHash matches"; only the loser of a race learns its head was stale.
 *
 * ## Why a duplicate event id can succeed
 *
 * A producer that retries after a network blip resends the same event. Failing that retry would make
 * the ledger hostile to the ordinary conditions it runs under, so an identical re-append is idempotent
 * and returns the stored row. A duplicate id with *different* content is a genuine defect and throws --
 * the same shape as the snapshot registry's content-conflict check, and for the same reason: the case
 * that cannot legitimately arise must be loud, because silence there corrupts the record everything
 * else is reconstructed from.
 */

export class LedgerVersionConflictError extends Error {
  constructor(readonly aggregateId: string, readonly expectedVersion: number) {
    super(
      `Aggregate ${aggregateId} has moved past version ${expectedVersion}: another writer appended `
      + "first. Re-read the head and rebuild the event -- the chain it was built against no longer exists.",
    );
    this.name = "LedgerVersionConflictError";
  }
}

export class LedgerEventConflictError extends Error {
  constructor(readonly eventId: string) {
    super(
      `Event ${eventId} already exists with different content. A repeated id carrying different facts `
      + "is a producer defect, not a retry, and accepting it would make the ledger disagree with itself.",
    );
    this.name = "LedgerEventConflictError";
  }
}

export interface AppendResult {
  readonly aggregateVersion: number;
  /** Global append order, assigned by the database. */
  readonly sequence: number;
  /** True when an identical event was already present and this call was a retry. */
  readonly deduplicated: boolean;
}

export class PostgresDecisionLedger {
  constructor(
    private readonly database: DatabasePool,
    /** The encoding that addresses this event's context snapshot. */
    private readonly contextEncodingVersion: string = researchIdentityEncodingVersion,
  ) {}

  /** The current head of an aggregate, or null when it has no events. */
  async head(aggregateId: string): Promise<DecisionLedgerEvent | null> {
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT * FROM decision_ledger
      WHERE aggregate_id = $1
      ORDER BY aggregate_version DESC
      LIMIT 1
    `, [aggregateId]);
    const row = result.rows[0];
    return row === undefined ? null : rowToEvent(row);
  }

  async readAggregate(aggregateId: string): Promise<readonly DecisionLedgerEvent[]> {
    const result = await this.database.query<Record<string, unknown>>(`
      SELECT * FROM decision_ledger WHERE aggregate_id = $1 ORDER BY aggregate_version ASC
    `, [aggregateId]);
    return result.rows.map(rowToEvent);
  }

  /**
   * Appends one event, enforcing `expectedVersion` atomically.
   *
   * `expectedVersion` is 0 for a new aggregate, so the opening event lands at 1 and the caller never
   * has to special-case "no head yet" with a sentinel.
   */
  async append(input: {
    readonly aggregateId: string;
    readonly expectedVersion: number;
    readonly event: DecisionLedgerEvent;
  }): Promise<AppendResult> {
    const { aggregateId, expectedVersion, event } = input;
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error(`expectedVersion must be a non-negative integer; got ${expectedVersion}.`);
    }
    if (event.aggregateId !== aggregateId) {
      throw new Error(`Event aggregateId ${event.aggregateId} does not match the append target ${aggregateId}.`);
    }
    if (event.aggregateVersion !== expectedVersion + 1) {
      throw new Error(
        `Event aggregateVersion ${event.aggregateVersion} must be expectedVersion + 1 `
        + `(${expectedVersion + 1}); the version written is what the constraint arbitrates.`,
      );
    }

    // Validated against the head this caller believes in. The constraint decides who wins the race;
    // this decides whether the event was legal at all, which a constraint cannot express.
    const head = expectedVersion === 0 ? null : await this.head(aggregateId);
    assertAppendable({ event, head });

    const eventHash = decisionEventHash(event);
    /*
     * `ON CONFLICT DO NOTHING` rather than catching the unique violation.
     *
     * Learned by failing: the first version let the INSERT raise and then read back to classify the
     * conflict. Inside a transaction that cannot work -- a raised statement aborts the transaction and
     * every later command returns "current transaction is aborted", so the classifying query failed
     * instead of answering. The exception-based shape only appears to work outside a transaction, which
     * is not where a ledger append belongs.
     *
     * `DO NOTHING` without a conflict target covers *both* unique constraints and raises nothing, so
     * the transaction stays healthy and the follow-up query can say which one it was.
     */
    const inserted = await this.database.query<{ sequence: string; aggregate_version: number }>(`
      INSERT INTO decision_ledger (
        event_id, decision_id, aggregate_id, aggregate_version, occurred_at, event_type,
        schema_version, state_from, state_to, context_encoding_version, context_snapshot_id,
        policy_versions, correlation_id, causation_id, payload_snapshot_id, previous_event_hash,
        event_hash, producer_service, producer_version, producer_instance_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT DO NOTHING
      RETURNING sequence, aggregate_version
    `, [
      event.eventId, event.decisionId, event.aggregateId, event.aggregateVersion, event.occurredAt,
      event.eventType, event.schemaVersion, event.stateFrom, event.stateTo,
      this.contextEncodingVersion, event.contextSnapshotId,
      JSON.stringify(event.policyVersions), event.correlationId, event.causationId,
      event.payloadSnapshotId, event.previousEventHash, eventHash,
      event.producer.service, event.producer.version, event.producer.instanceId,
    ]);

    const row = inserted.rows[0];
    if (row !== undefined) {
      return { aggregateVersion: row.aggregate_version, sequence: Number(row.sequence), deduplicated: false };
    }

    /*
     * The event id is checked first, and the order is the semantics.
     *
     * An identical retry conflicts on *both* constraints -- same event id and same aggregate version --
     * so testing the version first would report a retry as a lost race and make a producer rebuild an
     * event that was already durably stored.
     */
    const byEventId = await this.database.query<{ event_hash: string; sequence: string; aggregate_version: number }>(`
      SELECT event_hash, sequence, aggregate_version FROM decision_ledger WHERE event_id = $1
    `, [event.eventId]);
    const stored = byEventId.rows[0];
    if (stored !== undefined) {
      if (stored.event_hash !== eventHash) throw new LedgerEventConflictError(event.eventId);
      return {
        aggregateVersion: stored.aggregate_version,
        sequence: Number(stored.sequence),
        deduplicated: true,
      };
    }

    // A different event already holds this version: another writer appended first.
    throw new LedgerVersionConflictError(aggregateId, expectedVersion);
  }
}

function rowToEvent(row: Record<string, unknown>): DecisionLedgerEvent {
  return {
    eventId: row.event_id as string,
    decisionId: row.decision_id as string,
    aggregateId: row.aggregate_id as string,
    aggregateVersion: Number(row.aggregate_version),
    occurredAt: row.occurred_at as Date,
    eventType: row.event_type as DecisionLedgerEvent["eventType"],
    schemaVersion: Number(row.schema_version),
    stateFrom: row.state_from as DecisionLedgerEvent["stateFrom"],
    stateTo: row.state_to as DecisionLedgerEvent["stateTo"],
    contextSnapshotId: row.context_snapshot_id as string,
    policyVersions: row.policy_versions as Readonly<Record<string, string>>,
    correlationId: row.correlation_id as string,
    causationId: (row.causation_id ?? null) as string | null,
    payloadSnapshotId: (row.payload_snapshot_id ?? null) as string | null,
    previousEventHash: (row.previous_event_hash ?? null) as string | null,
    producer: {
      service: row.producer_service as string,
      version: row.producer_version as string,
      instanceId: row.producer_instance_id as string,
    },
  };
}
