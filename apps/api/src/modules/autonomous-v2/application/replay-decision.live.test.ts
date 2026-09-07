import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { policiesChangedMidDecision, replayDecision } from "./replay-decision.js";
import { PostgresDecisionLedger } from "../../../infrastructure/database/repositories/postgres-decision-ledger.js";
import { PostgresSnapshotRegistry } from "../../../infrastructure/database/repositories/postgres-snapshot-registry.js";
import { decisionEventHash, type DecisionLedgerEvent } from "../domain/decision-ledger.js";
import type { DatabasePool } from "../../../infrastructure/database/database.js";

/**
 * Replay end to end: P12 over P3's ledger and P2's registry, against a real database.
 *
 * The hermetic suite proves the reconstruction logic against fakes. This proves the three pieces agree
 * -- that a decision written through the real ledger, whose context was sealed in the real store, reads
 * back as replayable. A defect in the seam between them would pass every unit test on both sides.
 *
 * Transaction-scoped and rolled back, following `postgres-snapshot-registry.test.ts`: both tables
 * refuse DELETE by trigger, so a committing suite could not clean up and could not be run twice.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("replayDecision over the real ledger (live DB)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  const scoped = (): DatabasePool => client as unknown as DatabasePool;

  function eventFor(input: {
    aggregateId: string; version: number; contextSnapshotId: string;
    stateFrom: DecisionLedgerEvent["stateFrom"]; stateTo: DecisionLedgerEvent["stateTo"];
    previousEventHash: string | null; policyVersions?: Record<string, string>;
  }): DecisionLedgerEvent {
    return {
      eventId: `${input.aggregateId}-event-${input.version}`,
      decisionId: input.aggregateId,
      aggregateId: input.aggregateId,
      aggregateVersion: input.version,
      occurredAt: new Date("2026-08-31T09:46:00.000Z"),
      eventType: input.stateTo === "REJECTED" ? "DECISION_REJECTED" : "STAGE_COMPLETED",
      schemaVersion: 1,
      stateFrom: input.stateFrom,
      stateTo: input.stateTo,
      contextSnapshotId: input.contextSnapshotId,
      policyVersions: input.policyVersions ?? { GRID: "GRID_POLICY_V1" },
      correlationId: `${input.aggregateId}-correlation`,
      causationId: null,
      payloadSnapshotId: null,
      previousEventHash: input.previousEventHash,
      producer: { service: "brain", version: "2.2.0", instanceId: "live-test" },
    };
  }

  /** Writes a real decision through the real ledger and returns its aggregate id. */
  async function writeDecision(aggregateId: string, options: { readonly bumpPolicy?: boolean } = {}) {
    const registry = new PostgresSnapshotRegistry(scoped());
    const ledger = new PostgresDecisionLedger(scoped());
    const context = await registry.seal({ probe: "replay-context", aggregateId });

    const first = eventFor({
      aggregateId, version: 1, contextSnapshotId: context.snapshotId,
      stateFrom: "CANDIDATE_RESOLVED", stateTo: "CANDIDATE_RESOLVED", previousEventHash: null,
    });
    await ledger.append({ aggregateId, expectedVersion: 0, event: first });

    const second = eventFor({
      aggregateId, version: 2, contextSnapshotId: context.snapshotId,
      stateFrom: "CANDIDATE_RESOLVED", stateTo: "MARKET_STATE_INTERPRETED",
      previousEventHash: decisionEventHash(first),
      ...(options.bumpPolicy === true ? { policyVersions: { GRID: "GRID_POLICY_V2" } } : {}),
    });
    await ledger.append({ aggregateId, expectedVersion: 1, event: second });

    return { ledger, registry, context };
  }

  it("reads back a decision written through the real ledger as REPLAYABLE", async () => {
    const aggregateId = "replay-sound";
    const { ledger, registry } = await writeDecision(aggregateId);

    const report = await replayDecision({ aggregateId, history: ledger, contexts: registry });

    expect(report.verdict).toBe("REPLAYABLE");
    expect(report.findings).toEqual([]);
    expect(report.eventCount).toBe(2);
    expect(report.contextsResolved).toBe(2);
    expect(report.path).toEqual(["CANDIDATE_RESOLVED", "MARKET_STATE_INTERPRETED"]);
    expect(report.complete).toBe(false);
  });

  it("surfaces a policy that changed between stages of a real decision", async () => {
    const aggregateId = "replay-policy-bump";
    const { ledger, registry } = await writeDecision(aggregateId, { bumpPolicy: true });

    const report = await replayDecision({ aggregateId, history: ledger, contexts: registry });

    expect(report.verdict).toBe("REPLAYABLE");
    expect(policiesChangedMidDecision(report)).toEqual(["GRID: GRID_POLICY_V1 -> GRID_POLICY_V2"]);
  });

  it("cannot be made unreplayable by an unsealed context, because the foreign key refuses it", async () => {
    /*
     * The `UNRESOLVABLE_CONTEXT` finding is deliberately unreachable in production, and this is what
     * makes that claim true rather than assumed: `decision_ledger_context_resolvable` refuses the
     * insert, so the broken state cannot be created in the first place.
     *
     * The finding stays in the replay logic anyway. If it ever fires, the interesting fact is not the
     * missing snapshot -- it is that something reached the table without going through the constraint,
     * and removing the check as redundant would discard the only signal that the guarantee stopped
     * holding.
     */
    const aggregateId = "replay-orphan";
    const ledger = new PostgresDecisionLedger(scoped());

    await client.query("SAVEPOINT before_orphan");
    await expect(ledger.append({
      aggregateId, expectedVersion: 0,
      event: eventFor({
        aggregateId, version: 1, contextSnapshotId: "b".repeat(64),
        stateFrom: "CANDIDATE_RESOLVED", stateTo: "CANDIDATE_RESOLVED", previousEventHash: null,
      }),
    })).rejects.toThrow(/decision_ledger_context_resolvable|foreign key/i);
    await client.query("ROLLBACK TO SAVEPOINT before_orphan");

    // And nothing was recorded, so replay reports no history rather than a partial one.
    const report = await replayDecision({
      aggregateId, history: ledger, contexts: new PostgresSnapshotRegistry(scoped()),
    });
    expect(report.findings).toEqual(["NO_HISTORY"]);
  });

  it("reports a terminated decision as complete", async () => {
    const aggregateId = "replay-terminal";
    const registry = new PostgresSnapshotRegistry(scoped());
    const ledger = new PostgresDecisionLedger(scoped());
    const context = await registry.seal({ probe: "replay-context", aggregateId });

    const first = eventFor({
      aggregateId, version: 1, contextSnapshotId: context.snapshotId,
      stateFrom: "CANDIDATE_RESOLVED", stateTo: "CANDIDATE_RESOLVED", previousEventHash: null,
    });
    await ledger.append({ aggregateId, expectedVersion: 0, event: first });
    await ledger.append({
      aggregateId, expectedVersion: 1,
      event: eventFor({
        aggregateId, version: 2, contextSnapshotId: context.snapshotId,
        stateFrom: "CANDIDATE_RESOLVED", stateTo: "REJECTED",
        previousEventHash: decisionEventHash(first),
      }),
    });

    const report = await replayDecision({ aggregateId, history: ledger, contexts: registry });

    expect(report.verdict).toBe("REPLAYABLE");
    expect(report.complete).toBe(true);
    expect(report.path).toEqual(["CANDIDATE_RESOLVED", "REJECTED"]);
  });

  it("leaves both tables exactly as it found them", async () => {
    // Counted on a separate connection: inside this transaction the other tests' writes are invisible
    // anyway, so counting on `client` would pass whether or not the rollbacks worked.
    const outside = await pool.connect();
    try {
      const ledgerRows = await outside.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM decision_ledger WHERE aggregate_id LIKE 'replay-%'",
      );
      const snapshotRows = await outside.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM decision_snapshots WHERE bytes LIKE '%replay-context%'",
      );
      expect(ledgerRows.rows[0]!.n).toBe(0);
      expect(snapshotRows.rows[0]!.n).toBe(0);
    } finally {
      outside.release();
    }
  });
});
