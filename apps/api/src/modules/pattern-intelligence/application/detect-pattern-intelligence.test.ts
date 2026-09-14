import { describe, expect, it } from "vitest";
import type { ObservationSource } from "../domain/contracts.js";
import {
  InMemoryPatternCoverageRecorder,
  InMemoryPatternObservationLedger,
} from "../domain/in-memory-pattern-store.js";
import type { CandleLike } from "../domain/pattern-context-calculator.js";
import { StaticPatternDefinitionRegistry } from "../domain/pattern-definition-registry.js";
import { DetectPatternIntelligence } from "./detect-pattern-intelligence.js";

function makeSource(): ObservationSource {
  return {
    exchange: "NSE",
    underlying: "NIFTY50",
    instrumentType: "FUTIDX",
    contractSymbol: "NIFTY26AUGFUT",
    contractExpiry: new Date("2026-08-27T00:00:00.000Z"),
    contractRole: "NEAR_MONTH",
    timeframe: "5m",
    timezone: "Asia/Kolkata",
    priceScale: 100,
    tickSize: 0.05,
    dataVintageId: "nse-feed:2026-08-25T09:15:00.000Z",
    dataVintageAt: new Date("2026-08-25T09:15:00.000Z"),
  };
}

/** 09:15 IST on 2026-08-25, the continuous session open. */
const sessionOpen = new Date("2026-08-25T03:45:00.000Z");

function barAt(index: number, bar: Omit<CandleLike, "openTime">): CandleLike {
  return { openTime: new Date(sessionOpen.getTime() + index * 5 * 60_000), ...bar };
}

/**
 * Fourteen flat bars sharing a low at 24500, then a bar that sweeps below it and reclaims.
 *
 * The sweep lands at index 14 — the 15th closed bar — deliberately past the 14-bar warmup floor, so
 * the spring is emittable. The same geometry placed inside warmup is the second test below.
 */
function springAfterWarmup(): CandleLike[] {
  const candles: CandleLike[] = [];
  for (let i = 0; i < 14; i++) {
    candles.push(barAt(i, { open: 24520, high: 24530, low: 24500, close: 24520, volume: 1000 + i }));
  }
  // Penetration 20 points (8.2 bps, over the 2.0 floor); reclaim 30 points (12.2 bps, over the 3.0 floor).
  candles.push(barAt(14, { open: 24510, high: 24535, low: 24480, close: 24530, volume: 2500 }));
  return candles;
}

describe("DetectPatternIntelligence Application Service", () => {
  it("orchestrates detection, seals observations, and writes master + initial DETECTED event atomically", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const ledger = new InMemoryPatternObservationLedger();
    const service = new DetectPatternIntelligence({ definitions, ledger, coverage: new InMemoryPatternCoverageRecorder() });

    const result = await service.execute({ candles: springAfterWarmup(), source: makeSource() });

    expect(result.candlesEvaluated).toBe(15);
    expect(result.patternsRecorded).toBeGreaterThanOrEqual(1);

    const recorded = result.observations.find((o) => o.identity.patternFamily === "SWEEP_RECLAIM");
    expect(recorded).toBeDefined();
    expect(recorded!.identity.patternSubtype).toBe("SPRING");
    expect(recorded!.identity.orientation).toBe("UP");
    expect(recorded!.provenance.observationHash).toHaveLength(64);

    // The definition is resolved per family, and its hash comes from the frozen record.
    expect(recorded!.definitionRef.definitionId).toBe("pattern-intelligence.sweep-reclaim");
    expect(recorded!.definitionRef.definitionHash).toHaveLength(64);

    // rangeAtr is a real measurement, never the 1.0 the old ATR fallback produced.
    expect(recorded!.geometry.rangeAtr).toBeGreaterThan(0);
    expect(Number.isFinite(recorded!.geometry.rangeAtr)).toBe(true);

    const obsId = recorded!.identity.observationId;
    expect(ledger.observations.has(obsId)).toBe(true);
    const events = ledger.lifecycleEvents.get(obsId);
    expect(events).toHaveLength(1);
    expect(events![0]!.eventType).toBe("DETECTED");
    expect(events![0]!.sequenceNumber).toBe(1);
  });

  it("emits no observation before ATR warmup completes, and says so rather than staying silent", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const ledger = new InMemoryPatternObservationLedger();
    const service = new DetectPatternIntelligence({ definitions, ledger, coverage: new InMemoryPatternCoverageRecorder() });

    // The identical spring geometry, compressed so the sweep lands at index 5 -- inside warmup.
    // Before the strict non-emission rule this recorded an observation whose rangeAtr was exactly
    // 1.0, because the orchestrator substituted the pattern's own range for the missing ATR.
    const candles: CandleLike[] = [];
    for (let i = 0; i < 5; i++) {
      candles.push(barAt(i, { open: 24520, high: 24530, low: 24500, close: 24520, volume: 1000 + i }));
    }
    candles.push(barAt(5, { open: 24510, high: 24535, low: 24480, close: 24530, volume: 2500 }));

    const result = await service.execute({ candles, source: makeSource() });

    expect(result.patternsRecorded).toBe(0);
    expect(result.observations).toHaveLength(0);
    expect(ledger.observations.size).toBe(0);
    // Refusal is counted, so "nothing qualified" and "nothing could be evaluated" stay distinct.
    expect(result.candidatesRefusedBeforeWarmup).toBeGreaterThan(0);
  });

  it("records coverage for an evaluated window even when it yields nothing, and keeps first-cover time", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const coverage = new InMemoryPatternCoverageRecorder();
    const source = makeSource();

    const flat = Array.from({ length: 20 }, (_, i) =>
      barAt(i, { open: 24520, high: 24530, low: 24500, close: 24520, volume: 1000 }));

    const first = await new DetectPatternIntelligence({
      definitions, ledger: new InMemoryPatternObservationLedger(), coverage,
    }).execute({ candles: flat, source });

    expect(coverage.records.size).toBe(1);
    const record = [...coverage.records.values()][0]!;
    expect(record.candlesEvaluated).toBe(20);
    expect(record.patternsFound).toBe(first.patternsRecorded);
    expect(record.fromTime).toEqual(flat[0]!.openTime);
    expect(record.toTime).toEqual(flat[19]!.openTime);

    // Re-running the same window must not mint a second row or move the timestamp -- the marker
    // dates first cover, not the most recent write.
    const firstRecordedAt = record.recordedAt;
    await new DetectPatternIntelligence({
      definitions, ledger: new InMemoryPatternObservationLedger(), coverage,
    }).execute({ candles: flat, source: { ...source, dataVintageAt: new Date("2026-08-26T09:15:00.000Z") } });

    expect(coverage.records.size).toBe(1);
    expect([...coverage.records.values()][0]!.recordedAt).toEqual(firstRecordedAt);
  });

  it("refuses to emit for bars outside the observable session", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const ledger = new InMemoryPatternObservationLedger();
    const service = new DetectPatternIntelligence({ definitions, ledger, coverage: new InMemoryPatternCoverageRecorder() });

    // The same spring, shifted to 21:15 IST -- a shape a bad backfill can produce. Every bar of it
    // used to be stamped CLOSING and observed as a real closing-hour pattern.
    const offsetMs = 12 * 60 * 60 * 1000;
    const candles = springAfterWarmup().map((c) => ({ ...c, openTime: new Date(c.openTime.getTime() + offsetMs) }));

    const result = await service.execute({ candles, source: makeSource() });

    expect(result.patternsRecorded).toBe(0);
    expect(result.candidatesRefusedOutsideSession).toBeGreaterThan(0);
  });

  it("refuses to emit on a frozen bar that reports neither price movement nor volume", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const ledger = new InMemoryPatternObservationLedger();
    const service = new DetectPatternIntelligence({ definitions, ledger, coverage: new InMemoryPatternCoverageRecorder() });

    // The measured index-feed freeze: real bars, then a block pinned at one constant on zero volume.
    // A flat bar is trivially an inside bar, so this block used to manufacture inside-bar chains --
    // 16 of the 18 observations a real 2026-08-25 BANKNIFTY 1m session produced on frozen bars.
    const candles: CandleLike[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(barAt(i, { open: 24500 + i, high: 24530 + i, low: 24480 + i, close: 24520 + i, volume: 1000 + i }));
    }
    for (let i = 20; i < 30; i++) {
      candles.push(barAt(i, { open: 24540, high: 24540, low: 24540, close: 24540, volume: 0 }));
    }

    const result = await service.execute({ candles, source: makeSource() });

    expect(result.candidatesRefusedStaleBar).toBeGreaterThan(0);
    for (const o of result.observations) {
      const index = candles.findIndex((c) => c.openTime.getTime() === o.timing.detectedAt.getTime());
      expect(index).toBeLessThan(20);
    }
  });

  it("refuses to emit on a frozen bar even when the feed stamps volume on the pinned price", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const ledger = new InMemoryPatternObservationLedger();
    const service = new DetectPatternIntelligence({ definitions, ledger, coverage: new InMemoryPatternCoverageRecorder() });

    // The same freeze as the test above, in the shape the feed actually emits since 2026-08-31: the
    // pinned block carries large constituent volume rather than zeros. The `zero range AND zero
    // volume` conjunction admitted all of these -- on NIFTY50 1m it refused 4 of 13 frozen bars and
    // let 9 through, and they were recorded. Value repetition is volume-blind, so it catches them.
    const candles: CandleLike[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(barAt(i, { open: 24500 + i, high: 24530 + i, low: 24480 + i, close: 24520 + i, volume: 1000 + i }));
    }
    for (let i = 20; i < 30; i++) {
      candles.push(barAt(i, { open: 24540, high: 24540, low: 24540, close: 24540, volume: 125_958_451 }));
    }

    const result = await service.execute({ candles, source: makeSource() });

    expect(result.candidatesRefusedStaleBar).toBeGreaterThan(0);
    for (const o of result.observations) {
      const index = candles.findIndex((c) => c.openTime.getTime() === o.timing.detectedAt.getTime());
      // Index 20 is the freeze onset -- flat, but not yet a repeat of anything -- so it is admitted
      // by design, exactly as the first bar of any run is. Everything after it must be refused.
      expect(index).toBeLessThanOrEqual(20);
    }
  });

  it("keeps a zero-range bar that carries real volume, and a moving bar whose volume dropped out", async () => {
    // Both are genuine observations and must survive. A volume-only dropout (2026-07-23) has
    // trustworthy prices; an isolated zero-range bar on real volume is a real, if dull, print. The
    // full matrix, including the frozen-with-volume case, is in `domain/bar-integrity.test.ts`.
    const { isStaleBar } = await import("../domain/bar-integrity.js");
    const at = new Date("2026-08-25T06:00:00.000Z");
    expect(isStaleBar({ openTime: at, open: 24540, high: 24540, low: 24540, close: 24540, volume: 5000 })).toBe(false);
    expect(isStaleBar({ openTime: at, open: 24500, high: 24530, low: 24480, close: 24520, volume: 0 })).toBe(false);
    expect(isStaleBar({ openTime: at, open: 24540, high: 24540, low: 24540, close: 24540, volume: 0 })).toBe(true);
  });

  it("dates earliestExecutionAt from the next real bar, not a bar-duration guess across a session gap", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const ledger = new InMemoryPatternObservationLedger();
    const service = new DetectPatternIntelligence({ definitions, ledger, coverage: new InMemoryPatternCoverageRecorder() });

    // The spring lands on the LAST bar of a session; the next bar is the following trading morning.
    // The old derivation added the previous bar's duration to the detection time, so a pattern on a
    // session's first bar was stamped executable ~18 hours late -- on a multi-day series, every day.
    const candles = springAfterWarmup();
    const nextMorning = new Date("2026-08-26T03:45:00.000Z"); // 09:15 IST the next day
    candles.push({ openTime: nextMorning, open: 24530, high: 24560, low: 24525, close: 24555, volume: 1800 });

    const result = await service.execute({ candles, source: makeSource() });
    const spring = result.observations.find((o) => o.identity.patternSubtype === "SPRING");
    expect(spring).toBeDefined();
    expect(spring!.timing.earliestExecutionAt).toEqual(nextMorning);
  });

  it("skips EFFORT_RESULT on an index source, because the family is BLOCKED on constituent volume", async () => {
    const definitions = new StaticPatternDefinitionRegistry();
    const indexSource: ObservationSource = {
      ...makeSource(),
      underlying: "BANKNIFTY", instrumentType: "INDEX", contractSymbol: "NSE:NIFTYBANK-INDEX",
      contractExpiry: null, contractRole: "SPOT",
    };
    // A window that would trigger a climax if the family were evaluable here.
    const candles = Array.from({ length: 25 }, (_, i) =>
      barAt(i, { open: 24500, high: 24530, low: 24480, close: 24520, volume: 1000 }));
    candles.push(barAt(25, { open: 24520, high: 24600, low: 24515, close: 24530, volume: 60_000 }));

    const result = await new DetectPatternIntelligence({
      definitions, ledger: new InMemoryPatternObservationLedger(), coverage: new InMemoryPatternCoverageRecorder(),
    }).execute({ candles, source: indexSource });

    expect(result.familiesBlockedByDataReadiness).toContain("EFFORT_RESULT");
    expect(result.observations.some((o) => o.identity.patternFamily === "EFFORT_RESULT")).toBe(false);

    // ...and it stays enabled for FUTIDX, which has genuine traded volume.
    const futures = await new DetectPatternIntelligence({
      definitions, ledger: new InMemoryPatternObservationLedger(), coverage: new InMemoryPatternCoverageRecorder(),
    }).execute({ candles, source: makeSource() });
    expect(futures.familiesBlockedByDataReadiness).not.toContain("EFFORT_RESULT");
  });

  it("counts and names candidates refused for want of a frozen definition", async () => {
    // A registry misconfiguration -- renamed id, unregistered family, version bumped on the engine
    // but not the record -- used to be dropped silently, which is indistinguishable from a quiet
    // market. Refusing to persist is correct; refusing without a trace is not.
    const empty = { findFrozen: async () => null };
    const result = await new DetectPatternIntelligence({
      definitions: empty, ledger: new InMemoryPatternObservationLedger(), coverage: new InMemoryPatternCoverageRecorder(),
    }).execute({ candles: springAfterWarmup(), source: makeSource() });

    expect(result.patternsRecorded).toBe(0);
    expect(result.candidatesRefusedUnregistered).toBeGreaterThan(0);
    expect(result.unregisteredDefinitionIds).toContain("pattern-intelligence.sweep-reclaim");
  });
});
