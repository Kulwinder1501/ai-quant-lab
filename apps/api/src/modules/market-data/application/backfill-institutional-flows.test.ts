import { describe, expect, it, vi } from "vitest";
import type { InstitutionalFlow } from "../domain/institutional-flow.js";
import { BackfillInstitutionalFlows } from "./backfill-institutional-flows.js";

function flow(date: string, fii = 100, dii = -50): InstitutionalFlow {
  const session = new Date(`${date}T00:00:00.000Z`);
  return {
    date: session,
    fiiCashNetCr: fii,
    diiCashNetCr: dii,
    fiiIndexFuturesNetCr: null,
    fiiIndexOptionsNetCr: null,
    publishedAt: new Date(session.getTime() + 13 * 60 * 60 * 1000),
    source: "MRCHARTIST_NSE_ARCHIVE:fetch-pipeline",
    isProvisional: true,
  };
}

describe("BackfillInstitutionalFlows", () => {
  it("filters the range, preserves stronger existing rows, and inserts missing sessions", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const findByDate = vi.fn(async (date: Date) => date.toISOString().startsWith("2026-07-30") ? flow("2026-07-30") : null);
    const service = new BackfillInstitutionalFlows(
      { fetch: vi.fn().mockResolvedValue([flow("2026-07-29"), flow("2026-07-30"), flow("2026-07-31")]) },
      { findByDate, upsert },
    );
    const result = await service.execute({
      from: new Date("2026-07-30T00:00:00.000Z"),
      to: new Date("2026-07-31T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ eligible: 2, inserted: 1, preserved: 1 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ date: new Date("2026-07-31T00:00:00.000Z") }));
  });

  it("rejects conflicting duplicates instead of choosing one silently", async () => {
    const service = new BackfillInstitutionalFlows(
      { fetch: vi.fn().mockResolvedValue([flow("2026-07-31", 100), flow("2026-07-31", 101)]) },
      { findByDate: vi.fn(), upsert: vi.fn() },
    );
    await expect(service.execute({
      from: new Date("2026-07-31T00:00:00.000Z"),
      to: new Date("2026-07-31T00:00:00.000Z"),
    })).rejects.toThrow("conflicting real rows");
  });

  it("fails closed when archive values disagree with an existing first-party row", async () => {
    const service = new BackfillInstitutionalFlows(
      { fetch: vi.fn().mockResolvedValue([flow("2026-07-31", 100)]) },
      { findByDate: vi.fn().mockResolvedValue(flow("2026-07-31", 150)), upsert: vi.fn() },
    );
    await expect(service.execute({
      from: new Date("2026-07-31T00:00:00.000Z"),
      to: new Date("2026-07-31T00:00:00.000Z"),
    })).rejects.toThrow("disagrees with the preserved first-party row");
  });

  it("rejects a reversed range before requesting external data", async () => {
    const fetch = vi.fn();
    const service = new BackfillInstitutionalFlows(fetch as never, {} as never);
    await expect(service.execute({
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-07-01T00:00:00.000Z"),
    })).rejects.toThrow("must not be after");
    expect(fetch).not.toHaveBeenCalled();
  });
});
