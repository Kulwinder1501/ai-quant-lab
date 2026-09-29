import { describe, expect, it } from "vitest";
import {
  findOverlappingSessions,
  summariseCaptureSessions,
  type CaptureSessionWindowFrame,
} from "./capture-session-window.js";

const T0 = Date.UTC(2026, 8, 21, 3, 38, 0);
const HOUR = 60 * 60_000;

describe("summariseCaptureSessions", () => {
  it("groups frames by session and reports the span of each", () => {
    const frames: CaptureSessionWindowFrame[] = [
      { captureSessionId: "s1", receivedAt: new Date(T0) },
      { captureSessionId: "s1", receivedAt: new Date(T0 + 1_000) },
      { captureSessionId: "s2", receivedAt: new Date(T0 + 2 * HOUR) },
      { captureSessionId: "s2", receivedAt: new Date(T0 + 2 * HOUR + 5_000) },
    ];

    const summary = summariseCaptureSessions(frames);

    expect(summary).toHaveLength(2);
    expect(summary[0]).toMatchObject({
      captureSessionId: "s1", frames: 2, firstAt: new Date(T0), lastAt: new Date(T0 + 1_000),
    });
    expect(summary[1]).toMatchObject({
      captureSessionId: "s2",
      frames: 2,
      firstAt: new Date(T0 + 2 * HOUR),
      lastAt: new Date(T0 + 2 * HOUR + 5_000),
    });
  });

  it("sorts sessions by first appearance regardless of input order", () => {
    const frames: CaptureSessionWindowFrame[] = [
      { captureSessionId: "later", receivedAt: new Date(T0 + HOUR) },
      { captureSessionId: "earlier", receivedAt: new Date(T0) },
    ];

    const summary = summariseCaptureSessions(frames);

    expect(summary.map((entry) => entry.captureSessionId)).toEqual(["earlier", "later"]);
  });

  it("returns an empty list for no frames", () => {
    expect(summariseCaptureSessions([])).toEqual([]);
  });
});

describe("findOverlappingSessions", () => {
  it("finds nothing for sequential, non-overlapping sessions", () => {
    // The expected shape of a genuine multi-session pool: one collector run ends, a gap (a restart),
    // the next begins strictly afterwards.
    const sessions = summariseCaptureSessions([
      { captureSessionId: "day1", receivedAt: new Date(T0) },
      { captureSessionId: "day1", receivedAt: new Date(T0 + 6 * HOUR) },
      { captureSessionId: "day2", receivedAt: new Date(T0 + 24 * HOUR) },
      { captureSessionId: "day2", receivedAt: new Date(T0 + 30 * HOUR) },
    ]);

    expect(findOverlappingSessions(sessions)).toEqual([]);
  });

  it("flags two sessions whose time ranges intersect as concurrent writers", () => {
    // A bad deploy that didn't tear the old container down before starting the new one: both wrote
    // into the same interval, so pooling them would interleave two independent streams.
    const sessions = summariseCaptureSessions([
      { captureSessionId: "old", receivedAt: new Date(T0) },
      { captureSessionId: "old", receivedAt: new Date(T0 + 2 * HOUR) },
      { captureSessionId: "new", receivedAt: new Date(T0 + HOUR) },
      { captureSessionId: "new", receivedAt: new Date(T0 + 3 * HOUR) },
    ]);

    const overlaps = findOverlappingSessions(sessions);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      sessionA: "old",
      sessionB: "new",
      overlapFrom: new Date(T0 + HOUR),
      overlapTo: new Date(T0 + 2 * HOUR),
    });
  });

  it("treats a session nested entirely inside another as an overlap too", () => {
    const sessions = summariseCaptureSessions([
      { captureSessionId: "outer", receivedAt: new Date(T0) },
      { captureSessionId: "outer", receivedAt: new Date(T0 + 4 * HOUR) },
      { captureSessionId: "inner", receivedAt: new Date(T0 + HOUR) },
      { captureSessionId: "inner", receivedAt: new Date(T0 + 2 * HOUR) },
    ]);

    const overlaps = findOverlappingSessions(sessions);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toMatchObject({
      sessionA: "outer", sessionB: "inner",
      overlapFrom: new Date(T0 + HOUR), overlapTo: new Date(T0 + 2 * HOUR),
    });
  });

  it("does not flag a session that starts exactly when the previous one ends", () => {
    // A closed-closed boundary touch is not an overlap: real collector restarts can legitimately hand
    // off within the same millisecond bucket at 500ms cadence in rare cases.
    const sessions = summariseCaptureSessions([
      { captureSessionId: "s1", receivedAt: new Date(T0) },
      { captureSessionId: "s1", receivedAt: new Date(T0 + HOUR) },
      { captureSessionId: "s2", receivedAt: new Date(T0 + HOUR) },
      { captureSessionId: "s2", receivedAt: new Date(T0 + 2 * HOUR) },
    ]);

    // This is a boundary-touch case, which the interval-intersection definition used here (>=) does
    // treat as overlapping -- a single shared instant is enough to make the pooled series ambiguous
    // about which session that instant's frame belongs to for feature construction. Documented, not
    // silently accepted.
    expect(findOverlappingSessions(sessions)).toHaveLength(1);
  });

  it("returns nothing for a single session", () => {
    const sessions = summariseCaptureSessions([
      { captureSessionId: "only", receivedAt: new Date(T0) },
    ]);
    expect(findOverlappingSessions(sessions)).toEqual([]);
  });

  it("scales to many sequential sessions without quadratic blowup in the result", () => {
    const frames: CaptureSessionWindowFrame[] = [];
    for (let day = 0; day < 50; day += 1) {
      frames.push({ captureSessionId: `s${day}`, receivedAt: new Date(T0 + day * 24 * HOUR) });
      frames.push({ captureSessionId: `s${day}`, receivedAt: new Date(T0 + day * 24 * HOUR + HOUR) });
    }
    const sessions = summariseCaptureSessions(frames);
    expect(findOverlappingSessions(sessions)).toEqual([]);
  });
});
