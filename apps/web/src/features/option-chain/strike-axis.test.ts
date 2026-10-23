import { describe, expect, it } from "vitest";
import { nearestStrikeOnAxis } from "./strike-axis";

describe("nearestStrikeOnAxis", () => {
  const strikes = [22400, 22450, 22500, 22550];

  it("snaps to the closest strike", () => {
    expect(nearestStrikeOnAxis(strikes, 22463)).toBe(22450);
    expect(nearestStrikeOnAxis(strikes, 22490)).toBe(22500);
  });

  it("returns the edge strike when the target is outside the axis", () => {
    expect(nearestStrikeOnAxis(strikes, 100)).toBe(22400);
    expect(nearestStrikeOnAxis(strikes, 99999)).toBe(22550);
  });

  it("resolves an exact tie to the lower strike", () => {
    expect(nearestStrikeOnAxis(strikes, 22475)).toBe(22450);
  });

  it("returns null for a missing target, a non-finite target or an empty axis", () => {
    expect(nearestStrikeOnAxis(strikes, null)).toBeNull();
    expect(nearestStrikeOnAxis(strikes, Number.NaN)).toBeNull();
    expect(nearestStrikeOnAxis([], 22500)).toBeNull();
  });
});
