import { describe, expect, it } from "vitest";
import { decideBarReadiness } from "./pending-bar-readiness.js";

const WAIT = 25 * 60_000;

describe("decideBarReadiness", () => {
  it("captures a bar whose layers are all there", () => {
    expect(decideBarReadiness({ featuresCovered: true, atrComputed: true, ageMs: 5_000, waitMs: WAIT })).toBe("CAPTURE");
  });

  it("defers a young bar whose patterns are missing", () => {
    expect(decideBarReadiness({ featuresCovered: false, atrComputed: true, ageMs: 5_000, waitMs: WAIT })).toBe("DEFER");
  });

  it("defers a young bar whose ATR is missing -- the case that used to reach the capture step and throw", () => {
    expect(decideBarReadiness({ featuresCovered: true, atrComputed: false, ageMs: 5_000, waitMs: WAIT })).toBe("DEFER");
  });

  it("captures an old bar even without its ATR, so one missing indicator cannot hold up the queue", () => {
    expect(decideBarReadiness({ featuresCovered: true, atrComputed: false, ageMs: WAIT, waitMs: WAIT })).toBe("CAPTURE");
    expect(decideBarReadiness({ featuresCovered: false, atrComputed: false, ageMs: WAIT + 1, waitMs: WAIT })).toBe("CAPTURE");
  });

  it("still waits right up to the deadline", () => {
    expect(decideBarReadiness({ featuresCovered: true, atrComputed: false, ageMs: WAIT - 1, waitMs: WAIT })).toBe("DEFER");
  });
});
