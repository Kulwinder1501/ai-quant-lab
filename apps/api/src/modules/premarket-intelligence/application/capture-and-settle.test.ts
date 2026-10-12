import { describe, expect, it } from "vitest";
import { istInstant } from "../../platform/calendar/trading-session.js";
import { CapturePremarketSnapshot, type SnapshotSourceDependencies } from "./capture-premarket-snapshot.js";
import { SettleSessionOutcomes, type SessionOutcomeStore } from "./settle-session-outcomes.js";
import type { SessionOutcome } from "../domain/session-outcome.js";

const NOW = new Date("2026-10-12T03:40:30.000Z"); // 09:10 IST

function deps(overrides: Partial<SnapshotSourceDependencies> = {}): SnapshotSourceDependencies {
  return {
    giftNiftyQuote: async () => ({ lastPrice: 22575.5, changePercent: 0.24, expiryDate: "27-Oct-2026" }),
    cueQuotes: async () => new Map([
      ["^HSI", { changePercent: 0.25, price: 25000, observedAt: new Date("2026-10-12T08:08:40Z") }],
      ["^N225", { changePercent: -0.02, price: 48000, observedAt: new Date("2026-10-09T06:45:03Z") }],
      ["CL=F", { changePercent: null, price: null, observedAt: null }],
    ]),
    indexIndicatives: async () => ({ timestamp: "12-Oct-2026 09:08", rows: {
      NIFTY50: { indicativeClose: 22650, previousClose: 22520.45, last: null },
      BANKNIFTY: { indicativeClose: 55400, previousClose: 55256.65, last: null },
    } }),
    dailyBars: async () => [{ high: 22700, low: 22500, close: 22600 }, { high: 22750, low: 22550, close: 22650 }],
    ...overrides,
  };
}

describe("CapturePremarketSnapshot", () => {
  it("puts GIFT Nifty first, numbers evidence sequentially, and labels each cue with its own last-trade date", async () => {
    const { snapshot, diagnostics } = await new CapturePremarketSnapshot(deps()).capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0850" });

    expect(snapshot.evidence.map((e) => e.id).slice(0, 3)).toEqual(["market-evidence-001", "market-evidence-002", "market-evidence-003"]);
    expect(snapshot.evidence[0]).toMatchObject({ category: "GIFT_NIFTY", unit: "PERCENT_CHANGE", value: 0.24, source: "NSE_IX" });
    expect(snapshot.evidence[1]).toMatchObject({ category: "GIFT_NIFTY", unit: "PRICE", value: 22575.5 });
    const nikkei = snapshot.evidence.find((e) => e.label.startsWith("Nikkei"))!;
    expect(nikkei.label).toContain("last trade 2026-10-09"); // Japan was shut on 2026-10-12
    expect(snapshot.evidence.find((e) => e.label.startsWith("Hang Seng"))!.label).toContain("last trade 2026-10-12");
    expect(diagnostics.missingCues).toContain("CL=F");
    expect(snapshot.evidence.some((e) => e.category === "NSE_PREOPEN")).toBe(false);
  });

  describe("GIFT Nifty quote freshness", () => {
    const capture = (quoteTime: Date | null | undefined) => new CapturePremarketSnapshot(deps({
      giftNiftyQuote: async () => ({ lastPrice: 22575.5, changePercent: 0.24, expiryDate: "27-Oct-2026", quoteTime }),
    })).capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0850" });

    it("stamps the evidence with the exchange's own last-update time and says so in the label", async () => {
      const { snapshot } = await capture(new Date("2026-10-12T03:39:40.000Z")); // 09:09:40 IST
      const [change, price] = snapshot.evidence.filter((e) => e.category === "GIFT_NIFTY");
      expect(change!.observedAt).toBe("2026-10-12T03:39:40.000Z");
      expect(price!.observedAt).toBe("2026-10-12T03:39:40.000Z");
      expect(change!.label).toContain("last update 09:09 IST");
    });

    it("refuses a stale quote as the driver and reports how old it was", async () => {
      const { snapshot, diagnostics } = await capture(new Date("2026-10-12T02:00:00.000Z")); // 07:30 IST, 100.5 min before capture
      expect(snapshot.evidence.some((e) => e.category === "GIFT_NIFTY")).toBe(false);
      expect(String(diagnostics.giftNifty)).toMatch(/^STALE_QUOTE: last updated 2026-10-12T02:00:00.000Z, 101 min/);
    });

    it("keeps a quote with no exchange time, but leaves its time unknown instead of using the fetch time", async () => {
      const { snapshot, diagnostics } = await capture(null);
      const change = snapshot.evidence.find((e) => e.category === "GIFT_NIFTY" && e.unit === "PERCENT_CHANGE")!;
      expect(change.observedAt).toBeNull();
      expect(change.label).toContain("quote time not provided");
      expect(diagnostics.giftNiftyQuoteTime).toBe("NOT_PROVIDED_OR_UNUSABLE");
    });
  });

  it("builds candidate levels for both instruments", async () => {
    const { snapshot } = await new CapturePremarketSnapshot(deps()).capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0850" });
    expect(new Set(snapshot.candidateLevels.map((l) => l.instrument))).toEqual(new Set(["NIFTY50", "BANKNIFTY"]));
  });

  it("survives a GIFT Nifty outage and reports it instead of throwing", async () => {
    const { snapshot, diagnostics } = await new CapturePremarketSnapshot(deps({ giftNiftyQuote: async () => { throw new Error("nse ix down"); } }))
      .capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0850" });
    expect(snapshot.evidence.some((e) => e.category === "GIFT_NIFTY")).toBe(false);
    expect(String(diagnostics.giftNifty)).toContain("FETCH_FAILED");
  });

  it("adds pre-open evidence on the 09:10 slot only when the gate passes", async () => {
    const passing = await new CapturePremarketSnapshot(deps()).capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0910" });
    const preopen = passing.snapshot.evidence.filter((e) => e.category === "NSE_PREOPEN");
    expect(preopen).toHaveLength(2);
    expect((passing.diagnostics.preOpenProbe as { gate: string }).gate).toBe("PASSED");

    const closed = await new CapturePremarketSnapshot(deps({
      indexIndicatives: async () => ({ timestamp: "12-Oct-2026 15:30", rows: {
        NIFTY50: { indicativeClose: 0, previousClose: 22520.45, last: 22363 },
        BANKNIFTY: { indicativeClose: 0, previousClose: 55256.65, last: 54918 },
      } }),
    })).capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0910" });
    expect(closed.snapshot.evidence.some((e) => e.category === "NSE_PREOPEN")).toBe(false);
    expect((closed.diagnostics.preOpenProbe as { gate: string }).gate).toBe("TIMESTAMP_OUTSIDE_PREOPEN_WINDOW");
  });

  it("does not touch the pre-open feed on the 08:50 slot", async () => {
    let called = false;
    await new CapturePremarketSnapshot(deps({ indexIndicatives: async () => { called = true; throw new Error("x"); } }))
      .capture({ sessionDate: "2026-10-12", runSlot: "k", now: NOW, slot: "0850" });
    expect(called).toBe(false);
  });
});

describe("SettleSessionOutcomes", () => {
  function store(sessions: Array<{ sessionDate: string }>) {
    const saved: SessionOutcome[] = [];
    const s: SessionOutcomeStore = {
      listSessionsNeedingOutcome: async () => sessions.map((x) => ({ ...x, candidateLevels: [] })),
      loadMeasurementInputs: async (_instrument, date) => ({
        previousClose: 22520.45,
        bars: [{ openTime: istInstant(date, 9 * 60 + 15), open: 22600, high: 22610, low: 22590, close: 22605, volume: 100 }],
      }),
      saveOutcome: async (o) => { saved.push(o); },
    };
    return { s, saved };
  }

  it("does not measure a session before its close plus the settlement buffer", async () => {
    const { s, saved } = store([{ sessionDate: "2026-10-12" }]);
    const result = await new SettleSessionOutcomes(s, () => istInstant("2026-10-12", 15 * 60 + 40)).execute();
    expect(result).toMatchObject({ examined: 1, measured: 0, notYetClosed: 1 });
    expect(saved).toHaveLength(0);
  });

  it("measures both instruments once the session is over, and attributes gaps in the data", async () => {
    const { s, saved } = store([{ sessionDate: "2026-10-12" }]);
    const result = await new SettleSessionOutcomes(s, () => istInstant("2026-10-12", 16 * 60 + 40)).execute();
    expect(result.measured).toBe(1);
    expect(saved.map((o) => o.instrument).sort()).toEqual(["BANKNIFTY", "NIFTY50"]);
    expect(saved[0]!.gapOutcome).toBe("UP");
    // Only the 09:15 bar exists in this fixture, so the other two targets are unmeasurable, with reasons.
    expect(result.unmeasurableReasons).toEqual({ NO_1014_BAR: 2, CLOSE_WINDOW_HAS_0_BARS: 2 });
  });

  it("never measures a session dated in the future", async () => {
    const { s, saved } = store([{ sessionDate: "2026-10-13" }]);
    const result = await new SettleSessionOutcomes(s, () => istInstant("2026-10-12", 23 * 60)).execute();
    expect(result.notYetClosed).toBe(1);
    expect(saved).toHaveLength(0);
  });

  it("rejects a non-positive limit", async () => {
    await expect(new SettleSessionOutcomes(store([]).s).execute({ limit: 0 })).rejects.toThrow(/positive/);
  });
});
