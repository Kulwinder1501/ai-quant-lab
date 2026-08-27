import { describe, expect, it } from "vitest";
import {
  classifySessionRegimes,
  EXPECTED_CONCURRENT_REGIMES,
  KNOWN_COLLECTOR_REGIMES,
  LEGACY_POLLER_V1,
  POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
  STREAMER_V1_RECEIPT_CLOCK_ONLY,
  STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
  UNSTAMPED_REGIME,
} from "./collector-regimes.js";

describe("classifySessionRegimes", () => {
  it("treats the streamer and its floor poller as one healthy session", () => {
    /*
     * The designed steady state, and the case the old `regimes.length > 1` rule got wrong. The
     * scheduler keeps the once-a-minute HTTP poller deliberately: "a socket fails by going quiet",
     * so the poller deposits a quote every tick and the series degrades to its old resolution
     * instead of stopping. Two declared collectors is therefore normal, not a boundary crossing.
     */
    const result = classifySessionRegimes([
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
      POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
    ]);

    expect(result.unexpectedChange).toBe(false);
    expect(result.unstamped).toEqual([]);
  });

  it("reports an unstamped regime whatever else the session contains", () => {
    /*
     * The actual defect this vocabulary was written for. From 2026-08-24 the poller wrote NULL for
     * ~6-7% of every session's ticks, and migration 078 refuses a DEFAULT precisely so that surfaces
     * rather than being silently labelled.
     */
    const result = classifySessionRegimes([
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
      UNSTAMPED_REGIME,
    ]);

    expect(result.unstamped).toEqual([UNSTAMPED_REGIME]);
    // Not also a "change": the declared half is a single legitimate regime. Conflating the two is
    // what made the original finding read as a mid-session boundary when it was a missing stamp.
    expect(result.unexpectedChange).toBe(false);
    expect(result.declared).toEqual([STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION]);
  });

  it("still reports a genuine mid-session boundary", () => {
    const result = classifySessionRegimes([
      STREAMER_V1_RECEIPT_CLOCK_ONLY,
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
    ]);

    expect(result.unexpectedChange).toBe(true);
  });

  it("passes a historical session on a single superseded regime", () => {
    /*
     * Date-agnostic by design. An earlier version of this compared every regime against the current
     * concurrent set, which marked a legitimately all-STREAMER_V1 session from 2026-08-21 as
     * DEGRADED -- an existing collector-health test caught it. A single declared regime is fine
     * whichever one it is, because the check evaluates arbitrary session dates.
     */
    for (const regime of KNOWN_COLLECTOR_REGIMES) {
      const result = classifySessionRegimes([regime]);
      expect(result.unexpectedChange, `single regime ${regime}`).toBe(false);
      expect(result.unstamped).toEqual([]);
    }
  });

  it("reports a pair drawn from different eras even when both are known", () => {
    // LEGACY_POLLER_V1 alongside today's streamer is not a concurrent design, it is a rollback.
    const result = classifySessionRegimes([
      LEGACY_POLLER_V1,
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
    ]);

    expect(result.unexpectedChange).toBe(true);
  });

  it("is order and duplicate insensitive", () => {
    const forward = classifySessionRegimes([
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
      POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
    ]);
    const reversed = classifySessionRegimes([
      POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
      STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
    ]);

    expect(forward).toEqual(reversed);
  });

  it("keeps the expected concurrent set inside the known vocabulary", () => {
    // A typo in either list would otherwise make a live collector look undeclared forever.
    for (const regime of EXPECTED_CONCURRENT_REGIMES) {
      expect(KNOWN_COLLECTOR_REGIMES).toContain(regime);
    }
  });

  it("treats an empty session as unremarkable", () => {
    // "Nothing collected" is COLLECTOR_PRODUCED_NOTHING upstream; it must not also read as a regime
    // problem, or one outage would report two unrelated findings.
    const result = classifySessionRegimes([]);

    expect(result.unexpectedChange).toBe(false);
    expect(result.unstamped).toEqual([]);
    expect(result.declared).toEqual([]);
  });
});
