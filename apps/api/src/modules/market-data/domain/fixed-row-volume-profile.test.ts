import { describe, expect, it } from "vitest";
import {
  VOLUME_PROFILE_ROWS,
  buildFixedRowVolumeProfile,
  describeEntryAgainstProfile,
  type ProfileBar,
} from "./fixed-row-volume-profile.js";

function bar(low: number, high: number, volume: number): ProfileBar {
  return { low, high, close: (low + high) / 2, volume };
}

/** Two busy zones, 100-110 and 130-140, joined by one thin bar through the gap. */
function twoZoneBars(): ProfileBar[] {
  const bars: ProfileBar[] = [];
  for (let i = 0; i < 10; i += 1) bars.push(bar(100, 110, 1000));
  for (let i = 0; i < 10; i += 1) bars.push(bar(130, 140, 1000));
  bars.push(bar(110, 130, 100));
  return bars;
}

describe("buildFixedRowVolumeProfile", () => {
  it("keeps every contract of volume, spread over the rows", () => {
    const bars = [bar(100, 112.3, 500), bar(101, 120, 800), bar(99.5, 103, 250), bar(110, 110, 40)];
    const profile = buildFixedRowVolumeProfile(bars)!;

    expect(profile.rowVolumes).toHaveLength(VOLUME_PROFILE_ROWS);
    expect(profile.rowVolumes.reduce((a, b) => a + b, 0)).toBeCloseTo(1590, 6);
    expect(profile.totalVolume).toBe(1590);
  });

  it("does not let a zero-range bar become the POC -- the defect of the first study", () => {
    // 5,000 contracts spread across the day's range, plus one flat bar of 180 contracts at 54,950.
    const bars: ProfileBar[] = [];
    for (let i = 0; i < 50; i += 1) bars.push(bar(55_000 + i, 55_030 + i, 100));
    bars.push(bar(54_950, 54_950, 180));
    const profile = buildFixedRowVolumeProfile(bars)!;

    expect(profile.poc).toBeGreaterThan(55_000);
  });

  it("puts the POC in the busiest zone", () => {
    const bars = [...twoZoneBars(), ...Array.from({ length: 5 }, () => bar(134, 138, 1000))];
    const profile = buildFixedRowVolumeProfile(bars)!;

    expect(profile.poc).toBeGreaterThan(133);
    expect(profile.poc).toBeLessThan(139);
  });

  it("builds a value area that holds at least 70% of the volume and contains the POC", () => {
    const profile = buildFixedRowVolumeProfile(twoZoneBars())!;
    const inside = profile.rowVolumes.reduce((sum, volume, row) => {
      const bottom = profile.low + row * profile.rowWidth;
      return bottom >= profile.val - 1e-9 && bottom + profile.rowWidth <= profile.vah + 1e-9 ? sum + volume : sum;
    }, 0);

    expect(inside / profile.totalVolume).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(profile.val).toBeLessThanOrEqual(profile.poc);
    expect(profile.vah).toBeGreaterThanOrEqual(profile.poc);
  });

  it("finds one low-volume node between two busy zones, and a high-volume node in each zone", () => {
    const profile = buildFixedRowVolumeProfile(twoZoneBars())!;

    expect(profile.lvns).toHaveLength(1);
    expect(profile.lvns[0]!).toBeGreaterThan(115);
    expect(profile.lvns[0]!).toBeLessThan(125);
    expect(profile.hvns).toHaveLength(2);
    expect(profile.hvns.some((level) => Math.abs(level - profile.poc) < profile.rowWidth * 6)).toBe(true);
  });

  it("finds no low-volume node in a single-zone profile", () => {
    const bars = [bar(100, 110, 1000), bar(102, 108, 1000), bar(104, 106, 1000), bar(98, 112, 100)];
    expect(buildFixedRowVolumeProfile(bars)!.lvns).toEqual([]);
  });

  it("ignores a dip that has volume on only one side", () => {
    // Busy at the bottom, thinning steadily upward: no trough with a busy zone above it.
    const bars = [bar(100, 110, 1000), bar(110, 120, 400), bar(120, 130, 100), bar(130, 140, 20)];
    expect(buildFixedRowVolumeProfile(bars)!.lvns).toEqual([]);
  });

  it("returns null when there is nothing to profile", () => {
    expect(buildFixedRowVolumeProfile([])).toBeNull();
    expect(buildFixedRowVolumeProfile([bar(100, 110, 0)])).toBeNull();
    expect(buildFixedRowVolumeProfile([bar(100, 100, 500)])).toBeNull();
    expect(buildFixedRowVolumeProfile([bar(100, 110, 500)], 2)).toBeNull();
  });

  it("skips bars with no volume or a broken range, and keeps the rest", () => {
    const profile = buildFixedRowVolumeProfile([bar(100, 110, 500), bar(120, 90, 500), bar(100, 105, 0)])!;
    expect(profile.totalVolume).toBe(500);
  });
});

describe("describeEntryAgainstProfile", () => {
  const profile = buildFixedRowVolumeProfile(twoZoneBars())!;

  it("places an entry inside, above or below the value area", () => {
    expect(describeEntryAgainstProfile(profile, profile.poc, "LONG").position).toBe("INSIDE_VALUE");
    expect(describeEntryAgainstProfile(profile, profile.vah + 5, "LONG").position).toBe("ABOVE_VAH");
    expect(describeEntryAgainstProfile(profile, profile.val - 5, "SHORT").position).toBe("BELOW_VAL");
  });

  it("looks up for a LONG and down for a SHORT", () => {
    const long = describeEntryAgainstProfile(profile, 105, "LONG");
    expect(long.lvnAhead!.level).toBeGreaterThan(115);
    expect(long.lvnAhead!.distance).toBeCloseTo(long.lvnAhead!.level - 105, 9);
    expect(long.lvnBehind).toBeNull();

    const short = describeEntryAgainstProfile(profile, 135, "SHORT");
    expect(short.lvnAhead!.level).toBeLessThan(125);
    expect(short.lvnAhead!.distance).toBeCloseTo(135 - short.lvnAhead!.level, 9);
    expect(short.lvnBehind).toBeNull();
  });

  it("reports the dip as before the next busy zone when it is nearer", () => {
    // From 105 going up: the dip near 120 comes before the busy zone near 135, if there is one ahead.
    const fromBottom = describeEntryAgainstProfile(profile, 105, "LONG");
    expect(fromBottom.hvnAhead).not.toBeNull();
    expect(fromBottom.lvnAhead!.distance).toBeLessThan(fromBottom.hvnAhead!.distance);
    expect(fromBottom.lvnBeforeHvn).toBe(true);
  });

  it("returns no node ahead when there is none, and a null corridor flag", () => {
    const result = describeEntryAgainstProfile(profile, 139, "LONG");
    expect(result.lvnAhead).toBeNull();
    expect(result.lvnBeforeHvn).toBeNull();
  });

  it("signs the distance from the POC", () => {
    expect(describeEntryAgainstProfile(profile, profile.poc + 7, "LONG").fromPoc).toBeCloseTo(7, 9);
    expect(describeEntryAgainstProfile(profile, profile.poc - 7, "SHORT").fromPoc).toBeCloseTo(-7, 9);
  });
});
