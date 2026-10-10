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

describe("resolveConfluenceSignal: di_tilde is causally detrended from same-session prior-minute DI", () => {
  const closeTime = ist("2026-10-09", "11:00:00");
  const sessionStartUtc = ist("2026-10-09", "00:00:00");
  const minute = 60_000;

  /** A DISTINCT-ON-per-minute history row, `minutesBefore` whole minutes before the close's minute. */
  const historyRow = (minutesBefore: number, buy: string, sell: string) => ({
    received_at: new Date(closeTime.getTime() - minutesBefore * minute - 20_000),
    total_buy_qty: buy,
    total_sell_qty: sell,
  });

  function respond(currentFrame: Record<string, unknown>, history: unknown[]) {
    return (sql: string) => {
      if (sql.includes("FROM instruments")) return [{ symbol: "BANKNIFTY" }];
      if (sql.includes("liquidity_pool_candidates")) return [{ pool_type: "SESSION_HIGH", price: "100.05" }];
      if (sql.includes("FROM option_expiry_calendar")) return [{ expiry_date: "2026-10-27", expiry_kind: "MONTHLY" }];
      if (sql.includes("FROM depth_frames") && sql.includes("DISTINCT ON")) return history;
      if (sql.includes("FROM depth_frames")) return [currentFrame];
      return [];
    };
  }

  // Frame received 2s before the close (the decision cutoff): raw DI = (650-1350)/2000 = -0.35.
  const currentFrame = (buy = "650", sell = "1350") => ({
    received_at: new Date(closeTime.getTime() - 2_000),
    bid_price: ["100"], bid_qty: ["500"], ask_price: ["100.05"], ask_qty: ["100"],
    total_buy_qty: buy, total_sell_qty: sell,
  });

  it("returns di_tilde null with UNAVAILABLE_HISTORY (never 0) at the start of a session", async () => {
    const { database } = fakeDatabase(respond(currentFrame(), [1, 2, 3].map((n) => historyRow(n, "650", "1350"))));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    expect(signal?.raw_di).toBeCloseTo(-0.35, 12);
    expect(signal?.di_tilde).toBeNull();
    expect(signal?.di_status).toBe("UNAVAILABLE_HISTORY");
    expect(signal?.di_history_count).toBe(3);
    expect(signal?.gate_action).toBe("NO_ACTION");
  });

  it("yields di_tilde ~ 0 for a persistently one-sided book, not a constant sign", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => historyRow(i + 1, "650", "1350"));
    const { database } = fakeDatabase(respond(currentFrame(), rows));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    expect(signal?.di_status).toBe("OK");
    expect(Math.abs(signal?.di_tilde as number)).toBeLessThan(1e-9);
    expect(signal?.gate_action).toBe("NO_ACTION");
  });

  it("is positive when the book is more sell-heavy than its own trailing baseline", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => historyRow(i + 1, "650", "1350"));
    const { database } = fakeDatabase(respond(currentFrame("500", "1500"), rows)); // raw DI -0.5 vs -0.35 baseline

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    expect(signal?.di_tilde).toBeCloseTo(0.15, 12);
    expect(signal?.gate_action).toBe("BUY_PUT_OR_SHORT");
  });

  it("bounds the history query to this contract, this IST session, and strictly before the decision minute", async () => {
    const { database, queries } = fakeDatabase(respond(currentFrame(), []));

    await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    const historyQuery = queries.find((q) => q.sql.includes("DISTINCT ON"))!;
    const [symbol, from, until] = historyQuery.params as [string, Date, Date];
    expect(symbol).toBe("NSE:BANKNIFTY26OCTFUT");
    expect(historyQuery.sql).toContain("received_at >= $2");
    expect(historyQuery.sql).toContain("received_at < $3");
    // 11:00 close, frame at 10:59:58 -> its minute is 10:59, history ends strictly before it.
    expect(until.getTime()).toBe(ist("2026-10-09", "10:59:00").getTime());
    expect(until.getTime()).toBeLessThanOrEqual(closeTime.getTime());
    expect(from.getTime()).toBe(until.getTime() - 30 * minute);
    expect(from.getTime()).toBeGreaterThanOrEqual(sessionStartUtc.getTime());
    // Missing totals are filtered in SQL, never turned into DI = 0.
    expect(historyQuery.sql).toContain("total_buy_qty IS NOT NULL");
  });

  it("does not reach back across midnight at the start of the day", async () => {
    const early = ist("2026-10-09", "00:10:00");
    const frame = { ...currentFrame(), received_at: new Date(early.getTime() - 2_000) };
    const { database, queries } = fakeDatabase(respond(frame, []));

    await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", early));

    const [, from] = queries.find((q) => q.sql.includes("DISTINCT ON"))!.params as [string, Date, Date];
    expect(from.getTime()).toBe(sessionStartUtc.getTime());
  });

  it("ignores history rows from a previous session or at/after the frame, even if the query returned them", async () => {
    const stale = Array.from({ length: 30 }, (_, i) => ({
      ...historyRow(i + 1, "1900", "100"), // very buy-heavy yesterday
      received_at: new Date(sessionStartUtc.getTime() - (i + 1) * minute),
    }));
    const future = [{ ...historyRow(0, "100", "1900"), received_at: new Date(closeTime.getTime() - 1_000) }];
    const { database } = fakeDatabase(respond(currentFrame(), [...stale, ...future]));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    expect(signal?.di_history_count).toBe(0);
    expect(signal?.di_tilde).toBeNull();
  });

  it("treats a frame with a missing total as no raw DI rather than a one-sided book", async () => {
    const { database } = fakeDatabase(respond({ ...currentFrame(), total_sell_qty: null }, []));

    const signal = await asPrivate(new PostgresStrategyMarketContextRepository(database))
      .resolveConfluenceSignal(input, candle("BANKNIFTY", closeTime));

    expect(signal?.raw_di).toBeNull();
    expect(signal?.di_tilde).toBeNull();
    expect(signal?.di_status).toBe("UNAVAILABLE_DEPTH");
  });
});

describe("point-in-time evidence reads use known_at, not detected_at", () => {
  it("assembleContext filters pattern_detections and price_action_events on known_at <= the candle close", async () => {
    const closeTime = ist("2026-10-09", "11:00:00");
    const { database, queries } = fakeDatabase(() => []);
    const repository = new PostgresStrategyMarketContextRepository(database);

    // Only the evidence queries issued up front matter here; with an empty fake database the later
    // optional resolvers (regime / ICT) may give up, which is irrelevant to this assertion.
    await (repository as unknown as {
      assembleContext(i: unknown, c: unknown): Promise<unknown>;
    }).assembleContext(input, candle("BANKNIFTY", closeTime)).catch(() => undefined);

    const strip = (sql: string) => sql.replace(/--.*$/gm, "");
    const patterns = queries.find((q) => q.sql.includes("FROM pattern_detections"))!;
    const events = queries.find((q) => q.sql.includes("FROM price_action_events"))!;
    expect(patterns.sql).toContain("pattern_detections.known_at <= $2");
    expect(events.sql).toContain("AND known_at <= $2");
    expect(strip(patterns.sql)).not.toContain("detected_at");
    expect(strip(events.sql)).not.toContain("detected_at");
    expect(patterns.params).toEqual(["c1", closeTime]);
    expect(events.params).toEqual(["c1", closeTime]);
  });
});
