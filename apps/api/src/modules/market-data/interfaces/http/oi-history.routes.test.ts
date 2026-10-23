import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerMarketDataRoutes } from "./market-data.routes.js";

type Row = {
  observedAt: Date;
  strikePrice: number;
  optionType: "CE" | "PE";
  openInterest: number | null;
  previousOpenInterest: number | null;
  underlyingValue: number | null;
};

/** 2026-10-12 is a Monday; IST = UTC + 5:30. */
function ist(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 9, 12) + (hour * 60 + minute - 330) * 60_000);
}

function row(when: Date, strikePrice: number, optionType: "CE" | "PE", oi: number | null, prev: number | null): Row {
  return { observedAt: when, strikePrice, optionType, openInterest: oi, previousOpenInterest: prev, underlyingValue: 22_510 };
}

interface Calls {
  sessions: unknown[];
  rows: unknown[];
}

function fakeRepository(options: { sessions: boolean; rows: Row[] }, calls: Calls) {
  return {
    async oiHistorySessions(input: unknown) {
      calls.sessions.push(input);
      return options.sessions
        ? [{ sessionDate: "2026-10-12", snapshotCount: 3, firstObservedAt: ist(9, 11), lastObservedAt: ist(9, 41) }]
        : [];
    },
    async oiHistoryRows(input: { expiryDate?: string | null }) {
      calls.rows.push(input);
      return { expiryDate: options.rows.length === 0 ? (input.expiryDate ?? null) : "2026-10-27", rows: options.rows };
    },
  };
}

let server: Server | null = null;

async function start(options: { sessions: boolean; rows: Row[] }): Promise<{ base: string; calls: Calls }> {
  const calls: Calls = { sessions: [], rows: [] };
  const app: Express = express();
  registerMarketDataRoutes(app, { optionChainRepository: fakeRepository(options, calls) } as never);
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status(500).json({ error: String(error) });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const SESSION_ROWS: Row[] = [
  row(ist(9, 11), 22_500, "CE", 1_000, 1_000),
  row(ist(9, 11), 22_500, "PE", 2_000, 2_000),
  row(ist(9, 23), 22_500, "CE", 1_100, 1_000),
  row(ist(9, 23), 22_500, "PE", 1_900, 2_000),
  row(ist(9, 41), 22_500, "CE", 1_250, 1_000),
  row(ist(9, 41), 22_500, "PE", 1_800, 2_000),
];

describe("GET /api/v1/option-chain/oi-history", () => {
  it("rejects a malformed contract, an impossible date and an oversized request with 400", async () => {
    const { base, calls } = await start({ sessions: true, rows: SESSION_ROWS });
    const bad = [
      "contracts=22500",
      "date=2026-02-31",
      "expiry=27-10-2026",
      `contracts=${Array.from({ length: 9 }, (_, i) => `${22_000 + i * 50}CE`).join(",")}`,
    ];
    for (const query of bad) {
      const response = await fetch(`${base}/api/v1/option-chain/oi-history?${query}`);
      expect(response.status, query).toBe(400);
    }
    // Validation happens before any database read.
    expect(calls.sessions).toHaveLength(0);
    expect(calls.rows).toHaveLength(0);
  });

  it("says nothing has been collected, rather than returning an empty chart, when there are no sessions", async () => {
    const { base } = await start({ sessions: false, rows: [] });
    const body = await (await fetch(`${base}/api/v1/option-chain/oi-history?underlying=NIFTY50`)).json();
    expect(body.data).toMatchObject({ available: false, underlyingSymbol: "NIFTY50" });
    expect(body.data.reason).toContain("No option-chain snapshot");
  });

  it("explains an empty session and still offers the sessions that exist", async () => {
    const { base } = await start({ sessions: true, rows: [] });
    const body = await (await fetch(`${base}/api/v1/option-chain/oi-history?date=2026-10-17`)).json();
    expect(body.data.available).toBe(false);
    expect(body.data.reason).toContain("2026-10-17");
    expect(body.data.availableSessions).toHaveLength(1);
  });

  it("defaults to the latest session, the resolved expiry and the default contracts", async () => {
    const { base, calls } = await start({ sessions: true, rows: SESSION_ROWS });
    const response = await fetch(`${base}/api/v1/option-chain/oi-history`);
    expect(response.status).toBe(200);
    const { data } = await response.json();

    expect(data).toMatchObject({
      available: true,
      underlyingSymbol: "NIFTY50",
      sessionDate: "2026-10-12",
      sessionTimezone: "Asia/Kolkata",
      expiryDate: "2026-10-27",
      contractSelection: "DEFAULT",
    });
    expect(calls.rows[0]).toMatchObject({ underlyingSymbol: "NIFTY50", sessionDate: "2026-10-12" });
    // Pre-open carryover reported separately; the two intraday snapshots are the series.
    expect(data.preOpen.kind).toBe("PRE_OPEN_CARRYOVER");
    expect(data.observations).toHaveLength(2);
    expect(data.contracts.length).toBeGreaterThan(0);
    expect(data.availableSessions[0].snapshotCount).toBe(3);
  });

  it("honours requested contracts and passes the expiry and session date through", async () => {
    const { base, calls } = await start({ sessions: true, rows: SESSION_ROWS });
    const response = await fetch(
      `${base}/api/v1/option-chain/oi-history?date=2026-10-12&expiry=2026-10-27&contracts=22500ce`,
    );
    const { data } = await response.json();
    expect(data.contractSelection).toBe("REQUESTED");
    expect(data.contracts).toHaveLength(1);
    expect(data.contracts[0]).toMatchObject({ strikePrice: 22_500, optionType: "CE", previousCloseOpenInterest: 1_000 });
    expect(data.contracts[0].points.map((p: { changeVsPreviousClose: number }) => p.changeVsPreviousClose)).toEqual([100, 250]);
    expect(calls.rows[0]).toMatchObject({ sessionDate: "2026-10-12", expiryDate: "2026-10-27" });
  });
});
