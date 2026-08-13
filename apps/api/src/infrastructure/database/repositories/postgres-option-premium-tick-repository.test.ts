import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { PostgresOptionPremiumTickRepository } from "./postgres-option-premium-tick-repository.js";

const CONTRACT = {
  underlyingSymbol: "BANKNIFTY",
  expiryDate: new Date("2026-08-25T10:00:00.000Z"),
  strikePrice: 57700,
  optionType: "CE" as const,
};

function row(observedAt: string, bid: number): Record<string, unknown> {
  return {
    underlying_symbol: "BANKNIFTY",
    provider: "fyers-api-v3",
    observed_at: new Date(observedAt),
    expiry_date: "2026-08-25",
    strike_price: "57700",
    option_type: "CE",
    provider_symbol: "NSE:BANKNIFTY26AUG57700CE",
    last_price: String(bid),
    bid: String(bid),
    ask: String(bid + 1.5),
    volume: "1000",
    underlying_value: "57644",
  };
}

function poolReturning(rows: Array<Record<string, unknown>>): { pool: DatabasePool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows }));
  return { pool: { query } as unknown as DatabasePool, query };
}

describe("PostgresOptionPremiumTickRepository.latestForContract", () => {
  it("bounds the row to observed_at <= now inside SQL, before LIMIT 1", async () => {
    // The bound has to be in the query rather than a post-filter. Taking the newest row overall
    // and then rejecting a negative age threw the lookup away instead of falling back to the
    // newest row the caller was entitled to see, which is how a continuously quoted contract
    // reported "no quote".
    const now = new Date("2026-08-13T06:55:00.019Z");
    const { pool, query } = poolReturning([row("2026-08-13T06:54:26.254Z", 577.45)]);

    await new PostgresOptionPremiumTickRepository(pool).latestForContract(CONTRACT, 2 * 60_000, now);

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain("observed_at <= $5");
    expect(sql.indexOf("observed_at <= $5")).toBeLessThan(sql.indexOf("LIMIT 1"));
    expect(parameters).toEqual(["BANKNIFTY", "2026-08-25", 57700, "CE", now]);
  });

  it("returns the newest in-window tick rather than nothing when a newer tick exists", async () => {
    // The AutoBot incident, 2026-08-13. The run was claimed at 06:55:00.019 and a tick for this
    // contract was written at 06:55:00.696 -- 676ms later. The old query selected that row and
    // then discarded it for having a negative age, so the caller saw no quote at all, fell back
    // to a theoretical premium and booked STOP_LOSS at 519.58 while the book was bid 576-581,
    // above the position's own 579.36 target.
    //
    // With the bound in SQL the future row is never a candidate, and the 06:54:26 tick -- 34s
    // old, well inside the 120s window -- is returned. That bid holds the position instead.
    const now = new Date("2026-08-13T06:55:00.019Z");
    const { pool } = poolReturning([row("2026-08-13T06:54:26.254Z", 577.45)]);

    const tick = await new PostgresOptionPremiumTickRepository(pool)
      .latestForContract(CONTRACT, 2 * 60_000, now);

    expect(tick).not.toBeNull();
    expect(tick!.bid).toBe(577.45);
    expect(tick!.observedAt).toEqual(new Date("2026-08-13T06:54:26.254Z"));
  });

  it("still rejects a tick older than the freshness window", async () => {
    // Narrowing the future bound must not have widened the staleness one: a stale book pricing a
    // live position is the failure this window exists to prevent.
    const now = new Date("2026-08-13T06:55:00.019Z");
    const { pool } = poolReturning([row("2026-08-13T06:50:00.000Z", 540)]);

    await expect(new PostgresOptionPremiumTickRepository(pool)
      .latestForContract(CONTRACT, 2 * 60_000, now)).resolves.toBeNull();
  });

  it("returns null when the contract has no observation at or before now", async () => {
    const { pool } = poolReturning([]);

    await expect(new PostgresOptionPremiumTickRepository(pool)
      .latestForContract(CONTRACT, 2 * 60_000, new Date("2026-08-13T06:55:00.019Z")))
      .resolves.toBeNull();
  });
});

describe("PostgresOptionPremiumTickRepository.listForContractBetween", () => {
  it("reads (after, to] oldest first, so the earliest barrier crossing is found first", async () => {
    // Oldest-first is what makes the barrier scan correct: a position exits at the first moment a
    // level was reached. Newest-first would report a level that was touched and recovered from as
    // never having been touched.
    const after = new Date("2026-08-13T06:45:00.000Z");
    const to = new Date("2026-08-13T06:55:00.019Z");
    const { pool, query } = poolReturning([
      row("2026-08-13T06:46:00.100Z", 545),
      row("2026-08-13T06:54:26.254Z", 577.45),
    ]);

    const ticks = await new PostgresOptionPremiumTickRepository(pool)
      .listForContractBetween(CONTRACT, after, to);

    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]];
    // Exclusive lower bound: the sample a position opened on must not immediately close it,
    // matching the source-bar convention in `decidePaperTradeExit`.
    expect(sql).toContain("observed_at > $5");
    expect(sql).toContain("observed_at <= $6");
    expect(sql).toContain("ORDER BY observed_at ASC");
    // No LIMIT: truncating the window would drop the oldest crossings and report a later exit.
    expect(sql).not.toContain("LIMIT");
    expect(parameters).toEqual(["BANKNIFTY", "2026-08-25", 57700, "CE", after, to]);

    expect(ticks.map((tick) => tick.bid)).toEqual([545, 577.45]);
  });

  it("returns an empty list for a contract with no observations in the window", async () => {
    const { pool } = poolReturning([]);

    await expect(new PostgresOptionPremiumTickRepository(pool).listForContractBetween(
      CONTRACT,
      new Date("2026-08-13T06:45:00.000Z"),
      new Date("2026-08-13T06:55:00.019Z"),
    )).resolves.toEqual([]);
  });
});
