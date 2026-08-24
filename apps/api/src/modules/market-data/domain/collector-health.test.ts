import { describe, expect, it } from "vitest";
import {
  describeCollectorHealth,
  evaluateCollectorHealth,
  STRUCTURAL_SILENCE_MS,
  type CollectorObservation,
} from "./collector-health.js";

/** 09:15 and 15:40 IST on 2026-08-25, as UTC. */
const expectedOpenAt = new Date("2026-08-25T03:45:00.000Z");
const expectedCloseAt = new Date("2026-08-25T10:10:00.000Z");
const afterClose = new Date("2026-08-25T10:30:00.000Z");

/** A tick every 30 s across the whole derivatives session. */
function fullSession(overrides: {
  skipFrom?: Date;
  skipTo?: Date;
  regimeAt?: (at: Date) => string | null;
  exchangeClock?: boolean;
} = {}): CollectorObservation[] {
  const observations: CollectorObservation[] = [];
  for (let ms = expectedOpenAt.getTime(); ms <= expectedCloseAt.getTime(); ms += 30_000) {
    const observedAt = new Date(ms);
    if (overrides.skipFrom && overrides.skipTo && ms > overrides.skipFrom.getTime() && ms < overrides.skipTo.getTime()) {
      continue;
    }
    observations.push({
      observedAt,
      exchangeFeedTime: overrides.exchangeClock === false ? null : new Date(ms - 1_000),
      persistedAt: new Date(ms + 2_500),
      collectorRegime: overrides.regimeAt ? overrides.regimeAt(observedAt) : "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION",
    });
  }
  return observations;
}

const base = { sessionDate: "2026-08-25", expectedOpenAt, expectedCloseAt, now: afterClose };

describe("collector health", () => {
  it("reports HEALTHY for a session covered end to end", () => {
    const health = evaluateCollectorHealth({ ...base, observations: fullSession() });

    expect(health.status).toBe("HEALTHY");
    expect(health.findings).toEqual([]);
    expect(health.segment).toBe("EQUITY_DERIVATIVES");
    expect(health.expectedCloseAt.toISOString()).toBe("2026-08-25T10:10:00.000Z");
    expect(health.maxGapMs).toBeLessThanOrEqual(30_000);
  });

  it("detects the 11:00-12:45 shutdown as a receipt silence", () => {
    // The real failure mode: a deterministic daily outage inside the session.
    const health = evaluateCollectorHealth({
      ...base,
      observations: fullSession({
        skipFrom: new Date("2026-08-25T05:30:00.000Z"),
        skipTo: new Date("2026-08-25T07:15:00.000Z"),
      }),
    });

    expect(health.status).toBe("DEGRADED");
    expect(health.findings.some((finding) => finding.startsWith("RECEIPT_SILENCE_"))).toBe(true);
    expect(health.maxGapMs).toBeGreaterThan(6_000_000);
    expect(health.gaps).toHaveLength(1);
  });

  it("detects a collector that started after the open", () => {
    const late = fullSession().filter((item) => item.observedAt.getTime() > expectedOpenAt.getTime() + 30 * 60_000);
    const health = evaluateCollectorHealth({ ...base, observations: late });

    expect(health.findings).toContain("COLLECTOR_STARTED_LATE");
    expect(health.status).toBe("DEGRADED");
  });

  it("detects a collector that stopped before the derivatives close", () => {
    // Stopping at 15:30 is the legacy-poller failure: it truncated the F&O session at the cash bell.
    const cashCloseOnly = fullSession().filter((item) => item.observedAt.getTime() <= new Date("2026-08-25T10:00:00.000Z").getTime());
    const health = evaluateCollectorHealth({ ...base, observations: cashCloseOnly });

    expect(health.findings).toContain("COLLECTOR_STOPPED_EARLY");
  });

  it("does not call a still-running session stopped early", () => {
    // Mid-session the collector has legitimately not reached the close yet.
    const midSession = new Date("2026-08-25T06:00:00.000Z");
    const soFar = fullSession().filter((item) => item.observedAt.getTime() <= midSession.getTime());
    const health = evaluateCollectorHealth({ ...base, observations: soFar, now: midSession });

    expect(health.findings).not.toContain("COLLECTOR_STOPPED_EARLY");
    expect(health.status).toBe("INCOMPLETE");
  });

  it("reports a gap during a live session immediately, rather than waiting for the close", () => {
    // The whole point of running this in-session: discovering at 15:40 that 11:00-12:45 vanished is
    // too late to do anything about it.
    const midSession = new Date("2026-08-25T07:30:00.000Z");
    const soFar = fullSession({
      skipFrom: new Date("2026-08-25T05:30:00.000Z"),
      skipTo: new Date("2026-08-25T07:15:00.000Z"),
    }).filter((item) => item.observedAt.getTime() <= midSession.getTime());

    const health = evaluateCollectorHealth({ ...base, observations: soFar, now: midSession });

    expect(health.status).toBe("DEGRADED");
    expect(health.findings.some((finding) => finding.startsWith("RECEIPT_SILENCE_"))).toBe(true);
  });

  it("separates a vendor outage from our collector stopping", () => {
    // Both clocks gap together -> the feed stopped. Only receipt gaps -> we stopped receiving.
    const bothGap = evaluateCollectorHealth({
      ...base,
      observations: fullSession({
        skipFrom: new Date("2026-08-25T05:30:00.000Z"),
        skipTo: new Date("2026-08-25T06:00:00.000Z"),
      }),
    });

    expect(bothGap.receipt.gaps).toHaveLength(1);
    expect(bothGap.exchangeFeed.available).toBe(true);
    expect(bothGap.exchangeFeed.gaps).toHaveLength(1);
    expect(bothGap.findings.some((finding) => finding.startsWith("EXCHANGE_FEED_SILENCE_"))).toBe(true);
  });

  it("refuses to measure the exchange-feed domain when only some rows carry a clock", () => {
    // Partial coverage is worse than none here: gaps measured across only the stamped rows would
    // look like feed outages that never happened.
    const mixed = fullSession().map((item, index) => (
      index % 2 === 0 ? { ...item, exchangeFeedTime: null } : item
    ));
    const health = evaluateCollectorHealth({ ...base, observations: mixed });

    expect(health.exchangeFeed.available).toBe(false);
    expect(health.exchangeFeed.unavailableReason).toMatch(/carry an exchange clock/);
    expect(health.findings.every((finding) => !finding.startsWith("EXCHANGE_FEED_SILENCE_"))).toBe(true);
  });

  it("reports persistence lag separately from both feed clocks", () => {
    const health = evaluateCollectorHealth({ ...base, observations: fullSession() });

    expect(health.persistenceLagMs).toEqual({ median: 2_500, max: 2_500 });
  });

  it("flags an unexpected regime change mid-session", () => {
    const health = evaluateCollectorHealth({
      ...base,
      observations: fullSession({
        regimeAt: (at) => at.getTime() < new Date("2026-08-25T06:00:00.000Z").getTime()
          ? "STREAMER_V1_RECEIPT_CLOCK_ONLY"
          : "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION",
      }),
    });

    expect(health.findings.some((finding) => finding.startsWith("UNEXPECTED_REGIME_CHANGE:"))).toBe(true);
    expect(health.collectorRegimes).toHaveLength(2);
  });

  it("separates 'nothing collected' from 'something broke'", () => {
    // INCOMPLETE means cannot judge; DEGRADED is a positive finding. Collapsing them would make
    // "we have not looked" and "it broke" indistinguishable.
    const health = evaluateCollectorHealth({ ...base, observations: [] });

    expect(health.status).toBe("INCOMPLETE");
    expect(health.findings).toEqual(["COLLECTOR_PRODUCED_NOTHING"]);
    expect(health.persistenceLagMs).toBeNull();
  });

  it("derives the silence threshold from the streamer's reconnect cap, not a tuned number", () => {
    expect(STRUCTURAL_SILENCE_MS).toBe(300_000);
  });

  it("ignores silence outside the trading window", () => {
    // The collector goes quiet when the market shuts and the streamer holds contracts past the
    // bell, so same-date ticks contain long post-close gaps. Measured on 2026-08-24 those dominated
    // the findings; reporting them would mark every ordinary session DEGRADED until the alert
    // became noise.
    const withPostCloseTail: CollectorObservation[] = [
      ...fullSession(),
      // 16:00 and 16:34 IST: a half-hour hole entirely after the 15:40 close.
      { observedAt: new Date("2026-08-25T10:30:00.000Z"), exchangeFeedTime: null, persistedAt: new Date("2026-08-25T10:30:02.000Z"), collectorRegime: "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION" },
      { observedAt: new Date("2026-08-25T11:04:00.000Z"), exchangeFeedTime: null, persistedAt: new Date("2026-08-25T11:04:02.000Z"), collectorRegime: "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION" },
    ];
    const health = evaluateCollectorHealth({ ...base, observations: withPostCloseTail });

    expect(health.status).toBe("HEALTHY");
    expect(health.gaps).toEqual([]);
    // The raw extremes are still reported, because they are informative even when not faults.
    expect(health.lastObservedAt?.toISOString()).toBe("2026-08-25T11:04:00.000Z");
  });

  it("ignores a pre-open warm-up tick when judging gaps", () => {
    const withEarlyTick: CollectorObservation[] = [
      { observedAt: new Date("2026-08-25T03:42:00.000Z"), exchangeFeedTime: null, persistedAt: new Date("2026-08-25T03:42:02.000Z"), collectorRegime: "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION" },
      ...fullSession(),
    ];
    const health = evaluateCollectorHealth({ ...base, observations: withEarlyTick });

    expect(health.status).toBe("HEALTHY");
    expect(health.findings).toEqual([]);
  });

  it("does not report a regime boundary crossed outside trading hours", () => {
    // A deploy between sessions is not an unexpected mid-session change.
    const deployedAfterClose: CollectorObservation[] = [
      ...fullSession({ regimeAt: () => "STREAMER_V1_RECEIPT_CLOCK_ONLY" }),
      { observedAt: new Date("2026-08-25T10:30:00.000Z"), exchangeFeedTime: null, persistedAt: new Date("2026-08-25T10:30:02.000Z"), collectorRegime: "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION" },
    ];
    const health = evaluateCollectorHealth({ ...base, observations: deployedAfterClose });

    expect(health.collectorRegimes).toEqual(["STREAMER_V1_RECEIPT_CLOCK_ONLY"]);
    expect(health.status).toBe("HEALTHY");
  });

  it("names what broke rather than emitting a score", () => {
    const health = evaluateCollectorHealth({
      ...base,
      observations: fullSession({
        skipFrom: new Date("2026-08-25T05:30:00.000Z"),
        skipTo: new Date("2026-08-25T07:15:00.000Z"),
      }),
    });

    expect(describeCollectorHealth(health)).toMatch(/DEGRADED — RECEIPT_SILENCE_/);
    expect(describeCollectorHealth(evaluateCollectorHealth({ ...base, observations: fullSession() })))
      .toMatch(/HEALTHY — covered/);
  });
});
