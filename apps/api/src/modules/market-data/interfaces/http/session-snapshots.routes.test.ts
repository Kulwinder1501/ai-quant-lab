import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionSnapshotsQuery, registerSessionSnapshotsRoutes } from "./session-snapshots.routes.js";

let server: Server | null = null;

async function start(): Promise<{ base: string; calls: Array<{ underlyingSymbol: string; days: number }> }> {
  const calls: Array<{ underlyingSymbol: string; days: number }> = [];
  const repository = {
    async lastInSessionSnapshots(input: { underlyingSymbol: string; days: number }) {
      calls.push(input);
      return [
        { sessionDate: "2026-10-23", observedAt: new Date("2026-10-23T09:53:01.439Z") },
        { sessionDate: "2026-10-22", observedAt: new Date("2026-10-22T09:53:00.100Z") },
      ];
    },
  };
  const app: Express = express();
  registerSessionSnapshotsRoutes(app, { optionChainRepository: repository } as never);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, calls };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe("parseSessionSnapshotsQuery", () => {
  it("defaults to NIFTY50 and 10 sessions, upper-cases, and offers 5, 10 or 20", () => {
    expect(parseSessionSnapshotsQuery({ underlying: undefined, days: undefined })).toEqual({ ok: true, value: { underlying: "NIFTY50", days: 10 } });
    expect(parseSessionSnapshotsQuery({ underlying: "sbin", days: "20" })).toEqual({ ok: true, value: { underlying: "SBIN", days: 20 } });
    for (const days of ["7", "0", "ten"]) expect(parseSessionSnapshotsQuery({ underlying: undefined, days }).ok, days).toBe(false);
    expect(parseSessionSnapshotsQuery({ underlying: "TCS", days: undefined }).ok).toBe(false);
  });
});

describe("GET /api/v1/option-chain/session-snapshots", () => {
  it("lists each session's last in-session snapshot as an instant, newest first", async () => {
    const { base, calls } = await start();
    const { data } = await (await fetch(`${base}/api/v1/option-chain/session-snapshots?underlying=banknifty&days=5`)).json();
    expect(calls).toEqual([{ underlyingSymbol: "BANKNIFTY", days: 5 }]);
    expect(data).toMatchObject({ underlyingSymbol: "BANKNIFTY", days: 5, dayChoices: [5, 10, 20] });
    expect(data.sessions).toEqual([
      { sessionDate: "2026-10-23", observedAt: "2026-10-23T09:53:01.439Z" },
      { sessionDate: "2026-10-22", observedAt: "2026-10-22T09:53:00.100Z" },
    ]);
  });

  it("rejects a bad query with 400 before any read", async () => {
    const { base, calls } = await start();
    for (const query of ["days=7", "underlying=TCS"]) expect((await fetch(`${base}/api/v1/option-chain/session-snapshots?${query}`)).status, query).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
