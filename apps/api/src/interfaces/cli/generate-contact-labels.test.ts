import { describe, expect, it } from "vitest";
import {
  HORIZONS_SECONDS,
  buildInsertQuery,
  buildLabelQuery,
  computeContactLabel,
  type LabelBar,
  type LabelCandidate,
} from "./generate-contact-labels.js";

/**
 * Contact-label look-ahead regression (audit: 5m SESSION_HIGH/LOW 5646 of 5646 "contacted", 0
 * breached; 5m swing levels at 300s breached = 0 by construction).
 *
 * `known_at_time` is the OPEN of the confirming bar (repo stamp convention, `causal-pivot.ts`), so
 * for a 5m candidate [known_at, known_at + 5m) IS the confirming bar. The old window started at
 * known_at_time and therefore credited the confirming bar -- observed before the level existed.
 */

const KNOWN_AT = new Date("2026-09-14T04:00:00Z"); // open of the 5m confirming bar
const MIN = 60_000;

function at(minutesFromKnown: number): Date {
  return new Date(KNOWN_AT.getTime() + minutesFromKnown * MIN);
}

function bar(minute: number, high: number, low: number, close = (high + low) / 2): LabelBar {
  return { openTime: at(minute), high, low, close };
}

/** 1m bars covering [fromMinute, toMinute) with a constant range. */
function flat(fromMinute: number, toMinute: number, high: number, low: number, close?: number): LabelBar[] {
  const out: LabelBar[] = [];
  for (let m = fromMinute; m < toMinute; m++) out.push(bar(m, high, low, close));
  return out;
}

const UP_LEVEL = 50_100; // eps = 10 bps => contact needs high >= 50_049.9 ; delta = 5 bps => breach >= 50_125.05
const upCandidate: LabelCandidate = { side: "UP", poolPrice: UP_LEVEL, knownAtTime: KNOWN_AT, timeframeSeconds: 300 };

/** Pre-window context: price comfortably below the level, so the candidate is active. */
const before = flat(-6, 0, 49_900, 49_880, 49_890);

describe("contact label window starts at the confirming bar's CLOSE", () => {
  it("does not credit a contact made by the confirming bar itself (5m candidate)", () => {
    // The confirming bar [0,5) makes the level -- its high IS the level. After it, price stays away.
    const confirming = [
      ...flat(0, 4, 49_950, 49_900),
      bar(4, UP_LEVEL, 49_950, 49_960),
    ];
    const after = flat(5, 10, 49_980, 49_930); // never within 10 bps of the level
    const label = computeContactLabel(upCandidate, [...before, ...confirming, ...after], 300)!;

    expect(label.observableAt.toISOString()).toBe(at(5).toISOString());
    expect(label.contacted).toBe(false); // the old window would have said true
    expect(label.breached).toBe(false);
    expect(label.contactTime).toBeNull();
    expect(label.barsInWindow).toBe(5);
  });

  it("a touch inside the confirming bar does not count even at the longest horizon", () => {
    const confirming = flat(0, 5, 50_200, 49_950); // blows straight through the level while forming
    const after = flat(5, 20, 49_980, 49_930);
    for (const horizon of HORIZONS_SECONDS) {
      const label = computeContactLabel(upCandidate, [...before, ...confirming, ...after], horizon)!;
      expect(label.contacted).toBe(false);
      expect(label.breached).toBe(false);
    }
  });

  it("credits the first bar AFTER the confirming bar, stamped at that bar's close, not its open", () => {
    const bars = [
      ...before,
      ...flat(0, 5, 49_950, 49_900),
      ...flat(5, 7, 49_980, 49_930),
      bar(7, 50_060, 49_990), // touches (>= 50_049.9) in [07, 08)
      ...flat(8, 10, 49_980, 49_930),
    ];
    const label = computeContactLabel(upCandidate, bars, 300)!;
    expect(label.contacted).toBe(true);
    expect(label.contactTime!.toISOString()).toBe(at(8).toISOString()); // close of the touch bar
    expect(label.contactTime!.getTime()).toBeGreaterThan(at(7).getTime());
  });

  it("the earliest possible contact_time is observable_at + one bar (never inside the confirming bar)", () => {
    const bars = [...before, ...flat(0, 5, 50_300, 49_950), ...flat(5, 10, 50_300, 50_000)];
    const label = computeContactLabel(upCandidate, bars, 300)!;
    expect(label.contacted).toBe(true);
    expect(label.contactTime!.getTime()).toBe(at(6).getTime());
    expect(label.contactTime!.getTime()).toBeGreaterThanOrEqual(label.observableAt.getTime() + MIN);
  });

  it("measures price_at_known at the confirming bar's close and flags an already-at-level candidate inactive", () => {
    // The confirming bar closes at the level: nothing for a live system to wait for.
    const bars = [...before, ...flat(0, 4, 49_950, 49_900), bar(4, UP_LEVEL, 49_990, UP_LEVEL), ...flat(5, 10, 49_980, 49_930)];
    const label = computeContactLabel(upCandidate, bars, 300)!;
    expect(label.priceAtKnown).toBe(UP_LEVEL);
    expect(label.isActiveCandidate).toBe(false);
  });

  it("is active when price at the confirming bar's close is >= 2 eps (20 bps) away", () => {
    const bars = [...before, ...flat(0, 5, 49_950, 49_900, 49_950), ...flat(5, 10, 49_980, 49_930)];
    const label = computeContactLabel(upCandidate, bars, 300)!;
    expect(label.isActiveCandidate).toBe(true);
    expect(label.distanceBps).toBeCloseTo(((UP_LEVEL - 49_950) / UP_LEVEL) * 10_000, 6);
  });

  it("returns null (row excluded) when no bar has closed by observable_at", () => {
    expect(computeContactLabel(upCandidate, flat(5, 10, 49_980, 49_930), 300)).toBeNull();
  });
});

describe("contact label horizons and coverage", () => {
  it("has no 30s horizon: every horizon is a whole number of 1m bars", () => {
    expect(HORIZONS_SECONDS).not.toContain(30);
    for (const h of HORIZONS_SECONDS) expect(h % 60).toBe(0);
  });

  it("the 60s horizon sees exactly one bar (the first after the confirming bar)", () => {
    const bars = [
      ...before,
      ...flat(0, 5, 49_950, 49_900),
      bar(5, 49_980, 49_930),
      bar(6, 50_060, 49_990), // touch in the SECOND post-confirm bar
      ...flat(7, 10, 49_980, 49_930),
    ];
    const l60 = computeContactLabel(upCandidate, bars, 60)!;
    expect(l60.barsInWindow).toBe(1);
    expect(l60.contacted).toBe(false);
    const l120 = computeContactLabel(upCandidate, bars, 120)!;
    expect(l120.barsInWindow).toBe(2);
    expect(l120.contacted).toBe(true);
    expect(l120.contactTime!.toISOString()).toBe(at(7).toISOString());
  });

  it("a bar that straddles the horizon end is excluded (a 1m bar never fakes a sub-minute window)", () => {
    const bars = [...before, ...flat(0, 5, 49_950, 49_900), ...flat(5, 10, 49_980, 49_930)];
    expect(computeContactLabel(upCandidate, bars, 120)!.barsInWindow).toBe(2);
  });

  it("is UNKNOWN (null), not false, when the window is only partially covered and nothing touched", () => {
    const bars = [...before, ...flat(0, 5, 49_950, 49_900), ...flat(5, 7, 49_980, 49_930)]; // 2 of 5 bars
    const label = computeContactLabel(upCandidate, bars, 300)!;
    expect(label.barsInWindow).toBe(2);
    expect(label.contacted).toBeNull();
    expect(label.breached).toBeNull();
  });

  it("is UNKNOWN when there are no forward bars at all", () => {
    const label = computeContactLabel(upCandidate, [...before, ...flat(0, 5, 49_950, 49_900)], 300)!;
    expect(label.contacted).toBeNull();
    expect(label.breached).toBeNull();
    expect(label.contactTime).toBeNull();
  });

  it("a real touch in a partial window is still reported as contacted", () => {
    const bars = [...before, ...flat(0, 5, 49_950, 49_900), bar(5, 50_060, 49_990)];
    const label = computeContactLabel(upCandidate, bars, 300)!;
    expect(label.contacted).toBe(true);
    expect(label.breached).toBeNull(); // partial window, no breach seen, not fully covered -> unknown
  });

  it("distinguishes breach (>= +5 bps through) from contact", () => {
    const touchOnly = [...before, ...flat(0, 5, 49_950, 49_900), ...flat(5, 10, 50_060, 49_990)];
    expect(computeContactLabel(upCandidate, touchOnly, 300)).toMatchObject({ contacted: true, breached: false });
    const breach = [...before, ...flat(0, 5, 49_950, 49_900), ...flat(5, 10, 50_200, 49_990)];
    expect(computeContactLabel(upCandidate, breach, 300)).toMatchObject({ contacted: true, breached: true });
  });

  it("handles DOWN levels symmetrically and still excludes the confirming bar", () => {
    const level = 49_000;
    const down: LabelCandidate = { side: "DOWN", poolPrice: level, knownAtTime: KNOWN_AT, timeframeSeconds: 300 };
    const ctx = flat(-6, 0, 49_500, 49_480, 49_490);
    const confirming = [...flat(0, 4, 49_300, 49_100), bar(4, 49_200, level, 49_150)];
    const after = flat(5, 10, 49_400, 49_300);
    const label = computeContactLabel(down, [...ctx, ...confirming, ...after], 300)!;
    expect(label.contacted).toBe(false);
    expect(label.isActiveCandidate).toBe(true);

    const withTouch = [...ctx, ...confirming, ...flat(5, 7, 49_400, 49_300), bar(7, 49_100, 48_960), ...flat(8, 10, 49_400, 49_300)];
    const touched = computeContactLabel(down, withTouch, 300)!;
    expect(touched).toMatchObject({ contacted: true, breached: true });
    expect(touched.contactTime!.toISOString()).toBe(at(8).toISOString());
  });

  it("scales the confirming-bar exclusion with the candidate timeframe (1m vs 5m)", () => {
    const oneMin: LabelCandidate = { ...upCandidate, timeframeSeconds: 60 };
    const bars = [
      ...flat(-6, 0, 49_900, 49_880, 49_890),
      bar(0, UP_LEVEL, 49_950, 49_960), // 1m confirming bar
      bar(1, 50_060, 49_990), // first bar after it
      ...flat(2, 5, 49_980, 49_930),
    ];
    const label = computeContactLabel(oneMin, bars, 60)!;
    expect(label.observableAt.toISOString()).toBe(at(1).toISOString());
    expect(label.contacted).toBe(true);
    expect(label.contactTime!.toISOString()).toBe(at(2).toISOString());
  });
});

describe("contact label SQL (mirrors the reference rules)", () => {
  const sql = buildLabelQuery({
    epsilonBps: 10,
    deltaBps: 5,
    horizonSeconds: 300,
    timeframeFilter: "5m",
  });

  it("never starts the forward window at known_at_time", () => {
    expect(sql).not.toMatch(/c\.open_time\s*>=\s*pc\.known_at_time/);
    expect(sql).toMatch(/c\.open_time\s*>=\s*pc\.observable_at/);
  });

  it("derives observable_at from the candidate timeframe (known_at + bar span)", () => {
    expect(sql).toContain("lpc.known_at_time + tf.seconds * INTERVAL '1 second' AS observable_at");
    expect(sql).toContain("WHEN '5m' THEN 300");
    expect(sql).toContain("WHEN '1m' THEN 60");
  });

  it("only counts bars that close inside the horizon and stamps contact_time at the bar close", () => {
    expect(sql).toContain("c.open_time + INTERVAL '60 seconds' <= pc.observable_at + 300 * INTERVAL '1 second'");
    expect(sql).toContain("min(c.open_time + INTERVAL '60 seconds') FILTER");
  });

  it("measures price_at_known from bars that have closed by observable_at", () => {
    expect(sql).toContain("c.open_time + INTERVAL '60 seconds' <= lpc.known_at_time + tf.seconds * INTERVAL '1 second'");
  });

  it("filters candidates to the current candidate version by default and supports 'all'", () => {
    expect(sql).toContain("lpc.candidate_version = 'v2-dedup'");
    const all = buildLabelQuery({ epsilonBps: 10, deltaBps: 5, horizonSeconds: 300, timeframeFilter: null, candidateVersion: "all" });
    expect(all).not.toContain("lpc.candidate_version =");
  });

  it("rejects a malformed timeframe filter instead of interpolating it", () => {
    expect(() =>
      buildLabelQuery({ epsilonBps: 10, deltaBps: 5, horizonSeconds: 300, timeframeFilter: "5m' OR 1=1 --" })
    ).toThrow();
  });

  it("writes labeling_version v2-causal and conflicts on (candidate, horizon, version)", () => {
    const insert = buildInsertQuery({
      epsilonBps: 10,
      deltaBps: 5,
      horizonSeconds: 300,
      timeframeFilter: null,
      runId: "run-x",
    });
    expect(insert).toContain("labeling_version)");
    expect(insert).toContain("'v2-causal'");
    expect(insert).toContain("ON CONFLICT (candidate_id, horizon_seconds, labeling_version) DO NOTHING");
  });
});
