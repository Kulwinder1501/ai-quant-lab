import { describe, expect, it } from "vitest";
import { normaliseTradedVolume } from "./traded-volume.js";

describe("normaliseTradedVolume", () => {
  it("passes an ordinary cumulative volume through untouched", () => {
    expect(normaliseTradedVolume(1_200)).toEqual({ volume: 1_200, rejectedRaw: null });
    expect(normaliseTradedVolume(0)).toEqual({ volume: 0, rejectedRaw: null });
  });

  it("keeps a value above the int32 ceiling, since the column is BIGINT", () => {
    // The point of not clamping: a genuinely large volume is storable and must not be discarded just
    // because it is near the width that broke the provider's counter.
    expect(normaliseTradedVolume(2_147_483_648)).toEqual({ volume: 2_147_483_648, rejectedRaw: null });
  });

  it("refuses a negative volume and keeps what was reported", () => {
    // The crash-loop value, verbatim. A cumulative count cannot run backwards, so this is a wrapped
    // counter, not a measurement.
    expect(normaliseTradedVolume(-1_862_658_846))
      .toEqual({ volume: null, rejectedRaw: -1_862_658_846 });
  });

  it("does not silently unwrap a negative into a plausible positive", () => {
    // -1862658846 + 2^32 = 2432308450, which looks entirely believable -- and that is exactly why it
    // must not be written as though it were observed. The raw value is kept so a confirmed field
    // width makes this a one-line backfill later.
    const normalised = normaliseTradedVolume(-1_862_658_846);
    expect(normalised.volume).toBeNull();
    expect(normalised.volume).not.toBe(2_432_308_450);
  });

  it("refuses a fractional volume rather than rounding it", () => {
    expect(normaliseTradedVolume(1_200.5)).toEqual({ volume: null, rejectedRaw: 1_200.5 });
  });

  it("treats an absent volume as absent, not as rejected", () => {
    // "The feed did not say" and "the feed said something impossible" are different facts, and only
    // the second is worth keeping a raw value for.
    expect(normaliseTradedVolume(null)).toEqual({ volume: null, rejectedRaw: null });
    expect(normaliseTradedVolume(undefined)).toEqual({ volume: null, rejectedRaw: null });
  });

  it("treats an unusable number as absent rather than as an observation", () => {
    expect(normaliseTradedVolume(Number.NaN)).toEqual({ volume: null, rejectedRaw: null });
    expect(normaliseTradedVolume(Number.POSITIVE_INFINITY)).toEqual({ volume: null, rejectedRaw: null });
    expect(normaliseTradedVolume(Number.NEGATIVE_INFINITY)).toEqual({ volume: null, rejectedRaw: null });
  });
});
