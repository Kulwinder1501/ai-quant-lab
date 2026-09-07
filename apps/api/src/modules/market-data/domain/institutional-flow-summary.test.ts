import { describe, expect, it } from "vitest";
import type { InstitutionalFlow } from "./institutional-flow.js";
import {
  INSTITUTIONAL_FLOW_STALENESS_DAYS,
  buildGiftNiftyStatus,
  classifyStance,
  impliedGapBps,
  summariseInstitutionalFlows,
} from "./institutional-flow-summary.js";

function flow(
  date: string,
  fiiCashNetCr: number | null,
  diiCashNetCr: number | null,
  publishedAt = `${date}T13:00:00.000Z`,
): InstitutionalFlow {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    fiiCashNetCr,
    diiCashNetCr,
    fiiIndexFuturesNetCr: null,
    fiiIndexOptionsNetCr: null,
    publishedAt: new Date(publishedAt),
  };
}

describe("classifyStance", () => {
  it("reports both classes buying as accumulation", () => {
    expect(classifyStance(3623.51, 1864.03)).toBe("BOTH_ACCUMULATING");
  });

  it("reports both classes selling as distribution", () => {
    expect(classifyStance(-3623.51, -1864.03)).toBe("BOTH_DISTRIBUTING");
  });

  it("distinguishes the two divergence directions", () => {
    expect(classifyStance(3623.51, -1864.03)).toBe("FOREIGN_INFLOW_DOMESTIC_OUTFLOW");
    expect(classifyStance(-3623.51, 1864.03)).toBe("FOREIGN_OUTFLOW_DOMESTIC_SUPPORT");
  });

  it("treats small magnitudes on both legs as balanced rather than directional", () => {
    expect(classifyStance(12.5, -8.25)).toBe("BALANCED");
  });

  it("is UNKNOWN when either leg is absent, never treating null as flat", () => {
    expect(classifyStance(null, 1864.03)).toBe("UNKNOWN");
    expect(classifyStance(3623.51, null)).toBe("UNKNOWN");
    expect(classifyStance(null, null)).toBe("UNKNOWN");
  });
});

describe("summariseInstitutionalFlows", () => {
  const asOf = new Date("2026-07-31T07:00:00.000Z");

  it("describes an empty table as having no print rather than as a flat session", () => {
    const summary = summariseInstitutionalFlows([], asOf);
    expect(summary.latest).toBeNull();
    expect(summary.sessionsCovered).toBe(0);
    expect(summary.stance).toBe("UNKNOWN");
    expect(summary.fiiTotalCr).toBeNull();
    expect(summary.diiTotalCr).toBeNull();
    expect(summary.isStale).toBe(true);
  });

  it("picks the newest session regardless of input order", () => {
    const summary = summariseInstitutionalFlows(
      [flow("2026-07-28", 100, 200), flow("2026-07-30", 3623.51, -1864.03), flow("2026-07-29", 50, 60)],
      asOf,
    );
    expect(summary.latest?.date).toBe("2026-07-30");
    expect(summary.history.map((s) => s.date)).toEqual(["2026-07-30", "2026-07-29", "2026-07-28"]);
    expect(summary.stance).toBe("FOREIGN_INFLOW_DOMESTIC_OUTFLOW");
  });

  it("computes the combined net only when both legs are present", () => {
    const summary = summariseInstitutionalFlows([flow("2026-07-30", 3623.51, -1864.03)], asOf);
    expect(summary.latest?.combinedNetCr).toBe(1759.48);

    const partial = summariseInstitutionalFlows([flow("2026-07-30", 3623.51, null)], asOf);
    expect(partial.latest?.combinedNetCr).toBeNull();
  });

  it("sums only the present legs and reports null when a leg is absent throughout", () => {
    const summary = summariseInstitutionalFlows(
      [flow("2026-07-30", 100, null), flow("2026-07-29", 200, null)],
      asOf,
    );
    expect(summary.fiiTotalCr).toBe(300);
    expect(summary.diiTotalCr).toBeNull();
  });

  it("ages a print in whole days and flags staleness past the shared window", () => {
    const fresh = summariseInstitutionalFlows([flow("2026-07-30", 1, 1)], asOf);
    expect(fresh.ageInDays).toBe(1);
    expect(fresh.isStale).toBe(false);

    const boundary = summariseInstitutionalFlows([flow("2026-07-26", 1, 1)], asOf);
    expect(boundary.ageInDays).toBe(INSTITUTIONAL_FLOW_STALENESS_DAYS);
    expect(boundary.isStale).toBe(false);

    const stale = summariseInstitutionalFlows([flow("2026-07-25", 1, 1)], asOf);
    expect(stale.ageInDays).toBe(6);
    expect(stale.isStale).toBe(true);
  });
});

describe("impliedGapBps", () => {
  it("expresses a premium in basis points", () => {
    expect(impliedGapBps(24100, 24000)).toBeCloseTo(41.67, 2);
  });

  it("signs a discount negative", () => {
    expect(impliedGapBps(23900, 24000)).toBeCloseTo(-41.67, 2);
  });

  it("refuses non-positive or non-finite inputs instead of returning a gap", () => {
    expect(impliedGapBps(0, 24000)).toBeNull();
    expect(impliedGapBps(24000, 0)).toBeNull();
    expect(impliedGapBps(Number.NaN, 24000)).toBeNull();
    expect(impliedGapBps(24000, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("buildGiftNiftyStatus", () => {
  it("reports an unconfigured provider distinctly from a configured one with no print", () => {
    const unconfigured = buildGiftNiftyStatus({ print: null, domesticClose: 24000, configuredSymbol: null });
    expect(unconfigured.available).toBe(false);
    expect(unconfigured.reason).toBe("PROVIDER_NOT_CONFIGURED");
    expect(unconfigured.closePrice).toBeNull();

    const configured = buildGiftNiftyStatus({ print: null, domesticClose: 24000, configuredSymbol: "GIFTNIFTY=F" });
    expect(configured.reason).toBe("NO_PRINT_COLLECTED");
  });

  it("never reports a domestic close as offshore context when there is no print", () => {
    const status = buildGiftNiftyStatus({ print: null, domesticClose: 24000, configuredSymbol: null });
    expect(status.domesticClose).toBeNull();
    expect(status.impliedGapBps).toBeNull();
  });

  it("computes the gap when both a print and a settled domestic close exist", () => {
    const status = buildGiftNiftyStatus({
      print: {
        instrumentId: "GIFT_NIFTY",
        date: new Date("2026-07-30T00:00:00.000Z"),
        closePrice: 24100,
        publishedAt: new Date("2026-07-30T13:00:00.000Z"),
      },
      domesticClose: 24000,
      configuredSymbol: "GIFTNIFTY=F",
    });
    expect(status.available).toBe(true);
    expect(status.reason).toBeNull();
    expect(status.date).toBe("2026-07-30");
    expect(status.impliedGapBps).toBeCloseTo(41.67, 2);
  });

  it("keeps a print available but its gap unmeasurable when no domestic close settled", () => {
    const status = buildGiftNiftyStatus({
      print: {
        instrumentId: "GIFT_NIFTY",
        date: new Date("2026-07-30T00:00:00.000Z"),
        closePrice: 24100,
        publishedAt: new Date("2026-07-30T13:00:00.000Z"),
      },
      domesticClose: null,
      configuredSymbol: "GIFTNIFTY=F",
    });
    expect(status.available).toBe(true);
    expect(status.closePrice).toBe(24100);
    expect(status.impliedGapBps).toBeNull();
  });
});
