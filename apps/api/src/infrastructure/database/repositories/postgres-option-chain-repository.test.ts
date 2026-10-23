import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import type { OptionChainSnapshot } from "../../../modules/market-data/domain/option-chain.js";
import { PostgresOptionChainRepository, vendorGreeksFromRow } from "./postgres-option-chain-repository.js";

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

describe("PostgresOptionChainRepository vendor greeks", () => {
  function snapshot(vendorGreeks: unknown): OptionChainSnapshot {
    return {
      underlyingSymbol: "NIFTY50",
      provider: "fyers-api-v3",
      observedAt: new Date("2026-10-23T09:06:00.000Z"),
      underlyingValue: 22_543.25,
      listedExpiries: [],
      quotes: [{
        expiryDate: new Date("2026-10-27T10:00:00.000Z"),
        expiryKind: "MONTHLY",
        strikePrice: 22_500,
        optionType: "CE",
        providerSymbol: "NSE:NIFTY26OCT22500CE",
        providerToken: "tok",
        lastPrice: 195.4, bid: 195.3, ask: 195.6, volume: 100, openInterest: 6_500, previousOpenInterest: 6_000,
        openInterestChange: 500,
        vendorGreeks: vendorGreeks as never,
      }],
    };
  }

  function fakePool() {
    const calls: unknown[][] = [];
    const client = {
      query: vi.fn(async (_sql: string, values?: unknown[]) => {
        if (values) calls.push(values);
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    return { pool: { connect: async () => client } as unknown as DatabasePool, calls };
  }

  it("writes the provider's values in its own units, after the existing columns", async () => {
    const { pool, calls } = fakePool();
    await new PostgresOptionChainRepository(pool).saveSnapshot(snapshot({
      delta: 0.61, gamma: 0.0011, theta: -17, vega: 9.1, impliedVolatilityPercent: 15.11,
    }));
    const values = calls[0]!;
    expect(values).toHaveLength(22);
    expect(values.slice(16)).toEqual([22_543.25, 0.61, 0.0011, -17, 9.1, 15.11]);
  });

  it("writes NULL, not zero, when the provider sent none or only some", async () => {
    const none = fakePool();
    await new PostgresOptionChainRepository(none.pool).saveSnapshot(snapshot(undefined));
    expect(none.calls[0]!.slice(17)).toEqual([null, null, null, null, null]);

    const partial = fakePool();
    await new PostgresOptionChainRepository(partial.pool).saveSnapshot(snapshot({
      delta: null, gamma: null, theta: 0, vega: null, impliedVolatilityPercent: 15,
    }));
    // A reported zero theta is a value; the missing ones are not.
    expect(partial.calls[0]!.slice(17)).toEqual([null, null, 0, null, 15]);
  });

  it("selects the five columns when reading the latest snapshot", async () => {
    const query = vi.fn(async (sql: string) => (sql.includes("max(observed_at)")
      ? { rows: [{ observed_at: new Date("2026-10-23T09:06:00.000Z") }] }
      : { rows: [] }));
    await new PostgresOptionChainRepository({ query } as unknown as DatabasePool).latestSnapshot({ underlyingSymbol: "NIFTY50" });
    const readSql = (query.mock.calls as unknown as Array<[string]>).map((c) => c[0]).find((sql) => sql.includes("provider_symbol"))!;
    for (const column of ["vendor_delta", "vendor_gamma", "vendor_theta", "vendor_vega", "vendor_iv_percent"]) {
      expect(readSql).toContain(column);
    }
  });
});

describe("vendorGreeksFromRow", () => {
  it("maps stored columns back, converting numeric strings from the driver", () => {
    expect(vendorGreeksFromRow({
      vendor_delta: "0.610000", vendor_gamma: "0.00110000", vendor_theta: "-17.0000", vendor_vega: "9.1000", vendor_iv_percent: "15.1100",
    })).toEqual({ delta: 0.61, gamma: 0.0011, theta: -17, vega: 9.1, impliedVolatilityPercent: 15.11 });
  });

  it("reads all-NULL as null (not observed), never as an object of nulls or zeros", () => {
    expect(vendorGreeksFromRow({
      vendor_delta: null, vendor_gamma: null, vendor_theta: null, vendor_vega: null, vendor_iv_percent: null,
    })).toBeNull();
    expect(vendorGreeksFromRow({})).toBeNull();
  });

  it("keeps a stored zero as a value", () => {
    expect(vendorGreeksFromRow({ vendor_theta: "0.0000" })).toMatchObject({ theta: 0, delta: null });
  });
});
