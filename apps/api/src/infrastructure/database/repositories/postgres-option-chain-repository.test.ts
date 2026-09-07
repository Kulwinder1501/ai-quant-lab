import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { PostgresOptionChainRepository } from "./postgres-option-chain-repository.js";

describe("PostgresOptionChainRepository point-in-time reads", () => {
  it("bounds the expiry calendar before selecting its latest observation", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const asOf = new Date("2026-08-13T09:30:01.616Z");

    await new PostgresOptionChainRepository({ query } as unknown as DatabasePool)
      .latestExpiryCalendar("NIFTY50", asOf);

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("observed_at <= $2");
    expect(values).toEqual(["NIFTY50", asOf]);
  });

  it("bounds the chain snapshot before max(observed_at)", async () => {
    const query = vi.fn(async () => ({ rows: [{ observed_at: null }] }));
    const asOf = new Date("2026-08-13T09:30:01.616Z");

    await new PostgresOptionChainRepository({ query } as unknown as DatabasePool).latestSnapshot({
      underlyingSymbol: "NIFTY50",
      expiryDate: "2026-08-18",
      asOf,
    });

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("observed_at <= $3");
    expect(values).toEqual(["NIFTY50", "2026-08-18", asOf]);
  });
});
