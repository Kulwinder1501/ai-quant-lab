import { describe, expect, it } from "vitest";
import {
  CollectInstitutionalDataService,
  istTradingDate,
  type InstitutionalFlowSource,
} from "./collect-institutional-data.js";
import type { InstitutionalFlow } from "../domain/institutional-flow.js";
import type { OffshoreDerivative } from "../domain/offshore-derivative.js";

function flow(overrides: Partial<InstitutionalFlow> = {}): InstitutionalFlow {
  return {
    date: new Date("2026-07-29T00:00:00.000Z"),
    fiiCashNetCr: -2400.5,
    diiCashNetCr: 1800.25,
    fiiIndexFuturesNetCr: null,
    fiiIndexOptionsNetCr: null,
    publishedAt: new Date("2026-07-29T13:00:00.000Z"),
    ...overrides,
  };
}

function harness(source: Partial<InstitutionalFlowSource>, now = new Date("2026-07-29T13:00:00.000Z")) {
  const storedFlows: InstitutionalFlow[] = [];
  const storedOffshore: OffshoreDerivative[] = [];
  const service = new CollectInstitutionalDataService(
    {
      getFiiDiiData: async () => flow(),
      getGiftNiftyData: async () => null,
      ...source,
    },
    { upsert: async (value) => void storedFlows.push(value) },
    { upsert: async (value) => void storedOffshore.push(value) },
    () => now,
  );
  return { service, storedFlows, storedOffshore };
}

describe("istTradingDate", () => {
  // Deriving the session from UTC components was wrong for anything scheduled
  // between 00:00 and 05:30 IST, where the IST date is already the next day.
  it("resolves the IST session date, not the UTC one", () => {
    expect(istTradingDate(new Date("2026-07-29T13:00:00.000Z")).toISOString()).toBe("2026-07-29T00:00:00.000Z");
    // 21:30 UTC on the 29th is 03:00 IST on the 30th.
    expect(istTradingDate(new Date("2026-07-29T21:30:00.000Z")).toISOString()).toBe("2026-07-30T00:00:00.000Z");
    // 18:29 UTC is still 23:59 IST the same day.
    expect(istTradingDate(new Date("2026-07-29T18:29:00.000Z")).toISOString()).toBe("2026-07-29T00:00:00.000Z");
  });
});

describe("CollectInstitutionalDataService", () => {
  it("stores the flow under the session NSE reported", async () => {
    const { service, storedFlows } = harness({});
    const result = await service.execute();

    expect(storedFlows).toHaveLength(1);
    expect(storedFlows[0].date.toISOString()).toBe("2026-07-29T00:00:00.000Z");
    expect(result.flowSessionDate).toBe("2026-07-29");
    expect(result.flowIsStale).toBe(false);
  });

  // The original bug: NSE returns its latest available print, and the collector
  // stamped the *run* date onto it. On a holiday, or on any run before NSE
  // published, that filed the previous session's numbers under today's date —
  // so a date-keyed feature read figures from the wrong session entirely.
  it("keeps an earlier session's print under its own date and reports it as stale", async () => {
    const { service, storedFlows } = harness(
      { getFiiDiiData: async () => flow({ date: new Date("2026-07-28T00:00:00.000Z") }) },
      new Date("2026-07-29T13:00:00.000Z"),
    );

    const result = await service.execute();

    expect(storedFlows[0].date.toISOString()).toBe("2026-07-28T00:00:00.000Z");
    expect(result.flowSessionDate).toBe("2026-07-28");
    expect(result.flowIsStale).toBe(true);
    expect(result.warnings.some((w) => w.includes("not the expected session"))).toBe(true);
  });

  // Previously every error was caught and logged inside the service, so the CLI's
  // own handler could never set a non-zero exit code and a permanently broken
  // scraper looked like a successful cron run indefinitely.
  it("propagates a source failure instead of swallowing it", async () => {
    const { service, storedFlows } = harness({
      getFiiDiiData: async () => {
        throw new Error("NSE did not return session cookies");
      },
    });

    await expect(service.execute()).rejects.toThrow("NSE did not return session cookies");
    expect(storedFlows).toHaveLength(0);
  });

  it("reports a null cash figure as a warning rather than writing a zero", async () => {
    const { service, storedFlows } = harness({
      getFiiDiiData: async () => flow({ fiiCashNetCr: null }),
    });

    const result = await service.execute();

    expect(storedFlows[0].fiiCashNetCr).toBeNull();
    expect(result.warnings.some((w) => w.includes("FII cash net was absent"))).toBe(true);
  });

  it("treats an absent GIFT Nifty quote as a warning, not a failure", async () => {
    const { service, storedOffshore } = harness({ getGiftNiftyData: async () => null });

    const result = await service.execute();

    expect(result.flowStored).toBe(true);
    expect(result.offshoreStored).toBe(false);
    expect(storedOffshore).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes("No GIFT Nifty quote available"))).toBe(true);
  });

  it("does not let a GIFT Nifty failure discard the flow that was already collected", async () => {
    const { service, storedFlows } = harness({
      getGiftNiftyData: async () => {
        throw new Error("upstream 503");
      },
    });

    const result = await service.execute();

    expect(storedFlows).toHaveLength(1);
    expect(result.offshoreStored).toBe(false);
    expect(result.warnings.some((w) => w.includes("upstream 503"))).toBe(true);
  });

  it("asks for the offshore print of the session the flow actually describes", async () => {
    const requested: Date[] = [];
    const { service } = harness({
      getFiiDiiData: async () => flow({ date: new Date("2026-07-28T00:00:00.000Z") }),
      getGiftNiftyData: async (date) => {
        requested.push(date);
        return null;
      },
    });

    await service.execute();

    expect(requested).toHaveLength(1);
    expect(requested[0].toISOString()).toBe("2026-07-28T00:00:00.000Z");
  });

  it("stores a real offshore print when one is available", async () => {
    const { service, storedOffshore } = harness({
      getGiftNiftyData: async (date) => ({
        instrumentId: "GIFT_NIFTY",
        date,
        closePrice: 24_800.5,
        publishedAt: new Date("2026-07-29T13:05:00.000Z"),
      }),
    });

    const result = await service.execute();

    expect(result.offshoreStored).toBe(true);
    expect(storedOffshore[0].closePrice).toBe(24_800.5);
  });
});
