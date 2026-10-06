import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../../../infrastructure/database/database.js";
import { upsertSeedCandle, type SeedCandleInput } from "./upsert-seed-candle.js";

function input(overrides: Partial<SeedCandleInput> = {}): SeedCandleInput {
  return {
    instrumentId: "instrument-1",
    timeframe: "1d",
    openTime: new Date("2026-01-05T09:15:00.000Z"),
    closeTime: new Date("2026-01-05T15:30:00.000Z"),
    open: 100,
    high: 104,
    low: 96,
    close: 101,
    volume: 1_000,
    ...overrides,
  };
}

/** Records every statement so the guard can be asserted on, not just the result. */
function clientReturning(...results: Array<Array<{ id: string }>>): {
  client: DatabaseClient;
  statements: string[];
  parameters: unknown[][];
} {
  const statements: string[] = [];
  const parameters: unknown[][] = [];
  let call = 0;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      parameters.push(values ?? []);
      return { rows: results[call++] ?? [] } as never;
    },
  } as unknown as DatabaseClient;
  return { client, statements, parameters };
}

describe("upsertSeedCandle", () => {
  it("guards the conflicting update so a completed candle is never overwritten", async () => {
    // The guard is the entire point: without it a seed run rewrites settled history
    // that the backtests and ML feature builders read. It matches the restriction
    // PostgresCandleRepository.upsert already applies to all real ingestion.
    const { client, statements } = clientReturning([{ id: "candle-1" }]);

    await upsertSeedCandle(client, input());

    expect(statements[0]).toContain("ON CONFLICT");
    expect(statements[0]).toContain("WHERE candles.is_complete = FALSE");
  });

  it("returns the id of a freshly written candle without a second query", async () => {
    const { client, statements } = clientReturning([{ id: "candle-new" }]);

    await expect(upsertSeedCandle(client, input())).resolves.toBe("candle-new");
    expect(statements).toHaveLength(1);
  });

  it("reads the id back when the guard skipped an existing completed candle", async () => {
    // First statement returns nothing, which is what the guard produces on conflict.
    const { client, statements } = clientReturning([], [{ id: "candle-existing" }]);

    await expect(upsertSeedCandle(client, input())).resolves.toBe("candle-existing");
    expect(statements).toHaveLength(2);
    expect(statements[1]).toContain("SELECT id FROM candles");
  });

  it("records the provider in source and the ingestion path in metadata", async () => {
    const { client, parameters } = clientReturning([{ id: "candle-1" }]);

    await upsertSeedCandle(client, input());

    expect(parameters[0]).toContain("yahoo");
    expect(parameters[0]).toContain(JSON.stringify({ ingestedBy: "seed" }));
  });

  it("fails loudly rather than returning a bogus id when the row is neither written nor found", async () => {
    const { client } = clientReturning([], []);

    await expect(upsertSeedCandle(client, input())).rejects.toThrow(/neither written nor found/);
  });
});
