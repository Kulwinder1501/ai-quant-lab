import { describe, expect, it } from "vitest";
import {
  buildPathContrastUnits,
  inputSnapshotHash,
  sessionSetHash,
  type PathStudyBarInput,
  type PathStudySubjectInput,
} from "./path-study-inputs.js";

const decisionAt = new Date("2026-08-24T04:30:00.000Z");
const sessionCloseAt = new Date(decisionAt.getTime() + 120 * 60_000);

function bar(minute: number, close = 100): PathStudyBarInput {
  return {
    openTime: new Date(decisionAt.getTime() + (minute - 1) * 60_000),
    closeTime: new Date(decisionAt.getTime() + minute * 60_000),
    open: 100, high: Math.max(100, close), low: Math.min(100, close), close,
  };
}

function subject(overrides: Partial<PathStudySubjectInput> = {}): PathStudySubjectInput {
  return {
    opportunityId: "opp-1",
    sessionId: "2026-08-24",
    instrumentId: "inst-1",
    direction: "LONG",
    strategyDefinitionHashes: ["a".repeat(64)],
    selected: { decisionAt, sessionCloseAt, referencePrice: 100, atr: 2 },
    controls: [{ decisionAt, sessionCloseAt, referencePrice: 100.5, atr: 2 }],
    ...overrides,
  };
}

describe("session set hash", () => {
  it("separates two session sets that share first, last and count", () => {
    // The defect this closes: range plus count identifies a span, not a dataset. These two agree on all
    // three and are different data.
    const a = sessionSetHash(["2026-08-01", "2026-08-12", "2026-08-25"]);
    const b = sessionSetHash(["2026-08-01", "2026-08-13", "2026-08-25"]);
    expect(a).not.toBe(b);
  });

  it("is order-independent and duplicate-insensitive", () => {
    expect(sessionSetHash(["2026-08-25", "2026-08-24"])).toBe(sessionSetHash(["2026-08-24", "2026-08-25"]));
    expect(sessionSetHash(["2026-08-24", "2026-08-24"])).toBe(sessionSetHash(["2026-08-24"]));
  });

  it("moves when a session is added", () => {
    expect(sessionSetHash(["2026-08-24"])).not.toBe(sessionSetHash(["2026-08-24", "2026-08-25"]));
  });
});

describe("input snapshot hash", () => {
  const base = { subjects: [subject()], bars: [bar(1), bar(2, 101)] };

  it("is stable across row order from the database", () => {
    const reordered = { subjects: base.subjects, bars: [bar(2, 101), bar(1)] };
    expect(inputSnapshotHash(reordered)).toBe(inputSnapshotHash(base));
  });

  it("moves when the healer appends a repaired bar", () => {
    // The case that matters most. Same sessions, same count, one more observation -- which must read as
    // a new dataset rather than as a determinism violation on the old one.
    const healed = { subjects: base.subjects, bars: [...base.bars, bar(3, 102)] };
    expect(inputSnapshotHash(healed)).not.toBe(inputSnapshotHash(base));
  });

  it("moves when an existing bar is corrected, even slightly", () => {
    // Sensitivity is deliberate: the job is to detect that the input differs, not to judge whether the
    // difference was large enough to matter.
    const corrected = { subjects: base.subjects, bars: [bar(1), { ...bar(2, 101), high: 101.000001 }] };
    expect(inputSnapshotHash(corrected)).not.toBe(inputSnapshotHash(base));
  });

  it("moves when a recompute pass changes a decision's ATR", () => {
    // indicator_snapshots is rewritten wholesale by recompute passes, so the volatility scale every
    // ATR-unit figure divides by can change under a trial that has already run.
    const rescaled = {
      subjects: [subject({ selected: { decisionAt, sessionCloseAt, referencePrice: 100, atr: 2.5 } })],
      bars: base.bars,
    };
    expect(inputSnapshotHash(rescaled)).not.toBe(inputSnapshotHash(base));
  });

  it("moves when a control set changes", () => {
    const recontrolled = {
      subjects: [subject({ controls: [{ decisionAt, sessionCloseAt, referencePrice: 99.5, atr: 2 }] })],
      bars: base.bars,
    };
    expect(inputSnapshotHash(recontrolled)).not.toBe(inputSnapshotHash(base));
  });

  it("is unchanged by an identical reconstruction", () => {
    expect(inputSnapshotHash({ subjects: [subject()], bars: [bar(1), bar(2, 101)] }))
      .toBe(inputSnapshotHash(base));
  });
});

describe("unit assembly", () => {
  it("walks controls with the subject's direction, not their own", () => {
    /*
     * A control point exists in both directions at the same minute, and the matcher already chose the
     * one matching the treated direction. Re-deriving it here would read the opposite sign convention
     * into the baseline, inverting the contrast rather than merely weakening it — so the same falling
     * path must produce the same sign on both sides of a SHORT unit.
     */
    const falling = [bar(1, 99), bar(2, 98)];
    const units = buildPathContrastUnits({
      subjects: [subject({ direction: "SHORT" })],
      seriesByInstrument: new Map([["inst-1", falling]]),
      horizonsMinutes: [1, 2],
    });
    const unit = units[0]!;
    const selectedAt2 = unit.selected.observations.find((o) => o.horizonMinutes === 2)!;
    const controlAt2 = unit.controls[0]!.observations.find((o) => o.horizonMinutes === 2)!;

    // Price fell, so a SHORT reads it as favourable on both the treated and the control side.
    expect(selectedAt2.directionalReturnPoints).toBeGreaterThan(0);
    expect(controlAt2.directionalReturnPoints).toBeGreaterThan(0);
  });

  it("carries cohort provenance through to the unit", () => {
    const units = buildPathContrastUnits({
      subjects: [subject()],
      seriesByInstrument: new Map([["inst-1", [bar(1)]]]),
      horizonsMinutes: [1],
    });
    expect(units[0]!.strategyDefinitionHashes).toEqual(["a".repeat(64)]);
    expect(units[0]!.sessionId).toBe("2026-08-24");
  });

  it("yields an incomplete observation for an instrument with no series", () => {
    // A missing series must not silently become a flat path; it is missing data.
    const units = buildPathContrastUnits({
      subjects: [subject({ instrumentId: "unknown" })],
      seriesByInstrument: new Map([["inst-1", [bar(1)]]]),
      horizonsMinutes: [1],
    });
    expect(units[0]!.selected.observations[0]!.status).toBe("DATA_INCOMPLETE");
  });
});
