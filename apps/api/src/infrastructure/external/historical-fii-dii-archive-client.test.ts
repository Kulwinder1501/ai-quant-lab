import axios from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoricalFiiDiiArchiveClient } from "./historical-fii-dii-archive-client.js";

vi.mock("axios", () => ({ default: { get: vi.fn() } }));

const get = vi.mocked(axios.get);

describe("HistoricalFiiDiiArchiveClient", () => {
  beforeEach(() => get.mockReset());

  it("admits only real fetch-pipeline rows and assigns a conservative publication time", async () => {
    get.mockResolvedValue({
      data: [
        { date: "30-Jul-2026", fii_buy: 110, fii_sell: 100, fii_net: 10, dii_buy: 80, dii_sell: 85, dii_net: -5, _source: "fetch-pipeline" },
        { date: "29-Jul-2026", fii_buy: 120, fii_sell: 100, fii_net: 20, dii_buy: 90, dii_sell: 85, dii_net: 5, _source: "historical-seed" },
      ],
    } as never);
    const rows = await new HistoricalFiiDiiArchiveClient("https://example.test/history.json").fetch();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fiiCashNetCr: 10, diiCashNetCr: -5, source: "MRCHARTIST_NSE_ARCHIVE:fetch-pipeline" });
    expect(rows[0].publishedAt.toISOString()).toBe("2026-07-30T13:00:00.000Z");
  });

  it("rejects inconsistent arithmetic and fails closed when no valid real row remains", async () => {
    get.mockResolvedValue({
      data: [{ date: "30-Jul-2026", fii_buy: 110, fii_sell: 100, fii_net: 999, dii_buy: 80, dii_sell: 85, dii_net: -5, _source: "live-fetch" }],
    } as never);
    await expect(new HistoricalFiiDiiArchiveClient().fetch()).rejects.toThrow("no trusted, valid rows");
  });

  it("rejects a non-array upstream response", async () => {
    get.mockResolvedValue({ data: { error: "rate limited" } } as never);
    await expect(new HistoricalFiiDiiArchiveClient().fetch()).rejects.toThrow("did not return an array");
  });
});
