import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { PostgresOptionChainRepository, RUN_WINDOW_SECONDS } from "./postgres-option-chain-repository.js";

describe("PostgresOptionChainRepository.storedExpiriesAround", () => {
  it("looks a minute either side of the snapshot, for one underlying, one row per expiry", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const observedAt = new Date("2026-10-26T06:23:01.571Z");

    await new PostgresOptionChainRepository({ query } as unknown as DatabasePool).storedExpiriesAround("NIFTY50", observedAt);

    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("underlying_symbol = $1");
    expect(sql).toContain("BETWEEN $2::timestamptz - make_interval(secs => $3::double precision)");
    expect(sql).toContain("GROUP BY expiry_date");
    expect(sql).toContain("ORDER BY expiry_date");
    expect(values).toEqual(["NIFTY50", observedAt, RUN_WINDOW_SECONDS]);
    // Runs are at least 12 minutes apart; the window must stay far inside that or it would pull in the neighbouring run's books.
    expect(RUN_WINDOW_SECONDS).toBe(60);
  });

  it("returns each expiry as its settlement instant (10:00 UTC on the day) with its kind, in the order the query gives", async () => {
    // node-pg hands a DATE column over as local midnight.
    const query = vi.fn(async () => ({
      rows: [
        { expiry_date: new Date(2026, 9, 27), expiry_kind: "MONTHLY" },
        { expiry_date: new Date(2026, 10, 3), expiry_kind: "WEEKLY" },
      ],
    }));

    const expiries = await new PostgresOptionChainRepository({ query } as unknown as DatabasePool)
      .storedExpiriesAround("NIFTY50", new Date("2026-10-26T06:23:01.571Z"));

    expect(expiries.map((entry) => [entry.expiryDate.toISOString(), entry.expiryKind])).toEqual([
      ["2026-10-27T10:00:00.000Z", "MONTHLY"],
      ["2026-11-03T10:00:00.000Z", "WEEKLY"],
    ]);
  });
});
