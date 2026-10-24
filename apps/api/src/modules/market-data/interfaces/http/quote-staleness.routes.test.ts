import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseQuoteStalenessQuery, registerQuoteStalenessRoutes } from "./quote-staleness.routes.js";

/** 2026-10-26 is a Monday. IST is UTC+5:30. */
const ist = (hhmm: string): Date => new Date(new Date(`2026-10-26T${hhmm}:00.000Z`).getTime() - 330 * 60_000);
const q = (strike: number, side: "CE" | "PE", bid: number | null, ask: number | null) => ({ strike, side, bid, ask });

interface Call { underlyingSymbol: string; expiryDate: string | null | undefined; count: number }

let server: Server | null = null;

async function start(now: Date, holidayName: string | null = null): Promise<{ base: string; calls: Call[] }> {
  const calls: Call[] = [];
  const repository = {
    async recentQuoteSnapshots(input: { underlyingSymbol: string; expiryDate?: string | null; asOf: Date; count: number }) {
      calls.push({ underlyingSymbol: input.underlyingSymbol, expiryDate: input.expiryDate, count: input.count });
      return {
        expiryDate: input.expiryDate ?? "2026-10-27",
        snapshots: [
          { observedAt: ist("12:11"), quotes: [q(54_300, "CE", 330, 336), q(54_300, "PE", 310, 316)] },
          { observedAt: ist("11:53"), quotes: [q(54_300, "CE", 330, 336), q(54_300, "PE", 305, 316)] },
          { observedAt: ist("11:41"), quotes: [q(54_300, "CE", 330, 336)] },
          { observedAt: ist("11:23"), quotes: [q(54_300, "CE", 330, 336)] },
        ],
      };
    },
  };
  const database = { query: async () => ({ rows: holidayName ? [{ name: holidayName }] : [] }) };
  const app: Express = express();
  registerQuoteStalenessRoutes(app, { optionChainRepository: repository, database } as never, { now: () => now });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseQuoteStalenessQuery", () => {
  it("defaults to NIFTY50, upper-cases, and accepts only the four collected underlyings and an ISO expiry", () => {
    expect(parseQuoteStalenessQuery({ underlying: undefined, expiry: undefined })).toEqual({ ok: true, value: { underlying: "NIFTY50", expiry: null } });
    expect(parseQuoteStalenessQuery({ underlying: "banknifty", expiry: "2026-10-27" })).toEqual({ ok: true, value: { underlying: "BANKNIFTY", expiry: "2026-10-27" } });
    expect(parseQuoteStalenessQuery({ underlying: "TCS", expiry: undefined }).ok).toBe(false);
    expect(parseQuoteStalenessQuery({ underlying: undefined, expiry: "27-10-2026" }).ok).toBe(false);
  });
});

describe("GET /api/v1/option-chain/quote-staleness", () => {
  it("judges the age against the observed cadence and counts each contract's unchanged run", async () => {
    // 12:11 is the newest; at 12:25 it is 14 minutes old. The in-session gaps are 18, 12 and 18 minutes, so the expected gap is 18.
    const { base, calls } = await start(ist("12:25"));
    const { data } = await (await fetch(`${base}/api/v1/option-chain/quote-staleness?underlying=banknifty`)).json();

    expect(calls).toEqual([{ underlyingSymbol: "BANKNIFTY", expiryDate: null, count: 8 }]);
    expect(data).toMatchObject({ underlyingSymbol: "BANKNIFTY", expiryDate: "2026-10-27", marketOpen: true, holiday: null, window: 8 });
    expect(data.age).toMatchObject({ state: "fresh", ageSeconds: 14 * 60, expectedGapSeconds: 18 * 60, expectedGapFrom: "observed" });
    expect(data.snapshotTimes).toHaveLength(4);
    const byKey = Object.fromEntries(data.contracts.map((c: { strike: number; side: string }) => [`${c.strike}${c.side}`, c]));
    expect(byKey["54300CE"]).toMatchObject({ unchangedSnapshots: 4, unchangedSinceAt: ist("11:23").toISOString() });
    expect(byKey["54300PE"]).toMatchObject({ unchangedSnapshots: 1 });
    expect(data.definitions.unchanged).toContain("not proof of a stale price");
  });

  it("calls the chain overdue when the market is open and the newest snapshot is much older than the cadence", async () => {
    const { base } = await start(ist("13:10"));          // 59 minutes after 12:11, against an 18 minute cadence
    const { data } = await (await fetch(`${base}/api/v1/option-chain/quote-staleness`)).json();
    expect(data.age).toMatchObject({ state: "overdue", ageSeconds: 59 * 60 });
  });

  it("reports the age without judging it when the market is shut, and names a holiday", async () => {
    const { base } = await start(ist("16:00"));
    expect((await (await fetch(`${base}/api/v1/option-chain/quote-staleness`)).json()).data).toMatchObject({ marketOpen: false, age: { state: "market-closed" } });
    const holiday = await start(ist("12:25"), "Diwali");
    expect((await (await fetch(`${holiday.base}/api/v1/option-chain/quote-staleness`)).json()).data).toMatchObject({ marketOpen: false, holiday: "Diwali", age: { state: "market-closed" } });
  });

  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start(ist("12:25"));
    for (const query of ["underlying=TCS", "expiry=tomorrow"]) expect((await fetch(`${base}/api/v1/option-chain/quote-staleness?${query}`)).status, query).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
