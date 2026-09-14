import { describe, expect, it } from "vitest";
import {
  barSpanFromLabel,
  PATTERN_INTELLIGENCE_CONVENTION,
  relabelBar,
  resolveEarliestExecutionAt,
  SCALP_HARNESS_CONVENTION,
  sealPitInstants,
  type PitInstants,
} from "./pit-instants.js";

const MINUTE = 60_000;
const at = (iso: string): Date => new Date(iso);

describe("bar label conventions", () => {
  it("resolves the same span from either convention's label", () => {
    /*
     * The conversion this module exists for. Pattern Intelligence stamps the bar spanning
     * 15:20:00-15:21:00 as 15:20:00; the scalp harness stamps it as 15:21:00. Both resolve to one
     * span, which is what makes a cross-module join exact instead of approximately right.
     */
    const fromOpen = barSpanFromLabel({
      label: at("2026-08-31T15:20:00.000Z"),
      convention: "OPEN_LABELLED",
      durationMs: MINUTE,
    });
    const fromClose = barSpanFromLabel({
      label: at("2026-08-31T15:21:00.000Z"),
      convention: "CLOSE_LABELLED",
      durationMs: MINUTE,
    });

    expect(fromOpen).toEqual(fromClose);
    expect(fromOpen.openAt.toISOString()).toBe("2026-08-31T15:20:00.000Z");
    expect(fromOpen.closeAt.toISOString()).toBe("2026-08-31T15:21:00.000Z");
  });

  it("names the two conventions actually in use, so a caller cannot guess", () => {
    expect(PATTERN_INTELLIGENCE_CONVENTION).toBe("OPEN_LABELLED");
    expect(SCALP_HARNESS_CONVENTION).toBe("CLOSE_LABELLED");
  });

  it("relabels in both directions and is its own inverse", () => {
    const openLabel = at("2026-08-31T15:20:00.000Z");
    const closeLabel = relabelBar({
      label: openLabel, from: "OPEN_LABELLED", to: "CLOSE_LABELLED", durationMs: MINUTE,
    });

    expect(closeLabel.toISOString()).toBe("2026-08-31T15:21:00.000Z");
    expect(relabelBar({
      label: closeLabel, from: "CLOSE_LABELLED", to: "OPEN_LABELLED", durationMs: MINUTE,
    }).toISOString()).toBe(openLabel.toISOString());
  });

  it("reproduces the join the harness runner performs today", () => {
    // The runner reads Pattern Intelligence observations with `detectedAt: context.candle.openTime`
    // while its own decisionAt is `candle.closeTime`. That is correct, and it is the only place the
    // translation exists. Pinning it here means a future edit to that call site has something to
    // disagree with.
    const decisionAt = at("2026-08-31T15:21:00.000Z"); // harness decisionAt = close
    const observationLabel = relabelBar({
      label: decisionAt, from: SCALP_HARNESS_CONVENTION, to: PATTERN_INTELLIGENCE_CONVENTION, durationMs: MINUTE,
    });

    expect(observationLabel.toISOString()).toBe("2026-08-31T15:20:00.000Z");
  });

  it("refuses a bar label or duration it cannot use", () => {
    expect(() => barSpanFromLabel({ label: at("nope"), convention: "OPEN_LABELLED", durationMs: MINUTE }))
      .toThrow(/valid Date/);
    expect(() => barSpanFromLabel({ label: at("2026-08-31T15:20:00Z"), convention: "OPEN_LABELLED", durationMs: 0 }))
      .toThrow(/positive, finite/);
  });
});

describe("resolveEarliestExecutionAt", () => {
  it("takes the first bar opening strictly after knownAt", () => {
    const result = resolveEarliestExecutionAt({
      knownAt: at("2026-08-31T15:20:00.000Z"),
      subsequentBarOpens: [at("2026-08-31T15:21:00.000Z"), at("2026-08-31T15:22:00.000Z")],
      fallbackDurationMs: MINUTE,
    });

    expect(result.earliestExecutionAt.toISOString()).toBe("2026-08-31T15:21:00.000Z");
    expect(result.resolvedFromBar).toBe(true);
  });

  it("skips a bar that opened exactly at knownAt", () => {
    // Strictly after, not at. A bar opening at the instant the data became knowable was not
    // actionable on that information -- the comparison in the live derivation is `>`, not `>=`.
    const result = resolveEarliestExecutionAt({
      knownAt: at("2026-08-31T15:21:00.000Z"),
      subsequentBarOpens: [at("2026-08-31T15:21:00.000Z"), at("2026-08-31T15:22:00.000Z")],
      fallbackDurationMs: MINUTE,
    });

    expect(result.earliestExecutionAt.toISOString()).toBe("2026-08-31T15:22:00.000Z");
  });

  it("crosses a session boundary using the real next bar, not duration arithmetic", () => {
    /*
     * The regression that motivated the live derivation. Adding a bar duration to a detection on the
     * session's last bar lands inside the overnight close -- an instant at which nothing could be
     * executed. On a multi-day series that is every session, not an edge case. The candle series is
     * the only ground truth for when trading actually resumed.
     */
    const result = resolveEarliestExecutionAt({
      knownAt: at("2026-08-31T10:00:00.000Z"),       // 15:30 IST, session close
      subsequentBarOpens: [at("2026-09-01T03:46:00.000Z")], // 09:16 IST next session
      fallbackDurationMs: MINUTE,
    });

    expect(result.earliestExecutionAt.toISOString()).toBe("2026-09-01T03:46:00.000Z");
    expect(result.resolvedFromBar).toBe(true);
    // Duration arithmetic would have produced 10:01, ~17.75 hours early and inside the close.
    expect(result.earliestExecutionAt.getTime()).toBeGreaterThan(at("2026-08-31T10:01:00.000Z").getTime());
  });

  it("honours a knownAt that lands after the following bar has already opened", () => {
    // A late data vintage. The next bar was already unexecutable by the time we knew anything, so the
    // answer is the bar after it. The earlier derivation ignored knownAt and got this wrong.
    const result = resolveEarliestExecutionAt({
      knownAt: at("2026-08-31T15:21:30.000Z"),
      subsequentBarOpens: [
        at("2026-08-31T15:21:00.000Z"),
        at("2026-08-31T15:22:00.000Z"),
      ],
      fallbackDurationMs: MINUTE,
    });

    expect(result.earliestExecutionAt.toISOString()).toBe("2026-08-31T15:22:00.000Z");
  });

  it("falls back to duration only when no later bar was supplied, and says so", () => {
    // "We do not have the bar that would answer this", not "there is none". The flag is what lets a
    // caller tell an inferred instant from an observed one.
    const result = resolveEarliestExecutionAt({
      knownAt: at("2026-08-31T15:20:00.000Z"),
      subsequentBarOpens: [],
      fallbackDurationMs: MINUTE,
    });

    expect(result.earliestExecutionAt.toISOString()).toBe("2026-08-31T15:21:00.000Z");
    expect(result.resolvedFromBar).toBe(false);
  });

  it("falls back when every supplied bar is at or before knownAt", () => {
    const result = resolveEarliestExecutionAt({
      knownAt: at("2026-08-31T15:25:00.000Z"),
      subsequentBarOpens: [at("2026-08-31T15:21:00.000Z"), at("2026-08-31T15:22:00.000Z")],
      fallbackDurationMs: MINUTE,
    });

    expect(result.resolvedFromBar).toBe(false);
    expect(result.earliestExecutionAt.toISOString()).toBe("2026-08-31T15:26:00.000Z");
  });
});

describe("sealPitInstants", () => {
  const sound: PitInstants = {
    eventAt: at("2026-08-31T15:20:00.000Z"),
    knownAt: at("2026-08-31T15:21:00.000Z"),
    dataThrough: at("2026-08-31T15:20:00.000Z"),
    dataThroughConvention: "OPEN_LABELLED",
    earliestExecutionAt: at("2026-08-31T15:22:00.000Z"),
    referenceAt: at("2026-08-31T15:22:00.000Z"),
  };

  it("freezes the instants rather than trusting readonly", () => {
    // `readonly` is erased at runtime, and these travel into hashing and persistence, where a later
    // mutation would leave no trace.
    const sealed = sealPitInstants(sound);

    expect(Object.isFrozen(sealed)).toBe(true);
    expect(() => {
      (sealed as { knownAt: Date }).knownAt = at("2020-01-01T00:00:00.000Z");
    }).toThrow();
  });

  it("accepts dataThrough on either side of the bar boundary", () => {
    /*
     * The two live modules place it either side of the same boundary: Pattern Intelligence at the
     * bar's open, the harness one millisecond before its close. A rule constraining dataThrough
     * against knownAt would hold for one and reject the other, so there deliberately is none.
     */
    expect(() => sealPitInstants({ ...sound, dataThrough: at("2026-08-31T15:20:59.999Z"), dataThroughConvention: "CLOSE_LABELLED" }))
      .not.toThrow();
    expect(() => sealPitInstants({ ...sound, dataThrough: at("2026-08-31T15:20:00.000Z") }))
      .not.toThrow();
  });

  it("refuses knowing something before it happened", () => {
    expect(() => sealPitInstants({ ...sound, knownAt: at("2026-08-31T15:19:00.000Z") }))
      .toThrow(/cannot precede eventAt/);
  });

  it("refuses acting at or before the instant of knowing", () => {
    expect(() => sealPitInstants({ ...sound, earliestExecutionAt: sound.knownAt }))
      .toThrow(/strictly after knownAt/);
    expect(() => sealPitInstants({ ...sound, earliestExecutionAt: at("2026-08-31T15:20:30.000Z") }))
      .toThrow(/strictly after knownAt/);
  });

  it("refuses measuring from before entry", () => {
    // referenceAt is kept separate from earliestExecutionAt even though Pattern Intelligence sets
    // them equal today, because a horizon of H bars spans [0, H-1] from Bar 0 and conflating the two
    // is how that becomes an invisible off-by-one.
    expect(() => sealPitInstants({ ...sound, referenceAt: at("2026-08-31T15:21:30.000Z") }))
      .toThrow(/cannot precede earliestExecutionAt/);
  });

  it("refuses an invalid date in any field", () => {
    for (const field of ["eventAt", "knownAt", "dataThrough", "earliestExecutionAt", "referenceAt"] as const) {
      expect(() => sealPitInstants({ ...sound, [field]: at("nope") }), field).toThrow(/valid Date/);
    }
  });
});
