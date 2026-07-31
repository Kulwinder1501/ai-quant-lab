import { describe, expect, it, vi } from "vitest";
import type { InstitutionalFlow } from "../domain/institutional-flow.js";
import type { OffshoreDerivative } from "../domain/offshore-derivative.js";
import {
  DEFAULT_FLOW_HISTORY_SESSIONS,
  GIFT_NIFTY_DOMESTIC_SYMBOL,
  GIFT_NIFTY_INSTRUMENT_ID,
  GetInstitutionalContextService,
} from "./get-institutional-context.js";

const print: OffshoreDerivative = {
  instrumentId: GIFT_NIFTY_INSTRUMENT_ID,
  date: new Date("2026-07-30T00:00:00.000Z"),
  closePrice: 24100,
  publishedAt: new Date("2026-07-30T13:00:00.000Z"),
};

const flowRow: InstitutionalFlow = {
  date: new Date("2026-07-30T00:00:00.000Z"),
  fiiCashNetCr: 3623.51,
  diiCashNetCr: -1864.03,
  fiiIndexFuturesNetCr: null,
  fiiIndexOptionsNetCr: null,
  publishedAt: new Date("2026-07-31T07:39:46.257Z"),
};

function build(overrides: {
  flows?: InstitutionalFlow[];
  print?: OffshoreDerivative | null;
  domesticClose?: number | null;
  symbol?: string | null;
} = {}) {
  const listRecent = vi.fn().mockResolvedValue(overrides.flows ?? [flowRow]);
  const findLatest = vi.fn().mockResolvedValue(overrides.print ?? null);
  const findCloseOn = vi.fn().mockResolvedValue(overrides.domesticClose ?? null);

  const service = new GetInstitutionalContextService(
    { listRecent },
    { findLatest },
    { findCloseOn },
    overrides.symbol ?? null,
    () => new Date("2026-07-31T07:00:00.000Z"),
  );
  return { service, listRecent, findLatest, findCloseOn };
}

describe("GetInstitutionalContextService", () => {
  it("returns the real FII/DII print even when the GIFT Nifty feed is absent", async () => {
    const { service } = build();
    const result = await service.execute();

    expect(result.flows.latest?.fiiCashNetCr).toBe(3623.51);
    expect(result.flows.latest?.diiCashNetCr).toBe(-1864.03);
    expect(result.flows.stance).toBe("FOREIGN_INFLOW_DOMESTIC_OUTFLOW");
    expect(result.giftNifty.available).toBe(false);
    expect(result.giftNifty.reason).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("does not look up a domestic close when there is no offshore print to compare", async () => {
    const { service, findCloseOn } = build({ print: null });
    await service.execute();
    expect(findCloseOn).not.toHaveBeenCalled();
  });

  it("measures the gap against the print's own session close", async () => {
    const { service, findCloseOn } = build({ print, domesticClose: 24000, symbol: "GIFTNIFTY=F" });
    const result = await service.execute();

    expect(findCloseOn).toHaveBeenCalledWith(GIFT_NIFTY_DOMESTIC_SYMBOL, print.date);
    expect(result.giftNifty.impliedGapBps).toBeCloseTo(41.67, 2);
    expect(result.giftNifty.configuredSymbol).toBe("GIFTNIFTY=F");
  });

  it("defaults the history window and honours an explicit one", async () => {
    const { service, listRecent } = build();
    await service.execute();
    expect(listRecent).toHaveBeenCalledWith(DEFAULT_FLOW_HISTORY_SESSIONS);

    await service.execute({ historySessions: 3 });
    expect(listRecent).toHaveBeenLastCalledWith(3);
  });

  it("treats a blank configured symbol as unconfigured rather than as a symbol", async () => {
    const { service } = build({ symbol: "   " });
    const result = await service.execute();
    expect(result.giftNifty.configuredSymbol).toBeNull();
    expect(result.giftNifty.reason).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("reports an empty flows table as no print, not as a balanced session", async () => {
    const { service } = build({ flows: [] });
    const result = await service.execute();
    expect(result.flows.latest).toBeNull();
    expect(result.flows.stance).toBe("UNKNOWN");
    expect(result.flows.sessionsCovered).toBe(0);
  });
});
