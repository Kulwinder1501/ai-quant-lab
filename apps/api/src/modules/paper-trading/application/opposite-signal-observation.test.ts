import { describe, expect, it, vi } from "vitest";
import {
  OPPOSITE_SIGNAL_OBSERVATION_CODE,
  OPPOSITE_SIGNAL_WINDOW_MINUTES,
  observeOppositeSignal,
  type ObservationDatabase,
} from "./opposite-signal-observation.js";

const now = new Date("2026-10-13T05:20:00.000Z");

function databaseReturning(count: number | string): ObservationDatabase & { query: ReturnType<typeof vi.fn> } {
  return { query: vi.fn(async () => ({ rows: [{ opposite_count: count }] })) };
}

describe("observeOppositeSignal", () => {
  it("stamps the trade when an opposite-direction entry exists in the window", async () => {
    const database = databaseReturning("1");
    const note = await observeOppositeSignal({
      database, accountId: "acc", underlyingSymbol: "NIFTY50", optionType: "CE", now,
    });
    expect(note).toContain(OPPOSITE_SIGNAL_OBSERVATION_CODE);
    expect(note).toContain("log-only");
  });

  it("returns null when there is none", async () => {
    const note = await observeOppositeSignal({
      database: databaseReturning(0), accountId: "acc", underlyingSymbol: "NIFTY50", optionType: "PE", now,
    });
    expect(note).toBeNull();
  });

  it("looks back exactly the window, for the same account and underlying, against the other option type", async () => {
    const database = databaseReturning(0);
    await observeOppositeSignal({
      database, accountId: "acc", underlyingSymbol: "BANKNIFTY", optionType: "PE", now,
    });
    const [sql, values] = database.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("account_id = $1");
    expect(sql).toContain("underlying_symbol = $2");
    expect(sql).toContain("option_type <> $3");
    expect(values[0]).toBe("acc");
    expect(values[1]).toBe("BANKNIFTY");
    expect(values[2]).toBe("PE");
    expect((values[3] as Date).getTime()).toBe(now.getTime() - OPPOSITE_SIGNAL_WINDOW_MINUTES * 60_000);
    expect(values[4]).toBe(now);
  });

  it("never blocks an entry: a failed lookup yields null and does not throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const database: ObservationDatabase = { query: vi.fn(async () => { throw new Error("connection reset"); }) };
    await expect(observeOppositeSignal({
      database, accountId: "acc", underlyingSymbol: "NIFTY50", optionType: "CE", now,
    })).resolves.toBeNull();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
