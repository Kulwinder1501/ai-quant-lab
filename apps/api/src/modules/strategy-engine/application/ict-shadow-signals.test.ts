import { describe, expect, it, vi } from "vitest";
import {
  captureIctShadowSignals,
  resolveIctShadowSignals,
  type CapturePorts,
  type ResolvePorts,
} from "./ict-shadow-signals.js";
import type { StrategyMarketContext } from "../domain/strategy.js";
import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";

const SERIES = [{ symbol: "NIFTY50", timeframe: "15m" }, { symbol: "BANKNIFTY", timeframe: "5m" }];
const NOW = new Date("2026-10-13T05:00:00.000Z");

const counterBiasSnapshot = {
  atr14: 5, htfBias: "BEARISH", engineVersion: "t", configHash: "t",
  coverage: { structure: "COMPLETE", bias: "COMPLETE", zones: "COMPLETE", sessionLevels: "COMPLETE", liquidity: "COMPLETE", htf: "COMPLETE" },
  bias: { bias: "BEARISH", dailyTemplate: "OLHC", dealingRange: null },
  structure: { trend: "BEARISH" }, zones: { activeObs: [], activeFvgs: [] },
  sessionLevels: { levels: {}, lastSweepEvent: null },
  liquidity: { alignmentStatus: "BLOCKED", primaryTarget: null, intermediateTarget: null, invalidationLevel: null },
  mss: {
    direction: "BULLISH", brokenLevel: 110, brokenPivotTime: new Date("2026-10-13T03:00:00.000Z"), sweepBarIndex: 10,
    legStart: 100, legEnd: 140, breakBarIndex: 12, breakBarTime: new Date("2026-10-13T03:30:00.000Z"),
    displacementBodyAtr: 1.6, hasFvg: true, barsSinceBreak: 3, sweptKind: "SWING", availableAt: 0,
  },
} as unknown as IctStateCompositeSnapshot;

function context(closeTime: Date, snapshot: IctStateCompositeSnapshot | null = counterBiasSnapshot): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1", instrumentId: "inst-1", timeframe: "15m",
      openTime: new Date(closeTime.getTime() - 15 * 60_000), closeTime,
      open: 114.5, high: 117, low: 114, close: 116, volume: 1, tickSize: 0.05,
    },
    indicators: [], patterns: [], priceActionEvents: [], ictSnapshot: snapshot ?? undefined,
  };
}

function capturePorts(overrides: Partial<CapturePorts> = {}): CapturePorts & { insert: ReturnType<typeof vi.fn> } {
  return {
    findInstrumentId: vi.fn(async (symbol: string) => `id-${symbol}`),
    findLatestCompleted: vi.fn(async () => context(new Date("2026-10-13T04:15:00.000Z"))),
    insert: vi.fn(async () => true),
    ...overrides,
  } as CapturePorts & { insert: ReturnType<typeof vi.fn> };
}

describe("captureIctShadowSignals", () => {
  it("records a counter-bias signal with the real bias beside it", async () => {
    const ports = capturePorts();
    const results = await captureIctShadowSignals(ports, NOW, SERIES);
    expect(results.map((r) => r.status)).toEqual(["EVALUATED", "EVALUATED"]);
    expect(results[0]).toMatchObject({ signals: 1, inserted: 1 });
    const stored = ports.insert.mock.calls[0]![0];
    expect(stored).toMatchObject({ side: "LONG", bias: "BEARISH", biasAligned: false, liveWouldFire: false, timeframe: "15m" });
    expect(stored.details.barAgeSecondsAtCapture).toBeGreaterThan(0);
  });

  it("counts a repeat evaluation of the same bar as already recorded", async () => {
    const ports = capturePorts({ insert: vi.fn(async () => false) });
    const [first] = await captureIctShadowSignals(ports, NOW, SERIES);
    expect(first).toMatchObject({ signals: 1, inserted: 0 });
  });

  it("does not record a signal that closes at or after the 15:15 entry cutoff", async () => {
    const ports = capturePorts({ findLatestCompleted: vi.fn(async () => context(new Date("2026-10-13T09:45:00.000Z"))) });
    const [first] = await captureIctShadowSignals(ports, NOW, SERIES);
    expect(first).toMatchObject({ signals: 1, inserted: 0, skippedAtCutoff: 1 });
    expect(ports.insert).not.toHaveBeenCalled();
  });

  it("isolates a failing series from the others", async () => {
    let calls = 0;
    const ports = capturePorts({
      findLatestCompleted: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("context unavailable");
        return context(new Date("2026-10-13T04:15:00.000Z"));
      }),
    });
    const results = await captureIctShadowSignals(ports, NOW, SERIES);
    expect(results[0]).toMatchObject({ status: "FAILED", error: "context unavailable" });
    expect(results[1]).toMatchObject({ status: "EVALUATED", inserted: 1 });
  });

  it("reports a missing instrument or bar without failing", async () => {
    const none = await captureIctShadowSignals(capturePorts({ findInstrumentId: vi.fn(async () => null) }), NOW, SERIES);
    expect(none.every((r) => r.status === "NO_INSTRUMENT")).toBe(true);
    const noBar = await captureIctShadowSignals(capturePorts({ findLatestCompleted: vi.fn(async () => null) }), NOW, SERIES);
    expect(noBar.every((r) => r.status === "NO_BAR")).toBe(true);
  });

  it("records nothing when the bar carries no counter-bias setup", async () => {
    const ports = capturePorts({ findLatestCompleted: vi.fn(async () => context(new Date("2026-10-13T04:15:00.000Z"), null)) });
    const [first] = await captureIctShadowSignals(ports, NOW, SERIES);
    expect(first).toMatchObject({ status: "EVALUATED", signals: 0, inserted: 0 });
  });
});

describe("resolveIctShadowSignals", () => {
  const MINUTE = 60_000;
  const barClose = new Date("2026-10-13T04:30:00.000Z");
  const pending = [{
    id: "s-1", instrumentId: "inst-1", side: "LONG" as const,
    entryPrice: 100, stopLoss: 98, targetPrice: 104, barCloseTime: barClose,
  }];

  function ports(bars: ReturnType<ResolvePorts["loadOneMinuteBars"]> extends Promise<infer T> ? T : never): ResolvePorts & { recordResolution: ReturnType<typeof vi.fn> } {
    return {
      listUnresolved: vi.fn(async () => pending),
      loadOneMinuteBars: vi.fn(async () => bars),
      recordResolution: vi.fn(async () => true),
    } as ResolvePorts & { recordResolution: ReturnType<typeof vi.fn> };
  }

  const hit = [{
    id: "b-1", openTime: barClose, closeTime: new Date(barClose.getTime() + MINUTE),
    open: 100, high: 104.5, low: 100, close: 104,
  }];

  it("settles a signal whose bracket has been touched", async () => {
    const p = ports(hit);
    const summary = await resolveIctShadowSignals(p, new Date("2026-10-13T05:00:00.000Z"));
    expect(summary).toMatchObject({ considered: 1, settled: 1, open: 0 });
    expect(p.recordResolution.mock.calls[0]![1]).toMatchObject({ outcome: "TARGET" });
  });

  it("leaves a signal alone while it is still running", async () => {
    const quiet = [{ ...hit[0]!, high: 100.5, close: 100.2 }];
    const p = ports(quiet);
    const summary = await resolveIctShadowSignals(p, new Date("2026-10-13T04:35:00.000Z"));
    expect(summary).toMatchObject({ settled: 0, open: 1 });
    expect(p.recordResolution).not.toHaveBeenCalled();
  });
});
