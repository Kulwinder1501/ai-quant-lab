import { describe, expect, it } from "vitest";
import { PostgresShadowDecisionRepository, type ShadowDecisionInput } from "./postgres-shadow-decision-repository.js";

function makeInput(overrides: Partial<ShadowDecisionInput> = {}): ShadowDecisionInput {
  return {
    accountId: "11111111-1111-1111-1111-111111111111",
    strategyKey: "ict-structure-v1",
    instrumentId: "22222222-2222-2222-2222-222222222222",
    timeframe: "5m",
    sourceCandleId: "33333333-3333-3333-3333-333333333333",
    evaluatedAt: new Date("2026-10-05T10:05:00.000Z"),
    proposalCount: 1,
    decision: "REFUSED",
    contextMetadata: { engineVersion: "ict-state-v2" },
    strategyMetadata: { protectedStatusAtCutoff: "PROTECTED" },
    ...overrides,
  };
}

describe("PostgresShadowDecisionRepository.recordDecision", () => {
  it("inserts with the fields in positional order and JSON-encodes the metadata columns", async () => {
    let capturedSql = "";
    let capturedValues: unknown[] = [];
    const fakeDatabase = {
      query: async (sql: string, values?: unknown[]) => {
        capturedSql = sql;
        capturedValues = values ?? [];
        return { rows: [{ id: "row-1" }] };
      },
    };

    const repository = new PostgresShadowDecisionRepository(fakeDatabase as never);
    const wrote = await repository.recordDecision(makeInput());

    expect(wrote).toBe(true);
    expect(capturedSql).toMatch(/INSERT INTO shadow_decisions/);
    expect(capturedSql).toMatch(/ON CONFLICT \(account_id, strategy_key, source_candle_id\) DO NOTHING/);
    expect(capturedValues[0]).toBe("11111111-1111-1111-1111-111111111111");
    expect(capturedValues[1]).toBe("ict-structure-v1");
    expect(capturedValues[7]).toBe("REFUSED");
    expect(JSON.parse(capturedValues[8] as string)).toEqual({ engineVersion: "ict-state-v2" });
    expect(JSON.parse(capturedValues[9] as string)).toEqual({ protectedStatusAtCutoff: "PROTECTED" });
  });

  it("returns false when the conflict target already holds a row for this bar", async () => {
    const fakeDatabase = { query: async () => ({ rows: [] }) };
    const repository = new PostgresShadowDecisionRepository(fakeDatabase as never);
    expect(await repository.recordDecision(makeInput())).toBe(false);
  });
});
