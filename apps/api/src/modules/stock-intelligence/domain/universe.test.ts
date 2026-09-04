import { describe, expect, it } from "vitest";
import { NIFTY50_DRIVER_WEIGHTS } from "../../market-data/domain/nifty50-driver-weights.js";
import {
  NIFTY_NEXT_50_EQUITY_ROSTER,
  STOCK_INTELLIGENCE_ROSTER_AS_OF,
  nifty50EquityRoster,
  stockIntelligenceEquityRoster,
} from "./seed-roster.js";
import { isEligibleAt, type InstrumentExistence, type UniverseMembership } from "./universe.js";
import { fundamentalCompleteness, isStaleData } from "./data-quality.js";
import { isTailRegimeBucket, regimeBucket } from "./status.js";
import { assertAvailableAtCutoff } from "./timestamps.js";
import { LookaheadViolationError } from "../../research/domain/lookahead-guard.js";
import {
  reconstructNifty50MembershipSpells,
  reconstructNifty50MonthEnds,
  WIKIPEDIA_NIFTY50_SOURCE,
} from "./wikipedia-nifty50-history.js";

describe("stock intelligence seed roster", () => {
  it("keeps Nifty 50 aligned with the dashboard driver list and Next 50 disjoint", () => {
    const nifty50 = nifty50EquityRoster();
    expect(nifty50).toHaveLength(NIFTY50_DRIVER_WEIGHTS.length);
    expect(nifty50).toHaveLength(50);
    expect(NIFTY_NEXT_50_EQUITY_ROSTER).toHaveLength(50);

    const nifty50Symbols = new Set(nifty50.map((row) => row.symbol));
    const next50Symbols = NIFTY_NEXT_50_EQUITY_ROSTER.map((row) => row.symbol);
    expect(new Set(next50Symbols).size).toBe(50);
    expect(next50Symbols.some((symbol) => nifty50Symbols.has(symbol))).toBe(false);
    expect(stockIntelligenceEquityRoster()).toHaveLength(100);
    expect(STOCK_INTELLIGENCE_ROSTER_AS_OF).toBe("2026-09-03");
  });
});

describe("point-in-time universe eligibility", () => {
  const asOf = new Date("2026-09-03T00:00:00.000Z");
  const membership: UniverseMembership = {
    instrumentId: "inst-1",
    universe: "NIFTY50",
    effectiveFrom: asOf,
    effectiveTo: null,
    availableAt: asOf,
    provenance: "current_roster_snapshot",
  };

  it("refuses historical dates before the current-roster snapshot", () => {
    const decision = isEligibleAt({
      asOf: new Date("2020-01-15T00:00:00.000Z"),
      memberships: [membership],
      existence: {
        instrumentId: "inst-1",
        listedFrom: new Date("2010-01-01T00:00:00.000Z"),
        listedTo: null,
        availableAt: asOf,
      },
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("MEMBERSHIP_NOT_YET_AVAILABLE");
  });

  it("refuses a current member whose listing date is unknown", () => {
    const existence: InstrumentExistence = {
      instrumentId: "inst-1",
      listedFrom: null,
      listedTo: null,
      availableAt: asOf,
    };
    const decision = isEligibleAt({ asOf, memberships: [membership], existence });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("EXISTENCE_UNKNOWN");
  });

  it("accepts a member with a knowable listing date covering asOf", () => {
    const decision = isEligibleAt({
      asOf,
      memberships: [membership],
      existence: {
        instrumentId: "inst-1",
        listedFrom: new Date("2010-01-01T00:00:00.000Z"),
        listedTo: null,
        availableAt: asOf,
      },
    });
    expect(decision).toEqual({ eligible: true, reason: "ELIGIBLE", membership });
  });

  it("refuses membership that became knowable after asOf", () => {
    const late: UniverseMembership = {
      ...membership,
      availableAt: new Date("2026-09-10T00:00:00.000Z"),
    };
    const decision = isEligibleAt({
      asOf,
      memberships: [late],
      existence: {
        instrumentId: "inst-1",
        listedFrom: new Date("2010-01-01T00:00:00.000Z"),
        listedTo: null,
        availableAt: asOf,
      },
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe("MEMBERSHIP_NOT_YET_AVAILABLE");
  });
});

describe("Wikipedia NIFTY 50 month-end reconstruction", () => {
  it("produces exactly 50 unique members at every 2015-2024 month-end", () => {
    const history = reconstructNifty50MonthEnds();
    expect(history.size).toBe(120);
    for (const members of history.values()) {
      expect(members.size).toBe(50);
    }
    expect(WIKIPEDIA_NIFTY50_SOURCE.license).toBe("CC BY-SA 4.0");
  });

  it("reverses known replacements and retains leavers", () => {
    const history = reconstructNifty50MonthEnds();
    expect(history.get("2015-01-31")?.has("DLF")).toBe(true);
    expect(history.get("2015-01-31")?.has("IDEA")).toBe(false);
    expect(history.get("2016-06-30")?.has("YESBANK")).toBe(true);
    expect(history.get("2020-06-30")?.has("YESBANK")).toBe(false);
    expect(history.get("2024-12-31")?.has("TRENT")).toBe(true);
  });

  it("emits separate spells for a member that leaves and later re-enters", () => {
    const vedanta = reconstructNifty50MembershipSpells()
      .filter((row) => row.symbol === "VEDL");
    expect(vedanta).toHaveLength(2);
    expect(vedanta[0]).toMatchObject({
      effectiveFrom: "2015-01-31",
      effectiveTo: "2016-04-30",
    });
    expect(vedanta[1]).toMatchObject({
      effectiveFrom: "2017-05-31",
      effectiveTo: "2020-07-31",
    });
  });

  it("caps archive spells so they cannot grant eligibility after 2024", () => {
    const spells = reconstructNifty50MembershipSpells();
    expect(spells.filter((row) => row.effectiveTo === null)).toHaveLength(0);
    expect(spells.some((row) => row.effectiveTo === "2025-01-31")).toBe(true);
  });
});

describe("fundamental completeness", () => {
  const asOf = new Date("2026-09-03T00:00:00.000Z");

  it("scores 0 when nothing is available", () => {
    expect(fundamentalCompleteness(asOf, [])).toBe(0);
  });

  it("ignores records that post-date the cutoff", () => {
    expect(fundamentalCompleteness(asOf, [{
      field: "revenue_ttm",
      availableAt: new Date("2026-09-04T00:00:00.000Z"),
    }])).toBe(0);
  });

  it("decays a field to 0 once it is older than its max age", () => {
    const score = fundamentalCompleteness(asOf, [{
      field: "revenue_ttm",
      availableAt: new Date("2026-01-01T00:00:00.000Z"),
    }]);
    expect(score).toBe(0);
  });

  it("weights a fresh required field by its configured share", () => {
    const score = fundamentalCompleteness(asOf, [{
      field: "revenue_ttm",
      availableAt: asOf,
    }]);
    expect(score).toBeCloseTo(0.15, 6);
  });
});

describe("stale-data thresholds", () => {
  const thresholds = { days6M: 30, days12M: 60 };

  it("uses the configured 6M and 12M windows rather than a hardcoded constant", () => {
    expect(isStaleData(30, "6M", thresholds)).toBe(false);
    expect(isStaleData(31, "6M", thresholds)).toBe(true);
    expect(isStaleData(60, "12M", thresholds)).toBe(false);
    expect(isStaleData(61, "12M", thresholds)).toBe(true);
  });
});

describe("regime buckets", () => {
  it("names MVP buckets as macro:volatility and flags tail regimes", () => {
    expect(regimeBucket("expansion", "low")).toBe("expansion:low");
    expect(isTailRegimeBucket("recession:crisis")).toBe(true);
    expect(isTailRegimeBucket("slowdown:elevated")).toBe(true);
    expect(isTailRegimeBucket("expansion:low")).toBe(false);
  });
});

describe("available_at vs data_cutoff", () => {
  const cutoff = new Date("2026-09-02T04:00:00.000Z");

  it("reuses the lab lookahead guard so a future fact cannot enter a snapshot", () => {
    expect(() => assertAvailableAtCutoff(cutoff, cutoff, "fact")).not.toThrow();
    expect(() => assertAvailableAtCutoff(
      new Date(cutoff.getTime() + 1),
      cutoff,
      "fact",
    )).toThrow(LookaheadViolationError);
  });
});
