import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresDecisionPipelineLedger } from "./postgres-decision-pipeline-ledger.js";
import { PostgresDecisionLedger } from "./postgres-decision-ledger.js";
import { PostgresSnapshotRegistry } from "./postgres-snapshot-registry.js";
import { assertLedgerChain } from "../../../modules/autonomous-v2/domain/decision-ledger.js";
import { runDecisionPipeline, type DecisionPipelineInput } from "../../../modules/autonomous-v2/domain/decision-pipeline.js";
import type { LegacyPatternObservation, ObservationOrientation } from "../../../modules/autonomous-v2/application/pattern-adapter.js";
import type { InstrumentRiskSnapshot } from "../../../modules/platform/risk/risk-snapshot.js";
import type { OptionChainQuote, OptionChainSnapshot } from "../../../modules/market-data/domain/option-chain.js";
import { snapshotRefFor, type SnapshotRef } from "../../../modules/platform/snapshot/snapshot-ref.js";
import { sealPitInstants, type PitInstants } from "../../../modules/platform/pit/pit-instants.js";
import type { DatabasePool } from "../database.js";

/**
 * The Decision Pipeline Ledger's persistence guarantees, against a real database.
 *
 * Every test runs inside a transaction that is rolled back, following `postgres-decision-ledger.test.ts`:
 * `decision_ledger` refuses UPDATE/DELETE by trigger, so a suite that committed could not clean up.
 */
const databaseUrl = process.env.DATABASE_URL;

const decisionAt = new Date("2026-09-14T09:25:00.000Z");
const observedIn: SnapshotRef = snapshotRefFor({ bar: "NIFTY50@09:25" });
const nearExpiry = new Date("2026-09-14T15:30:00.000Z");
const farExpiry = new Date("2026-09-21T15:30:00.000Z");

const instants: Readonly<PitInstants> = sealPitInstants({
  eventAt: decisionAt,
  knownAt: new Date(decisionAt.getTime() + 1_000),
  dataThrough: new Date(decisionAt.getTime() - 1),
  dataThroughConvention: "CLOSE_LABELLED",
  earliestExecutionAt: new Date(decisionAt.getTime() + 2_000),
  referenceAt: new Date(decisionAt.getTime() + 2_000),
});

function patternObservation(orientation: ObservationOrientation): LegacyPatternObservation {
  return {
    provenance: "LEGACY_CANDLESTICK",
    patternCode: "FIXTURE",
    algorithmVersion: "v1",
    orientation,
    detectorConfidence: 0.8,
    contextCandleIds: ["c1"],
    details: {},
    instants,
    observedIn,
  };
}

function context(decisionId: string) {
  return Object.freeze({
    decisionId,
    decisionAt,
    evaluationAt: decisionAt,
    schedulerLagMs: 0,
    instants,
    snapshotRef: observedIn,
    policyVersions: Object.freeze({ pipeline: "TEST" }),
  });
}

function accountSnapshot(overrides: Partial<InstrumentRiskSnapshot<unknown>> = {}): InstrumentRiskSnapshot<unknown> {
  return {
    accountEquity: 1_000_000,
    peakEquity: 1_000_000,
    openPositionCount: 0,
    realizedPnlToday: 0,
    volatilityRegime: null,
    ...overrides,
  };
}

function quote(overrides: Partial<OptionChainQuote> = {}): OptionChainQuote {
  return {
    expiryDate: farExpiry,
    expiryKind: "WEEKLY",
    strikePrice: 24_000,
    optionType: "CE",
    providerSymbol: "NIFTY24000CE",
    providerToken: null,
    lastPrice: 101,
    bid: 100,
    ask: 102,
    volume: 1_000,
    openInterest: 5_000,
    previousOpenInterest: 4_800,
    openInterestChange: 200,
    ...overrides,
  };
}

function decisionChain(): OptionChainSnapshot {
  const strikes = [23_900, 24_000, 24_100];
  const expiries = [
    { expiryDate: nearExpiry, expiryKind: "WEEKLY" as const },
    { expiryDate: farExpiry, expiryKind: "WEEKLY" as const },
  ];
  const quotes: OptionChainQuote[] = [];
  for (const { expiryDate, expiryKind } of expiries) {
    for (const strike of strikes) {
      for (const optionType of ["CE", "PE"] as const) {
        quotes.push(quote({ expiryDate, expiryKind, strikePrice: strike, optionType }));
      }
    }
  }
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: 24_000,
    quotes,
    listedExpiries: expiries,
  };
}

function executionChain(): OptionChainSnapshot {
  return {
    underlyingSymbol: "NIFTY50",
    provider: "fixture",
    observedAt: decisionAt,
    underlyingValue: 24_000,
    quotes: [
      quote({ strikePrice: 24_000, optionType: "CE", expiryDate: farExpiry }),
      quote({ strikePrice: 24_000, optionType: "PE", expiryDate: farExpiry }),
    ],
    listedExpiries: [{ expiryDate: farExpiry, expiryKind: "WEEKLY" }],
  };
}

function input(decisionId: string, overrides: Partial<DecisionPipelineInput> = {}): DecisionPipelineInput {
  return {
    decisionId,
    instrumentSymbol: "NIFTY50",
    context: context(decisionId),
    patternObservations: [patternObservation("UP")],
    patternCoverage: "LOADED",
    volatilityReading: null,
    institutionalFlow: { fiiCashNetCr: null, diiCashNetCr: null },
    tickSize: 25,
    entryReference: 24_000,
    atrValue: 50,
    costBps: 5,
    accountSnapshot: accountSnapshot(),
    lotSize: 75,
    optionChain: decisionChain(),
    executionChain: executionChain(),
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)("PostgresDecisionPipelineLedger (live DB)", () => {
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

  it("writes exactly 7 events for a run that reached EXECUTED, in lifecycle order", async () => {
    const run = runDecisionPipeline(input("decision-ledger-executed"));
    expect(run.outcome).toEqual({ kind: "EXECUTED" });

    const pipelineLedger = new PostgresDecisionPipelineLedger(scoped(), "test-instance");
    await pipelineLedger.append(run);

    const events = await new PostgresDecisionLedger(scoped()).readAggregate(run.decisionId);
    expect(events.map((event) => event.stateTo)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
      "EDGE_ASSESSED",
      "RISK_APPROVED",
      "INSTRUMENT_SELECTED",
      "EXECUTED",
    ]);
    expect(events.every((event) => event.eventType === "STAGE_COMPLETED")).toBe(true);
    assertLedgerChain(events);
  });

  it("writes exactly 2 events for a null-lineage run (closed with no action)", async () => {
    const run = runDecisionPipeline(input("decision-ledger-no-action", { patternObservations: [] }));
    expect(run.outcome.kind).toBe("CLOSED_NO_ACTION");
    expect(run.lineage).toBeNull();

    const pipelineLedger = new PostgresDecisionPipelineLedger(scoped(), "test-instance");
    await pipelineLedger.append(run);

    const events = await new PostgresDecisionLedger(scoped()).readAggregate(run.decisionId);
    expect(events.map((event) => ({ stateFrom: event.stateFrom, stateTo: event.stateTo, eventType: event.eventType }))).toEqual([
      { stateFrom: "CANDIDATE_RESOLVED", stateTo: "CANDIDATE_RESOLVED", eventType: "STAGE_COMPLETED" },
      { stateFrom: "CANDIDATE_RESOLVED", stateTo: "CLOSED_NO_ACTION", eventType: "DECISION_CLOSED_NO_ACTION" },
    ]);
    assertLedgerChain(events);
  });

  it("writes an early-termination aggregate whose terminal event's stateFrom is the last live state reached", async () => {
    // NONE-oriented pattern -> both thesis sides rejected -> dies at THESIS_FORMED.
    const run = runDecisionPipeline(input("decision-ledger-rejected", {
      patternObservations: [patternObservation("NONE")],
    }));
    expect(run.outcome.kind).toBe("REJECTED");
    expect(run.lineage?.entries.map((entry) => entry.state)).toEqual([
      "CANDIDATE_RESOLVED",
      "MARKET_STATE_INTERPRETED",
      "THESIS_FORMED",
    ]);

    const pipelineLedger = new PostgresDecisionPipelineLedger(scoped(), "test-instance");
    await pipelineLedger.append(run);

    const events = await new PostgresDecisionLedger(scoped()).readAggregate(run.decisionId);
    expect(events).toHaveLength(4); // CANDIDATE_RESOLVED (x2 hops) + MARKET_STATE_INTERPRETED + terminal
    const terminal = events[events.length - 1]!;
    expect(terminal.stateFrom).toBe("THESIS_FORMED");
    expect(terminal.stateTo).toBe("REJECTED");
    expect(terminal.eventType).toBe("DECISION_REJECTED");
  });

  it("seals each stage's own payload, resolvable back to the exact stage value", async () => {
    const run = runDecisionPipeline(input("decision-ledger-payload"));
    const pipelineLedger = new PostgresDecisionPipelineLedger(scoped(), "test-instance");
    await pipelineLedger.append(run);

    const events = await new PostgresDecisionLedger(scoped()).readAggregate(run.decisionId);
    const marketStateEvent = events.find((event) => event.stateTo === "MARKET_STATE_INTERPRETED")!;
    expect(marketStateEvent.payloadSnapshotId).not.toBeNull();

    const registry = new PostgresSnapshotRegistry(scoped());
    const resolved = await registry.resolve({
      snapshotId: marketStateEvent.payloadSnapshotId!,
      encodingVersion: "canonical-json-sha256-v1",
    });
    expect(JSON.parse(resolved)).toMatchObject({ interpretationId: run.stages.marketState!.interpretationId });
  });

  it("is idempotent under a full retry: appending the same run twice does not throw or duplicate", async () => {
    const run = runDecisionPipeline(input("decision-ledger-retry"));
    const pipelineLedger = new PostgresDecisionPipelineLedger(scoped(), "test-instance");

    await pipelineLedger.append(run);
    await expect(pipelineLedger.append(run)).resolves.toBeUndefined();

    const events = await new PostgresDecisionLedger(scoped()).readAggregate(run.decisionId);
    expect(events).toHaveLength(7);
  });
});
