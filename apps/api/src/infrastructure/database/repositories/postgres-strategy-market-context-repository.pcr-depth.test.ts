import { describe, expect, it } from "vitest";
import { PostgresStrategyMarketContextRepository } from "./postgres-strategy-market-context-repository.js";
import type { DatabaseQueryable } from "../database.js";

/**
 * Orchestration tests for the option-chain PCR as-of join and the depth lookup, using an
 * injected fake database (no Postgres needed). They pin WHICH expiry / contract / time bounds the
 * repository asks for; the SQL text itself is exercised by the live-DB tests in the sibling file.
 */

interface RecordedQuery { sql: string; params: unknown[] }

/** IST wall-clock -> UTC instant. */
function ist(date: string, time: string): Date {
  return new Date(new Date(`${date}T${time}.000Z`).getTime() - 330 * 60_000);
}

function fakeDatabase(
  respond: (sql: string, params: unknown[]) => unknown[],
): { database: DatabaseQueryable; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const database = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: respond(sql, params), rowCount: 0 };
    },
  } as unknown as DatabaseQueryable;
  return { database, queries };
}

function candle(symbol: string, closeTime: Date) {
  return {
    id: "c1", instrument_id: "i1", timeframe: "5m",
    open_time: new Date(closeTime.getTime() - 5 * 60_000), close_time: closeTime,
    open: "100", high: "100", low: "100", close: "100", volume: "1", tick_size: "0.05", symbol,
  };
}

type Private = {
  resolveOptionChainSignal(input: unknown, candle: unknown): Promise<Record<string, unknown> | undefined>;
  resolveConfluenceSignal(input: unknown, candle: unknown): Promise<Record<string, unknown> | undefined>;
};
const asPrivate = (repository: PostgresStrategyMarketContextRepository) => repository as unknown as Private;
const input = { instrumentId: "i1", timeframe: "5m" };

describe("resolveOptionChainSignal: expiry is chosen before the snapshot", () => {
  const closeTime = ist("2026-09-21", "11:00:00");

  function respond(snapshotAt: Date | null, aggregate = { call_oi: "100000", put_oi: "140000", contracts: "30", missing_oi: "0" }) {
    return (sql: string) => {
      if (sql.includes("FROM instruments")) return [{ symbol: "NIFTY50" }];
      if (sql.includes("FROM option_expiry_calendar")) {
        return [
          { expiry_date: "2026-09-29", expiry_kind: "MONTHLY" },
          { expiry_date: "2026-09-22", expiry_kind: "WEEKLY" },
          { expiry_date: "2026-10-06", expiry_kind: "WEEKLY" },
        ];
      }
      if (sql.includes("SELECT observed_at")) return snapshotAt ? [{ observed_at: snapshotAt }] : [];
      if (sql.includes("COUNT(*)")) return [aggregate];
      return [];
    };
  }

  it("asks for the NEAREST expiry's snapshot, not the farther roll book", async () => {
    const observedAt = new Date(closeTime.getTime() - 6 * 60_000);
    const { database, queries } = fakeDatabase(respond(observedAt));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", closeTime));

    const snapshotQuery = queries.find((query) => query.sql.includes("SELECT observed_at"))!;
    expect(snapshotQuery.params[1]).toBe("2026-09-22");
    expect(snapshotQuery.sql).toContain("expiry_date = $2::date");
    // Session hygiene: 09:15-15:30 IST only.
    expect(snapshotQuery.sql).toContain("TIME '09:15:00' AND TIME '15:30:00'");
    const aggregateQuery = queries.find((query) => query.sql.includes("COUNT(*)"))!;
    expect(aggregateQuery.params[1]).toBe("2026-09-22");
    expect(signal).toMatchObject({ pcr: 1.4, pcrWindowed: 1.4, expiryDate: "2026-09-22", unavailableReason: null });
  });

  it("skips an expiry that settled at 15:30 IST and uses the next one", async () => {
    const afterSettlement = ist("2026-09-22", "15:30:00");
    const { database, queries } = fakeDatabase(respond(new Date(afterSettlement.getTime() - 60_000)));

    await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", afterSettlement));

    expect(queries.find((query) => query.sql.includes("SELECT observed_at"))!.params[1]).toBe("2026-09-29");
  });

  it("reports STALE explicitly when the newest in-session snapshot is older than 20 minutes", async () => {
    const { database } = fakeDatabase(respond(new Date(closeTime.getTime() - 25 * 60_000)));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", closeTime));

    expect(signal).toMatchObject({ pcr: null, unavailableReason: "STALE", unavailableMessage: "PCR unavailable (stale)" });
  });

  it("accepts an 18-minute-old snapshot (healthy collector cadence)", async () => {
    const { database } = fakeDatabase(respond(new Date(closeTime.getTime() - 18 * 60_000)));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", closeTime));

    expect(signal?.pcr).toBe(1.4);
  });

  it("reports NO_SNAPSHOT when no in-session snapshot exists for the expiry", async () => {
    const { database } = fakeDatabase(respond(null));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", closeTime));

    expect(signal).toMatchObject({ pcr: null, unavailableReason: "NO_SNAPSHOT", expiryDate: "2026-09-22" });
  });

  it("reports INCOMPLETE_OPEN_INTEREST rather than a PCR biased by missing put OI", async () => {
    const { database } = fakeDatabase(respond(
      new Date(closeTime.getTime() - 60_000),
      { call_oi: "100000", put_oi: "0", contracts: "30", missing_oi: "4" },
    ));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", closeTime));

    expect(signal).toMatchObject({ pcr: null, unavailableReason: "INCOMPLETE_OPEN_INTEREST" });
  });

  it("reports NO_UNSETTLED_EXPIRY when the calendar has nothing left", async () => {
    const late = ist("2026-10-06", "15:31:00");
    const { database } = fakeDatabase((sql) => {
      if (sql.includes("FROM instruments")) return [{ symbol: "NIFTY50" }];
      if (sql.includes("FROM option_expiry_calendar")) return [{ expiry_date: "2026-10-06", expiry_kind: "WEEKLY" }];
      return [];
    });

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveOptionChainSignal(input, candle("NIFTY50", late));

    expect(signal).toMatchObject({ pcr: null, unavailableReason: "NO_UNSETTLED_EXPIRY" });
  });
});

describe("resolveConfluenceSignal: depth is looked up on the front-month futures contract", () => {
  const closeTime = ist("2026-10-09", "11:00:00");

  function respond(symbol: string, depthRows: unknown[]) {
    return (sql: string) => {
      if (sql.includes("FROM instruments")) return [{ symbol }];
      if (sql.includes("liquidity_pool_candidates")) return [{ pool_type: "SESSION_HIGH", price: "100.05" }];
      if (sql.includes("FROM option_expiry_calendar")) {
        return [
          { expiry_date: "2026-10-27", expiry_kind: "MONTHLY" },
          { expiry_date: "2026-10-13", expiry_kind: "WEEKLY" },
          { expiry_date: "2026-11-24", expiry_kind: "MONTHLY" },
        ];
      }
      if (sql.includes("FROM depth_frames")) return depthRows;
      return [];
    };
  }

  it("queries NSE:BANKNIFTY26OCTFUT (not 'BANKNIFTY') bounded to 5 seconds before the close", async () => {
    const { database, queries } = fakeDatabase(respond("BANKNIFTY", [{
      bid_price: ["100"], bid_qty: ["500"], ask_price: ["100.05"], ask_qty: ["100"],
      total_buy_qty: "5000", total_sell_qty: "1000",
    }]));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    const depthQuery = queries.find((query) => query.sql.includes("FROM depth_frames"))!;
    expect(depthQuery.params[0]).toBe("NSE:BANKNIFTY26OCTFUT");
    expect(depthQuery.params[1]).toEqual(closeTime);
    expect(depthQuery.params[2]).toEqual(new Date(closeTime.getTime() - 5_000));
    expect(depthQuery.sql).toContain("received_at >= $3");
    expect(signal?.raw_di).not.toBeNull();
    expect(signal?.depth_state).toBeUndefined();
  });

  it("maps NIFTY50 to the NIFTY futures ticker and reports no depth when nothing was captured", async () => {
    const { database, queries } = fakeDatabase(respond("NIFTY50", []));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("NIFTY50", closeTime));

    expect(queries.find((query) => query.sql.includes("FROM depth_frames"))!.params[0]).toBe("NSE:NIFTY26OCTFUT");
    expect(signal).toMatchObject({
      is_level_proximate: true,
      raw_di: null,
      di_tilde: null,
      gate_action: "NO_ACTION",
      depth_state: "NO_DEPTH",
    });
  });

  it("returns raw_di null (never 0) when no qualifying frame exists", async () => {
    const { database } = fakeDatabase(respond("BANKNIFTY", []));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    expect(signal?.raw_di).toBeNull();
    expect(signal?.depth_state).toBe("NO_DEPTH");
  });

  it("reports no depth, without querying frames, when no futures contract can be resolved", async () => {
    const { database, queries } = fakeDatabase((sql) => {
      if (sql.includes("FROM instruments")) return [{ symbol: "XAU_USD" }];
      if (sql.includes("liquidity_pool_candidates")) return [{ pool_type: "SESSION_HIGH", price: "100.05" }];
      return [];
    });

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("XAU_USD", closeTime));

    expect(queries.some((query) => query.sql.includes("FROM depth_frames"))).toBe(false);
    expect(signal).toMatchObject({ raw_di: null, depth_state: "NO_DEPTH" });
  });
});
