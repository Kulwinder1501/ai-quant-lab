import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../../../infrastructure/database/database.js";
import { VolatilityRiskControl } from "./risk-control.js";

function databaseWith(rows: Array<{ prediction: string; confidence: string }>) {
  const query = vi.fn(async () => ({ rows }));
  return { database: { query } as unknown as DatabasePool, query };
}

describe("VolatilityRiskControl", () => {
  it("reduces rather than increases exposure on confident expansion", async () => {
    const { database } = databaseWith([{ prediction: "EXPANSION", confidence: "0.8" }]);
    await expect(new VolatilityRiskControl(database).evaluateRisk({
      baseLots: 2,
      instrumentId: "instrument-1",
      asOf: new Date("2026-08-07T05:00:00Z"),
    })).resolves.toEqual({ regime: "EXPANSION", adjustedLots: 1, stopMultiplier: 1 });
  });

  it("ignores low-confidence evidence", async () => {
    const { database } = databaseWith([{ prediction: "EXPANSION", confidence: "0.49" }]);
    await expect(new VolatilityRiskControl(database).evaluateRisk({
      baseLots: 1,
      instrumentId: "instrument-1",
    })).resolves.toEqual({ regime: "UNKNOWN", adjustedLots: 1, stopMultiplier: 1 });
  });

  it("queries only fresh production evidence for the requested instrument", async () => {
    const { database, query } = databaseWith([]);
    const asOf = new Date("2026-08-07T05:00:00Z");
    await new VolatilityRiskControl(database).evaluateRisk({
      baseLots: 1,
      instrumentId: "instrument-7",
      asOf,
      maxAgeMinutes: 30,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("m.stage = 'PRODUCTION'"),
      ["instrument-7", asOf, 30],
    );
  });

  it("rejects an invalid base size before querying", async () => {
    const { database, query } = databaseWith([]);
    await expect(new VolatilityRiskControl(database).evaluateRisk({
      baseLots: 0,
      instrumentId: "instrument-1",
    })).rejects.toThrow("baseLots");
    expect(query).not.toHaveBeenCalled();
  });
});
